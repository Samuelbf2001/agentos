import { and, asc, eq, inArray, lte, notInArray, or } from "drizzle-orm";
import { errors, newId, nowMs } from "@agentos/shared";
import type { AgentosSqliteDb } from "../client.js";
import { people, projects, taskNotificationLog, tasks } from "../schema.js";
import type {
  NewTaskNotificationLog,
  TaskNotificationKind,
  TaskNotificationLog,
  TaskNotificationStatus,
} from "../types.js";

export interface CreateTaskNotificationInput {
  id?: string;
  taskId: string;
  personId: string;
  kind: TaskNotificationKind;
  scheduledAt?: number;
  deliveredAt?: number | null;
  status?: TaskNotificationStatus;
  dedupeKey?: string;
  lastError?: string | null;
  createdAt?: number;
}

export interface CreateTaskNotificationResult {
  notification: TaskNotificationLog;
  /** false cuando la misma `dedupe_key` ya había sido registrada. */
  inserted: boolean;
}

export interface ListTaskNotificationsFilter {
  taskId?: string;
  personId?: string;
  kind?: TaskNotificationKind;
  status?: TaskNotificationStatus | TaskNotificationStatus[];
  /** Solo avisos listos para procesar hasta este instante. */
  dueAt?: number;
}

function defaultDedupeKey(input: CreateTaskNotificationInput, scheduledAt: number): string {
  // due_24h debe existir como máximo una vez por tarea/persona. Assignment
  // incluye la ventana temporal para permitir un aviso por cambio real.
  return input.kind === "due_24h"
    ? `${input.taskId}:${input.personId}:due_24h`
    : `${input.taskId}:${input.personId}:assignment:${scheduledAt}`;
}

function validateNotificationTarget(db: AgentosSqliteDb, taskId: string, personId: string): void {
  const row = db
    .select({ projectOrgId: projects.orgId, personOrgId: people.orgId })
    .from(tasks)
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .innerJoin(people, eq(people.id, personId))
    .where(eq(tasks.id, taskId))
    .get();
  if (!row) {
    if (!db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, taskId)).get()) {
      throw errors.notFound("task", taskId);
    }
    throw errors.notFound("person", personId);
  }
  if (row.projectOrgId !== row.personOrgId) {
    throw errors.validation(
      `La persona ${personId} no pertenece a la organización del proyecto de la tarea ${taskId}`,
      { taskId, personId, projectOrgId: row.projectOrgId, personOrgId: row.personOrgId },
    );
  }
}

export function getTaskNotificationLog(db: AgentosSqliteDb, id: string): TaskNotificationLog | undefined {
  return db.select().from(taskNotificationLog).where(eq(taskNotificationLog.id, id)).get();
}

export function getTaskNotificationLogByDedupeKey(
  db: AgentosSqliteDb,
  dedupeKey: string,
): TaskNotificationLog | undefined {
  return db.select().from(taskNotificationLog).where(eq(taskNotificationLog.dedupeKey, dedupeKey)).get();
}

/** Alias corto para callers de workers. */
export const getNotificationLogByDedupeKey = getTaskNotificationLogByDedupeKey;
export const getNotificationLog = getTaskNotificationLog;

export function listTaskNotificationLogs(
  db: AgentosSqliteDb,
  filter: ListTaskNotificationsFilter = {},
): TaskNotificationLog[] {
  const conds = [];
  if (filter.taskId) conds.push(eq(taskNotificationLog.taskId, filter.taskId));
  if (filter.personId) conds.push(eq(taskNotificationLog.personId, filter.personId));
  if (filter.kind) conds.push(eq(taskNotificationLog.kind, filter.kind));
  if (filter.status) {
    conds.push(
      Array.isArray(filter.status)
        ? inArray(taskNotificationLog.status, filter.status)
        : eq(taskNotificationLog.status, filter.status),
    );
  }
  if (filter.dueAt !== undefined) {
    conds.push(lte(taskNotificationLog.scheduledAt, filter.dueAt));
  }
  const base = db.select().from(taskNotificationLog);
  return (conds.length > 0 ? base.where(and(...conds)) : base)
    .orderBy(asc(taskNotificationLog.scheduledAt), asc(taskNotificationLog.createdAt))
    .all();
}

export const listNotificationLogs = listTaskNotificationLogs;

/** Avisos pendientes/reintentables cuyo horario ya llegó. */
export function listPendingTaskNotifications(db: AgentosSqliteDb, at = nowMs()): TaskNotificationLog[] {
  const ids = db
    .select({ id: taskNotificationLog.id })
    .from(taskNotificationLog)
    .innerJoin(tasks, eq(tasks.id, taskNotificationLog.taskId))
    .where(
      and(
        inArray(taskNotificationLog.status, ["pending", "failed"]),
        lte(taskNotificationLog.scheduledAt, at),
        notInArray(tasks.status, ["DONE", "CANCELLED"]),
      ),
    )
    .orderBy(asc(taskNotificationLog.scheduledAt), asc(taskNotificationLog.createdAt))
    .all();
  return ids.map((row) => getTaskNotificationLog(db, row.id)!).filter(Boolean);
}

