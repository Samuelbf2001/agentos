/**
 * Despachador determinista: tarea READY → claim atómico → run del runner fake
 * que mueve a REVIEW con artefacto VÍA EL GATEWAY de tools → task_events
 * correcto. Carrera: dos ticks no doblan el run. Run que muere sin mover la
 * tarea → suelta el lease (READY).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  attachArtifact,
  createAgent,
  getTask,
  listArtifacts,
  listPendingApprovals,
  listRuns,
  listTaskEvents,
  listTasks,
} from "@agentos/db";
import { callTool, makeFixture, makeReadyTask, waitFor, type TestFixture } from "./helpers.js";

let fx: TestFixture;

beforeAll(async () => {
  fx = await makeFixture();
});
afterAll(async () => {
  await fx.close();
});

describe("despachador", () => {
  it("READY → claim → run → el fake mueve a REVIEW con artefacto vía gateway", async () => {
    const task = await makeReadyTask(fx, fx.sam, { title: "Informe de assessment" });

    fx.aiRunner.setBehavior(async (input, ctx) => {
      const current = (await getTask(fx.db, ctx.taskId!))!;
      await callTool(input, "tasks.attach_artifact", {
        task_id: current.id,
        kind: "document",
        title: "Informe de assessment v1",
        content: "# Informe\nHallazgos con fuente [doc:x].",
      });
      const after = (await getTask(fx.db, current.id))!;
      await callTool(input, "tasks.move", {
        task_id: current.id,
        to: "REVIEW",
        expected_version: after.version,
      });
      return { text: "Informe listo y en revisión." };
    });

    const report = await fx.api.ctx.dispatcher.tick();
    expect(report.dispatched).toHaveLength(1);
    const runId = report.dispatched[0]!;

    await waitFor(async () => (await getTask(fx.db, task.id))!.status === "REVIEW", {
      label: "tarea en REVIEW",
    });

    // Artefacto adjunto (regla anti-teatro cumplida).
    const artifacts = await listArtifacts(fx.db, task.id);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]!.runId).toBe(runId);

    // Timeline: claimed (READY→IN_PROGRESS) y moved (IN_PROGRESS→REVIEW), ambos con run_id.
    const events = await listTaskEvents(fx.db, task.id);
    const claimed = events.find((e) => e.kind === "claimed");
    expect(claimed?.fromStatus).toBe("READY");
    expect(claimed?.toStatus).toBe("IN_PROGRESS");
    expect(claimed?.runId).toBe(runId);
    const moved = events.find((e) => e.kind === "moved" && e.toStatus === "REVIEW");
    expect(moved?.fromStatus).toBe("IN_PROGRESS");
    expect(moved?.actor).toBe("agent:sam");
    expect(moved?.runId).toBe(runId);

    // El run terminó bien y quedó atribuido a la tarea.
    const run = await waitFor(async () => {
      const r = (await listRuns(fx.db, { taskId: task.id }))[0];
      return r && r.status === "succeeded" ? r : undefined;
    });
    expect(run.trigger).toBe("dispatcher");
    expect(run.agentId).toBe(fx.sam.id);
  });

  it("carrera: dos ticks seguidos no doblan el run de la misma tarea", async () => {
    const task = await makeReadyTask(fx, fx.sam, { title: "Tarea de carrera" });

    let resolveBehavior!: () => void;
    const gate = new Promise<void>((r) => (resolveBehavior = r));
    fx.aiRunner.setBehavior(async () => {
      await gate; // mantiene el run vivo mientras el segundo tick corre
      return { text: "hecho" };
    });

    const [r1, r2] = await Promise.all([fx.api.ctx.dispatcher.tick(), fx.api.ctx.dispatcher.tick()]);
    // Uno de los dos ticks despachó; el otro fue reentrante o no vio candidatas.
    const totalDispatched = r1.dispatched.length + r2.dispatched.length;
    expect(totalDispatched).toBe(1);

    const r3 = await fx.api.ctx.dispatcher.tick(); // la tarea ya está IN_PROGRESS
    expect(r3.dispatched).toHaveLength(0);

    resolveBehavior();
    await waitFor(async () => {
      const r = await listRuns(fx.db, { taskId: task.id });
      return r.length === 1 && r[0]!.status === "succeeded";
    });
    expect(await listRuns(fx.db, { taskId: task.id })).toHaveLength(1);

    // Limpieza: el run no movió la tarea → volvió a READY; se cancela (humano)
    // para que no contamine los ticks de los tests siguientes.
    const released = await waitFor(async () => {
      const t = (await getTask(fx.db, task.id))!;
      return t.status === "READY" ? t : undefined;
    });
    await fx.api.ctx.engine.moveTask({
      taskId: task.id,
      to: "CANCELLED",
      expectedVersion: released.version,
      actor: `person:${fx.person.id}`,
    });
  });

  it("run que termina sin mover la tarea → el despachador suelta el lease (READY)", async () => {
    const task = await makeReadyTask(fx, fx.sam, { title: "Run que no mueve nada" });
    fx.aiRunner.setBehavior(() => ({ text: "no hice nada con el tablero" }));

    const report = await fx.api.ctx.dispatcher.tick();
    expect(report.dispatched).toHaveLength(1);

    const recovered = await waitFor(async () => {
      const t = (await getTask(fx.db, task.id))!;
      return t.status === "READY" ? t : undefined;
    });
    expect(recovered.leaseUntil).toBeNull();
    const releaseEvent = (await listTaskEvents(fx.db, task.id)).find(
      (e) => e.kind === "moved" && e.actor === "system:dispatcher" && e.toStatus === "READY",
    );
    expect(releaseEvent).toBeTruthy();
  });

  // Fix H9: ask_human sin mover la tarjeta NO vuelve a READY (eso re-despachaba
  // y duplicaba pregunta y run) → la plataforma la fuerza a BLOCKED(approval);
  // al decidir la pregunta, la tarjeta vuelve a la cola con la respuesta en su timeline.
  it("ask_human sin mover la tarjeta → BLOCKED(approval), sin re-despacho; la respuesta la devuelve a READY", async () => {
    // Limpieza: cancelar tareas READY sobrantes de tests anteriores.
    for (const leftover of await listTasks(fx.db, { status: "READY" })) {
      await fx.api.ctx.engine.moveTask({
        taskId: leftover.id,
        to: "CANCELLED",
        expectedVersion: leftover.version,
        actor: `person:${fx.person.id}`,
      });
    }

    const task = await makeReadyTask(fx, fx.sam, { title: "Entrevista sin insumo en el Hub" });
    fx.aiRunner.setBehavior(async (input, ctx) => {
      await callTool(input, "ask_human", {
        kind: "question",
        title: "Falta el insumo de la entrevista",
        body: "No hay nota de entrevista en el Hub: ¿la cargas o reasigno?",
        task_id: ctx.taskId,
      });
      // El agente cierra el turno SIN mover la tarjeta (el bug de la demo).
      return { text: "Pregunté al humano y espero." };
    });

    const report = await fx.api.ctx.dispatcher.tick();
    expect(report.dispatched).toHaveLength(1);

    const blocked = await waitFor(async () => {
      const t = (await getTask(fx.db, task.id))!;
      return t.status === "BLOCKED" ? t : undefined;
    });
    expect(blocked.blockedReason).toBe("approval");

    // Un tick posterior NO re-despacha la tarjeta (antes: pregunta y run duplicados).
    const again = await fx.api.ctx.dispatcher.tick();
    expect(again.dispatched).toHaveLength(0);
    expect(await listRuns(fx.db, { taskId: task.id })).toHaveLength(1);
    const approvals = (await listPendingApprovals(fx.db)).filter((a) => a.taskId === task.id);
    expect(approvals).toHaveLength(1);

    // El humano responde → la tarjeta vuelve a READY con la respuesta en el timeline.
    const res = await fx.api.app.inject({
      method: "POST",
      url: `/api/approvals/${approvals[0]!.id}/decide`,
      headers: fx.authHeaders,
      payload: { decision: "approved", note: "Carga la nota tú: te adjunté el audio en el Hub" },
    });
    expect(res.statusCode).toBe(200);

    const ready = (await getTask(fx.db, task.id))!;
    expect(ready.status).toBe("READY");
    const answer = (await listTaskEvents(fx.db, task.id)).find(
      (e) => e.kind === "comment" && String((e.payload as { body?: string })?.body).includes("te adjunté el audio"),
    );
    expect(answer).toBeTruthy();

    // Limpieza: que no contamine otros tests.
    fx.aiRunner.setBehavior(undefined);
    await fx.api.ctx.engine.moveTask({
      taskId: task.id,
      to: "CANCELLED",
      expectedVersion: ready.version,
      actor: `person:${fx.person.id}`,
    });
  });

  // Fix H6: los entregables de consultoría (report, process_map, ...) también
  // disparan la auto-crítica de Quinn — con la lista del seed solo lo hacían
  // los tipos técnicos y US-10 quedaba muerto en el caso de uso principal.
  it("entregable 'report' en REVIEW dispara la auto-crítica de Quinn (trigger system)", async () => {
    const quinn = await createAgent(fx.db, {
      slug: "quinn",
      name: "Quinn",
      layer: "meta",
      runtime: "ai_sdk",
      providerProfileId: fx.provider.id,
      model: "mock-model",
      toolsAllowlist: ["tasks.get", "tasks.list", "board.get"],
    });
    fx.aiRunner.setBehavior(() => ({ text: "Crítica adversaria del informe." }));

    const task = await makeReadyTask(fx, fx.sam, {
      title: "Informe de assessment para crítica",
      activityType: "report",
    });
    const actor = `person:${fx.person.id}`;
    const inProgress = await fx.api.ctx.engine.moveTask({
      taskId: task.id,
      to: "IN_PROGRESS",
      expectedVersion: task.version,
      actor,
    });
    await attachArtifact(fx.db, {
      taskId: task.id,
      kind: "document",
      title: "Informe v1",
      content: "# Informe",
      createdBy: "agent:sam",
    });
    await fx.api.ctx.engine.moveTask({
      taskId: task.id,
      to: "REVIEW",
      expectedVersion: inProgress.version,
      actor,
    });

    const critique = await waitFor(
      async () =>
        (await listRuns(fx.db, { taskId: task.id, agentId: quinn.id })).find((r) => r.trigger === "system"),
      { label: "run de crítica de Quinn" },
    );
    expect(critique.agentId).toBe(quinn.id);
  });
});
