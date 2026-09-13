/** Espejo Postgres de src/repositories/task-trash.ts — misma superficie, asíncrona (§NFR-9). */
import { and, desc, eq, exists, inArray, isNotNull, isNull, lt, ne, or, sql, gte } from "drizzle-orm";
import { errors, nowMs } from "@agentos/shared";
import type { AgentosPgDb } from "../client-pg.js";
import {
  approvals,
  artifacts,
  canvasNotes,
  notionImportLinks,
  projects,
  runs,
  taskAssignees,
  taskEvents,
  taskLabels,
  taskNotificationLog,
  tasks,
} from "../schema-pg.js";
import type { Task } from "../types-pg.js";
import {
  deletedByFromActor,
  uploadIdsIn,
  type ListDeletedTasksFilter,
  type PurgeDeletedTasksInput,
  type PurgeDeletedTasksResult,
  type RestoreTaskInput,
  type SoftDeleteTaskInput,
  type TaskTrashResult,
} from "../../task-trash-common.js";
import { appendAudit } from "./audit.js";
import { appendTaskEvent, getTask } from "./tasks.js";

const CHUNK = 1000;

function chunks<T>(items: readonly T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

type Tx = AgentosPgDb;

async function descendants(db: Tx, rootId: string, stamp: number | null): Promise<string[]> {
  const cond = stamp === null ? sql`t.deleted_at IS NULL` : sql`t.deleted_at = ${stamp}`;
  const rows = (await db.execute(sql`
    WITH RECURSIVE sub(id) AS (
      SELECT t.id FROM tasks t WHERE t.parent_task_id = ${rootId} AND ${cond}
      UNION
      SELECT t.id FROM tasks t JOIN sub ON t.parent_task_id = sub.id WHERE ${cond}
    )
    SELECT id FROM sub
  `)) as unknown as { id: string }[];
  return rows.map((r) => String(r.id)).filter((id) => id !== rootId);
}

async function busyTaskIds(db: Tx, ids: readonly string[], now: number): Promise<string[]> {
  const busy = new Set<string>();
  for (const part of chunks(ids)) {
    const rows = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(
        and(
          inArray(tasks.id, part),
          or(
            and(eq(tasks.status, "IN_PROGRESS"), isNotNull(tasks.leaseUntil), gte(tasks.leaseUntil, now)),
            exists(
              db
                .select({ id: runs.id })
                .from(runs)
                .where(and(eq(runs.taskId, tasks.id), inArray(runs.status, ["queued", "running"]))),
            ),
          ),
        ),
      );
    for (const r of rows) busy.add(r.id);
  }
  return [...busy];
}

export async function softDeleteTask(db: AgentosPgDb, id: string, input: SoftDeleteTaskInput): Promise<TaskTrashResult> {
  const now = input.now ?? nowMs();
  const deletedBy = deletedByFromActor(input.actor);
  let subtaskIds: string[] = [];
  await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Tx;
    const task = await getTask(tx, id);
    if (!task) throw errors.notFound("task", id);
    if (task.deletedAt !== null) {
      throw errors.conflict("La tarea ya está en la papelera", { taskId: id, reason: "task_already_deleted" });
    }
    if (task.version !== input.expectedVersion) throw errors.versionConflict("task", id, input.expectedVersion);
    subtaskIds = await descendants(tx, id, null);
    const busy = await busyTaskIds(tx, [id, ...subtaskIds], now);
    if (busy.length > 0) {
      throw errors.conflict("No se puede desactivar una tarea en ejecución", {
        taskId: id,
        reason: "task_running",
        runningTaskIds: busy,
      });
    }
    const updated = await tx
      .update(tasks)
      .set({ deletedAt: now, deletedBy, version: sql`${tasks.version} + 1`, updatedAt: now })
      .where(and(eq(tasks.id, id), eq(tasks.version, input.expectedVersion), isNull(tasks.deletedAt)))
      .returning({ id: tasks.id });
    if (updated.length === 0) throw errors.versionConflict("task", id, input.expectedVersion);
    for (const part of chunks(subtaskIds)) {
      await tx
        .update(tasks)
        .set({ deletedAt: now, deletedBy, version: sql`${tasks.version} + 1`, updatedAt: now })
        .where(and(inArray(tasks.id, part), isNull(tasks.deletedAt)));
    }
    await appendTaskEvent(tx, {
      taskId: id,
      kind: "deleted",
      actor: input.actor,
      payload: { deletedAt: now, subtaskIds },
    });
    await appendAudit(tx, {
      actor: input.actor,
      source: input.source ?? "ui",
      action: "task.deleted",
      entityType: "task",
      entityId: id,
      before: { status: task.status, version: task.version },
      after: { deletedAt: now, deletedBy, subtaskIds },
    });
  });
  return { task: (await getTask(db, id))!, subtaskIds };
}