/** Nombre explícito para el job de vencimientos del próximo frente. */
export const listDueTaskNotificationLogs = listPendingTaskNotifications;

/**
 * Crea un log idempotente. La unicidad durable de `dedupe_key` es la última
 * defensa frente a dos workers concurrentes; el catch devuelve la fila ganadora.
 */
export function createTaskNotificationLog(db: AgentosSqliteDb, input: CreateTaskNotificationInput): CreateTaskNotificationResult {
  validateNotificationTarget(db, input.taskId, input.personId);
  const scheduledAt = input.scheduledAt ?? nowMs();
  const dedupeKey = input.dedupeKey ?? defaultDedupeKey(input, scheduledAt);
  const existing = getTaskNotificationLogByDedupeKey(db, dedupeKey);
  if (existing) return { notification: existing, inserted: false };

  const row: NewTaskNotificationLog = {
    id: input.id ?? newId(),
    taskId: input.taskId,
    personId: input.personId,
    kind: input.kind,
    scheduledAt,
    deliveredAt: input.deliveredAt ?? null,
    status: input.status ?? "pending",
    dedupeKey,
    lastError: input.lastError ?? null,
    createdAt: input.createdAt ?? nowMs(),
  };
  try {
    db.insert(taskNotificationLog).values(row).run();
  } catch (err) {
    const raced = getTaskNotificationLogByDedupeKey(db, dedupeKey);
    if (raced) return { notification: raced, inserted: false };
    throw err;
  }
  return { notification: getTaskNotificationLog(db, row.id!)!, inserted: true };
}

/** Alias semántico para el próximo procesador de avisos. */
export const createNotificationLog = createTaskNotificationLog;
export const createTaskNotification = createTaskNotificationLog;

/**
 * Claim atómico de un aviso. Solo un worker puede pasar pending/failed a
 * processing; repetir la llamada devuelve false y no vuelve a ejecutar el
 * efecto externo. Un aviso futuro no se reclama antes de `at`.
 */
export function claimTaskNotificationLog(db: AgentosSqliteDb, id: string, at = nowMs()): boolean {
  const result = db
    .update(taskNotificationLog)
    .set({ status: "processing", lastError: null })
    .where(
      and(
        eq(taskNotificationLog.id, id),
        lte(taskNotificationLog.scheduledAt, at),
        or(eq(taskNotificationLog.status, "pending"), eq(taskNotificationLog.status, "failed")),
      ),
    )
    .run();
  return result.changes > 0;
}

export const claimNotificationLog = claimTaskNotificationLog;
export const claimTaskNotification = claimTaskNotificationLog;

export function claimTaskNotificationLogByDedupeKey(
  db: AgentosSqliteDb,
  dedupeKey: string,
  at = nowMs(),
): boolean {
  const row = getTaskNotificationLogByDedupeKey(db, dedupeKey);
  return row ? claimTaskNotificationLog(db, row.id, at) : false;
}

export function markTaskNotificationDelivered(
  db: AgentosSqliteDb,
  id: string,
  deliveredAt = nowMs(),
): TaskNotificationLog {
  const result = db
    .update(taskNotificationLog)
    .set({ status: "delivered", deliveredAt, lastError: null })
    .where(eq(taskNotificationLog.id, id))
    .run();
  if (result.changes === 0) throw errors.notFound("task_notification_log", id);
  return getTaskNotificationLog(db, id)!;
}

/** Actualización genérica para workers que persisten el resultado del envío. */
export function updateTaskNotificationLog(
  db: AgentosSqliteDb,
  id: string,
  patch: Partial<Pick<TaskNotificationLog, "status" | "deliveredAt" | "lastError">>,
): TaskNotificationLog {
  const result = db.update(taskNotificationLog).set(patch).where(eq(taskNotificationLog.id, id)).run();
  if (result.changes === 0) throw errors.notFound("task_notification_log", id);
  return getTaskNotificationLog(db, id)!;
}

export function markTaskNotificationFailed(db: AgentosSqliteDb, id: string, lastError: string): TaskNotificationLog {
  const result = db
    .update(taskNotificationLog)
    .set({ status: "failed", lastError, deliveredAt: null })
    .where(eq(taskNotificationLog.id, id))
    .run();
  if (result.changes === 0) throw errors.notFound("task_notification_log", id);
  return getTaskNotificationLog(db, id)!;
}

export function suppressTaskNotification(db: AgentosSqliteDb, id: string, reason: string): TaskNotificationLog {
  const result = db
    .update(taskNotificationLog)
    .set({ status: "suppressed", lastError: reason, deliveredAt: null })
    .where(eq(taskNotificationLog.id, id))
    .run();
  if (result.changes === 0) throw errors.notFound("task_notification_log", id);
  return getTaskNotificationLog(db, id)!;
}
