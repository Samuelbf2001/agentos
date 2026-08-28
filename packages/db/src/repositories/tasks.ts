import { and, asc, eq, sql } from "drizzle-orm";
import { errors, newId, nowMs, type TaskStatus } from "@agentos/shared";
import type { AgentosDb } from "../client.js";
import { artifacts, taskEvents, tasks } from "../schema.js";
import type { Artifact, NewArtifact, NewTask, NewTaskEvent, Task, TaskEvent } from "../types.js";

// ── CRUD ────────────────────────────────────────────────────────────────────

export function createTask(
  db: AgentosDb,
  input: Omit<NewTask, "id" | "createdAt" | "updatedAt" | "version"> & { id?: string },
): Task {
  const now = nowMs();
  const row: NewTask = { ...input, id: input.id ?? newId(), createdAt: now, updatedAt: now };
  db.insert(tasks).values(row).run();
  return getTask(db, row.id!)!;
}

export function getTask(db: AgentosDb, id: string): Task | undefined {
  return db.select().from(tasks).where(eq(tasks.id, id)).get();
}

export function listTasks(
  db: AgentosDb,
  filter: { projectId?: string; status?: TaskStatus; assigneeAgentId?: string } = {},
): Task[] {
  const conds = [];
  if (filter.projectId) conds.push(eq(tasks.projectId, filter.projectId));
  if (filter.status) conds.push(eq(tasks.status, filter.status));
  if (filter.assigneeAgentId) conds.push(eq(tasks.assigneeAgentId, filter.assigneeAgentId));
  const base = db.select().from(tasks);
  const q = conds.length > 0 ? base.where(and(...conds)) : base;
  return q.orderBy(asc(tasks.status), asc(tasks.orderKey)).all();
}

/** Tablero de un proyecto: usa el índice tasks(project_id, status, order_key). */
export function boardTasks(db: AgentosDb, projectId: string): Task[] {
  return db
    .select()
    .from(tasks)
    .where(eq(tasks.projectId, projectId))
    .orderBy(asc(tasks.status), asc(tasks.orderKey))
    .all();
}

/**
 * Actualización con optimistic locking (`expected_version` de ARCHITECTURE §6):
 * conflicto obliga a releer, no last-write-wins.
 */
export function updateTask(
  db: AgentosDb,
  id: string,
  patch: Partial<Omit<Task, "id" | "createdAt" | "version">>,
  expectedVersion: number,
): Task {
  const res = db
    .update(tasks)
    .set({ ...patch, updatedAt: nowMs(), version: sql`${tasks.version} + 1` })
    .where(sql`${tasks.id} = ${id} AND ${tasks.version} = ${expectedVersion}`)
    .run();
  if (res.changes === 0) {
    if (!getTask(db, id)) throw errors.notFound("task", id);
    throw errors.versionConflict("task", id, expectedVersion);
  }
  return getTask(db, id)!;
}

// ── Claim atómico + lease (patrón work-queue, ARCHITECTURE §6) ──────────────

export interface ClaimResult {
  claimed: boolean;
  task?: Task;
}

/**
 * Claim atómico a nivel SQL: `UPDATE … WHERE status='READY' AND (lease vencido o nulo)`.
 * `changes = 0` significa carrera perdida → `{ claimed: false }` (CA-3.2).
 * El motor completo (despachador, latido, reaper) llega en B3; el patrón SQL se valida aquí.
 */
export function claimTask(
  db: AgentosDb,
  input: { taskId: string; agentId: string; leaseMs?: number; runId?: string },
): ClaimResult {
  const now = nowMs();
  const leaseUntil = now + (input.leaseMs ?? 60_000);
  const res = db.$client
    .prepare(
      `UPDATE tasks
       SET status = 'IN_PROGRESS',
           lease_until = @leaseUntil,
           attempts = attempts + 1,
           version = version + 1,
           updated_at = @now
       WHERE id = @taskId
         AND status = 'READY'
         AND (lease_until IS NULL OR lease_until < @now)`,
    )
    .run({ taskId: input.taskId, leaseUntil, now });
  if (res.changes === 0) return { claimed: false };

  const task = getTask(db, input.taskId)!;
  appendTaskEvent(db, {
    taskId: task.id,
    runId: input.runId ?? null,
    kind: "claimed",
    fromStatus: "READY",
    toStatus: "IN_PROGRESS",
    actor: `agent:${input.agentId}`,
    payload: { leaseUntil },
  });
  return { claimed: true, task };
}

/** Latido: renueva el lease de una tarea IN_PROGRESS. */
export function renewLease(db: AgentosDb, taskId: string, leaseMs = 60_000): boolean {
  const now = nowMs();
  const res = db.$client
    .prepare(
      `UPDATE tasks SET lease_until = @leaseUntil, updated_at = @now
       WHERE id = @taskId AND status = 'IN_PROGRESS'`,
    )
    .run({ taskId, leaseUntil: now + leaseMs, now });
  return res.changes > 0;
}