export async function restoreTask(db: AgentosPgDb, id: string, input: RestoreTaskInput): Promise<TaskTrashResult> {
  const now = input.now ?? nowMs();
  let subtaskIds: string[] = [];
  await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Tx;
    const task = await getTask(tx, id);
    if (!task) throw errors.notFound("task", id);
    if (task.deletedAt === null) {
      throw errors.conflict("La tarea no está en la papelera", { taskId: id, reason: "task_not_deleted" });
    }
    const stamp = task.deletedAt;
    subtaskIds = await descendants(tx, id, stamp);
    for (const part of chunks([id, ...subtaskIds])) {
      await tx
        .update(tasks)
        .set({ deletedAt: null, deletedBy: null, version: sql`${tasks.version} + 1`, updatedAt: now })
        .where(and(inArray(tasks.id, part), eq(tasks.deletedAt, stamp)));
    }
    await appendTaskEvent(tx, {
      taskId: id,
      kind: "restored",
      actor: input.actor,
      payload: { deletedAt: stamp, subtaskIds },
    });
    await appendAudit(tx, {
      actor: input.actor,
      source: input.source ?? "ui",
      action: "task.restored",
      entityType: "task",
      entityId: id,
      before: { deletedAt: stamp, deletedBy: task.deletedBy },
      after: { deletedAt: null, subtaskIds },
    });
  });
  return { task: (await getTask(db, id))!, subtaskIds };
}

export async function listDeletedTasks(db: AgentosPgDb, filter: ListDeletedTasksFilter = {}): Promise<Task[]> {
  const conds = [isNotNull(tasks.deletedAt)];
  if (filter.projectId) conds.push(eq(tasks.projectId, filter.projectId));
  if (filter.orgId) {
    conds.push(
      exists(
        db
          .select({ id: projects.id })
          .from(projects)
          .where(and(eq(projects.id, tasks.projectId), eq(projects.orgId, filter.orgId))),
      ),
    );
  }
  const q = filter.q?.trim();
  if (q) {
    const like = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    conds.push(sql`${tasks.title} ILIKE ${like}`);
  }
  return await db
    .select()
    .from(tasks)
    .where(and(...conds))
    .orderBy(desc(tasks.deletedAt), desc(tasks.id))
    .limit(filter.limit ?? 500);
}

