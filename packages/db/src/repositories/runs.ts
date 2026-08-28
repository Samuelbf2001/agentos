import { asc, eq } from "drizzle-orm";
import { errors, newId, nowMs, type RunStatus } from "@agentos/shared";
import type { AgentosDb } from "../client.js";
import { runs, spans } from "../schema.js";
import type { NewRun, NewSpan, Run, Span } from "../types.js";

// ── Runs ────────────────────────────────────────────────────────────────────

/**
 * Crea un run. `root_run_id` desnormalizado (ARCHITECTURE §10):
 * si tiene padre hereda su raíz; si no, es su propia raíz.
 */
export function createRun(
  db: AgentosDb,
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

export function getRun(db: AgentosDb, id: string): Run | undefined {
  return db.select().from(runs).where(eq(runs.id, id)).get();
}

export function updateRun(
  db: AgentosDb,
  id: string,
  patch: Partial<Omit<Run, "id" | "createdAt" | "rootRunId">>,
): Run {
  const res = db.update(runs).set(patch).where(eq(runs.id, id)).run();
  if (res.changes === 0) throw errors.notFound("run", id);
  return getRun(db, id)!;
}

/** Árbol completo de un run raíz sin recursión (índice runs(root_run_id)). */
export function listRunsByRoot(db: AgentosDb, rootRunId: string): Run[] {
  return db
    .select()
    .from(runs)
    .where(eq(runs.rootRunId, rootRunId))
    .orderBy(asc(runs.createdAt))
    .all();
}

export function listRunsForTask(db: AgentosDb, taskId: string): Run[] {
  return db.select().from(runs).where(eq(runs.taskId, taskId)).orderBy(asc(runs.createdAt)).all();
}

// ── Extensiones B2 (RunnerPool / observabilidad §10) ────────────────────────

/** Runs por estado (cola FIFO visible del RunnerPool: status='queued' consultable). */
export function listRunsByStatus(db: AgentosDb, status: RunStatus): Run[] {
  return db.select().from(runs).where(eq(runs.status, status)).orderBy(asc(runs.createdAt)).all();
}

/**
 * Suma de runs.cost_usd creados en la ventana [fromMs, toMs).
 * Presupuesto por día del RunnerPool (NFR-5). Los runs con cost_usd NULL
 * (proveedor sin coste reportado) no suman — nunca cero inferido, y el
 * presupuesto solo puede vigilar lo que se reporta.
 */
export function sumRunCostBetween(db: AgentosDb, fromMs: number, toMs: number): number {
  const row = db.$client
    .prepare(
      `SELECT coalesce(sum(cost_usd), 0) AS total FROM runs WHERE created_at >= ? AND created_at < ?`,
    )
    .get(fromMs, toMs) as { total: number };
  return row.total;
}

// ── Spans ───────────────────────────────────────────────────────────────────

export function addSpan(
  db: AgentosDb,
  input: Omit<NewSpan, "id" | "startedAt"> & { id?: string; startedAt?: number },
): Span {
  const row: NewSpan = { ...input, id: input.id ?? newId(), startedAt: input.startedAt ?? nowMs() };
  db.insert(spans).values(row).run();
  return db.select().from(spans).where(eq(spans.id, row.id!)).get()!;
}

export function endSpan(
  db: AgentosDb,
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

export function listSpans(db: AgentosDb, runId: string): Span[] {
  return db.select().from(spans).where(eq(spans.runId, runId)).orderBy(asc(spans.startedAt)).all();
}
