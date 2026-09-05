/**
 * M6a — re-creación consent-first de cadencias (CA-M3.4) en el hook de DONE
 * del BoardEngine (junto a promoteUnblockedTasks, fail-soft):
 * - DONE de la instancia confirmada → nace la SIGUIENTE (due = due anterior +
 *   periodo, título re-renderizado, asignado re-resuelto) y la vieja sigue DONE.
 * - Guarda-raíl anti-bucle: con una instancia ABIERTA no se crea otra.
 * - No confirmada: ni nace ni renace.
 * - Roster: si el preferido cambió, se re-resuelve; si nadie es asignable, NO
 *   se crea y queda aviso (task_event + audit) — fail-soft.
 */
import { describe, expect, it } from "vitest";
import { DAY_MS } from "@agentos/shared";
import {
  attachArtifact,
  getAgentBySlug,
  getTask,
  launchModule,
  listTaskEvents,
  listTasks,
  openDb,
  queryAudit,
  runMigrations,
  seed,
  updateAgent,
  type AgentosDb,
  type LaunchModuleResult,
  type Task,
} from "@agentos/db";
import {
  createBoardEngine,
  recordingEventSink,
  respawnCadenceInstance,
  type BoardEngine,
} from "../src/index.js";

const NOW = Date.parse("2026-08-28T00:00:00.000Z");

interface Fixture {
  db: AgentosDb;
  engine: BoardEngine;
  sink: ReturnType<typeof recordingEventSink>;
  r: LaunchModuleResult;
  reporte: Task;
}

async function cadenceFixture(): Promise<Fixture> {
  const db = openDb(":memory:");
  runMigrations(db);
  await seed(db, { env: {} });
  const sink = recordingEventSink();
  const engine = createBoardEngine({ db, sink });
  const r = await launchModule(db, {
    moduleSlug: "operacion",
    org: { name: "Nova Ops S.A." },
    inputs: { cliente: "Nova", objetivo: "Operar la promesa mes a mes." },
    cadencesConfirmed: ["reporte_semanal"],
    actor: "person:ernesto",
    idempotencyKey: "launch:test:respawn:operacion",
    now: NOW,
  });
  const byKey = new Map(
    (r.launch.result as { tasks: { key: string; taskId: string }[] }).tasks.map(
      (t) => [t.key, t.taskId] as const,
    ),
  );
  return { db, engine, sink, r, reporte: (await getTask(db, byKey.get("reporte_semanal")!))! };
}

/** DONE por la máquina real: humano + artefacto (regla anti-teatro). */
async function humanDone(f: Fixture, taskId: string): Promise<void> {
  let task = (await getTask(f.db, taskId))!;
  if (task.status === "READY") {
    await f.engine.moveTask({
      taskId,
      to: "IN_PROGRESS",
      expectedVersion: task.version,
      actor: "person:ernesto",
    });
    task = (await getTask(f.db, taskId))!;
  }
  await attachArtifact(f.db, { taskId, kind: "document", title: "Evidencia" });
  await f.engine.moveTask({ taskId, to: "DONE", expectedVersion: task.version, actor: "person:ernesto" });
}

/** Instancias de la plantilla cadence por su task_event created (mapeo real). */
async function instancesOf(db: AgentosDb, projectId: string, templateKey: string): Promise<Task[]> {
  const tasks = await listTasks(db, { projectId });
  const result: Task[] = [];
  for (const t of tasks) {
    const events = await listTaskEvents(db, t.id);
    if (events.some((e) => e.kind === "created" && e.payload?.["template_key"] === templateKey)) {
      result.push(t);
    }
  }
  return result;
}

