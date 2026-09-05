import { and, asc, eq, exists, sql } from "drizzle-orm";
import { errors, nowMs, type TaskStatus } from "@agentos/shared";
import type { AgentosPgDb } from "../client-pg.js";
import { people, projects, taskAssignees, tasks } from "../schema-pg.js";
import type {
  NewTaskAssignee,
  Task,
  TaskAssignee,
  TaskAssigneeSelectionInput,
  TaskCreateInput,
} from "../types-pg.js";

export type TaskWithAssignees = Task & { assignees: TaskAssignee[] };

export interface ReplaceTaskAssigneesInput extends TaskAssigneeSelectionInput {
  personIds?: readonly string[];
  primaryPersonId?: string | null;
  actor?: string;
}

export interface TaskAssigneeObjectInput {
  personId: string;
  isPrimary?: boolean;
}

export interface ReplaceTaskAssigneesObjectInput {
  assignees: readonly (string | TaskAssigneeObjectInput)[];
  primaryPersonId?: string | null;
  primaryAssigneePersonId?: string | null;
  assignedBy?: string;
  actor?: string;
}

interface NormalizedAssignees {
  personIds: string[];
  primaryPersonId: string | null;
  assignedBy: string;
}

export async function listTaskAssignees(db: AgentosPgDb, taskId: string): Promise<TaskAssignee[]> {
  return await db
    .select()
    .from(taskAssignees)
    .where(eq(taskAssignees.taskId, taskId))
    .orderBy(asc(taskAssignees.createdAt), asc(taskAssignees.personId));
}

export async function getPrimaryTaskAssignee(
  db: AgentosPgDb,
  taskId: string,
): Promise<TaskAssignee | undefined> {
  const [row] = await db
    .select()
    .from(taskAssignees)
    .where(and(eq(taskAssignees.taskId, taskId), eq(taskAssignees.isPrimary, true)))
    .limit(1);
  return row;
}

export async function getTaskWithAssignees(
  db: AgentosPgDb,
  taskId: string,
): Promise<TaskWithAssignees | undefined> {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
  return task ? { ...task, assignees: await listTaskAssignees(db, taskId) } : undefined;
}

export async function listTasksWithAssignees(
  db: AgentosPgDb,
  filter: {
    projectId?: string;
    status?: TaskStatus;
    assigneeAgentId?: string;
    personId?: string;
    assigneePersonId?: string;
  } = {},
): Promise<TaskWithAssignees[]> {
  const conds = [];
  if (filter.projectId) conds.push(eq(tasks.projectId, filter.projectId));
  if (filter.status) conds.push(eq(tasks.status, filter.status));
  if (filter.assigneeAgentId) conds.push(eq(tasks.assigneeAgentId, filter.assigneeAgentId));
  const personId = filter.personId ?? filter.assigneePersonId;
  if (personId) {
    conds.push(
      exists(
        db
          .select({ taskId: taskAssignees.taskId })
          .from(taskAssignees)
          .where(and(eq(taskAssignees.taskId, tasks.id), eq(taskAssignees.personId, personId))),
      ),
    );
  }
  const base = db.select().from(tasks);
  const rows = await (conds.length > 0 ? base.where(and(...conds)) : base)
    .orderBy(asc(tasks.status), asc(tasks.orderKey));
  return await Promise.all(
    rows.map(async (task) => ({ ...task, assignees: await listTaskAssignees(db, task.id) })),
  );
}

export async function boardTasksWithAssignees(
  db: AgentosPgDb,
  projectId: string,
): Promise<TaskWithAssignees[]> {
  return await listTasksWithAssignees(db, { projectId });
}

export async function validateTaskAssigneeOrganization(
  db: AgentosPgDb,
  projectId: string,
  personIds: readonly string[],
): Promise<void> {
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!project) throw errors.notFound("project", projectId);
  for (const personId of personIds) {
    const [person] = await db.select().from(people).where(eq(people.id, personId)).limit(1);
    if (!person) throw errors.notFound("person", personId);
    if (person.orgId !== project.orgId) {
      throw errors.validation(
        `La persona ${personId} no pertenece a la organización del proyecto ${projectId}`,
        { projectId, projectOrgId: project.orgId, personId, personOrgId: person.orgId },
      );
    }
  }
}

