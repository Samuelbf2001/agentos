/**
 * Papelera de tareas en apps/api: presentación (`deleted_at`, `deleted_by`,
 * `purge_at`) y el reloj que purga DE VERDAD las tareas con más de N días en
 * la papelera.
 *
 * - `AGENTOS_TASK_PURGE_DAYS` (default 90): antigüedad mínima para purgar.
 * - `AGENTOS_TASK_PURGE_DISABLED=1`: el reloj no arranca (la papelera sigue
 *   funcionando; solo no se borra nada definitivamente).
 *
 * El reloj corre una vez al arrancar y luego cada 24 h. Los tests nunca lo
 * arrancan: `buildApi` lo deja parado con `autoStartLoops: false` y la purga
 * se prueba con `runOnce` y un reloj inyectado.
 */
import fs from "node:fs";
import { getProject, purgeDeletedTasks, type AgentosDb, type PurgeDeletedTasksResult, type Task } from "@agentos/db";
import { artifactsRoot, resolveArtifactPath } from "./artifact-files.js";
import { resolveUploadPath } from "./uploads.js";

export const DEFAULT_TASK_PURGE_DAYS = 90;
export const DAY_MS = 86_400_000;
export const DEFAULT_TASK_PURGE_INTERVAL_MS = DAY_MS;

export function resolveTaskPurgeDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.AGENTOS_TASK_PURGE_DAYS?.trim();
  if (!raw) return DEFAULT_TASK_PURGE_DAYS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : DEFAULT_TASK_PURGE_DAYS;
}

export function resolveTaskPurgeDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.AGENTOS_TASK_PURGE_DISABLED ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true";
}

/** Campos de papelera del contrato HTTP (snake_case). null si la tarea está activa. */
export interface TaskTrashFields {
  deleted_at: number | null;
  deleted_by: string | null;
  purge_at: number | null;
}

export function trashFields(
  task: Pick<Task, "deletedAt" | "deletedBy">,
  purgeDays: number = resolveTaskPurgeDays(),
): TaskTrashFields {
  const deletedAt = task.deletedAt ?? null;
  return {
    deleted_at: deletedAt,
    deleted_by: deletedAt === null ? null : (task.deletedBy ?? null),
    purge_at: deletedAt === null ? null : deletedAt + purgeDays * DAY_MS,
  };
}

/** La tarea tal cual + los tres campos de papelera. */
export function withTrashFields<T extends Pick<Task, "deletedAt" | "deletedBy">>(
  task: T,
  purgeDays?: number,
): T & TaskTrashFields {
  return { ...task, ...trashFields(task, purgeDays) };
}

export interface TaskPurgeLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface TaskPurgeScheduler {
  readonly days: number;
  readonly intervalMs: number;
  readonly disabled: boolean;
  readonly running: boolean;
  start(): void;
  stop(): void;
  /** Un ciclo ya (tests y operación). */
  runOnce(): Promise<PurgeDeletedTasksResult & { filesRemoved: number }>;
}

export interface TaskPurgeSchedulerOptions {
  db: AgentosDb;
  days?: number;
  intervalMs?: number;
  disabled?: boolean;
  now?: () => number;
  logger?: TaskPurgeLogger;
}

const consoleLogger: TaskPurgeLogger = {
  info: (obj, msg) => console.info(`[agentos-api] ${msg}`, obj),
  warn: (obj, msg) => console.warn(`[agentos-api] ${msg}`, obj),
};

/** Borra en disco los binarios que la purga dejó huérfanos. Best-effort: nunca lanza. */
async function removeOrphanFiles(db: AgentosDb, result: PurgeDeletedTasksResult): Promise<number> {
  let removed = 0;
  for (const file of result.artifactFiles) {
    try {
      const project = (await getProject(db, file.projectId)) ?? null;
      const absolute = resolveArtifactPath(artifactsRoot(project), file.path);
      if (fs.existsSync(absolute)) {
        fs.rmSync(absolute, { force: true });
        removed += 1;
      }
    } catch {
      // Ruta fuera de la raíz o disco no disponible: el registro ya no existe; se ignora.
    }
  }
  for (const uploadId of result.uploadIds) {
    try {
      const found = await resolveUploadPath(uploadId);
      if (found) {
        fs.rmSync(found.path, { force: true });
        removed += 1;
      }
    } catch {
      // Igual que arriba.
    }
  }
  return removed;
}

export function createTaskPurgeScheduler(options: TaskPurgeSchedulerOptions): TaskPurgeScheduler {
  const days = options.days ?? resolveTaskPurgeDays();
  const intervalMs = options.intervalMs ?? DEFAULT_TASK_PURGE_INTERVAL_MS;
  const disabled = options.disabled ?? resolveTaskPurgeDisabled();
  const now = options.now ?? Date.now;
  const logger = options.logger ?? consoleLogger;
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight = false;

  async function runOnce(): Promise<PurgeDeletedTasksResult & { filesRemoved: number }> {
    const result = await purgeDeletedTasks(options.db, {
      olderThanMs: days * DAY_MS,
      now: now(),
      actor: "system:task-purge",
    });
    const filesRemoved = result.purged > 0 ? await removeOrphanFiles(options.db, result) : 0;
    if (result.purged > 0) {
      // Solo conteos: ni títulos ni contenido de las tareas purgadas.
      logger.info({ purged: result.purged, filesRemoved, days }, "purga de la papelera de tareas");
    }
    return { ...result, filesRemoved };
  }

  async function tick(): Promise<void> {
    if (inFlight) return;
    inFlight = true;
    try {
      await runOnce();
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "la purga de la papelera falló");
    } finally {
      inFlight = false;
    }
  }

  return {
    days,
    intervalMs,
    disabled,
    get running() {
      return timer !== null;
    },
    start(): void {
      if (timer || disabled || intervalMs <= 0) return;
      // Una línea al arrancar: sin ella, en producción no hay forma de saber
      // si la purga está viva hasta que purga algo (90 días).
      logger.info({ days, intervalMs }, "purga de la papelera activa");
      void tick();
      timer = setInterval(() => void tick(), intervalMs);
      timer.unref?.();
    },
    stop(): void {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
    runOnce,
  };
}