/**
 * Reaper: devuelve a READY las tareas IN_PROGRESS con lease vencido;
 * con attempts >= maxAttempts pasan a BLOCKED ('stuck'). Devuelve ids afectados.
 */
export function reapExpiredLeases(
  db: AgentosDb,
  maxAttempts = 3,
): { requeued: string[]; blocked: string[] } {
  const now = nowMs();
  const expired = db.$client
    .prepare(
      `SELECT id, attempts FROM tasks
       WHERE status = 'IN_PROGRESS' AND lease_until IS NOT NULL AND lease_until < @now`,
    )
    .all({ now }) as { id: string; attempts: number }[];

  const requeued: string[] = [];
  const blocked: string[] = [];
  const requeue = db.$client.prepare(
    `UPDATE tasks SET status = 'READY', lease_until = NULL, version = version + 1, updated_at = @now
     WHERE id = @id AND status = 'IN_PROGRESS'`,
  );
  const block = db.$client.prepare(
    `UPDATE tasks SET status = 'BLOCKED', blocked_reason = 'stuck', lease_until = NULL,
       version = version + 1, updated_at = @now
     WHERE id = @id AND status = 'IN_PROGRESS'`,
  );
  for (const t of expired) {
    if (t.attempts >= maxAttempts) {
      if (block.run({ id: t.id, now }).changes > 0) {
        blocked.push(t.id);
        appendTaskEvent(db, {
          taskId: t.id,
          kind: "reaped",
          fromStatus: "IN_PROGRESS",
          toStatus: "BLOCKED",
          actor: "system:reaper",
          payload: { reason: "stuck", attempts: t.attempts },
        });
      }
    } else if (requeue.run({ id: t.id, now }).changes > 0) {
      requeued.push(t.id);
      appendTaskEvent(db, {
        taskId: t.id,
        kind: "reaped",
        fromStatus: "IN_PROGRESS",
        toStatus: "READY",
        actor: "system:reaper",
        payload: { attempts: t.attempts },
      });
    }
  }
  return { requeued, blocked };
}

/**
 * B4 (lectura nueva): candidatas del despachador — la ÚNICA cola es READY
 * (ARCHITECTURE §6) con agente asignado y lease libre, ordenadas por
 * prioridad y antigüedad. El claim atómico sigue siendo quien decide.
 */
export function listDispatchableTasks(db: AgentosDb, at = nowMs(), limit = 20): Task[] {
  const rows = db.$client
    .prepare(
      `SELECT id FROM tasks
       WHERE status = 'READY'
         AND assignee_agent_id IS NOT NULL
         AND (lease_until IS NULL OR lease_until < @at)
       ORDER BY CASE priority
                  WHEN 'urgent' THEN 0
                  WHEN 'high' THEN 1
                  WHEN 'normal' THEN 2
                  ELSE 3
                END,
                created_at ASC
       LIMIT @limit`,
    )
    .all({ at, limit }) as { id: string }[];
  return rows.map((r) => getTask(db, r.id)!);
}

// ── Timeline (task_events, append-only) ─────────────────────────────────────

export function appendTaskEvent(
  db: AgentosDb,
  input: Omit<NewTaskEvent, "id" | "createdAt"> & { id?: string },
): TaskEvent {
  const row: NewTaskEvent = { ...input, id: input.id ?? newId(), createdAt: nowMs() };
  db.insert(taskEvents).values(row).run();
  return db.select().from(taskEvents).where(eq(taskEvents.id, row.id!)).get()!;
}

export function listTaskEvents(db: AgentosDb, taskId: string): TaskEvent[] {
  return db
    .select()
    .from(taskEvents)
    .where(eq(taskEvents.taskId, taskId))
    .orderBy(asc(taskEvents.createdAt))
    .all();
}

// ── Artefactos (regla anti-teatro: nada llega a REVIEW/DONE sin artefacto) ──

export function attachArtifact(
  db: AgentosDb,
  input: Omit<NewArtifact, "id" | "createdAt"> & { id?: string },
): Artifact {
  const row: NewArtifact = { ...input, id: input.id ?? newId(), createdAt: nowMs() };
  db.insert(artifacts).values(row).run();
  return db.select().from(artifacts).where(eq(artifacts.id, row.id!)).get()!;
}

export function listArtifacts(db: AgentosDb, taskId: string): Artifact[] {
  return db
    .select()
    .from(artifacts)
    .where(eq(artifacts.taskId, taskId))
    .orderBy(asc(artifacts.createdAt))
    .all();
}

export function countArtifacts(db: AgentosDb, taskId: string): number {
  const row = db
    .select({ n: sql<number>`count(*)` })
    .from(artifacts)
    .where(eq(artifacts.taskId, taskId))
    .get();
  return row?.n ?? 0;
}
