/**
 * M3 (§13.4, CA-M2.3): guard de dependencias en BACKLOG→READY (fail-closed para
 * system/agent, override humano auditado) y promoteUnblockedTasks como hook del
 * ÚNICO camino de dominio a DONE (la transición del motor). Incluye la cadena
 * real kickoff→entrevistas del launch de consultoría.
 */
import { describe, expect, it } from "vitest";
import { isAgentosError } from "@agentos/shared";
import {
  attachArtifact,
  getTask,
  launchModule,
  listTaskEvents,
  openDb,
  queryAudit,
  runMigrations,
  seed,
  updateTask,
  type AgentosDb,
} from "@agentos/db";
import {
  createBoardEngine,
  dependencyState,
  isTransitionAllowed,
  recordingEventSink,
  type BoardEngine,
} from "../src/index.js";
import { fixture, seedTask, type Fixture } from "./helpers.js";

/** Lleva una tarea a DONE por la máquina real (humano + artefacto anti-teatro). */
function humanDone(db: AgentosDb, engine: BoardEngine, taskId: string, actor: string): void {
  let task = getTask(db, taskId)!;
  if (task.status === "READY") {
    engine.moveTask({ taskId, to: "IN_PROGRESS", expectedVersion: task.version, actor });
    task = getTask(db, taskId)!;
  }
  attachArtifact(db, { taskId, kind: "document", title: "Evidencia de cierre" });
  engine.moveTask({ taskId, to: "DONE", expectedVersion: task.version, actor });
}

// ── Matriz ──────────────────────────────────────────────────────────────────

describe("matriz — system BACKLOG→READY (§13.4)", () => {
  it("system ahora puede BACKLOG→READY (guard de deps en el motor); agent/human como antes", () => {
    expect(isTransitionAllowed("system", "BACKLOG", "READY")).toBe(true);
    expect(isTransitionAllowed("human", "BACKLOG", "READY")).toBe(true);
    expect(isTransitionAllowed("agent", "BACKLOG", "READY")).toBe(true); // guard "solo orquestador" en el motor
    // El resto de la fila system no cambió.
    expect(isTransitionAllowed("system", "READY", "BACKLOG")).toBe(false);
    expect(isTransitionAllowed("system", "REVIEW", "DONE")).toBe(false);
  });
});

// ── Guard de dependencias ───────────────────────────────────────────────────

