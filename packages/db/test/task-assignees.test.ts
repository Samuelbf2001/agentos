import { describe, expect, it } from "vitest";
import { isAgentosError } from "@agentos/shared";
import { openDb, type AgentosDb } from "../src/client.js";
import { runMigrations } from "../src/migrate.js";
import { createOrganization, createPerson } from "../src/repositories/organizations-people.js";
import { createProject } from "../src/repositories/projects.js";
import {
  backfillTaskAssignees,
  getTaskWithAssignees,
  listTaskAssignees,
  listTasksWithAssignees,
  replaceTaskAssignees,
} from "../src/repositories/task-assignees.js";
import { createTask, listTasks, updateTask } from "../src/repositories/tasks.js";
import {
  claimTaskNotificationLog,
  createTaskNotificationLog,
  getTaskNotificationLog,
  listDueTaskNotificationLogs,
  listTaskNotificationLogs,
  markTaskNotificationDelivered,
  markTaskNotificationFailed,
} from "../src/repositories/task-notifications.js";

function freshDb(): AgentosDb {
  const db = openDb(":memory:");
  runMigrations(db);
  return db;
}

function fixture(db: AgentosDb) {
  const org = createOrganization(db, { name: "Org asignaciones", kind: "client" });
  const otherOrg = createOrganization(db, { name: "Org ajena", kind: "client" });
  const project = createProject(db, {
    orgId: org.id,
    name: "Proyecto asignaciones",
    type: "assessment",
    stage: "ENTENDER",
  });
  const ana = createPerson(db, { orgId: org.id, fullName: "Ana", email: "ana@example.test" });
  const luis = createPerson(db, { orgId: org.id, fullName: "Luis", email: "luis@example.test" });
  const outsider = createPerson(db, {
    orgId: otherOrg.id,
    fullName: "Persona ajena",
    email: "ajena@example.test",
  });
  return { org, otherOrg, project, ana, luis, outsider };
}

describe("task_assignees", () => {
  it("hace backfill de la proyección legacy y es idempotente", () => {
    const db = freshDb();
    const { project, ana } = fixture(db);
    const task = createTask(db, {
      projectId: project.id,
      title: "Legacy",
      stage: "ENTENDER",
      orderKey: "a0",
    });
    // Simula una fila creada por una instalación anterior a la tabla puente.
    db.$client.prepare("UPDATE tasks SET assignee_person_id = ? WHERE id = ?").run(ana.id, task.id);

    expect(backfillTaskAssignees(db)).toBe(1);
    expect(backfillTaskAssignees(db)).toBe(0);
    expect(listTaskAssignees(db, task.id)).toMatchObject([
      { taskId: task.id, personId: ana.id, isPrimary: true },
    ]);
    expect(getTaskWithAssignees(db, task.id)?.assigneePersonId).toBe(ana.id);
  });

  it("permite múltiples responsables, primaria y filtro por persona", () => {
    const db = freshDb();
    const { project, ana, luis } = fixture(db);
    const task = createTask(db, {
      projectId: project.id,
      title: "Multi",
      stage: "ENTENDER",
      orderKey: "a0",
      assigneePersonIds: [ana.id, luis.id],
      primaryAssigneePersonId: luis.id,
      assignedBy: "person:owner",
    });

    const withPeople = getTaskWithAssignees(db, task.id)!;
    expect(withPeople.assignees.map((row) => row.personId).sort()).toEqual([ana.id, luis.id].sort());
    expect(withPeople.assignees.find((row) => row.isPrimary)?.personId).toBe(luis.id);
    expect(task.assigneePersonId).toBe(luis.id);
    expect(listTasks(db, { personId: ana.id }).map((row) => row.id)).toEqual([task.id]);
    expect(listTasksWithAssignees(db, { personId: ana.id })[0]?.assignees).toHaveLength(2);
  });

  it("un solo responsable sin primario explícito queda como principal (defecto de usabilidad)", () => {
    const db = freshDb();
    const { project, ana } = fixture(db);
    const task = createTask(db, {
      projectId: project.id,
      title: "Un responsable",
      stage: "ENTENDER",
      orderKey: "a0",
      assigneePersonIds: [ana.id],
    });
    expect(listTaskAssignees(db, task.id)).toMatchObject([{ personId: ana.id, isPrimary: true }]);
    expect(getTaskWithAssignees(db, task.id)?.assigneePersonId).toBe(ana.id);

    // También al reemplazar (no sólo al crear): el mismo defecto se reprodujo
    // vía PATCH de responsables sobre una tarea ya existente.
    const another = createTask(db, {
      projectId: project.id,
      title: "Reemplazo sin primario",
      stage: "ENTENDER",
      orderKey: "a1",
    });
    const replaced = replaceTaskAssignees(db, another.id, { personIds: [ana.id] }, another.version);
    expect(replaced.assignees).toMatchObject([{ personId: ana.id, isPrimary: true }]);
    expect(replaced.assigneePersonId).toBe(ana.id);
  });

  it("varios responsables sin primario explícito: el primero de la lista es el principal", () => {
    const db = freshDb();
    const { project, ana, luis } = fixture(db);
    const task = createTask(db, {
      projectId: project.id,
      title: "Varios sin primario",
      stage: "ENTENDER",
      orderKey: "a0",
      assigneePersonIds: [luis.id, ana.id],
    });
    expect(getTaskWithAssignees(db, task.id)?.assignees.find((row) => row.isPrimary)?.personId).toBe(luis.id);
    expect(task.assigneePersonId).toBe(luis.id);
  });

  it("respeta el primario explícito aunque no sea el primero de la lista", () => {
    const db = freshDb();
    const { project, ana, luis } = fixture(db);
    const task = createTask(db, {
      projectId: project.id,
      title: "Explícito",
      stage: "ENTENDER",
      orderKey: "a0",
      assigneePersonIds: [luis.id, ana.id],
      primaryAssigneePersonId: ana.id,
    });
    expect(getTaskWithAssignees(db, task.id)?.assignees.find((row) => row.isPrimary)?.personId).toBe(ana.id);
    expect(task.assigneePersonId).toBe(ana.id);
  });

  it("quitar todos los responsables limpia la proyección legacy", () => {
    const db = freshDb();
    const { project, ana } = fixture(db);
    const task = createTask(db, {
      projectId: project.id,
      title: "Vaciar",
      stage: "ENTENDER",
      orderKey: "a0",
      assigneePersonIds: [ana.id],
    });
    expect(task.assigneePersonId).toBe(ana.id);
    const cleared = replaceTaskAssignees(db, task.id, { personIds: [] }, task.version);
    expect(cleared.assignees).toHaveLength(0);
    expect(cleared.assigneePersonId).toBeNull();
  });

  it("rechaza persona de otra organización sin crear tarea", () => {
    const db = freshDb();
    const { project, outsider } = fixture(db);
    expect(() =>
      createTask(db, {
        projectId: project.id,
        title: "No debe crear",
        stage: "ENTENDER",
        orderKey: "a0",
        assigneePersonIds: [outsider.id],
      }),
    ).toThrow();
    expect(listTasks(db, { projectId: project.id })).toHaveLength(0);
  });

  it("replace usa optimistic locking: conflicto no muta responsables ni proyección", () => {
    const db = freshDb();
    const { project, ana, luis } = fixture(db);
    const task = createTask(db, {
      projectId: project.id,
      title: "Conflicto",
      stage: "ENTENDER",
      orderKey: "a0",
      assigneePersonIds: [ana.id],
      primaryAssigneePersonId: ana.id,
    });
    const before = listTaskAssignees(db, task.id);
    const current = updateTask(db, task.id, { dueAt: Date.now() + 86_400_000 }, task.version);
    try {
      replaceTaskAssignees(
        db,
        task.id,
        { personIds: [luis.id], primaryPersonId: luis.id },
        task.version,
      );
      expect.unreachable("debió fallar por versión vieja");
    } catch (err) {
      expect(isAgentosError(err, "version_conflict")).toBe(true);
    }
    expect(listTaskAssignees(db, task.id)).toEqual(before);
    expect(getTaskWithAssignees(db, task.id)?.assigneePersonId).toBe(ana.id);
    expect(getTaskWithAssignees(db, task.id)?.version).toBe(current.version);
  });
});

