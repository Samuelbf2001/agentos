/**
 * Ficha de tarea estilo Notion — cambio de proyecto y evento de actualización:
 * `POST /api/tasks/:id/project` (mueve la tarjeta entre tableros con todas sus
 * validaciones y publica `task.moved_project` en AMBOS topics) y el evento
 * `task.updated` que `PATCH /api/tasks/:id` debe publicar tras guardar.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  createOrganization,
  createPerson,
  createProject,
  createTask,
  getTask,
  replaceTaskAssignees,
  type PersistedEvent,
  type Project,
} from "@agentos/db";
import { domainPayload } from "../src/bus-bridge.js";
import { makeFixture, type TestFixture } from "./helpers.js";

describe("Tareas — cambio de proyecto (POST /api/tasks/:id/project) y task.updated", () => {
  const fixtures: TestFixture[] = [];

  afterEach(async () => {
    for (const fixture of fixtures.splice(0)) await fixture.close();
  });

  async function fx(): Promise<TestFixture> {
    const fixture = await makeFixture();
    fixtures.push(fixture);
    return fixture;
  }

  /** Segundo proyecto del MISMO cliente (ACME): destino válido para cualquier responsable. */
  async function siblingProject(fixture: TestFixture): Promise<Project> {
    return createProject(fixture.db, {
      orgId: fixture.org.id,
      name: "Implementación ACME",
      type: "transform",
      stage: "CONSTRUIR",
      gateState: "pending",
    });
  }

  async function eventsOf(fixture: TestFixture, topic: string, type: string): Promise<PersistedEvent[]> {
    const all = await fixture.api.ctx.bus.getSince(topic, 0);
    return all.filter((ev) => ev.type === type);
  }

  it("mueve la tarea a otro proyecto, recalcula orderKey, incrementa version y publica task.moved_project en ambos topics", async () => {
    const fixture = await fx();
    const target = await siblingProject(fixture);
    // Una tarjeta ya en la columna destino: la movida debe caer DESPUÉS de ella.
    await createTask(fixture.db, { projectId: target.id, title: "Ya estaba", stage: "CONSTRUIR", orderKey: "m" });
    const task = await createTask(fixture.db, {
      projectId: fixture.project.id,
      title: "Tarea que cambia de proyecto",
      stage: "ENTENDER",
      orderKey: "m",
    });

    const res = await fixture.api.app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/project`,
      headers: fixture.authHeaders,
      payload: { project_id: target.id, expected_version: task.version },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { task: { id: string; projectId: string; orderKey: string; version: number } };
    expect(body.task.projectId).toBe(target.id);
    expect(body.task.version).toBe(task.version + 1);
    expect(body.task.orderKey > "m").toBe(true);

    // La respuesta tiene la MISMA forma que GET /api/tasks/:id (assignees + labels).
    const detail = await fixture.api.app.inject({
      method: "GET",
      url: `/api/tasks/${task.id}`,
      headers: fixture.authHeaders,
    });
    expect(detail.statusCode).toBe(200);
    const shown = (detail.json() as { task: unknown }).task;
    expect(body.task).toEqual(shown);

    // Evento en el tablero viejo Y en el nuevo, con el payload exacto.
    const expectedPayload = { task: shown, from_project_id: fixture.project.id, to_project_id: target.id };
    const oldTopic = await eventsOf(fixture, `board:${fixture.project.id}`, "task.moved_project");
    const newTopic = await eventsOf(fixture, `board:${target.id}`, "task.moved_project");
    expect(oldTopic).toHaveLength(1);
    expect(newTopic).toHaveLength(1);
    expect(domainPayload(oldTopic[0]!)).toEqual(expectedPayload);
    expect(domainPayload(newTopic[0]!)).toEqual(expectedPayload);
    expect(Object.keys(domainPayload(newTopic[0]!)).sort()).toEqual(["from_project_id", "task", "to_project_id"]);
  });

  it("responsable externo de otro cliente en el destino → 400 validation que NOMBRA a la persona (no se limpia en silencio)", async () => {
    const fixture = await fx();
    const otherOrg = await createOrganization(fixture.db, { name: "Otra Org S.A.", kind: "client" });
    const otherProject = await createProject(fixture.db, {
      orgId: otherOrg.id,
      name: "Proyecto de Otra Org",
      type: "assessment",
      stage: "ENTENDER",
      gateState: "pending",
    });
    const externalPerson = await createPerson(fixture.db, {
      orgId: fixture.org.id,
      fullName: "Externo ACME",
      isInternal: false,
      role: "Cliente",
    });
    const created = await createTask(fixture.db, {
      projectId: fixture.project.id,
      title: "Tarea con responsable de ACME",
      stage: "ENTENDER",
      orderKey: "m",
    });
    const assigned = await replaceTaskAssignees(
      fixture.db,
      created.id,
      { personIds: [externalPerson.id], primaryPersonId: externalPerson.id, assignedBy: "test" },
      created.version,
    );

    const res = await fixture.api.app.inject({
      method: "POST",
      url: `/api/tasks/${created.id}/project`,
      headers: fixture.authHeaders,
      payload: { project_id: otherProject.id, expected_version: assigned.version },
    });
    expect(res.statusCode).toBe(400);
    const err = res.json() as { error: { code: string; message: string; details?: { personId?: string } } };
    expect(err.error.code).toBe("validation_error");
    expect(err.error.message).toContain("Externo ACME");
    expect(err.error.details?.personId).toBe(externalPerson.id);

    // Nada cambió: sigue en el proyecto original, con su responsable y su versión.
    const after = (await getTask(fixture.db, created.id))!;
    expect(after.projectId).toBe(fixture.project.id);
    expect(after.version).toBe(assigned.version);
    expect(after.assigneePersonId).toBe(externalPerson.id);
    expect(await eventsOf(fixture, `board:${otherProject.id}`, "task.moved_project")).toHaveLength(0);
  });

  it("parentTaskId que se queda en el proyecto viejo → 400 validation", async () => {
    const fixture = await fx();
    const target = await siblingProject(fixture);
    const parent = await createTask(fixture.db, {
      projectId: fixture.project.id,
      title: "Padre en el proyecto viejo",
      stage: "ENTENDER",
      orderKey: "m",
    });
    const child = await createTask(fixture.db, {
      projectId: fixture.project.id,
      title: "Hija",
      stage: "ENTENDER",
      orderKey: "n",
      parentTaskId: parent.id,
    });

    const res = await fixture.api.app.inject({
      method: "POST",
      url: `/api/tasks/${child.id}/project`,
      headers: fixture.authHeaders,
      payload: { project_id: target.id, expected_version: child.version },
    });
    expect(res.statusCode).toBe(400);
    const err = res.json() as { error: { code: string; message: string; details?: { parentTaskId?: string } } };
    expect(err.error.code).toBe("validation_error");
    expect(err.error.message).toContain("Padre en el proyecto viejo");
    expect(err.error.details?.parentTaskId).toBe(parent.id);
    expect((await getTask(fixture.db, child.id))!.projectId).toBe(fixture.project.id);
  });

  it("dependsOn que apunta al proyecto viejo → 400 validation", async () => {
    const fixture = await fx();
    const target = await siblingProject(fixture);
    const dependency = await createTask(fixture.db, {
      projectId: fixture.project.id,
      title: "Dependencia previa",
      stage: "ENTENDER",
      orderKey: "m",
    });
    const dependent = await createTask(fixture.db, {
      projectId: fixture.project.id,
      title: "Depende de otra",
      stage: "ENTENDER",
      orderKey: "n",
      dependsOn: [dependency.id],
    });

    const res = await fixture.api.app.inject({
      method: "POST",
      url: `/api/tasks/${dependent.id}/project`,
      headers: fixture.authHeaders,
      payload: { project_id: target.id, expected_version: dependent.version },
    });
    expect(res.statusCode).toBe(400);
    const err = res.json() as { error: { code: string; message: string } };
    expect(err.error.code).toBe("validation_error");
    expect(err.error.message).toContain("Dependencia previa");
  });

  it("expected_version viejo → 409 version_conflict sin mover nada", async () => {
    const fixture = await fx();
    const target = await siblingProject(fixture);
    const task = await createTask(fixture.db, {
      projectId: fixture.project.id,
      title: "Versión desactualizada",
      stage: "ENTENDER",
      orderKey: "m",
    });

    const res = await fixture.api.app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/project`,
      headers: fixture.authHeaders,
      payload: { project_id: target.id, expected_version: task.version + 5 },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe("version_conflict");
    expect((await getTask(fixture.db, task.id))!.projectId).toBe(fixture.project.id);
  });

  it("proyecto destino inexistente → 404", async () => {
    const fixture = await fx();
    const task = await createTask(fixture.db, {
      projectId: fixture.project.id,
      title: "Destino fantasma",
      stage: "ENTENDER",
      orderKey: "m",
    });

    const res = await fixture.api.app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/project`,
      headers: fixture.authHeaders,
      payload: { project_id: "no-existe", expected_version: task.version },
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: { code: string } }).error.code).toBe("not_found");
  });

  it("PATCH /api/tasks/:id publica task.updated en board:<projectId> con { task } tras guardar", async () => {
    const fixture = await fx();
    const task = await createTask(fixture.db, {
      projectId: fixture.project.id,
      title: "Título original",
      stage: "ENTENDER",
      orderKey: "m",
    });

    const res = await fixture.api.app.inject({
      method: "PATCH",
      url: `/api/tasks/${task.id}`,
      headers: fixture.authHeaders,
      payload: { expected_version: task.version, title: "Título editado", priority: "high" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { task: { id: string; title: string; version: number } };

    const events = await eventsOf(fixture, `board:${fixture.project.id}`, "task.updated");
    expect(events).toHaveLength(1);
    const payload = domainPayload(events[0]!);
    expect(Object.keys(payload)).toEqual(["task"]);
    expect(payload.task).toEqual(body.task);
    expect((payload.task as { title: string; version: number }).title).toBe("Título editado");
    expect((payload.task as { version: number }).version).toBe(task.version + 1);
  });
});
