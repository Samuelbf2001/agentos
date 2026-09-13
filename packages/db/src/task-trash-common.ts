/**
 * Piezas de la papelera de tareas compartidas por los dos motores (sin
 * dependencias de SQLite ni de Postgres): tipos de entrada/salida, el error de
 * "tarea en la papelera" y dos utilidades puras.
 */
import { errors, type AuditSource } from "@agentos/shared";
import type { Task } from "./types.js";

/** Una tarea en la papelera es de solo lectura hasta que se restaura (409 `conflict`). */
export function taskDeletedConflict(id: string) {
  return errors.conflict("La tarea está en la papelera: restáurala antes de modificarla", {
    taskId: id,
    reason: "task_deleted",
  });
}

// ── Tipos compartidos por los dos motores ───────────────────────────────────

export interface SoftDeleteTaskInput {
  /** ActorRef (`person:<id>`, `agent:<slug>`, `system:<x>`). */
  actor: string;
  expectedVersion: number;
  source?: AuditSource;
  /** Reloj inyectable (tests). */
  now?: number;
}

export interface RestoreTaskInput {
  actor: string;
  source?: AuditSource;
  now?: number;
}

export interface TaskTrashResult {
  task: Task;
  /** Subtareas desactivadas/restauradas en cascada con el MISMO `deleted_at`. */
  subtaskIds: string[];
}

export interface ListDeletedTasksFilter {
  projectId?: string;
  orgId?: string;
  /** Texto libre sobre el título (sin distinguir mayúsculas). */
  q?: string;
  limit?: number;
}

export interface PurgeDeletedTasksInput {
  /** Antigüedad mínima en la papelera (ms). 90 días = 7_776_000_000. */
  olderThanMs: number;
  now?: number;
  actor?: string;
}

/** Binario de un artefacto que quedó huérfano en disco tras la purga. */
export interface PurgedArtifactFile {
  artifactId: string;
  taskId: string;
  projectId: string;
  /** Ruta RELATIVA a la raíz de artefactos del proyecto (tal cual `artifacts.path`). */
  path: string;
}

export interface PurgeDeletedTasksResult {
  purged: number;
  cutoff: number;
  taskIds: string[];
  /** Archivos de artefacto (storage `artifacts_root`) que ya no referencia nadie. */
  artifactFiles: PurgedArtifactFile[];
  /** Ids de `/api/uploads/<id>` citados SOLO por descripciones de tareas purgadas. */
  uploadIds: string[];
}

/** `person:<id>` → `<id>`; cualquier otro actor se guarda tal cual. */
export function deletedByFromActor(actor: string): string {
  return actor.startsWith("person:") ? actor.slice("person:".length) : actor;
}

export const UPLOAD_REF_RE = /\/api\/uploads\/([0-9a-f-]{36})/g;

export function uploadIdsIn(text: string | null | undefined): string[] {
  if (!text) return [];
  return [...new Set([...text.matchAll(UPLOAD_REF_RE)].map((m) => m[1]!))];
}

