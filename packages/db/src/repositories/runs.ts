import { and, asc, desc, eq } from "drizzle-orm";
import { errors, newId, nowMs, type RunStatus } from "@agentos/shared";
import type { AgentosSqliteDb } from "../client.js";
import { runs, spans } from "../schema.js";
import type { NewRun, NewSpan, Run, Span } from "../types.js";

// ── Runs ────────────────────────────────────────────────────────────────────

/**
 * Crea un run. `root_run_id` desnormalizado (ARCHITECTURE §10):
 * si tiene padre hereda su raíz; si no, es su propia raíz.
 */
export function createRun(
  db: AgentosSqliteDb,
  input: Omit<NewRun, "id" | "createdAt" | "rootRunId"> & { id?: string; rootRunId?: string },
): Run {
  const id = input.id ?? newId();
  let rootRunId = input.rootRunId;
  if (!rootRunId) {
    if (input.parentRunId) {
      const parent = getRun(db, input.parentRunId);
      if (!parent) throw errors.notFound("run", input.parentRunId);
      rootRunId = parent.rootRunId;
    } else {
      rootRunId = id;
    }
  }
  const row: NewRun = { ...input, id, rootRunId, createdAt: nowMs() };
  db.insert(runs).values(row).run();
  return getRun(db, id)!;
}

export function getRun(db: AgentosSqliteDb, id: string): Run | undefined {
  return db.select().from(runs).where(eq(runs.id, id)).get();
}

export function updateRun(
  db: AgentosSqliteDb,
  id: string,
  patch: Partial<Omit<Run, "id" | "createdAt" | "rootRunId">>,
): Run {
  const res = db.update(runs).set(patch).where(eq(runs.id, id)).run();
  if (res.changes === 0) throw errors.notFound("run", id);
  return getRun(db, id)!;
}

/** Árbol completo de un run raíz sin recursión (índice runs(root_run_id)). */
export function listRunsByRoot(db: AgentosSqliteDb, rootRunId: string): Run[] {
  return db
    .select()
    .from(runs)
    .where(eq(runs.rootRunId, rootRunId))
    .orderBy(asc(runs.createdAt))
    .all();
}

export function listRunsForTask(db: AgentosSqliteDb, taskId: string): Run[] {
  return db.select().from(runs).where(eq(runs.taskId, taskId)).orderBy(asc(runs.createdAt)).all();
}

// ── Extensiones B2 (RunnerPool / observabilidad §10) ────────────────────────

/** Runs por estado (cola FIFO visible del RunnerPool: status='queued' consultable). */
export function listRunsByStatus(db: AgentosSqliteDb, status: RunStatus): Run[] {
  return db.select().from(runs).where(eq(runs.status, status)).orderBy(asc(runs.createdAt)).all();
}

/**
 * Suma de runs.cost_usd creados en la ventana [fromMs, toMs).
 * Presupuesto por día del RunnerPool (NFR-5). Los runs con cost_usd NULL
 * (proveedor sin coste reportado) no suman — nunca cero inferido, y el
 * presupuesto solo puede vigilar lo que se reporta.
 */
export function sumRunCostBetween(db: AgentosSqliteDb, fromMs: number, toMs: number): number {
  const row = db.$client
    .prepare(
      `SELECT coalesce(sum(cost_usd), 0) AS total FROM runs WHERE created_at >= ? AND created_at < ?`,
    )
    .get(fromMs, toMs) as { total: number };
  return row.total;
}

/**
 * M3 (§13.4): gasto acumulado de un proyecto — suma de runs.cost_usd de TODOS
 * sus runs (cualquier estado). Corte de presupuesto de fase del despachador y
 * exposición en system.health. NULL no suma — nunca cero inferido (CA-7.2).
 */
export function sumRunCostForProject(db: AgentosSqliteDb, projectId: string): number {
  const row = db.$client
    .prepare(`SELECT coalesce(sum(cost_usd), 0) AS total FROM runs WHERE project_id = ?`)
    .get(projectId) as { total: number };
  return row.total;
}

/** B4 (lectura nueva): listado general de runs con filtros para GET /api/runs. */
export interface RunListFilter {
  status?: RunStatus;
  taskId?: string;
  projectId?: string;
  agentId?: string;
  limit?: number;
}

export function listRuns(db: AgentosSqliteDb, filter: RunListFilter = {}): Run[] {
  const conds = [];
  if (filter.status) conds.push(eq(runs.status, filter.status));
  if (filter.taskId) conds.push(eq(runs.taskId, filter.taskId));
  if (filter.projectId) conds.push(eq(runs.projectId, filter.projectId));
  if (filter.agentId) conds.push(eq(runs.agentId, filter.agentId));
  const base = db.select().from(runs);
  const q = conds.length > 0 ? base.where(and(...conds)) : base;
  return q.orderBy(desc(runs.createdAt)).limit(filter.limit ?? 100).all();
}

// ── Spans ───────────────────────────────────────────────────────────────────

export function addSpan(
  db: AgentosSqliteDb,
  input: Omit<NewSpan, "id" | "startedAt"> & { id?: string; startedAt?: number },
): Span {
  const row: NewSpan = { ...input, id: input.id ?? newId(), startedAt: input.startedAt ?? nowMs() };
  db.insert(spans).values(row).run();
  return db.select().from(spans).where(eq(spans.id, row.id!)).get()!;
}

export function endSpan(
  db: AgentosSqliteDb,
  id: string,
  patch: { status?: string; attrs?: Record<string, unknown>; endedAt?: number } = {},
): Span {
  const res = db
    .update(spans)
    .set({ ...patch, endedAt: patch.endedAt ?? nowMs() })
    .where(eq(spans.id, id))
    .run();
  if (res.changes === 0) throw errors.notFound("span", id);
  return db.select().from(spans).where(eq(spans.id, id)).get()!;
}

export function listSpans(db: AgentosSqliteDb, runId: string): Span[] {
  return db.select().from(spans).where(eq(spans.runId, runId)).orderBy(asc(spans.startedAt)).all();
}
