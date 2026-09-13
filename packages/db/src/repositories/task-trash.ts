/**
 * Papelera de tareas (borrado suave). Espejo Postgres: src/pg/repositories/task-trash.ts.
 *
 * Decisión de diseño: la desactivación NO es un estado de `TaskStatus`; son dos
 * columnas (`deleted_at`, `deleted_by`). La máquina de estados del tablero no
 * se toca y `status` se conserva intacto, así que restaurar devuelve la
 * tarjeta exactamente como estaba. A los N días (90 por defecto, lo decide el
 * llamante) `purgeDeletedTasks` la borra DE VERDAD, resolviendo cada FK.
 */
import { errors, nowMs } from "@agentos/shared";
import type { AgentosSqliteDb } from "../client.js";
import type { Task } from "../types.js";
import {
  deletedByFromActor,
  uploadIdsIn,
  type ListDeletedTasksFilter,
  type PurgeDeletedTasksInput,
  type PurgeDeletedTasksResult,
  type RestoreTaskInput,
  type SoftDeleteTaskInput,
  type TaskTrashResult,
} from "../task-trash-common.js";
import { appendAudit } from "./audit.js";
import { appendTaskEvent, getTask } from "./tasks.js";

const CHUNK = 400;

function chunks<T>(items: readonly T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function placeholders(n: number): string {
  return Array.from({ length: n }, () => "?").join(", ");
}

function inTx(db: AgentosSqliteDb, work: () => void): void {
  const inTransaction = (db.$client as unknown as { inTransaction?: boolean }).inTransaction === true;
  if (inTransaction) work();
  else db.$client.transaction(work)();
}

// ── Desactivar ──────────────────────────────────────────────────────────────

/** Descendientes (recursivo) de una tarea que cumplen `deleted_at IS NULL` o `= stamp`. */
function descendants(db: AgentosSqliteDb, rootId: string, stamp: number | null): string[] {
  const cond = stamp === null ? "t.deleted_at IS NULL" : "t.deleted_at = @stamp";
  const rows = db.$client
    .prepare(
      `WITH RECURSIVE sub(id) AS (
         SELECT t.id FROM tasks t WHERE t.parent_task_id = @rootId AND ${cond}
         UNION
         SELECT t.id FROM tasks t JOIN sub ON t.parent_task_id = sub.id WHERE ${cond}
       )
       SELECT id FROM sub`,
    )
    .all({ rootId, stamp }) as { id: string }[];
  return rows.map((r) => r.id).filter((id) => id !== rootId);
}

/** Tareas de la lista con claim/lease vigente o con un run en cola/ejecutándose. */
function busyTaskIds(db: AgentosSqliteDb, ids: readonly string[], now: number): string[] {
  const busy = new Set<string>();
  for (const part of chunks(ids)) {
    const rows = db.$client
      .prepare(
        `SELECT t.id FROM tasks t
          WHERE t.id IN (${placeholders(part.length)})
            AND (
              (t.status = 'IN_PROGRESS' AND t.lease_until IS NOT NULL AND t.lease_until >= ?)
              OR EXISTS (SELECT 1 FROM runs r WHERE r.task_id = t.id AND r.status IN ('queued', 'running'))
            )`,
      )
      .all(...part, now) as { id: string }[];
    for (const r of rows) busy.add(r.id);
  }
  return [...busy];
}

/**
 * Manda una tarea (y sus subtareas activas, con el MISMO `deleted_at`) a la
 * papelera. Conflicto si ya está desactivada, si la versión es vieja o si ella
 * o una subtarea está en ejecución (lease vigente o run en cola/corriendo):
 * una tarea en ejecución no se desactiva.
 */
export function softDeleteTask(db: AgentosSqliteDb, id: string, input: SoftDeleteTaskInput): TaskTrashResult {
  const now = input.now ?? nowMs();
  const deletedBy = deletedByFromActor(input.actor);
  let subtaskIds: string[] = [];
  inTx(db, () => {
    const task = getTask(db, id);
    if (!task) throw errors.notFound("task", id);
    if (task.deletedAt !== null) {
      throw errors.conflict("La tarea ya está en la papelera", { taskId: id, reason: "task_already_deleted" });
    }
    if (task.version !== input.expectedVersion) throw errors.versionConflict("task", id, input.expectedVersion);
    subtaskIds = descendants(db, id, null);
    const busy = busyTaskIds(db, [id, ...subtaskIds], now);
    if (busy.length > 0) {
      throw errors.conflict("No se puede desactivar una tarea en ejecución", {
        taskId: id,
        reason: "task_running",
        runningTaskIds: busy,
      });
    }
    const res = db.$client
      .prepare(
        `UPDATE tasks SET deleted_at = @now, deleted_by = @deletedBy, version = version + 1, updated_at = @now
          WHERE id = @id AND version = @version AND deleted_at IS NULL`,
      )
      .run({ id, now, deletedBy, version: input.expectedVersion });
    if (res.changes === 0) throw errors.versionConflict("task", id, input.expectedVersion);
    for (const part of chunks(subtaskIds)) {
      db.$client
        .prepare(
          `UPDATE tasks SET deleted_at = ?, deleted_by = ?, version = version + 1, updated_at = ?
            WHERE id IN (${placeholders(part.length)}) AND deleted_at IS NULL`,
        )
        .run(now, deletedBy, now, ...part);
    }
    appendTaskEvent(db, {
      taskId: id,
      kind: "deleted",
      actor: input.actor,
      payload: { deletedAt: now, subtaskIds },
    });
    appendAudit(db, {
      actor: input.actor,
      source: input.source ?? "ui",
      action: "task.deleted",
      entityType: "task",
      entityId: id,
      before: { status: task.status, version: task.version },
      after: { deletedAt: now, deletedBy, subtaskIds },
    });
  });
  return { task: getTask(db, id)!, subtaskIds };
}

// ── Restaurar ───────────────────────────────────────────────────────────────

/**
 * Saca una tarea de la papelera junto con las subtareas que se desactivaron
 * EN LA MISMA operación (mismo `deleted_at`). Una subtarea desactivada antes,
 * por separado, se queda en la papelera.
 */
export function restoreTask(db: AgentosSqliteDb, id: string, input: RestoreTaskInput): TaskTrashResult {
  const now = input.now ?? nowMs();
  let subtaskIds: string[] = [];
  inTx(db, () => {
    const task = getTask(db, id);
    if (!task) throw errors.notFound("task", id);
    if (task.deletedAt === null) {
      throw errors.conflict("La tarea no está en la papelera", { taskId: id, reason: "task_not_deleted" });
    }
    const stamp = task.deletedAt;
    subtaskIds = descendants(db, id, stamp);
    for (const part of chunks([id, ...subtaskIds])) {
      db.$client
        .prepare(
          `UPDATE tasks SET deleted_at = NULL, deleted_by = NULL, version = version + 1, updated_at = ?
            WHERE id IN (${placeholders(part.length)}) AND deleted_at = ?`,
        )
        .run(now, ...part, stamp);
    }
    appendTaskEvent(db, {
      taskId: id,
      kind: "restored",
      actor: input.actor,
      payload: { deletedAt: stamp, subtaskIds },
    });
    appendAudit(db, {
      actor: input.actor,
      source: input.source ?? "ui",
      action: "task.restored",
      entityType: "task",
      entityId: id,
      before: { deletedAt: stamp, deletedBy: task.deletedBy },
      after: { deletedAt: null, subtaskIds },
    });
  });
  return { task: getTask(db, id)!, subtaskIds };
}

// ── Papelera ────────────────────────────────────────────────────────────────

/** Tareas desactivadas, las más recientes primero. */
export function listDeletedTasks(db: AgentosSqliteDb, filter: ListDeletedTasksFilter = {}): Task[] {
  const conds = ["t.deleted_at IS NOT NULL"];
  const params: Record<string, unknown> = { limit: filter.limit ?? 500 };
  if (filter.projectId) {
    conds.push("t.project_id = @projectId");
    params.projectId = filter.projectId;
  }
  if (filter.orgId) {
    conds.push("EXISTS (SELECT 1 FROM projects p WHERE p.id = t.project_id AND p.org_id = @orgId)");
    params.orgId = filter.orgId;
  }
  const q = filter.q?.trim();
  if (q) {
    conds.push("lower(t.title) LIKE @q ESCAPE '\\'");
    params.q = `%${q.toLowerCase().replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  }
  const rows = db.$client
    .prepare(
      `SELECT t.id FROM tasks t WHERE ${conds.join(" AND ")}
        ORDER BY t.deleted_at DESC, t.id DESC LIMIT @limit`,
    )
    .all(params) as { id: string }[];
  return rows.map((r) => getTask(db, r.id)!);
}

// ── Purga definitiva ────────────────────────────────────────────────────────

/**
 * Borra DE VERDAD las tareas con `deleted_at < now - olderThanMs`, en una
 * transacción. Resolución de dependencias (ninguna FK tiene ON DELETE):
 *
 * - `task_labels`, `task_assignees`, `task_notification_log`, `task_events`
 *   (timeline y comentarios; el FTS de comentarios se limpia por trigger) y
 *   `artifacts` → se BORRAN. `canvas_notes.image_artifact_id` que apuntara a
 *   uno de esos artefactos → NULL (la nota conserva su `image_path`, y ese
 *   archivo NO se lista para borrar).
 * - `runs.task_id` y `approvals.task_id` → NULL: son contabilidad de coste y
 *   gobierno; borrarlos cambiaría el gasto de presupuesto y la traza.
 * - Subtareas que sobreviven (restauradas por separado o desactivadas más
 *   tarde) → `parent_task_id = NULL`. Tareas que sobreviven con la purgada en
 *   `depends_on` → se quita ese id (sube `version`).
 * - `notion_import_links` de la tarea → `import_status = 'deleted_in_agentos'`
 *   para que una reimportación NO la vuelva a crear.
 * - `canvas_notes.proposals[].created_task_id` se deja tal cual (JSON sin FK):
 *   anularlo haría que "Crear tareas" la volviera a crear.
 *
 * Deja UN evento de auditoría agregado (`task.purged`) con ids y conteo, sin
 * contenido de las tareas.
 */
export function purgeDeletedTasks(db: AgentosSqliteDb, input: PurgeDeletedTasksInput): PurgeDeletedTasksResult {
  const now = input.now ?? nowMs();
  const cutoff = now - input.olderThanMs;
  const result: PurgeDeletedTasksResult = { purged: 0, cutoff, taskIds: [], artifactFiles: [], uploadIds: [] };
  inTx(db, () => {
    const doomed = db.$client
      .prepare(
        `SELECT id, project_id AS projectId, description FROM tasks
          WHERE deleted_at IS NOT NULL AND deleted_at < ? ORDER BY deleted_at ASC`,
      )
      .all(cutoff) as { id: string; projectId: string; description: string | null }[];
    if (doomed.length === 0) return;
    const ids = doomed.map((t) => t.id);
    const idSet = new Set(ids);
    const projectByTask = new Map(doomed.map((t) => [t.id, t.projectId]));
    const exec = (sqlText: (ph: string) => string, extra: unknown[] = []): void => {
      for (const part of chunks(ids)) {
        db.$client.prepare(sqlText(placeholders(part.length))).run(...extra, ...part);
      }
    };

    // Artefactos: los binarios huérfanos se devuelven al llamante (la DB no toca disco).
    for (const part of chunks(ids)) {
      const rows = db.$client
        .prepare(
          `SELECT a.id, a.task_id AS taskId, a.path, a.meta,
                  EXISTS (SELECT 1 FROM canvas_notes n WHERE n.image_artifact_id = a.id) AS usedByNote
             FROM artifacts a WHERE a.task_id IN (${placeholders(part.length)})`,
        )
        .all(...part) as { id: string; taskId: string; path: string | null; meta: string | null; usedByNote: number }[];
      for (const row of rows) {
        let storage: unknown;
        try {
          storage = row.meta ? (JSON.parse(row.meta) as { storage?: unknown }).storage : undefined;
        } catch {
          storage = undefined;
        }
        if (row.path && storage === "artifacts_root" && !row.usedByNote) {
          result.artifactFiles.push({
            artifactId: row.id,
            taskId: row.taskId,
            projectId: projectByTask.get(row.taskId)!,
            path: row.path,
          });
        }
      }
    }
    exec(
      (ph) =>
        `UPDATE canvas_notes SET image_artifact_id = NULL
          WHERE image_artifact_id IN (SELECT id FROM artifacts WHERE task_id IN (${ph}))`,
    );
    exec((ph) => `DELETE FROM artifacts WHERE task_id IN (${ph})`);
    exec((ph) => `DELETE FROM task_events WHERE task_id IN (${ph})`);
    exec((ph) => `DELETE FROM task_labels WHERE task_id IN (${ph})`);
    exec((ph) => `DELETE FROM task_assignees WHERE task_id IN (${ph})`);
    exec((ph) => `DELETE FROM task_notification_log WHERE task_id IN (${ph})`);
    exec((ph) => `UPDATE runs SET task_id = NULL WHERE task_id IN (${ph})`);
    exec((ph) => `UPDATE approvals SET task_id = NULL WHERE task_id IN (${ph})`);
    exec(
      (ph) =>
        `UPDATE notion_import_links SET import_status = 'deleted_in_agentos'
          WHERE agentos_object_kind = 'task' AND agentos_object_id IN (${ph})`,
    );
    // Jerarquía: primero se sueltan TODAS las auto-FKs que tocan el lote.
    exec((ph) => `UPDATE tasks SET parent_task_id = NULL WHERE parent_task_id IN (${ph})`);

    // depends_on (JSON sin FK) de las tareas que sobreviven.
    const withDeps = db.$client
      .prepare(`SELECT id, depends_on AS dependsOn FROM tasks WHERE depends_on IS NOT NULL AND depends_on != '[]'`)
      .all() as { id: string; dependsOn: string }[];
    const stripDeps = db.$client.prepare(
      `UPDATE tasks SET depends_on = @deps, version = version + 1, updated_at = @now WHERE id = @id`,
    );
    for (const row of withDeps) {
      if (idSet.has(row.id)) continue;
      let deps: string[];
      try {
        deps = JSON.parse(row.dependsOn) as string[];
      } catch {
        continue;
      }
      const kept = deps.filter((d) => !idSet.has(d));
      if (kept.length !== deps.length) stripDeps.run({ id: row.id, deps: JSON.stringify(kept), now });
    }

    // Imágenes subidas desde la descripción que nadie más cita.
    const candidates = new Set(doomed.flatMap((t) => uploadIdsIn(t.description)));
    const stillUsed = db.$client.prepare(
      `SELECT 1 FROM tasks WHERE description LIKE @like LIMIT 1`,
    );
    const stillUsedByNote = db.$client.prepare(
      `SELECT 1 FROM canvas_notes WHERE transcription LIKE @like OR proposals LIKE @like LIMIT 1`,
    );

    exec((ph) => `DELETE FROM tasks WHERE id IN (${ph})`);

    for (const uploadId of candidates) {
      const like = `%/api/uploads/${uploadId}%`;
      if (!stillUsed.get({ like }) && !stillUsedByNote.get({ like })) result.uploadIds.push(uploadId);
    }

    result.purged = ids.length;
    result.taskIds = ids;
    appendAudit(db, {
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
