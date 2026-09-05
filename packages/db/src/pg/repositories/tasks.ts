/** Espejo Postgres de src/repositories/tasks.ts — misma superficie, asíncrona (§NFR-9). */
import { and, asc, eq, isNotNull, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import { errors, newId, nowMs, type TaskStatus } from "@agentos/shared";
import type { AgentosPgDb } from "../client-pg.js";
import { artifacts, taskEvents, tasks } from "../schema-pg.js";
import {
  insertTaskAssigneeRows,
  normalizeNewTaskAssignees,
  synchronizeTaskAssignees,
  validateTaskAssigneeOrganization,
} from "./task-assignees.js";
import type { Artifact, NewArtifact, NewTask, NewTaskEvent, Task, TaskCreateInput, TaskEvent } from "../types-pg.js";

// ── CRUD ────────────────────────────────────────────────────────────────────

export async function createTask(
  db: AgentosPgDb,
  input: TaskCreateInput,
): Promise<Task> {
  const now = nowMs();
  const { normalized, taskInput } = normalizeNewTaskAssignees(input);
  const row: NewTask = {
    ...taskInput,
    assigneePersonId: normalized.primaryPersonId,
    id: input.id ?? newId(),
    createdAt: now,
    updatedAt: now,
  };
  await db.transaction(async (tx) => {
    await validateTaskAssigneeOrganization(tx as unknown as AgentosPgDb, row.projectId, normalized.personIds);
    await tx.insert(tasks).values(row);
    await insertTaskAssigneeRows(tx as unknown as AgentosPgDb, row.id!, normalized, now);
  });
  return (await getTask(db, row.id!))!;
}

export async function getTask(db: AgentosPgDb, id: string): Promise<Task | undefined> {
  const [row] = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
  return row;
}

export async function listTasks(
  db: AgentosPgDb,
  filter: {
    projectId?: string;
    status?: TaskStatus;
    assigneeAgentId?: string;
    personId?: string;
    assigneePersonId?: string;
  } = {},
): Promise<Task[]> {
  const conds = [];
  if (filter.projectId) conds.push(eq(tasks.projectId, filter.projectId));
  if (filter.status) conds.push(eq(tasks.status, filter.status));
  if (filter.assigneeAgentId) conds.push(eq(tasks.assigneeAgentId, filter.assigneeAgentId));
  const personId = filter.personId ?? filter.assigneePersonId;
  if (personId) {
    conds.push(
      sql`EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = ${tasks.id} AND ta.person_id = ${personId})`,
    );
  }
  const base = db.select().from(tasks);
  const q = conds.length > 0 ? base.where(and(...conds)) : base;
  return await q.orderBy(asc(tasks.status), asc(tasks.orderKey));
}

/** Tablero de un proyecto: usa el índice tasks(project_id, status, order_key). */
export async function boardTasks(db: AgentosPgDb, projectId: string): Promise<Task[]> {
  return await db
    .select()
    .from(tasks)
    .where(eq(tasks.projectId, projectId))
    .orderBy(asc(tasks.status), asc(tasks.orderKey));
}

/**
 * Actualización con optimistic locking (`expected_version` de ARCHITECTURE §6):
 * conflicto obliga a releer, no last-write-wins.
 */
export async function updateTask(
  db: AgentosPgDb,
  id: string,
  patch: Partial<Omit<Task, "id" | "createdAt" | "version">>,
  expectedVersion: number,
): Promise<Task> {
  const hasLegacyAssignee = patch.assigneePersonId !== undefined;
  const legacyAssignee = patch.assigneePersonId ?? null;
  const taskPatch = hasLegacyAssignee
    ? (() => {
        const { assigneePersonId: _ignored, ...rest } = patch;
        return rest;
      })()
    : patch;

  if (hasLegacyAssignee) {
    await db.transaction(async (tx) => {
      const [current] = await tx.select().from(tasks).where(eq(tasks.id, id)).limit(1);
      if (!current) throw errors.notFound("task", id);
      // Validate before the conditional UPDATE so a rejected person cannot
      // alter either the projection or the bridge. The helper validates again
      // after the update using the resulting project, covering a simultaneous
      // project move as well.
      await validateTaskAssigneeOrganization(
        tx as unknown as AgentosPgDb,
        current.projectId,
        legacyAssignee ? [legacyAssignee] : [],
      );
      const updated = await tx
        .update(tasks)
        .set({
          ...taskPatch,
          assigneePersonId: legacyAssignee,
          updatedAt: nowMs(),
          version: sql`${tasks.version} + 1`,
        })
        .where(sql`${tasks.id} = ${id} AND ${tasks.version} = ${expectedVersion}`)
        .returning({ id: tasks.id });
      if (updated.length === 0) {
        const [stillThere] = await tx.select().from(tasks).where(eq(tasks.id, id)).limit(1);
        if (!stillThere) throw errors.notFound("task", id);
        throw errors.versionConflict("task", id, expectedVersion);
      }
      await synchronizeTaskAssignees(tx as unknown as AgentosPgDb, id, legacyAssignee);
    });
  } else {
    const updated = await db
      .update(tasks)
      .set({ ...taskPatch, updatedAt: nowMs(), version: sql`${tasks.version} + 1` })
      .where(sql`${tasks.id} = ${id} AND ${tasks.version} = ${expectedVersion}`)
      .returning({ id: tasks.id });
    if (updated.length === 0) {
      if (!(await getTask(db, id))) throw errors.notFound("task", id);
      throw errors.versionConflict("task", id, expectedVersion);
    }
  }
  return (await getTask(db, id))!;
}

// ── Claim atómico + lease (patrón work-queue, ARCHITECTURE §6) ──────────────

export interface ClaimResult {
  claimed: boolean;
  task?: Task;
}

/**
 * Claim atómico a nivel SQL: `UPDATE … WHERE status='READY' AND (lease vencido o nulo)`.
 * Cero filas afectadas significa carrera perdida → `{ claimed: false }` (CA-3.2).
 * El motor completo (despachador, latido, reaper) llega en B3; el patrón SQL se valida aquí.
 *
 * El UPDATE condicional con `.returning()` es tan atómico en Postgres como el
 * `UPDATE ... WHERE` de SQLite: es una única sentencia SQL, y Postgres evalúa el
 * WHERE y aplica el SET de forma atómica por fila (con su propio bloqueo de fila
 * implícito) — dos claims concurrentes sobre la misma tarea nunca pueden ganar
 * ambos. `FOR UPDATE SKIP LOCKED` sería una mejora OPCIONAL para reducir la
 * espera bajo alta contención con muchos despachadores (documentada en
 * docs/POSTGRES.md), no un requisito para la corrección del claim.
 */
export async function claimTask(
  db: AgentosPgDb,
  input: { taskId: string; agentId: string; leaseMs?: number; runId?: string },
): Promise<ClaimResult> {
  const now = nowMs();
  const leaseUntil = now + (input.leaseMs ?? 60_000);
  const claimed = await db
    .update(tasks)
    .set({
      status: "IN_PROGRESS",
      leaseUntil,
      attempts: sql`${tasks.attempts} + 1`,
      version: sql`${tasks.version} + 1`,
      updatedAt: now,
    })
    .where(
      and(
        eq(tasks.id, input.taskId),
        eq(tasks.status, "READY"),
        or(isNull(tasks.leaseUntil), lt(tasks.leaseUntil, now)),
      ),
    )
    .returning({ id: tasks.id });
  if (claimed.length === 0) return { claimed: false };

  const task = (await getTask(db, input.taskId))!;
  await appendTaskEvent(db, {
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
export async function renewLease(db: AgentosPgDb, taskId: string, leaseMs = 60_000): Promise<boolean> {
  const now = nowMs();
  const renewed = await db
    .update(tasks)
    .set({ leaseUntil: now + leaseMs, updatedAt: now })
    .where(and(eq(tasks.id, taskId), eq(tasks.status, "IN_PROGRESS")))
    .returning({ id: tasks.id });
  return renewed.length > 0;
}

/**
 * Reaper: devuelve a READY las tareas IN_PROGRESS con lease vencido;
 * con attempts >= maxAttempts pasan a BLOCKED ('stuck'). Devuelve ids afectados.
 */
export async function reapExpiredLeases(
  db: AgentosPgDb,
  maxAttempts = 3,
): Promise<{ requeued: string[]; blocked: string[] }> {
  const now = nowMs();
  const expired = await db
    .select({ id: tasks.id, attempts: tasks.attempts })
    .from(tasks)
    .where(and(eq(tasks.status, "IN_PROGRESS"), isNotNull(tasks.leaseUntil), lt(tasks.leaseUntil, now)));

  const requeued: string[] = [];
  const blocked: string[] = [];
  for (const t of expired) {
    if (t.attempts >= maxAttempts) {
      const res = await db
        .update(tasks)
        .set({
          status: "BLOCKED",
          blockedReason: "stuck",
          leaseUntil: null,
          version: sql`${tasks.version} + 1`,
          updatedAt: now,
        })
        .where(and(eq(tasks.id, t.id), eq(tasks.status, "IN_PROGRESS")))
        .returning({ id: tasks.id });
      if (res.length > 0) {
        blocked.push(t.id);
        await appendTaskEvent(db, {
          taskId: t.id,
          kind: "reaped",
          fromStatus: "IN_PROGRESS",
          toStatus: "BLOCKED",
          actor: "system:reaper",
          payload: { reason: "stuck", attempts: t.attempts },
        });
      }
    } else {
      const res = await db
        .update(tasks)
        .set({ status: "READY", leaseUntil: null, version: sql`${tasks.version} + 1`, updatedAt: now })
        .where(and(eq(tasks.id, t.id), eq(tasks.status, "IN_PROGRESS")))
        .returning({ id: tasks.id });
      if (res.length > 0) {
        requeued.push(t.id);
        await appendTaskEvent(db, {
          taskId: t.id,
          kind: "reaped",
          fromStatus: "IN_PROGRESS",
          toStatus: "READY",
          actor: "system:reaper",
          payload: { attempts: t.attempts },
        });
      }
    }
  }
  return { requeued, blocked };
}

/**
 * B4 (lectura nueva): candidatas del despachador — la ÚNICA cola es READY
 * (ARCHITECTURE §6) con agente asignado y lease libre, ordenadas por
 * prioridad y antigüedad. El claim atómico sigue siendo quien decide.
 */
export async function listDispatchableTasks(db: AgentosPgDb, at = nowMs(), limit = 20): Promise<Task[]> {
  const rows = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(
        eq(tasks.status, "READY"),
        isNotNull(tasks.assigneeAgentId),
        or(isNull(tasks.leaseUntil), lt(tasks.leaseUntil, at)),
      ),
    )
    .orderBy(
      sql`CASE ${tasks.priority}
            WHEN 'urgent' THEN 0
            WHEN 'high' THEN 1
            WHEN 'normal' THEN 2
            ELSE 3
          END`,
      asc(tasks.createdAt),
    )
    .limit(limit);
  const out = await Promise.all(rows.map((r) => getTask(db, r.id)));
  return out.map((t) => t!);
}

/**
 * M2 (lectura nueva): tareas ABIERTAS (ni DONE ni CANCELLED) por agente — la
 * resolución de asignaciones del launch elige, dentro de una capa, al agente
 * con menos carga (§13.5; desempate determinista por slug en el motor).
 */
export async function countOpenTasksByAgent(db: AgentosPgDb): Promise<Map<string, number>> {
  const rows = await db
    .select({ agentId: tasks.assigneeAgentId, n: sql<number>`count(*)::int` })
    .from(tasks)
    .where(and(isNotNull(tasks.assigneeAgentId), notInArray(tasks.status, ["DONE", "CANCELLED"])))
    .groupBy(tasks.assigneeAgentId);
  return new Map(rows.map((r) => [r.agentId as string, Number(r.n)]));
}

// ── Timeline (task_events, append-only) ─────────────────────────────────────

export async function appendTaskEvent(
  db: AgentosPgDb,
  input: Omit<NewTaskEvent, "id" | "createdAt"> & { id?: string },
): Promise<TaskEvent> {
  const row: NewTaskEvent = { ...input, id: input.id ?? newId(), createdAt: nowMs() };
  await db.insert(taskEvents).values(row);
  const [saved] = await db.select().from(taskEvents).where(eq(taskEvents.id, row.id!)).limit(1);
  return saved!;
}

export async function listTaskEvents(db: AgentosPgDb, taskId: string): Promise<TaskEvent[]> {
  return await db
    .select()
    .from(taskEvents)
    .where(eq(taskEvents.taskId, taskId))
    .orderBy(asc(taskEvents.createdAt));
}

// ── Artefactos (regla anti-teatro: nada llega a REVIEW/DONE sin artefacto) ──

export async function attachArtifact(
  db: AgentosPgDb,
  input: Omit<NewArtifact, "id" | "createdAt"> & { id?: string },
): Promise<Artifact> {
  const row: NewArtifact = { ...input, id: input.id ?? newId(), createdAt: nowMs() };
  await db.insert(artifacts).values(row);
  const [saved] = await db.select().from(artifacts).where(eq(artifacts.id, row.id!)).limit(1);
  return saved!;
}

export async function listArtifacts(db: AgentosPgDb, taskId: string): Promise<Artifact[]> {
  return await db
    .select()
    .from(artifacts)
    .where(eq(artifacts.taskId, taskId))
    .orderBy(asc(artifacts.createdAt));
}

export async function countArtifacts(db: AgentosPgDb, taskId: string): Promise<number> {
  // `count(*)` es bigint en Postgres y el driver lo entrega como STRING (no
  // pierde precisión con >2^53). El casteo a int lo devuelve como number, que
  // es lo que promete el contrato compartido con SQLite.
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(artifacts)
    .where(eq(artifacts.taskId, taskId))
    .limit(1);
  return Number(row?.n ?? 0);
}
