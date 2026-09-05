import { and, asc, eq, inArray, lte, notInArray, or } from "drizzle-orm";
import { errors, newId, nowMs } from "@agentos/shared";
import type { AgentosPgDb } from "../client-pg.js";
import { people, projects, taskNotificationLog, tasks } from "../schema-pg.js";
import type {
  NewTaskNotificationLog,
  TaskNotificationKind,
  TaskNotificationLog,
  TaskNotificationStatus,
} from "../types-pg.js";

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
  inserted: boolean;
}

export interface ListTaskNotificationsFilter {
  taskId?: string;
  personId?: string;
  kind?: TaskNotificationKind;
  status?: TaskNotificationStatus | TaskNotificationStatus[];
  dueAt?: number;
}

function defaultDedupeKey(input: CreateTaskNotificationInput, scheduledAt: number): string {
  return input.kind === "due_24h"
    ? `${input.taskId}:${input.personId}:due_24h`
    : `${input.taskId}:${input.personId}:assignment:${scheduledAt}`;
}

async function validateNotificationTarget(db: AgentosPgDb, taskId: string, personId: string): Promise<void> {
  const [row] = await db
    .select({ projectOrgId: projects.orgId, personOrgId: people.orgId, personIsInternal: people.isInternal })
    .from(tasks)
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .innerJoin(people, eq(people.id, personId))
    .where(eq(tasks.id, taskId))
    .limit(1);
  if (!row) {
    const [task] = await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, taskId)).limit(1);
    if (!task) throw errors.notFound("task", taskId);
    throw errors.notFound("person", personId);
  }
  if (row.personIsInternal) return;
  if (row.projectOrgId !== row.personOrgId) {
    throw errors.validation(
      `La persona ${personId} no pertenece a la organización del proyecto de la tarea ${taskId} ni es personal interno`,
      { taskId, personId, projectOrgId: row.projectOrgId, personOrgId: row.personOrgId },
    );
  }
}

export async function getTaskNotificationLog(
  db: AgentosPgDb,
  id: string,
): Promise<TaskNotificationLog | undefined> {
  const [row] = await db.select().from(taskNotificationLog).where(eq(taskNotificationLog.id, id)).limit(1);
  return row;
}

export async function getTaskNotificationLogByDedupeKey(
  db: AgentosPgDb,
  dedupeKey: string,
): Promise<TaskNotificationLog | undefined> {
  const [row] = await db
    .select()
    .from(taskNotificationLog)
    .where(eq(taskNotificationLog.dedupeKey, dedupeKey))
    .limit(1);
  return row;
}

export const getNotificationLogByDedupeKey = getTaskNotificationLogByDedupeKey;
export const getNotificationLog = getTaskNotificationLog;

export async function listTaskNotificationLogs(
  db: AgentosPgDb,
  filter: ListTaskNotificationsFilter = {},
): Promise<TaskNotificationLog[]> {
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
  if (filter.dueAt !== undefined) conds.push(lte(taskNotificationLog.scheduledAt, filter.dueAt));
  const base = db.select().from(taskNotificationLog);
  return await (conds.length > 0 ? base.where(and(...conds)) : base)
    .orderBy(asc(taskNotificationLog.scheduledAt), asc(taskNotificationLog.createdAt));
}

export const listNotificationLogs = listTaskNotificationLogs;

export async function listPendingTaskNotifications(
  db: AgentosPgDb,
  at = nowMs(),
): Promise<TaskNotificationLog[]> {
  const ids = await db
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
    .orderBy(asc(taskNotificationLog.scheduledAt), asc(taskNotificationLog.createdAt));
  const rows = await Promise.all(ids.map((row) => getTaskNotificationLog(db, row.id)));
  return rows.filter((row): row is TaskNotificationLog => row !== undefined);
}

export const listDueTaskNotificationLogs = listPendingTaskNotifications;