/** Ver la doc completa (resolución de cada FK) en src/repositories/task-trash.ts. */
export async function purgeDeletedTasks(
  db: AgentosPgDb,
  input: PurgeDeletedTasksInput,
): Promise<PurgeDeletedTasksResult> {
  const now = input.now ?? nowMs();
  const cutoff = now - input.olderThanMs;
  const result: PurgeDeletedTasksResult = { purged: 0, cutoff, taskIds: [], artifactFiles: [], uploadIds: [] };
  await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Tx;
    const doomed = await tx
      .select({ id: tasks.id, projectId: tasks.projectId, description: tasks.description })
      .from(tasks)
      .where(and(isNotNull(tasks.deletedAt), lt(tasks.deletedAt, cutoff)))
      .orderBy(tasks.deletedAt);
    if (doomed.length === 0) return;
    const ids = doomed.map((t) => t.id);
    const idSet = new Set(ids);
    const projectByTask = new Map(doomed.map((t) => [t.id, t.projectId]));

    for (const part of chunks(ids)) {
      const rows = await tx
        .select({ id: artifacts.id, taskId: artifacts.taskId, path: artifacts.path, meta: artifacts.meta })
        .from(artifacts)
        .where(inArray(artifacts.taskId, part));
      const artifactIds = rows.map((r) => r.id);
      const usedByNote = new Set<string>();
      for (const aPart of chunks(artifactIds)) {
        const notes = await tx
          .select({ artifactId: canvasNotes.imageArtifactId })
          .from(canvasNotes)
          .where(inArray(canvasNotes.imageArtifactId, aPart));
        for (const n of notes) if (n.artifactId) usedByNote.add(n.artifactId);
        await tx.update(canvasNotes).set({ imageArtifactId: null }).where(inArray(canvasNotes.imageArtifactId, aPart));
      }
      for (const row of rows) {
        const storage = (row.meta as { storage?: unknown } | null)?.storage;
        if (row.path && storage === "artifacts_root" && !usedByNote.has(row.id)) {
          result.artifactFiles.push({
            artifactId: row.id,
            taskId: row.taskId,
            projectId: projectByTask.get(row.taskId)!,
            path: row.path,
          });
        }
      }
    }

    for (const part of chunks(ids)) {
      await tx.delete(artifacts).where(inArray(artifacts.taskId, part));
      await tx.delete(taskEvents).where(inArray(taskEvents.taskId, part));
      await tx.delete(taskLabels).where(inArray(taskLabels.taskId, part));
      await tx.delete(taskAssignees).where(inArray(taskAssignees.taskId, part));
      await tx.delete(taskNotificationLog).where(inArray(taskNotificationLog.taskId, part));
      await tx.update(runs).set({ taskId: null }).where(inArray(runs.taskId, part));
      await tx.update(approvals).set({ taskId: null }).where(inArray(approvals.taskId, part));
      await tx
        .update(notionImportLinks)
        .set({ importStatus: "deleted_in_agentos" })
        .where(and(eq(notionImportLinks.agentosObjectKind, "task"), inArray(notionImportLinks.agentosObjectId, part)));
      await tx.update(tasks).set({ parentTaskId: null }).where(inArray(tasks.parentTaskId, part));
    }

    const withDeps = await tx
      .select({ id: tasks.id, dependsOn: tasks.dependsOn })
      .from(tasks)
      .where(ne(tasks.dependsOn, sql`'[]'::jsonb`));
    for (const row of withDeps) {
      if (idSet.has(row.id)) continue;
      const deps = Array.isArray(row.dependsOn) ? row.dependsOn : [];
      const kept = deps.filter((d) => !idSet.has(d));
      if (kept.length !== deps.length) {
        await tx
          .update(tasks)
          .set({ dependsOn: kept, version: sql`${tasks.version} + 1`, updatedAt: now })
          .where(eq(tasks.id, row.id));
      }
    }

    for (const part of chunks(ids)) {
      await tx.delete(tasks).where(inArray(tasks.id, part));
    }

    const candidates = new Set(doomed.flatMap((t) => uploadIdsIn(t.description)));
    for (const uploadId of candidates) {
      const like = `%/api/uploads/${uploadId}%`;
      const [inTask] = await tx
        .select({ id: tasks.id })
        .from(tasks)
        .where(sql`${tasks.description} LIKE ${like}`)
        .limit(1);
      const [inNote] = await tx
        .select({ id: canvasNotes.id })
        .from(canvasNotes)
        .where(sql`${canvasNotes.transcription} LIKE ${like} OR ${canvasNotes.proposals}::text LIKE ${like}`)
        .limit(1);
      if (!inTask && !inNote) result.uploadIds.push(uploadId);
    }

    result.purged = ids.length;
    result.taskIds = ids;
    await appendAudit(tx, {
      actor: input.actor ?? "system:task-purge",
      source: "system",
      action: "task.purged",
      entityType: "task",
      entityId: null,
      after: { count: ids.length, taskIds: ids, cutoff },
    });
  });
  return result;
}
