/**
 * Papelera en el MCP admin: para los perfiles ro y rw una tarea desactivada no
 * existe — no sale en tasks.list, board.get ni system.health, tasks.get da
 * not_found y ninguna mutación la toca.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createTask, getTask, listTasks, softDeleteTask, type Task } from "@agentos/db";
import { adminFixture, type AdminFixture } from "./helpers.js";

let f: AdminFixture;
let hidden: Task;
let before: number;

beforeEach(async () => {
  f = await adminFixture();
  before = (await listTasks(f.db, { projectId: f.project.id })).length;
  hidden = await createTask(f.db, {
    projectId: f.project.id,
    title: "Oculta en la papelera",
    stage: "ENTENDER",
    orderKey: "zz-papelera",
  });
  hidden = (await softDeleteTask(f.db, hidden.id, { actor: `person:${f.person.id}`, expectedVersion: hidden.version }))
    .task;
});

describe("MCP admin — papelera", () => {
  for (const profile of ["ro", "rw"] as const) {
    it(`perfil ${profile}: tasks.list, board.get y health no ven la desactivada; tasks.get → not_found`, async () => {
      const call = profile === "ro" ? f.callRo : f.call;
      const list = (await call("agentos.tasks.list", { project_id: f.project.id })) as Task[];
      expect(list.map((t) => t.id)).not.toContain(hidden.id);
      expect(list).toHaveLength(before);

      const board = (await call("agentos.board.get", { project_id: f.project.id })) as { total: number };
      expect(board.total).toBe(before);

      const health = (await call("agentos.system.health")) as { tasks: number };
      expect(health.tasks).toBe((await listTasks(f.db)).length);

      await expect(call("agentos.tasks.get", { task_id: hidden.id })).rejects.toMatchObject({ code: "not_found" });
    });
  }

  it("perfil rw: mover una desactivada → not_found y no cambia nada", async () => {
    await expect(
      f.call("agentos.tasks.move", {
        task_id: hidden.id,
        to: "CANCELLED",
        expected_version: hidden.version,
        reason: "test",
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect((await getTask(f.db, hidden.id))!.status).toBe("BACKLOG");
  });
});
