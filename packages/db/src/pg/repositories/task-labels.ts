/** Espejo Postgres de src/repositories/task-labels.ts — misma superficie, asíncrona (§NFR-9). */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { errors, nowMs } from "@agentos/shared";
import type { AgentosPgDb } from "../client-pg.js";
import { taskLabels, tasks } from "../schema-pg.js";
import type { TaskLabel } from "../types-pg.js";

export const MAX_LABEL_LENGTH = 40;
export const MAX_LABELS_PER_TASK = 20;

export function normalizeLabel(raw: string): string {
  return raw.trim().replace(/\s+/g, " ").toLocaleLowerCase("es");
}

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

export async function listTaskLabels(db: AgentosPgDb, taskId: string): Promise<string[]> {
  const rows = await db
    .select({ label: taskLabels.label })
    .from(taskLabels)
    .where(eq(taskLabels.taskId, taskId))
    .orderBy(asc(taskLabels.label));
  return rows.map((row) => row.label);
}

export async function listLabelsForTasks(
  db: AgentosPgDb,
  taskIds: readonly string[],
): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (taskIds.length === 0) return map;
  const rows = await db
    .select({ taskId: taskLabels.taskId, label: taskLabels.label })
    .from(taskLabels)
    .where(inArray(taskLabels.taskId, [...taskIds]))
    .orderBy(asc(taskLabels.label));
  for (const row of rows) {
    const list = map.get(row.taskId) ?? [];
    list.push(row.label);
    map.set(row.taskId, list);
  }
  return map;
}

export async function replaceTaskLabels(
  db: AgentosPgDb,
  taskId: string,
  labels: readonly string[],
  createdBy: string | null = null,
): Promise<string[]> {
  const normalized = normalizeLabels(labels);
  await db.transaction(async (tx) => {
    const [task] = await tx.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, taskId)).limit(1);
    if (!task) throw errors.notFound("task", taskId);
    await tx.delete(taskLabels).where(eq(taskLabels.taskId, taskId));
    const now = nowMs();
    if (normalized.length > 0) {
      await tx
        .insert(taskLabels)
        .values(normalized.map((label) => ({ taskId, label, createdBy, createdAt: now })));
    }
  });
  return normalized;
}

export async function addTaskLabels(
  db: AgentosPgDb,
  taskId: string,
  labels: readonly string[],
  createdBy: string | null = null,
): Promise<string[]> {
  const current = await listTaskLabels(db, taskId);
  return replaceTaskLabels(db, taskId, [...current, ...labels], createdBy);
}

export async function removeTaskLabel(
  db: AgentosPgDb,
  taskId: string,
  label: string,
): Promise<string[]> {
  const normalized = normalizeLabel(label);
  await db
    .delete(taskLabels)
    .where(and(eq(taskLabels.taskId, taskId), eq(taskLabels.label, normalized)));
  return listTaskLabels(db, taskId);
}

export interface LabelUsage {
  label: string;
  count: number;
}

export async function listLabelCatalog(
  db: AgentosPgDb,
  filter: { projectId?: string } = {},
): Promise<LabelUsage[]> {
  const rows = filter.projectId
    ? await db
        .select({ label: taskLabels.label, count: sql<number>`count(*)` })
        .from(taskLabels)
        .innerJoin(tasks, eq(tasks.id, taskLabels.taskId))
        .where(eq(tasks.projectId, filter.projectId))
        .groupBy(taskLabels.label)
        .orderBy(asc(taskLabels.label))
    : await db
        .select({ label: taskLabels.label, count: sql<number>`count(*)` })
        .from(taskLabels)
        .groupBy(taskLabels.label)
        .orderBy(asc(taskLabels.label));
  return rows.map((row) => ({ label: row.label, count: Number(row.count) }));
}

export async function listTaskLabelRows(db: AgentosPgDb, taskId: string): Promise<TaskLabel[]> {
  return await db
    .select()
    .from(taskLabels)
    .where(eq(taskLabels.taskId, taskId))
    .orderBy(asc(taskLabels.label));
}
