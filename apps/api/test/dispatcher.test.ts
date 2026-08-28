/**
 * Despachador determinista: tarea READY → claim atómico → run del runner fake
 * que mueve a REVIEW con artefacto VÍA EL GATEWAY de tools → task_events
 * correcto. Carrera: dos ticks no doblan el run. Run que muere sin mover la
 * tarea → suelta el lease (READY).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTask, listArtifacts, listRuns, listTaskEvents } from "@agentos/db";
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
    const task = makeReadyTask(fx, fx.sam, { title: "Informe de assessment" });

    fx.aiRunner.setBehavior(async (input, ctx) => {
      const current = getTask(fx.db, ctx.taskId!)!;
      await callTool(input, "tasks.attach_artifact", {
        task_id: current.id,
        kind: "document",
        title: "Informe de assessment v1",
        content: "# Informe\nHallazgos con fuente [doc:x].",
      });
      const after = getTask(fx.db, current.id)!;
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

    await waitFor(() => getTask(fx.db, task.id)!.status === "REVIEW", { label: "tarea en REVIEW" });

    // Artefacto adjunto (regla anti-teatro cumplida).
    const artifacts = listArtifacts(fx.db, task.id);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]!.runId).toBe(runId);

    // Timeline: claimed (READY→IN_PROGRESS) y moved (IN_PROGRESS→REVIEW), ambos con run_id.
    const events = listTaskEvents(fx.db, task.id);
    const claimed = events.find((e) => e.kind === "claimed");
    expect(claimed?.fromStatus).toBe("READY");
    expect(claimed?.toStatus).toBe("IN_PROGRESS");
    expect(claimed?.runId).toBe(runId);
    const moved = events.find((e) => e.kind === "moved" && e.toStatus === "REVIEW");
    expect(moved?.fromStatus).toBe("IN_PROGRESS");
    expect(moved?.actor).toBe("agent:sam");
    expect(moved?.runId).toBe(runId);

    // El run terminó bien y quedó atribuido a la tarea.
    const run = await waitFor(() => {
      const r = listRuns(fx.db, { taskId: task.id })[0];
      return r && r.status === "succeeded" ? r : undefined;
    });
    expect(run.trigger).toBe("dispatcher");
    expect(run.agentId).toBe(fx.sam.id);
  });

  it("carrera: dos ticks seguidos no doblan el run de la misma tarea", async () => {
    const task = makeReadyTask(fx, fx.sam, { title: "Tarea de carrera" });

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
    await waitFor(() => {
      const r = listRuns(fx.db, { taskId: task.id });
      return r.length === 1 && r[0]!.status === "succeeded";
    });
    expect(listRuns(fx.db, { taskId: task.id })).toHaveLength(1);

    // Limpieza: el run no movió la tarea → volvió a READY; se cancela (humano)
    // para que no contamine los ticks de los tests siguientes.
    const released = await waitFor(() => {
      const t = getTask(fx.db, task.id)!;
      return t.status === "READY" ? t : undefined;
    });
    fx.api.ctx.engine.moveTask({
      taskId: task.id,
      to: "CANCELLED",
      expectedVersion: released.version,
      actor: `person:${fx.person.id}`,
    });
  });

  it("run que termina sin mover la tarea → el despachador suelta el lease (READY)", async () => {
    const task = makeReadyTask(fx, fx.sam, { title: "Run que no mueve nada" });
    fx.aiRunner.setBehavior(() => ({ text: "no hice nada con el tablero" }));

    const report = await fx.api.ctx.dispatcher.tick();
    expect(report.dispatched).toHaveLength(1);

    const recovered = await waitFor(() => {
      const t = getTask(fx.db, task.id)!;
      return t.status === "READY" ? t : undefined;
    });
    expect(recovered.leaseUntil).toBeNull();
    const releaseEvent = listTaskEvents(fx.db, task.id).find(
      (e) => e.kind === "moved" && e.actor === "system:dispatcher" && e.toStatus === "READY",
    );
    expect(releaseEvent).toBeTruthy();
  });
});
