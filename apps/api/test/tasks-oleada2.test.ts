import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPerson,
  createTask,
  listTaskNotificationLogs,
  type Person,
} from "@agentos/db";
import { makeFixture, type TestFixture } from "./helpers.js";

describe("Oleada 2 — REST y avisos de tareas", () => {
  let fixtures: TestFixture[] = [];

  afterEach(async () => {
    for (const fixture of fixtures.splice(0)) await fixture.close();
  });

  function people(fixture: TestFixture): [Person, Person] {
    return [
      createPerson(fixture.db, {
        orgId: fixture.org.id,
        fullName: "Ana responsable",
        email: "ana@acme.test",
        isInternal: true,
        role: "Operadora",
      }),
      createPerson(fixture.db, {
        orgId: fixture.org.id,
        fullName: "Luis responsable",
        email: "luis@acme.test",
        isInternal: true,
        role: "Operador",
      }),
    ];
  }

  it("crea/lista/consulta dos responsables y conserva contexto del proyecto", async () => {
    const fixture = await makeFixture();
    fixtures.push(fixture);
    const [ana, luis] = people(fixture);
    const created = await fixture.api.app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: fixture.authHeaders,
      payload: {
        project_id: fixture.project.id,
        title: "Entrevista de responsables",
        stage: "ENTENDER",
        assignee_person_ids: [ana.id, luis.id],
        primary_assignee_person_id: luis.id,
        due_at: new Date(Date.now() + 86_400_000).toISOString(),
      },
    });
    expect(created.statusCode).toBe(201);
    const createdBody = created.json() as { task: { id: string; assigneePersonId: string; assignees: Array<{ personId: string }> } };
    expect(createdBody.task.assigneePersonId).toBe(luis.id);
    expect(createdBody.task.assignees.map((row) => row.personId).sort()).toEqual([ana.id, luis.id].sort());

    const listed = await fixture.api.app.inject({
      method: "GET",
      url: `/api/tasks?project_id=${fixture.project.id}&assignee_person_id=${ana.id}`,
      headers: fixture.authHeaders,
    });
    expect(listed.statusCode).toBe(200);
    expect((listed.json() as { tasks: unknown[] }).tasks).toHaveLength(1);

    const detail = await fixture.api.app.inject({
      method: "GET",
      url: `/api/tasks/${createdBody.task.id}`,
      headers: fixture.authHeaders,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      task: { id: createdBody.task.id, assignees: expect.any(Array) },
      project: { id: fixture.project.id },
      project_sources: expect.any(Array),
      knowledge_docs: expect.any(Array),
      artifacts: expect.any(Array),
      events: expect.any(Array),
      runs: expect.any(Array),
    });
  });

  it("asigna atómicamente, audita y rechaza expected_version viejo", async () => {
    const fixture = await makeFixture();
    fixtures.push(fixture);
    const [ana, luis] = people(fixture);
    const task = createTask(fixture.db, {
      projectId: fixture.project.id,
      title: "Reasignación",
      stage: "ENTENDER",
      orderKey: "oleada2-assign",
      assigneePersonIds: [ana.id],
      primaryAssigneePersonId: ana.id,
    });
    const assigned = await fixture.api.app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/assign`,
      headers: fixture.authHeaders,
      payload: {
        expected_version: task.version,
        assignee_person_ids: [luis.id],
        primary_assignee_person_id: luis.id,
      },
    });
    expect(assigned.statusCode).toBe(200);
    const assignedTask = (assigned.json() as { task: { version: number; assignees: Array<{ personId: string }> } }).task;
    expect(assignedTask.assignees.map((row) => row.personId)).toEqual([luis.id]);

    const conflict = await fixture.api.app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/assign`,
      headers: fixture.authHeaders,
      payload: {
        expected_version: task.version,
        assignee_person_ids: [ana.id],
        primary_assignee_person_id: ana.id,
      },
    });
    expect(conflict.statusCode).toBe(409);
    expect((conflict.json() as { error: { code: string } }).error.code).toBe("version_conflict");
  });

  it("fake delivery deduplica assignment y due_24h; terminal no recibe avisos", async () => {
    const send = vi.fn<(message: { to: string; subject: string; body: string }) => void>();
    const now = Date.now();
    const fixture = await makeFixture({
      notificationNow: () => now,
      notificationDelivery: { enabled: true, provider: "fake", send },
    });
    fixtures.push(fixture);
    const [ana] = people(fixture);
    const created = await fixture.api.app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: fixture.authHeaders,
      payload: {
        project_id: fixture.project.id,
        title: "Aviso con fake",
        stage: "ENTENDER",
        assignee_person_ids: [ana.id],
        primary_assignee_person_id: ana.id,
        due_at: now + 12 * 60 * 60 * 1000,
      },
    });
    expect(created.statusCode).toBe(201);
    const task = (created.json() as { task: { id: string } }).task;
    expect(send).toHaveBeenCalledTimes(1);

    const firstDue = await fixture.api.app.inject({
      method: "POST",
      url: "/api/notifications/process-due",
      headers: fixture.authHeaders,
      payload: {},
    });
    expect(firstDue.statusCode).toBe(200);
    expect(send).toHaveBeenCalledTimes(2);
    const secondDue = await fixture.api.app.inject({
      method: "POST",
      url: "/api/notifications/process-due",
      headers: fixture.authHeaders,
      payload: {},
    });
    expect(secondDue.statusCode).toBe(200);
    expect(send).toHaveBeenCalledTimes(2);
    expect(listTaskNotificationLogs(fixture.db, { taskId: task.id })).toHaveLength(2);

    const terminal = createTask(fixture.db, {
      projectId: fixture.project.id,
      title: "No avisar terminal",
      stage: "ENTENDER",
      status: "DONE",
      orderKey: "oleada2-done",
      dueAt: now + 12 * 60 * 60 * 1000,
      assigneePersonIds: [ana.id],
      primaryAssigneePersonId: ana.id,
    });
    await fixture.api.app.inject({
      method: "POST",
      url: "/api/notifications/process-due",
      headers: fixture.authHeaders,
      payload: {},
    });
    expect(listTaskNotificationLogs(fixture.db, { taskId: terminal.id })).toHaveLength(0);
  });

  it("sin proveedor no hace entrega y deja estado suppressed auditable", async () => {
    const send = vi.fn();
    const fixture = await makeFixture({ notificationDelivery: { enabled: false, provider: "off", send } });
    fixtures.push(fixture);
    const [ana] = people(fixture);
    const response = await fixture.api.app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: fixture.authHeaders,
      payload: {
        project_id: fixture.project.id,
        title: "Aviso apagado",
        stage: "ENTENDER",
        assignee_person_ids: [ana.id],
        primary_assignee_person_id: ana.id,
      },
    });
    expect(response.statusCode).toBe(201);
    expect(send).not.toHaveBeenCalled();
    const taskId = (response.json() as { task: { id: string } }).task.id;
    expect(listTaskNotificationLogs(fixture.db, { taskId })[0]?.status).toBe("suppressed");
  });

  it("no acepta una hora aportada por quien dispara el procesador", async () => {
    const fixture = await makeFixture();
    fixtures.push(fixture);
    const response = await fixture.api.app.inject({
      method: "POST",
      url: "/api/notifications/process-due",
      headers: fixture.authHeaders,
      payload: { now: Date.now() + 86_400_000 },
    });
    expect(response.statusCode).toBe(400);
  });

  it("reintenta un aviso due_24h fallido con la misma dedupe_key", async () => {
    const now = Date.now();
    const send = vi
      .fn<(message: { to: string; subject: string; body: string }) => Promise<void>>()
      .mockRejectedValueOnce(new Error("proveedor temporalmente caído"))
      .mockResolvedValueOnce(undefined);
    const fixture = await makeFixture({
      notificationNow: () => now,
      notificationDelivery: { enabled: true, provider: "fake", send },
    });
    fixtures.push(fixture);
    const [ana] = people(fixture);
    const task = createTask(fixture.db, {
      projectId: fixture.project.id,
      title: "Reintento de vencimiento",
      stage: "ENTENDER",
      orderKey: "oleada2-retry",
      dueAt: now + 12 * 60 * 60 * 1000,
      assigneePersonIds: [ana.id],
      primaryAssigneePersonId: ana.id,
    });

    await fixture.api.app.inject({
      method: "POST",
      url: "/api/notifications/process-due",
      headers: fixture.authHeaders,
      payload: {},
    });
    expect(listTaskNotificationLogs(fixture.db, { taskId: task.id })).toMatchObject([
      { status: "failed" },
    ]);

    await fixture.api.app.inject({
      method: "POST",
      url: "/api/notifications/process-due",
      headers: fixture.authHeaders,
      payload: {},
    });
    const logs = listTaskNotificationLogs(fixture.db, { taskId: task.id });
    expect(send).toHaveBeenCalledTimes(2);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ status: "delivered" });
  });
});