describe("task_notification_log", () => {
  it("crea de forma idempotente, reclama una vez y marca entrega/fallo", () => {
    const db = freshDb();
    const { project, ana } = fixture(db);
    const task = createTask(db, { projectId: project.id, title: "Avisos", stage: "ENTENDER", orderKey: "a0" });
    const scheduledAt = Date.now() - 1;
    const first = createTaskNotificationLog(db, {
      taskId: task.id,
      personId: ana.id,
      kind: "assignment",
      scheduledAt,
      dedupeKey: "assignment:task:person:change-1",
    });
    const retry = createTaskNotificationLog(db, {
      taskId: task.id,
      personId: ana.id,
      kind: "assignment",
      scheduledAt,
      dedupeKey: "assignment:task:person:change-1",
    });
    expect(first.inserted).toBe(true);
    expect(retry.inserted).toBe(false);
    expect(retry.notification.id).toBe(first.notification.id);
    expect(listTaskNotificationLogs(db, { taskId: task.id })).toHaveLength(1);

    expect(claimTaskNotificationLog(db, first.notification.id, Date.now())).toBe(true);
    expect(claimTaskNotificationLog(db, first.notification.id, Date.now())).toBe(false);
    expect(markTaskNotificationFailed(db, first.notification.id, "SMTP temporal").status).toBe("failed");
    expect(claimTaskNotificationLog(db, first.notification.id, Date.now())).toBe(true);
    expect(markTaskNotificationDelivered(db, first.notification.id).status).toBe("delivered");
    expect(getTaskNotificationLog(db, first.notification.id)?.deliveredAt).toBeTruthy();
  });

  it("deduplica due_24h por tarea/persona y excluye DONE de candidatos", () => {
    const db = freshDb();
    const { project, ana } = fixture(db);
    const task = createTask(db, { projectId: project.id, title: "Due", stage: "ENTENDER", orderKey: "a0" });
    const first = createTaskNotificationLog(db, {
      taskId: task.id,
      personId: ana.id,
      kind: "due_24h",
      scheduledAt: Date.now() - 1,
    });
    const second = createTaskNotificationLog(db, {
      taskId: task.id,
      personId: ana.id,
      kind: "due_24h",
      scheduledAt: Date.now() + 1,
    });
    expect(second.inserted).toBe(false);
    expect(second.notification.id).toBe(first.notification.id);
    expect(listDueTaskNotificationLogs(db, Date.now())).toHaveLength(1);

    updateTask(db, task.id, { status: "DONE" }, task.version);
    expect(listDueTaskNotificationLogs(db, Date.now())).toHaveLength(0);
  });
});