describe("guard de dependencias en BACKLOG→READY", () => {
  function withDependent(f: Fixture) {
    const dep = seedTask(f); // BACKLOG
    const dependent = seedTask(f);
    const updated = updateTask(f.db, dependent.id, { dependsOn: [dep.id] }, dependent.version);
    return { dep, dependent: updated };
  }

  it("system con deps insatisfechas → dependency_not_satisfied con los ids bloqueantes", () => {
    const f = fixture();
    const { dep, dependent } = withDependent(f);
    let err: unknown;
    try {
      f.engine.moveTask({
        taskId: dependent.id,
        to: "READY",
        expectedVersion: dependent.version,
        actor: "system:dependencies",
      });
    } catch (e) {
      err = e;
    }
    expect(isAgentosError(err, "dependency_not_satisfied"), String(err)).toBe(true);
    expect((err as { details: { unsatisfied: string[] } }).details.unsatisfied).toEqual([dep.id]);
    expect(getTask(f.db, dependent.id)!.status).toBe("BACKLOG");
  });

  it("agente (incluso el orquestador) con deps insatisfechas → rechazado", () => {
    const f = fixture();
    const { dependent } = withDependent(f);
    expect(() =>
      f.engine.moveTask({
        taskId: dependent.id,
        to: "READY",
        expectedVersion: dependent.version,
        actor: "agent:alex", // orquestador: pasa el guard de rol, NO el de deps
      }),
    ).toThrowError(/dependencias sin cerrar/);
  });

  it("humano puede forzar (override) y queda auditado como tal", () => {
    const f = fixture();
    const { dep, dependent } = withDependent(f);
    const moved = f.engine.moveTask({
      taskId: dependent.id,
      to: "READY",
      expectedVersion: dependent.version,
      actor: `person:${f.person.id}`,
      note: "la necesito ya",
    });
    expect(moved.status).toBe("READY");

    const audits = queryAudit(f.db, { action: "task.dependency_override", entityId: dependent.id });
    expect(audits).toHaveLength(1);
    expect(audits[0]!.actor).toBe(`person:${f.person.id}`);
    expect(audits[0]!.after?.["unsatisfiedDependsOn"]).toEqual([dep.id]);
    expect(audits[0]!.reason).toBe("la necesito ya");

    const moveEvent = listTaskEvents(f.db, dependent.id).find((e) => e.kind === "moved")!;
    expect(moveEvent.payload?.["dependencyOverride"]).toBe(true);
    expect(moveEvent.payload?.["unsatisfiedDependsOn"]).toEqual([dep.id]);
  });

  it("con TODAS las deps en DONE, system promueve sin error (y sin audit de override)", () => {
    const f = fixture();
    const { dep, dependent } = withDependent(f);
    // Setup directo del estado de la dep (patrón seedTask): DONE.
    f.db.$client.prepare(`UPDATE tasks SET status = 'DONE', version = version + 1 WHERE id = ?`).run(dep.id);
    expect(dependencyState(f.db, dependent.id).satisfied).toBe(true);
    const moved = f.engine.moveTask({
      taskId: dependent.id,
      to: "READY",
      expectedVersion: dependent.version,
      actor: "system:dependencies",
    });
    expect(moved.status).toBe("READY");
    expect(queryAudit(f.db, { action: "task.dependency_override" })).toHaveLength(0);
  });

  it("dependencyState: una dep inexistente cuenta como insatisfecha (fail-closed)", () => {
    const f = fixture();
    const t = seedTask(f);
    updateTask(f.db, t.id, { dependsOn: ["no-existe"] }, t.version);
    const state = dependencyState(f.db, t.id);
    expect(state.satisfied).toBe(false);
    expect(state.unsatisfied).toEqual(["no-existe"]);
  });
});

// ── promoteUnblockedTasks (hook en DONE) ────────────────────────────────────

describe("promoteUnblockedTasks — hook en la transición a DONE (CA-M2.3)", () => {
  it("DONE parcial no promueve; el DONE de la última dep promueve por la máquina real", () => {
    const f = fixture();
    const actor = `person:${f.person.id}`;
    const dep1 = seedTask(f, { status: "READY" });
    const dep2 = seedTask(f, { status: "READY" });
    const dependent = seedTask(f);
    updateTask(f.db, dependent.id, { dependsOn: [dep1.id, dep2.id] }, dependent.version);
    const solo = seedTask(f); // BACKLOG sin deps: el sistema NO lo toca

    humanDone(f.db, f.engine, dep1.id, actor);
    expect(getTask(f.db, dependent.id)!.status).toBe("BACKLOG"); // dep2 sigue abierta

    humanDone(f.db, f.engine, dep2.id, actor);
    const promoted = getTask(f.db, dependent.id)!;
    expect(promoted.status).toBe("READY");
    expect(getTask(f.db, solo.id)!.status).toBe("BACKLOG");

    // La promoción pasó por la máquina: task_event 'moved' de actor system + evento de board.
    const moveEvent = listTaskEvents(f.db, dependent.id).find(
      (e) => e.kind === "moved" && e.actor === "system:dependencies",
    )!;
    expect(moveEvent.fromStatus).toBe("BACKLOG");
    expect(moveEvent.toStatus).toBe("READY");
    const boardMoves = f.sink.published.filter(
      (p) =>
        p.topic === `board:${f.project.id}` &&
        p.event.type === "task.moved" &&
        (p.event as { payload?: { taskId?: string } }).payload?.taskId === dependent.id,
    );
    expect(boardMoves).toHaveLength(1);
  });

  it("fail-soft: la dependiente sin DoD se queda en BACKLOG y no tumba el DONE", () => {
    const f = fixture();
    const actor = `person:${f.person.id}`;
    const dep = seedTask(f, { status: "READY" });
    const sinDod = seedTask(f, { definitionOfDone: null });
    updateTask(f.db, sinDod.id, { dependsOn: [dep.id] }, sinDod.version);

    humanDone(f.db, f.engine, dep.id, actor); // no lanza
    expect(getTask(f.db, dep.id)!.status).toBe("DONE");
    expect(getTask(f.db, sinDod.id)!.status).toBe("BACKLOG");
  });

  it("invocable directa: devuelve los ids promovidos", () => {
    const f = fixture();
    const dep = seedTask(f);
    f.db.$client.prepare(`UPDATE tasks SET status = 'DONE', version = version + 1 WHERE id = ?`).run(dep.id);
    const dependent = seedTask(f);
    updateTask(f.db, dependent.id, { dependsOn: [dep.id] }, dependent.version);

    expect(f.engine.promoteUnblockedTasks(f.project.id)).toEqual([dependent.id]);
    expect(f.engine.promoteUnblockedTasks(f.project.id)).toEqual([]); // idempotente
  });
});