export async function createTaskNotificationLog(
  db: AgentosPgDb,
  input: CreateTaskNotificationInput,
): Promise<CreateTaskNotificationResult> {
  await validateNotificationTarget(db, input.taskId, input.personId);
  const scheduledAt = input.scheduledAt ?? nowMs();
  const dedupeKey = input.dedupeKey ?? defaultDedupeKey(input, scheduledAt);
  const existing = await getTaskNotificationLogByDedupeKey(db, dedupeKey);
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
    await db.insert(taskNotificationLog).values(row).onConflictDoNothing({
      target: taskNotificationLog.dedupeKey,
    });
  } catch (err) {
    const raced = await getTaskNotificationLogByDedupeKey(db, dedupeKey);
    if (raced) return { notification: raced, inserted: false };
    throw err;
  }
  const saved = await getTaskNotificationLogByDedupeKey(db, dedupeKey);
  if (!saved) throw errors.notFound("task_notification_log", row.id!);
  return { notification: saved, inserted: saved.id === row.id };
}

export const createNotificationLog = createTaskNotificationLog;
export const createTaskNotification = createTaskNotificationLog;

export async function claimTaskNotificationLog(db: AgentosPgDb, id: string, at = nowMs()): Promise<boolean> {
  const rows = await db
    .update(taskNotificationLog)
    .set({ status: "processing", lastError: null })
    .where(
      and(
        eq(taskNotificationLog.id, id),
        lte(taskNotificationLog.scheduledAt, at),
        or(eq(taskNotificationLog.status, "pending"), eq(taskNotificationLog.status, "failed")),
      ),
    )
    .returning({ id: taskNotificationLog.id });
  return rows.length > 0;
}

export const claimNotificationLog = claimTaskNotificationLog;
export const claimTaskNotification = claimTaskNotificationLog;

export async function claimTaskNotificationLogByDedupeKey(
  db: AgentosPgDb,
  dedupeKey: string,
  at = nowMs(),
): Promise<boolean> {
  const row = await getTaskNotificationLogByDedupeKey(db, dedupeKey);
  return row ? claimTaskNotificationLog(db, row.id, at) : false;
}

export async function markTaskNotificationDelivered(
  db: AgentosPgDb,
  id: string,
  deliveredAt = nowMs(),
): Promise<TaskNotificationLog> {
  const rows = await db
    .update(taskNotificationLog)
    .set({ status: "delivered", deliveredAt, lastError: null })
    .where(eq(taskNotificationLog.id, id))
    .returning({ id: taskNotificationLog.id });
  if (rows.length === 0) throw errors.notFound("task_notification_log", id);
  return (await getTaskNotificationLog(db, id))!;
}

export async function updateTaskNotificationLog(
  db: AgentosPgDb,
  id: string,
  patch: Partial<Pick<TaskNotificationLog, "status" | "deliveredAt" | "lastError">>,
): Promise<TaskNotificationLog> {
  const rows = await db
    .update(taskNotificationLog)
    .set(patch)
    .where(eq(taskNotificationLog.id, id))
    .returning({ id: taskNotificationLog.id });
  if (rows.length === 0) throw errors.notFound("task_notification_log", id);
  return (await getTaskNotificationLog(db, id))!;
}

export async function markTaskNotificationFailed(
  db: AgentosPgDb,
  id: string,
  lastError: string,
): Promise<TaskNotificationLog> {
  const rows = await db
    .update(taskNotificationLog)
    .set({ status: "failed", lastError, deliveredAt: null })
    .where(eq(taskNotificationLog.id, id))
    .returning({ id: taskNotificationLog.id });
  if (rows.length === 0) throw errors.notFound("task_notification_log", id);
  return (await getTaskNotificationLog(db, id))!;
}

export async function suppressTaskNotification(
  db: AgentosPgDb,
  id: string,
  reason: string,
): Promise<TaskNotificationLog> {
  const rows = await db
    .update(taskNotificationLog)
    .set({ status: "suppressed", lastError: reason, deliveredAt: null })
    .where(eq(taskNotificationLog.id, id))
    .returning({ id: taskNotificationLog.id });
  if (rows.length === 0) throw errors.notFound("task_notification_log", id);
  return (await getTaskNotificationLog(db, id))!;
}