describe("re-creación de cadencia en el hook de DONE (CA-M3.4 — M6a)", () => {
  it("DONE de la instancia → nace la siguiente con due+periodo; la vieja sigue DONE", async () => {
    const f = await cadenceFixture();
    expect(f.reporte.status).toBe("READY");
    expect(f.reporte.dueAt).toBe(NOW + 7 * DAY_MS);

    await humanDone(f, f.reporte.id);

    const instancias = await instancesOf(f.db, f.r.project.id, "reporte_semanal");
    expect(instancias).toHaveLength(2);
    const vieja = instancias.find((t) => t.id === f.reporte.id)!;
    const nueva = instancias.find((t) => t.id !== f.reporte.id)!;
    expect(vieja.status).toBe("DONE");
    expect(nueva.status).toBe("READY");
    expect(nueva.title).toBe(f.reporte.title); // mismo título re-renderizado
    expect(nueva.definitionOfDone).toBe(f.reporte.definitionOfDone);
    expect(nueva.dueAt).toBe(f.reporte.dueAt! + 7 * DAY_MS); // due de la cerrada + periodo
    expect(nueva.assigneeAgentId).toBe((await getAgentBySlug(f.db, "clara"))!.id); // rol datos
    expect(nueva.dependsOn ?? []).toEqual([]);

    // El evento created de la nueva mantiene el mapeo tarea→plantilla (la cadena sigue).
    const created = (await listTaskEvents(f.db, nueva.id)).find((e) => e.kind === "created")!;
    expect(created.actor).toBe("system:cadence");
    expect(created.payload?.["template_key"]).toBe("reporte_semanal");
    expect(created.payload?.["respawn_of"]).toBe(f.reporte.id);
    // Y el tablero se enteró (evento board task.created del sistema de cadencia).
    expect(
      f.sink.published.some(
        (p) =>
          p.topic === `board:${f.r.project.id}` &&
          p.event.type === "task.created" &&
          (p.event as { payload?: { actor?: string } }).payload?.actor === "system:cadence",
      ),
    ).toBe(true);
  });

  it("guarda-raíl anti-bucle: con la nueva instancia ABIERTA no se duplica", async () => {
    const f = await cadenceFixture();
    await humanDone(f, f.reporte.id);
    expect(await instancesOf(f.db, f.r.project.id, "reporte_semanal")).toHaveLength(2);

    // Segundo intento sobre la MISMA tarea DONE (p. ej. hook repetido): nada.
    expect(await respawnCadenceInstance(f.db, f.reporte.id)).toBeNull();
    expect(await instancesOf(f.db, f.r.project.id, "reporte_semanal")).toHaveLength(2);
  });

  it("la cadena continúa: cerrar la instancia re-creada crea la tercera", async () => {
    const f = await cadenceFixture();
    await humanDone(f, f.reporte.id);
    const segunda = (await instancesOf(f.db, f.r.project.id, "reporte_semanal")).find(
      (t) => t.status === "READY",
    )!;
    await humanDone(f, segunda.id);
    const instancias = await instancesOf(f.db, f.r.project.id, "reporte_semanal");
    expect(instancias).toHaveLength(3);
    const tercera = instancias.find((t) => t.status === "READY")!;
    expect(tercera.dueAt).toBe(segunda.dueAt! + 7 * DAY_MS);
  });

  it("no confirmada: no nace en el launch ni renace al cerrar otras tareas", async () => {
    const f = await cadenceFixture();
    expect(await instancesOf(f.db, f.r.project.id, "sprint_semanal")).toHaveLength(0);
    // Cerrar una tarea NO cadence no crea cadencias.
    const byKey = new Map(
      (f.r.launch.result as { tasks: { key: string; taskId: string }[] }).tasks.map(
        (t) => [t.key, t.taskId] as const,
      ),
    );
    await humanDone(f, byKey.get("kickoff_ops")!);
    expect(await instancesOf(f.db, f.r.project.id, "sprint_semanal")).toHaveLength(0);
    expect(await instancesOf(f.db, f.r.project.id, "reporte_semanal")).toHaveLength(1);
  });

  it("roster cambiado: el asignado se re-resuelve contra el roster ACTUAL (clara pausada → sally)", async () => {
    const f = await cadenceFixture();
    const clara = (await getAgentBySlug(f.db, "clara"))!;
    await updateAgent(f.db, clara.id, { status: "paused" }, clara.version);

    await humanDone(f, f.reporte.id);
    const nueva = (await instancesOf(f.db, f.r.project.id, "reporte_semanal")).find(
      (t) => t.status === "READY",
    )!;
    expect(nueva.assigneeAgentId).toBe((await getAgentBySlug(f.db, "sally"))!.id); // capa operacion
  });

  it("nadie asignable: NO se crea y queda aviso fail-soft (task_event + audit)", async () => {
    const f = await cadenceFixture();
    for (const slug of ["clara", "sally"]) {
      const agent = (await getAgentBySlug(f.db, slug))!;
      await updateAgent(f.db, agent.id, { status: "paused" }, agent.version);
    }

    await humanDone(f, f.reporte.id); // el DONE NO se cae (fail-soft)
    expect((await getTask(f.db, f.reporte.id))!.status).toBe("DONE");
    expect(await instancesOf(f.db, f.r.project.id, "reporte_semanal")).toHaveLength(1); // sin nueva

    const aviso = (await listTaskEvents(f.db, f.reporte.id)).find(
      (e) => e.kind === "comment" && e.payload?.["cadence_skipped"] === true,
    )!;
    expect(aviso.actor).toBe("system:cadence");
    expect(aviso.payload?.["reason"]).toBe("agent_not_assignable");

    const audit = await queryAudit(f.db, {
      action: "modules.cadence_skipped",
      entityId: f.reporte.id,
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.after?.["template_key"]).toBe("reporte_semanal");
  });

  it("tareas ajenas al launch (manuales) no disparan cadencia", async () => {
    const f = await cadenceFixture();
    const manual = await f.engine.createTask(
      {
        projectId: f.r.project.id,
        title: "Tarea manual",
        stage: "OPERAR",
        definitionOfDone: "Hecha.",
        assigneeAgentId: (await getAgentBySlug(f.db, "sally"))!.id,
      },
      { actor: "person:ernesto" },
    );
    const before = (await listTasks(f.db, { projectId: f.r.project.id })).length;
    // BACKLOG→READY→IN_PROGRESS→DONE por humano.
    const t = (await getTask(f.db, manual.id))!;
    await f.engine.moveTask({ taskId: t.id, to: "READY", expectedVersion: t.version, actor: "person:ernesto" });
    await humanDone(f, manual.id);
    expect(await listTasks(f.db, { projectId: f.r.project.id })).toHaveLength(before); // nada nuevo
  });
});