function normalizeAssignees(
  input: ReplaceTaskAssigneesInput | ReplaceTaskAssigneesObjectInput,
): NormalizedAssignees {
  const raw = "assignees" in input
    ? input.assignees
    : input.personIds ?? input.assigneePersonIds ?? [];
  const personIds = raw.map((item) => (typeof item === "string" ? item : item.personId));
  const unique = new Set(personIds);
  if (unique.size !== personIds.length) {
    throw errors.validation("Una tarea no puede tener el mismo responsable dos veces", { personIds });
  }
  const flagged = "assignees" in input
    ? input.assignees.filter((item): item is TaskAssigneeObjectInput => typeof item !== "string" && item.isPrimary === true)
    : [];
  if (flagged.length > 1) {
    throw errors.validation("Una tarea solo puede tener una persona principal", {
      personIds: flagged.map((item) => item.personId),
    });
  }
  const explicitPrimary =
    ("primaryPersonId" in input ? input.primaryPersonId : undefined) ??
    input.primaryAssigneePersonId ??
    (flagged[0]?.personId ?? null);
  if (explicitPrimary !== null && explicitPrimary !== undefined && !unique.has(explicitPrimary)) {
    throw errors.validation("La persona principal debe estar incluida entre los responsables", {
      primaryPersonId: explicitPrimary,
      personIds,
    });
  }
  if (flagged[0] && explicitPrimary !== flagged[0].personId) {
    throw errors.validation("La persona principal no coincide con la selección de responsables", {
      primaryPersonId: explicitPrimary,
      flaggedPrimary: flagged[0].personId,
    });
  }
  return {
    personIds,
    primaryPersonId: explicitPrimary ?? null,
    assignedBy: input.assignedBy ?? input.actor ?? "system:task-assignment",
  };
}

export async function insertTaskAssigneeRows(
  db: AgentosPgDb,
  taskId: string,
  normalized: NormalizedAssignees,
  createdAt = nowMs(),
): Promise<void> {
  for (const personId of normalized.personIds) {
    const row: NewTaskAssignee = {
      taskId,
      personId,
      isPrimary: normalized.primaryPersonId === personId,
      assignedBy: normalized.assignedBy,
      createdAt,
    };
    await db.insert(taskAssignees).values(row);
  }
}

/**
 * Mantiene la tabla puente alineada cuando un consumidor legacy todavía
 * actualiza `tasks.assignee_person_id` directamente.
 *
 * La operación se invoca desde la misma transacción que actualiza la tarea;
 * si la validación o el INSERT fallan, el cambio de la proyección también se
 * revierte.
 */
export async function synchronizeTaskAssignees(
  db: AgentosPgDb,
  taskId: string,
  personId: string | null,
  assignedBy = "system:legacy-task-update",
): Promise<void> {
  const [task] = await db.select({ projectId: tasks.projectId }).from(tasks).where(eq(tasks.id, taskId)).limit(1);
  if (!task) throw errors.notFound("task", taskId);
  await validateTaskAssigneeOrganization(db, task.projectId, personId ? [personId] : []);
  await db.delete(taskAssignees).where(eq(taskAssignees.taskId, taskId));
  if (personId) {
    await db.insert(taskAssignees).values({
      taskId,
      personId,
      isPrimary: true,
      assignedBy,
      createdAt: nowMs(),
    });
  }
}

