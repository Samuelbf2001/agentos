/**
 * Etiquetas de tarea (tabla de unión `task_labels`).
 *
 * Se eligió una tabla de unión y no un JSON en `tasks` porque el tablero y la
 * vista "Mis tareas" filtran por etiqueta: una unión se indexa igual en SQLite
 * y en Postgres, mientras que un array JSON obligaría a un escaneo en SQLite.
 *
 * `label` se persiste normalizada (minúsculas, espacios colapsados) para que
 * "Cliente" y "cliente " sean la misma etiqueta y el filtro sea determinista.
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { errors, nowMs } from "@agentos/shared";
import type { AgentosDb } from "../client.js";
import { taskLabels, tasks } from "../schema.js";
import type { TaskLabel } from "../types.js";

export const MAX_LABEL_LENGTH = 40;
export const MAX_LABELS_PER_TASK = 20;

/** Minúsculas + espacios colapsados. Nunca inventa una etiqueta vacía. */
export function normalizeLabel(raw: string): string {
  return raw.trim().replace(/\s+/g, " ").toLocaleLowerCase("es");
}

/** Normaliza, deduplica y valida una lista de entrada del usuario. */
export function normalizeLabels(raw: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const candidate of raw) {
    const label = normalizeLabel(candidate);
    if (!label) continue;
    if (label.length > MAX_LABEL_LENGTH) {
      throw errors.validation(`Una etiqueta no puede superar ${MAX_LABEL_LENGTH} caracteres`, { label });
    }
    if (seen.has(label)) continue;
    seen.add(label);
    out.push(label);
  }
  if (out.length > MAX_LABELS_PER_TASK) {
    throw errors.validation(`Una tarea admite como máximo ${MAX_LABELS_PER_TASK} etiquetas`, {
      count: out.length,
    });
  }
  return out.sort();
}

export function listTaskLabels(db: AgentosDb, taskId: string): string[] {
  return db
    .select({ label: taskLabels.label })
    .from(taskLabels)
    .where(eq(taskLabels.taskId, taskId))
    .orderBy(asc(taskLabels.label))
    .all()
    .map((row) => row.label);
}

/** Etiquetas de varias tareas en una sola consulta (evita N+1 en el tablero). */
export function listLabelsForTasks(db: AgentosDb, taskIds: readonly string[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  if (taskIds.length === 0) return map;
  const rows = db
    .select({ taskId: taskLabels.taskId, label: taskLabels.label })
    .from(taskLabels)
    .where(inArray(taskLabels.taskId, [...taskIds]))
    .orderBy(asc(taskLabels.label))
    .all();
  for (const row of rows) {
    const list = map.get(row.taskId) ?? [];
    list.push(row.label);
    map.set(row.taskId, list);
  }
  return map;
}

/**
 * Reemplaza el conjunto completo de etiquetas de una tarea. No toca
 * `tasks.version`: una etiqueta es metadato de clasificación, no una
 * transición de la máquina de estados, y no debe invalidar el
 * `expected_version` que el humano tiene abierto en la ficha.
 */
export function replaceTaskLabels(
  db: AgentosDb,
  taskId: string,
  labels: readonly string[],
  createdBy: string | null = null,
): string[] {
  const normalized = normalizeLabels(labels);
  const work = (): void => {
    const task = db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, taskId)).get();
    if (!task) throw errors.notFound("task", taskId);
    db.delete(taskLabels).where(eq(taskLabels.taskId, taskId)).run();
    const now = nowMs();
    for (const label of normalized) {
      db.insert(taskLabels).values({ taskId, label, createdBy, createdAt: now }).run();
    }
  };
  const inTransaction = (db.$client as unknown as { inTransaction?: boolean }).inTransaction === true;
  if (inTransaction) work();
  else db.$client.transaction(work)();
  return normalized;
}

/** Añade etiquetas sin borrar las existentes (idempotente por par). */
export function addTaskLabels(
  db: AgentosDb,
  taskId: string,
  labels: readonly string[],
  createdBy: string | null = null,
): string[] {
  const current = listTaskLabels(db, taskId);
  return replaceTaskLabels(db, taskId, [...current, ...labels], createdBy);
}

export function removeTaskLabel(db: AgentosDb, taskId: string, label: string): string[] {
  const normalized = normalizeLabel(label);
  db.delete(taskLabels)
    .where(and(eq(taskLabels.taskId, taskId), eq(taskLabels.label, normalized)))
    .run();
  return listTaskLabels(db, taskId);
}

export interface LabelUsage {
  label: string;
  count: number;
}

/**
 * Catálogo de etiquetas en uso, con su frecuencia. Opcionalmente acotado a un
 * proyecto para que el filtro del tablero no ofrezca etiquetas de otro cliente.
 */
export function listLabelCatalog(
  db: AgentosDb,
  filter: { projectId?: string } = {},
): LabelUsage[] {
  const rows = filter.projectId
    ? db
        .select({ label: taskLabels.label, count: sql<number>`count(*)` })
        .from(taskLabels)
        .innerJoin(tasks, eq(tasks.id, taskLabels.taskId))
        .where(eq(tasks.projectId, filter.projectId))
        .groupBy(taskLabels.label)
        .orderBy(asc(taskLabels.label))
        .all()
    : db
        .select({ label: taskLabels.label, count: sql<number>`count(*)` })
        .from(taskLabels)
        .groupBy(taskLabels.label)
        .orderBy(asc(taskLabels.label))
        .all();
  return rows.map((row) => ({ label: row.label, count: Number(row.count) }));
}

/** Filas crudas (para migración/portabilidad). */
export function listTaskLabelRows(db: AgentosDb, taskId: string): TaskLabel[] {
  return db
    .select()
    .from(taskLabels)
    .where(eq(taskLabels.taskId, taskId))
    .orderBy(asc(taskLabels.label))
    .all();
}
