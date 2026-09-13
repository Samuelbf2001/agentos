/**
 * Papelera en el motor del tablero: una tarea desactivada no se mueve ni recibe
 * delegaciones, el claim nunca la toma, y como dependencia NO bloquea. La
 * máquina de estados no cambia: la papelera son columnas, no un estado.
 */
import { describe, expect, it } from "vitest";
import { isAgentosError } from "@agentos/shared";
import { getTask, softDeleteTask, updateTask } from "@agentos/db";
import { dependencyState } from "../src/index.js";
import { fixture, seedTask } from "./helpers.js";

describe("papelera — motor del tablero", () => {
  it("moveTask sobre una tarea desactivada → conflict task_deleted (sin tocar el estado)", async () => {
    const f = await fixture();
    const task = await seedTask(f);
    const { task: deleted } = await softDeleteTask(f.db, task.id, {
      actor: `person:${f.person.id}`,
      expectedVersion: task.version,
    });
    let err: unknown;
    try {
      await f.engine.moveTask({
        taskId: task.id,
        to: "CANCELLED",
        expectedVersion: deleted.version,
        actor: `person:${f.person.id}`,
      });
    } catch (e) {
      err = e;
    }
    expect(isAgentosError(err, "conflict"), String(err)).toBe(true);
    expect((err as { details: { reason: string } }).details.reason).toBe("task_deleted");
    expect((await getTask(f.db, task.id))!.status).toBe("BACKLOG");
  });

  it("claim nunca toma una tarea desactivada", async () => {
    const f = await fixture();
    const task = await seedTask(f, { status: "READY" });
    await softDeleteTask(f.db, task.id, { actor: `person:${f.person.id}`, expectedVersion: task.version });
    const result = await f.engine.claim({ taskId: task.id, agentId: f.sam.id });
    expect(result.claimed).toBe(false);
  });

  it("una dependencia en la papelera no bloquea; una inexistente sigue bloqueando (fail-closed)", async () => {
    const f = await fixture();
    const dep = await seedTask(f);
    const dependent = await seedTask(f);
    await updateTask(f.db, dependent.id, { dependsOn: [dep.id, "no-existe"] }, dependent.version);
    await softDeleteTask(f.db, dep.id, { actor: `person:${f.person.id}`, expectedVersion: dep.version });
    const state = await dependencyState(f.db, dependent.id);
    expect(state.unsatisfied).toEqual(["no-existe"]);
  });

  it("no se delega bajo una tarea madre desactivada", async () => {
    const f = await fixture();
    const parent = await seedTask(f, { status: "IN_PROGRESS" });
    // Sin lease vigente: se puede desactivar aunque el estado sea IN_PROGRESS.
    await softDeleteTask(f.db, parent.id, { actor: `person:${f.person.id}`, expectedVersion: parent.version });
    let err: unknown;
    try {
      await f.engine.delegate({
        parentTaskId: parent.id,
        assignee: "sam",
        title: "Sub",
        payload: { tarea: "x", limites: "y", forma_de_buena_respuesta: "z" },
        actor: "agent:alex",
        runId: f.run.id,
      } as unknown as Parameters<typeof f.engine.delegate>[0]);
    } catch (e) {
      err = e;
    }
    expect(isAgentosError(err, "conflict"), String(err)).toBe(true);
  });
});
