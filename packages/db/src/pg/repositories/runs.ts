/** Espejo Postgres de src/repositories/runs.ts — misma superficie, asíncrona (§NFR-9). */
import { and, asc, desc, eq, gte, lt, sql } from "drizzle-orm";
import { errors, newId, nowMs, type RunStatus } from "@agentos/shared";
import type { AgentosPgDb } from "../client-pg.js";
import { runs, spans } from "../schema-pg.js";
import type { NewRun, NewSpan, Run, Span } from "../types-pg.js";

// ── Runs ────────────────────────────────────────────────────────────────────

/**
 * Crea un run. `root_run_id` desnormalizado (ARCHITECTURE §10):
 * si tiene padre hereda su raíz; si no, es su propia raíz.
 */
export async function createRun(
  db: AgentosPgDb,
  input: Omit<NewRun, "id" | "createdAt" | "rootRunId"> & { id?: string; rootRunId?: string },
): Promise<Run> {
  const id = input.id ?? newId();
  let rootRunId = input.rootRunId;
  if (!rootRunId) {
    if (input.parentRunId) {
      const parent = await getRun(db, input.parentRunId);
      if (!parent) throw errors.notFound("run", input.parentRunId);
      rootRunId = parent.rootRunId;
    } else {
      rootRunId = id;
    }
  }
  const row: NewRun = { ...input, id, rootRunId, createdAt: nowMs() };
  await db.insert(runs).values(row);
  return (await getRun(db, id))!;
}

export async function getRun(db: AgentosPgDb, id: string): Promise<Run | undefined> {
  const [row] = await db.select().from(runs).where(eq(runs.id, id)).limit(1);
  return row;
}

export async function updateRun(
  db: AgentosPgDb,
  id: string,
  patch: Partial<Omit<Run, "id" | "createdAt" | "rootRunId">>,
): Promise<Run> {
  const updated = await db.update(runs).set(patch).where(eq(runs.id, id)).returning({ id: runs.id });
  if (updated.length === 0) throw errors.notFound("run", id);
  return (await getRun(db, id))!;
}

/** Árbol completo de un run raíz sin recursión (índice runs(root_run_id)). */
export async function listRunsByRoot(db: AgentosPgDb, rootRunId: string): Promise<Run[]> {
  return await db.select().from(runs).where(eq(runs.rootRunId, rootRunId)).orderBy(asc(runs.createdAt));
}

export async function listRunsForTask(db: AgentosPgDb, taskId: string): Promise<Run[]> {
  return await db.select().from(runs).where(eq(runs.taskId, taskId)).orderBy(asc(runs.createdAt));
}

// ── Extensiones B2 (RunnerPool / observabilidad §10) ────────────────────────

/** Runs por estado (cola FIFO visible del RunnerPool: status='queued' consultable). */
export async function listRunsByStatus(db: AgentosPgDb, status: RunStatus): Promise<Run[]> {
  return await db.select().from(runs).where(eq(runs.status, status)).orderBy(asc(runs.createdAt));
}

/**
 * Suma de runs.cost_usd creados en la ventana [fromMs, toMs).
 * Presupuesto por día del RunnerPool (NFR-5). Los runs con cost_usd NULL
 * (proveedor sin coste reportado) no suman — nunca cero inferido, y el
 * presupuesto solo puede vigilar lo que se reporta.
 */
export async function sumRunCostBetween(db: AgentosPgDb, fromMs: number, toMs: number): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${runs.costUsd}), 0)::float8` })
    .from(runs)
    .where(and(gte(runs.createdAt, fromMs), lt(runs.createdAt, toMs)));
  return Number(row?.total ?? 0);
}

/**
 * M3 (§13.4): gasto acumulado de un proyecto — suma de runs.cost_usd de TODOS
 * sus runs (cualquier estado). Corte de presupuesto de fase del despachador y
 * exposición en system.health. NULL no suma — nunca cero inferido (CA-7.2).
 */
export async function sumRunCostForProject(db: AgentosPgDb, projectId: string): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${runs.costUsd}), 0)::float8` })
    .from(runs)
    .where(eq(runs.projectId, projectId));
  return Number(row?.total ?? 0);
}

/** B4 (lectura nueva): listado general de runs con filtros para GET /api/runs. */
export interface RunListFilter {
  status?: RunStatus;
  taskId?: string;
  projectId?: string;
  agentId?: string;
  limit?: number;
}

export async function listRuns(db: AgentosPgDb, filter: RunListFilter = {}): Promise<Run[]> {
  const conds = [];
  if (filter.status) conds.push(eq(runs.status, filter.status));
  if (filter.taskId) conds.push(eq(runs.taskId, filter.taskId));
  if (filter.projectId) conds.push(eq(runs.projectId, filter.projectId));
  if (filter.agentId) conds.push(eq(runs.agentId, filter.agentId));
  const base = db.select().from(runs);
  const q = conds.length > 0 ? base.where(and(...conds)) : base;
  return await q.orderBy(desc(runs.createdAt)).limit(filter.limit ?? 100);
}

// ── Spans ───────────────────────────────────────────────────────────────────

export async function addSpan(
  db: AgentosPgDb,
  input: Omit<NewSpan, "id" | "startedAt"> & { id?: string; startedAt?: number },
): Promise<Span> {
  const row: NewSpan = { ...input, id: input.id ?? newId(), startedAt: input.startedAt ?? nowMs() };
  await db.insert(spans).values(row);
  const [saved] = await db.select().from(spans).where(eq(spans.id, row.id!)).limit(1);
  return saved!;
}

export async function endSpan(
  db: AgentosPgDb,
  id: string,
  patch: { status?: string; attrs?: Record<string, unknown>; endedAt?: number } = {},
): Promise<Span> {
  const updated = await db
    .update(spans)
    .set({ ...patch, endedAt: patch.endedAt ?? nowMs() })
    .where(eq(spans.id, id))
    .returning({ id: spans.id });
  if (updated.length === 0) throw errors.notFound("span", id);
  const [saved] = await db.select().from(spans).where(eq(spans.id, id)).limit(1);
  return saved!;
}

export async function listSpans(db: AgentosPgDb, runId: string): Promise<Span[]> {
  return await db.select().from(spans).where(eq(spans.runId, runId)).orderBy(asc(spans.startedAt));
}
