import { describe, expect, it } from "vitest";
import { createPerson, getTask, listTaskAssignees, listTaskEvents, queryAudit } from "@agentos/db";
import { toolsFixture } from "./helpers.js";

describe("Oleada 2 — tools tasks.*", () => {
  it("tasks.create/list/get exponen responsables, due_at y contexto", async () => {
    const fixture = await toolsFixture();
    const other = await createPerson(fixture.db, {
      orgId: fixture.person.orgId,
      fullName: "Luis MCP",
      email: "luis-mcp@example.test",
      isInternal: true,
    });
    const created = await fixture.runtime.execute(fixture.ctxFor(fixture.alex), "tasks.create", {
      project_id: fixture.project.id,
      title: "Tarea MCP multi-responsable",
      stage: "ENTENDER",
      assignee_person_ids: [fixture.person.id, other.id],
      primary_assignee_person_id: other.id,
      due_at: Date.now() + 86_400_000,
    });
    expect(created.status).toBe("ok");
    if (created.status !== "ok") throw new Error("unreachable");
    const task = created.result as { id: string; assigneePersonId: string; assignees: Array<{ personId: string }> };
    expect(task.assigneePersonId).toBe(other.id);
    expect(task.assignees.map((row) => row.personId).sort()).toEqual([fixture.person.id, other.id].sort());

    const listed = await fixture.runtime.execute(fixture.ctxFor(fixture.alex), "tasks.list", {
      project_id: fixture.project.id,
      assignee_person_id: fixture.person.id,
    });
    expect(listed.status).toBe("ok");
    if (listed.status !== "ok") throw new Error("unreachable");
    expect((listed.result as unknown[]).some((row) => (row as { id: string }).id === task.id)).toBe(true);

    const detail = await fixture.runtime.execute(fixture.ctxFor(fixture.alex), "tasks.get", { task_id: task.id });
    expect(detail.status).toBe("ok");
    if (detail.status !== "ok") throw new Error("unreachable");
    expect(detail.result).toMatchObject({
      task: { id: task.id, assignees: expect.any(Array) },
      project_sources: expect.any(Array),
      knowledge_docs: expect.any(Array),
    });
  });

  it("tasks.assign_people usa expected_version y no permite persona ajena", async () => {
    const fixture = await toolsFixture();
    const other = await createPerson(fixture.db, {
      orgId: fixture.person.orgId,
      fullName: "Luis MCP",
      email: "luis-mcp@example.test",
      isInternal: true,
    });
    const taskResult = await fixture.runtime.execute(fixture.ctxFor(fixture.alex), "tasks.create", {
      project_id: fixture.project.id,
      title: "Tarea reasignable",
      stage: "ENTENDER",
      assignee_person_ids: [fixture.person.id],
      primary_assignee_person_id: fixture.person.id,
    });
    if (taskResult.status !== "ok") throw new Error("unreachable");
    const task = (await getTask(fixture.db, (taskResult.result as { id: string }).id))!;
    const assigned = await fixture.runtime.execute(fixture.humanCtx(), "tasks.assign_people", {
      task_id: task.id,
      assignee_person_ids: [other.id],
      primary_assignee_person_id: other.id,
      expected_version: task.version,
    });
    expect(assigned.status).toBe("ok");
    expect((await listTaskAssignees(fixture.db, task.id)).map((row) => row.personId)).toEqual([other.id]);

    await expect(
      fixture.runtime.execute(fixture.humanCtx(), "tasks.assign_people", {
        task_id: task.id,
        assignee_person_ids: [fixture.person.id],
        primary_assignee_person_id: fixture.person.id,
        expected_version: task.version,
      }),
    ).rejects.toMatchObject({ code: "version_conflict" });
    await expect(
      fixture.runtime.execute(fixture.humanCtx(), "tasks.assign_people", {
        task_id: task.id,
        assignee_person_ids: ["persona-inexistente"],
        primary_assignee_person_id: "persona-inexistente",
        expected_version: (await getTask(fixture.db, task.id))!.version,
      }),
    ).rejects.toThrow();
  });

  it("tasks.set_due_date conserva estado, deja evento/auditoría y respeta versión", async () => {
    const fixture = await toolsFixture();
    const created = await fixture.runtime.execute(fixture.ctxFor(fixture.alex), "tasks.create", {
      project_id: fixture.project.id,
      title: "Tarea con vencimiento MCP",
      stage: "ENTENDER",
    });
    if (created.status !== "ok") throw new Error("unreachable");
    const before = (await getTask(fixture.db, (created.result as { id: string }).id))!;
    const dueAt = Date.now() + 86_400_000;

    const set = await fixture.runtime.execute(fixture.ctxFor(fixture.alex), "tasks.set_due_date", {
      task_id: before.id,
      due_at: dueAt,
      expected_version: before.version,
    });
    expect(set).toMatchObject({ status: "ok", result: { id: before.id, dueAt, status: before.status } });
    expect(await listTaskEvents(fixture.db, before.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "due_date_changed", payload: { beforeDueAt: null, afterDueAt: dueAt } }),
    ]));
    expect(await queryAudit(fixture.db, { action: "task.set_due_date", entityId: before.id })).toHaveLength(1);

    await expect(
      fixture.runtime.execute(fixture.ctxFor(fixture.alex), "tasks.set_due_date", {
        task_id: before.id,
        due_at: null,
        expected_version: before.version,
      }),
    ).rejects.toMatchObject({ code: "version_conflict" });

    const current = (await getTask(fixture.db, before.id))!;
    const cleared = await fixture.runtime.execute(fixture.ctxFor(fixture.alex), "tasks.set_due_date", {
      task_id: before.id,
      due_at: null,
      expected_version: current.version,
    });
    expect(cleared).toMatchObject({ status: "ok", result: { dueAt: null, status: before.status } });
  });
});