// ── Cadena real: launch de consultoría ──────────────────────────────────────

describe("cadena kickoff→entrevistas del launch real (consultoría)", () => {
  it("kickoff DONE promueve las 3 entrevistas; los mapas esperan a las entrevistas", () => {
    const db = openDb(":memory:");
    runMigrations(db);
    seed(db, { env: {} });
    const sink = recordingEventSink();
    const engine = createBoardEngine({ db, sink });

    const r = launchModule(db, {
      moduleSlug: "consultoria",
      org: { name: "Nova Manufactura S.A.", kind: "client" },
      inputs: {
        empresa: "Nova Manufactura S.A.",
        alias: "Nova",
        industria: "manufactura",
        empleados: 40,
        sponsor: "Gerente General",
        objetivo: "Diagnóstico Entender.",
        areas: ["direccion", "operaciones", "ventas"],
        procesos_core: ["Producción", "Ventas → Facturación"],
        fecha_objetivo: "2026-09-15",
      },
      toggles: { iso9001: true },
      actor: "person:ernesto",
      idempotencyKey: "launch:test:deps:consultoria",
    });
    const byKey = new Map(
      (r.launch.result as { tasks: { key: string; taskId: string }[] }).tasks.map(
        (t) => [t.key, t.taskId] as const,
      ),
    );
    const status = (key: string) => getTask(db, byKey.get(key)!)!.status;
    expect(status("kickoff")).toBe("READY");
    expect(status("entrevista:direccion")).toBe("BACKLOG");

    humanDone(db, engine, byKey.get("kickoff")!, "person:ernesto");

    for (const key of ["entrevista:direccion", "entrevista:operaciones", "entrevista:ventas"]) {
      expect(status(key), key).toBe("READY");
    }
    // Todo lo que depende de las entrevistas sigue esperando.
    for (const key of [
      "mapa_proceso:produccion",
      "mapa_proceso:ventas_facturacion",
      "fugas",
      "matriz_iso",
      "informe",
      "roadmap",
    ]) {
      expect(status(key), key).toBe("BACKLOG");
    }

    // Cerrar las 3 entrevistas promueve los 2 mapas (deps: [entrevista]).
    for (const key of ["entrevista:direccion", "entrevista:operaciones", "entrevista:ventas"]) {
      humanDone(db, engine, byKey.get(key)!, "person:ernesto");
    }
    expect(status("mapa_proceso:produccion")).toBe("READY");
    expect(status("mapa_proceso:ventas_facturacion")).toBe("READY");
    expect(status("fugas")).toBe("BACKLOG"); // depende también de los mapas
  });
});