export async function replaceTaskAssignees(
  db: AgentosPgDb,
  taskId: string,
  input: ReplaceTaskAssigneesInput | ReplaceTaskAssigneesObjectInput,
  expectedVersion: number,
): Promise<TaskWithAssignees>;
export async function replaceTaskAssignees(
  db: AgentosPgDb,
  taskId: string,
  personIds: readonly string[],
  primaryPersonId: string | null | undefined,
  expectedVersion: number,
  assignedBy?: string,
): Promise<TaskWithAssignees>;
export async function replaceTaskAssignees(
  db: AgentosPgDb,
  taskId: string,
  inputOrPersonIds: ReplaceTaskAssigneesInput | ReplaceTaskAssigneesObjectInput | readonly string[],
  expectedVersionOrPrimary: number | string | null | undefined,
  expectedVersionMaybe?: number,
  assignedBy?: string,
): Promise<TaskWithAssignees> {
  const expectedVersion =
    typeof expectedVersionOrPrimary === "number" ? expectedVersionOrPrimary : expectedVersionMaybe;
  if (expectedVersion === undefined) throw errors.validation("expected_version es obligatorio");
  const input: ReplaceTaskAssigneesInput = Array.isArray(inputOrPersonIds)
    ? {
        personIds: inputOrPersonIds,
        primaryPersonId: (expectedVersionOrPrimary as string | null | undefined) ?? null,
        assignedBy,
      }
    : (inputOrPersonIds as ReplaceTaskAssigneesInput);
  const normalized = normalizeAssignees(input);

  await db.transaction(async (tx) => {
    const [current] = await tx.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
    if (!current) throw errors.notFound("task", taskId);
    await validateTaskAssigneeOrganization(tx as unknown as AgentosPgDb, current.projectId, normalized.personIds);

    // El UPDATE condicional es la primera mutación: una versión vieja no
    // puede borrar/insertar responsables de una escritura concurrente.
    const updated = await tx
      .update(tasks)
      .set({
        assigneePersonId: normalized.primaryPersonId,
        updatedAt: nowMs(),
        version: sql`${tasks.version} + 1`,
      })
      .where(sql`${tasks.id} = ${taskId} AND ${tasks.version} = ${expectedVersion}`)
      .returning({ id: tasks.id });
    if (updated.length === 0) {
      const [stillThere] = await tx.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
      if (!stillThere) throw errors.notFound("task", taskId);
      throw errors.versionConflict("task", taskId, expectedVersion);
    }

    await tx.delete(taskAssignees).where(eq(taskAssignees.taskId, taskId));
    for (const personId of normalized.personIds) {
      const row: NewTaskAssignee = {
        taskId,
        personId,
        isPrimary: normalized.primaryPersonId === personId,
        assignedBy: normalized.assignedBy,
        createdAt: nowMs(),
      };
      await tx.insert(taskAssignees).values(row);
    }
  });

  return (await getTaskWithAssignees(db, taskId))!;
}

export const assignTaskPeople = replaceTaskAssignees;

/** Backfill idempotente de la proyección singular histórica. */
export async function backfillTaskAssignees(
  db: AgentosPgDb,
  assignedBy = "system:migration:0005",
): Promise<number> {
  const rows = await db
    .select({ taskId: tasks.id, personId: tasks.assigneePersonId, createdAt: tasks.createdAt })
    .from(tasks)
    .where(sql`${tasks.assigneePersonId} IS NOT NULL`);
  let inserted = 0;
  for (const row of rows) {
    if (!row.personId) continue;
    const [existing] = await db
      .select({ taskId: taskAssignees.taskId })
      .from(taskAssignees)
      .where(and(eq(taskAssignees.taskId, row.taskId), eq(taskAssignees.personId, row.personId)))
      .limit(1);
    if (existing) continue;
    await db
      .insert(taskAssignees)
      .values({
        taskId: row.taskId,
        personId: row.personId,
        isPrimary: true,
        assignedBy,
        createdAt: row.createdAt,
      })
      .onConflictDoNothing({ target: [taskAssignees.taskId, taskAssignees.personId] });
    const [after] = await db
      .select({ taskId: taskAssignees.taskId })
      .from(taskAssignees)
      .where(and(eq(taskAssignees.taskId, row.taskId), eq(taskAssignees.personId, row.personId)))
      .limit(1);
    if (after) inserted += 1;
  }
  return inserted;
}

export function normalizeNewTaskAssignees(input: TaskCreateInput): {
  normalized: NormalizedAssignees;
  taskInput: Omit<TaskCreateInput, keyof TaskAssigneeSelectionInput>;
} {
  const { assigneePersonIds, primaryAssigneePersonId, assignedBy, ...taskInput } = input;
  const legacy = taskInput.assigneePersonId;
  const normalized = normalizeAssignees({
    personIds: assigneePersonIds ?? (legacy ? [legacy] : []),
    primaryPersonId: primaryAssigneePersonId !== undefined ? primaryAssigneePersonId : legacy ?? null,
    assignedBy,
  });
  return { normalized, taskInput };
}
