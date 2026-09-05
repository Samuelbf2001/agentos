import { and, asc, eq, exists, sql } from "drizzle-orm";
import { errors, newId, nowMs, type TaskStatus } from "@agentos/shared";
import type { AgentosDb } from "../client.js";
import { people, projects, taskAssignees, tasks } from "../schema.js";
import type {
  NewTaskAssignee,
  Task,
  TaskAssignee,
  TaskAssigneeSelectionInput,
  TaskCreateInput,
} from "../types.js";

/** Fila de tarea acompañada por la asignación humana canónica. */
export type TaskWithAssignees = Task & { assignees: TaskAssignee[] };

export interface ReplaceTaskAssigneesInput extends TaskAssigneeSelectionInput {
  /** Alias explícito para callers de dominio que no usan el nombre REST. */
  personIds?: readonly string[];
  /** Alias aceptado por el contrato HTTP/MCP. */
  primaryPersonId?: string | null;
  /** Actor de la operación; `assignedBy` sigue siendo el nombre persistido. */
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

/**
 * Lista los responsables de una tarea en un orden estable. La tabla puente es
 * canónica; no se reconstruye la lista desde `tasks.assignee_person_id`.
 */
export function listTaskAssignees(db: AgentosDb, taskId: string): TaskAssignee[] {
  return db
    .select()
    .from(taskAssignees)
    .where(eq(taskAssignees.taskId, taskId))
    .orderBy(asc(taskAssignees.createdAt), asc(taskAssignees.personId))
    .all();
}

export function getPrimaryTaskAssignee(db: AgentosDb, taskId: string): TaskAssignee | undefined {
  return db
    .select()
    .from(taskAssignees)
    .where(and(eq(taskAssignees.taskId, taskId), eq(taskAssignees.isPrimary, true)))
    .get();
}

export function getTaskWithAssignees(db: AgentosDb, taskId: string): TaskWithAssignees | undefined {
  const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
  return task ? { ...task, assignees: listTaskAssignees(db, taskId) } : undefined;
}

/**
 * Lee tareas y responsables en una única superficie de dominio. `personId`
 * filtra contra la tabla puente y por tanto también encuentra responsables no
 * primarios; `assigneePersonId` queda como alias legacy.
 */
export function listTasksWithAssignees(
  db: AgentosDb,
  filter: {
    projectId?: string;
    status?: TaskStatus;
    assigneeAgentId?: string;
    personId?: string;
    assigneePersonId?: string;
  } = {},
): TaskWithAssignees[] {
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
  const rows = (conds.length > 0 ? base.where(and(...conds)) : base)
    .orderBy(asc(tasks.status), asc(tasks.orderKey))
    .all();
  return rows.map((task) => ({ ...task, assignees: listTaskAssignees(db, task.id) }));
}

/** Igual que `listTasksWithAssignees`, para el tablero de un proyecto. */
export function boardTasksWithAssignees(db: AgentosDb, projectId: string): TaskWithAssignees[] {
  return listTasksWithAssignees(db, { projectId });
}

/**
 * Verifica la regla de aislamiento humano: cada persona debe existir y, o
 * bien pertenecer a la organización dueña del proyecto, o bien ser personal
 * interno (`is_internal`) asignable a cualquier proyecto (I3). Se exporta
 * para que `createTask` y la reposición compartan exactamente la misma
 * validación.
 */
export function validateTaskAssigneeOrganization(
  db: AgentosDb,
  projectId: string,
  personIds: readonly string[],
): void {
  const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project) throw errors.notFound("project", projectId);
  for (const personId of personIds) {
    const person = db.select().from(people).where(eq(people.id, personId)).get();
    if (!person) throw errors.notFound("person", personId);
    if (person.isInternal) continue;
    if (person.orgId !== project.orgId) {
      throw errors.validation(
        `La persona ${personId} no pertenece a la organización del proyecto ${projectId} ni es personal interno`,
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

/** @internal Inserta las filas puente después de que la validación haya pasado. */
export function insertTaskAssigneeRows(
  db: AgentosDb,
  taskId: string,
  normalized: NormalizedAssignees,
  createdAt = nowMs(),
): void {
  for (const personId of normalized.personIds) {
    const row: NewTaskAssignee = {
      taskId,
      personId,
      isPrimary: normalized.primaryPersonId === personId,
      assignedBy: normalized.assignedBy,
      createdAt,
    };
    db.insert(taskAssignees).values(row).run();
  }
}

/** @internal Mantiene el puente cuando un consumer legacy actualiza el campo singular. */
export function synchronizeTaskAssignees(
  db: AgentosDb,
  taskId: string,
  personId: string | null,
  assignedBy = "system:legacy-task-update",
): void {
  const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
  if (!task) throw errors.notFound("task", taskId);
  const normalized: NormalizedAssignees = {
    personIds: personId ? [personId] : [],
    primaryPersonId: personId,
    assignedBy,
  };
  validateTaskAssigneeOrganization(db, task.projectId, normalized.personIds);
  db.delete(taskAssignees).where(eq(taskAssignees.taskId, taskId)).run();
  insertTaskAssigneeRows(db, taskId, normalized);
}

/**
 * Reemplaza atómicamente la lista de responsables. La actualización de la
 * proyección legacy ocurre antes de borrar/insertar la tabla puente, de modo
 * que un conflicto de versión no muta absolutamente nada y cualquier error
 * posterior revierte la transacción completa.
 */
export function replaceTaskAssignees(
  db: AgentosDb,
  taskId: string,
  input: ReplaceTaskAssigneesInput | ReplaceTaskAssigneesObjectInput,
  expectedVersion: number,
): TaskWithAssignees;
export function replaceTaskAssignees(
  db: AgentosDb,
  taskId: string,
  personIds: readonly string[],
  primaryPersonId: string | null | undefined,
  expectedVersion: number,
  assignedBy?: string,
): TaskWithAssignees;
export function replaceTaskAssignees(
  db: AgentosDb,
  taskId: string,
  inputOrPersonIds: ReplaceTaskAssigneesInput | ReplaceTaskAssigneesObjectInput | readonly string[],
  expectedVersionOrPrimary: number | string | null | undefined,
  expectedVersionMaybe?: number,
  assignedBy?: string,
): TaskWithAssignees {
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

  const work = (): void => {
    const current = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
    if (!current) throw errors.notFound("task", taskId);
    validateTaskAssigneeOrganization(db, current.projectId, normalized.personIds);

    // Guard the version before touching task_assignees. This also serializes
    // concurrent replacements on the same task in Postgres and SQLite.
    const updated = db
      .update(tasks)
      .set({
        assigneePersonId: normalized.primaryPersonId,
        updatedAt: nowMs(),
        version: sql`${tasks.version} + 1`,
      })
      .where(sql`${tasks.id} = ${taskId} AND ${tasks.version} = ${expectedVersion}`)
      .run();
    if (updated.changes === 0) {
      if (!db.select().from(tasks).where(eq(tasks.id, taskId)).get()) {
        throw errors.notFound("task", taskId);
      }
      throw errors.versionConflict("task", taskId, expectedVersion);
    }

    db.delete(taskAssignees).where(eq(taskAssignees.taskId, taskId)).run();
    insertTaskAssigneeRows(db, taskId, normalized);
  };

  const inTransaction = (db.$client as unknown as { inTransaction?: boolean }).inTransaction === true;
  if (inTransaction) work();
  else db.$client.transaction(work)();

  return getTaskWithAssignees(db, taskId)!;
}

/** Alias de dominio para callers que prefieren el verbo `assign`. */
export const assignTaskPeople = replaceTaskAssignees;

/**
 * Backfill idempotente para instalaciones que ya tenían la proyección
 * singular. La migración SQL ejecuta el mismo paso; este helper permite a un
 * operador verificar/reparar una base parcialmente migrada sin duplicar pares.
 */
export function backfillTaskAssignees(
  db: AgentosDb,
  assignedBy = "system:migration:0005",
): number {
  const rows = db.$client
    .prepare(
      `SELECT t.id AS task_id, t.assignee_person_id AS person_id, t.created_at
         FROM tasks t
        WHERE t.assignee_person_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM task_assignees ta
             WHERE ta.task_id = t.id AND ta.person_id = t.assignee_person_id
          )`,
    )
    .all() as { task_id: string; person_id: string; created_at: number }[];
  const insert = db.$client.prepare(
    `INSERT INTO task_assignees (task_id, person_id, is_primary, assigned_by, created_at)
     VALUES (@taskId, @personId, 1, @assignedBy, @createdAt)`,
  );
  const run = db.$client.transaction(() => {
    for (const row of rows) {
      insert.run({ taskId: row.task_id, personId: row.person_id, assignedBy, createdAt: row.created_at });
    }
  });
  const inTransaction = (db.$client as unknown as { inTransaction?: boolean }).inTransaction === true;
  if (inTransaction) {
    for (const row of rows) {
      insert.run({ taskId: row.task_id, personId: row.person_id, assignedBy, createdAt: row.created_at });
    }
  } else {
    run();
  }
  return rows.length;
}

/**
 * Normaliza y valida una selección para `createTask`; se mantiene en este
 * módulo para que creación y reemplazo no puedan divergir en la regla de org.
 */
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
