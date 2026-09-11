import { and, asc, desc, eq, isNull, notInArray, sql } from "drizzle-orm";
import { errors, newId, nowMs, type BlockedReason, type TaskStatus } from "@agentos/shared";
import type { AgentosSqliteDb } from "../client.js";
import { artifacts, taskEvents, tasks } from "../schema.js";
import {
  insertTaskAssigneeRows,
  normalizeNewTaskAssignees,
  synchronizeTaskAssignees,
  validateTaskAssigneeOrganization,
} from "./task-assignees.js";
import type { Artifact, NewArtifact, NewTask, NewTaskEvent, Task, TaskCreateInput, TaskEvent } from "../types.js";

// ── CRUD ────────────────────────────────────────────────────────────────────

export function createTask(
  db: AgentosSqliteDb,
  input: TaskCreateInput,
): Task {
  const now = nowMs();
  const { normalized, taskInput } = normalizeNewTaskAssignees(input);
  const row: NewTask = {
    ...taskInput,
    // The singular column is always written from the canonical selection,
    // including when callers provide only assigneePersonIds.
    assigneePersonId: normalized.primaryPersonId,
    id: input.id ?? newId(),
    // Una migración puede traer la fecha de creación original; el resto nace ahora.
    createdAt: input.createdAt ?? now,
    updatedAt: now,
  };
  const insert = (): void => {
    validateTaskAssigneeOrganization(db, row.projectId, normalized.personIds);
    db.insert(tasks).values(row).run();
    insertTaskAssigneeRows(db, row.id!, normalized, now);
  };
  // Module launches already own a better-sqlite3 transaction. Avoid nesting a
  // second BEGIN there while keeping direct repository writes atomic.
  const inTransaction = (db.$client as unknown as { inTransaction?: boolean }).inTransaction === true;
  if (inTransaction) insert();
  else db.$client.transaction(insert)();
  return getTask(db, row.id!)!;
}

export function getTask(db: AgentosSqliteDb, id: string): Task | undefined {
  return db.select().from(tasks).where(eq(tasks.id, id)).get();
}

export function listTasks(
  db: AgentosSqliteDb,
  filter: {
    projectId?: string;
    status?: TaskStatus;
    assigneeAgentId?: string;
    /** Filtro humano canónico (incluye responsables no primarios). */
    personId?: string;
    /** Alias de compatibilidad para el contrato HTTP. */
    assigneePersonId?: string;
  } = {},
): Task[] {
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
  return q.orderBy(asc(tasks.status), asc(tasks.orderKey)).all();
}

/** Tablero de un proyecto: usa el índice tasks(project_id, status, order_key). */
export function boardTasks(db: AgentosSqliteDb, projectId: string): Task[] {
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
  db: AgentosSqliteDb,
  id: string,
  patch: Partial<Omit<Task, "id" | "createdAt" | "version">>,
  expectedVersion: number,
): Task {
  const hasLegacyAssignee = patch.assigneePersonId !== undefined;
  const legacyAssignee = patch.assigneePersonId ?? null;
  const taskPatch = hasLegacyAssignee
    ? (() => {
        const { assigneePersonId: _ignored, ...rest } = patch;
        return rest;
      })()
    : patch;
  const work = (): void => {
    if (hasLegacyAssignee) {
      const current = getTask(db, id);
      if (!current) throw errors.notFound("task", id);
      validateTaskAssigneeOrganization(db, current.projectId, legacyAssignee ? [legacyAssignee] : []);
    }
    const res = db
      .update(tasks)
      .set({
        ...taskPatch,
        ...(hasLegacyAssignee ? { assigneePersonId: legacyAssignee } : {}),
        updatedAt: nowMs(),
        version: sql`${tasks.version} + 1`,
      })
      .where(sql`${tasks.id} = ${id} AND ${tasks.version} = ${expectedVersion}`)
      .run();
    if (res.changes === 0) {
      if (!getTask(db, id)) throw errors.notFound("task", id);
      throw errors.versionConflict("task", id, expectedVersion);
    }
    if (hasLegacyAssignee) synchronizeTaskAssignees(db, id, legacyAssignee);
  };
  const inTransaction = (db.$client as unknown as { inTransaction?: boolean }).inTransaction === true;
  if (hasLegacyAssignee && !inTransaction) db.$client.transaction(work)();
  else work();
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
  db: AgentosSqliteDb,
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
export function renewLease(db: AgentosSqliteDb, taskId: string, leaseMs = 60_000): boolean {
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
  db: AgentosSqliteDb,
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
export function listDispatchableTasks(db: AgentosSqliteDb, at = nowMs(), limit = 20): Task[] {
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

/**
 * M2 (lectura nueva): tareas ABIERTAS (ni DONE ni CANCELLED) por agente — la
 * resolución de asignaciones del launch elige, dentro de una capa, al agente
 * con menos carga (§13.5; desempate determinista por slug en el motor).
 */
export function countOpenTasksByAgent(db: AgentosSqliteDb): Map<string, number> {
  const rows = db.$client
    .prepare(
      `SELECT assignee_agent_id AS agentId, count(*) AS n FROM tasks
       WHERE assignee_agent_id IS NOT NULL AND status NOT IN ('DONE', 'CANCELLED')
       GROUP BY assignee_agent_id`,
    )
    .all() as { agentId: string; n: number }[];
  return new Map(rows.map((r) => [r.agentId, r.n]));
}

// ── Timeline (task_events, append-only) ─────────────────────────────────────

export function appendTaskEvent(
  db: AgentosSqliteDb,
  input: Omit<NewTaskEvent, "id" | "createdAt"> & { id?: string },
): TaskEvent {
  const row: NewTaskEvent = { ...input, id: input.id ?? newId(), createdAt: nowMs() };
  db.insert(taskEvents).values(row).run();
  return db.select().from(taskEvents).where(eq(taskEvents.id, row.id!)).get()!;
}

export function listTaskEvents(db: AgentosSqliteDb, taskId: string): TaskEvent[] {
  return db
    .select()
    .from(taskEvents)
    .where(eq(taskEvents.taskId, taskId))
    .orderBy(asc(taskEvents.createdAt))
    .all();
}

// ── Artefactos (regla anti-teatro: nada llega a REVIEW/DONE sin artefacto) ──

export function attachArtifact(
  db: AgentosSqliteDb,
  input: Omit<NewArtifact, "id" | "createdAt"> & { id?: string },
): Artifact {
  const row: NewArtifact = { ...input, id: input.id ?? newId(), createdAt: nowMs() };
  db.insert(artifacts).values(row).run();
  return db.select().from(artifacts).where(eq(artifacts.id, row.id!)).get()!;
}

export function getArtifact(db: AgentosSqliteDb, id: string): Artifact | undefined {
  return db.select().from(artifacts).where(eq(artifacts.id, id)).get();
}

export function listArtifacts(db: AgentosSqliteDb, taskId: string): Artifact[] {
  return db
    .select()
    .from(artifacts)
    .where(eq(artifacts.taskId, taskId))
    .orderBy(asc(artifacts.createdAt))
    .all();
}

export function countArtifacts(db: AgentosSqliteDb, taskId: string): number {
  const row = db
    .select({ n: sql<number>`count(*)` })
    .from(artifacts)
    .where(eq(artifacts.taskId, taskId))
    .get();
  return row?.n ?? 0;
}

// ── Lecturas/escrituras portables que antes vivían en core como SQL crudo ──
// (rama feat/postgres-async: nada fuera de packages/db toca `$client`)

/**
 * Máximo `order_key` de una columna del tablero. El motor calcula a partir de
 * él la clave "al final de la columna" (crecimiento acotado).
 */
export function maxOrderKey(
  db: AgentosSqliteDb,
  projectId: string,
  status: TaskStatus,
): string | null {
  const row = db
    .select({ mk: sql<string | null>`max(${tasks.orderKey})` })
    .from(tasks)
    .where(and(eq(tasks.projectId, projectId), eq(tasks.status, status)))
    .get();
  return row?.mk ?? null;
}

export interface TransitionTaskInput {
  taskId: string;
  from: TaskStatus;
  to: TaskStatus;
  blockedReason?: BlockedReason | null;
  /** BLOCKED → READY reinicia el contador de intentos. */
  resetAttempts?: boolean;
  expectedVersion: number;
}

/**
 * UPDATE atómico de estado con `expected_version` **y** estado origen (jamás
 * last-write-wins — ARCHITECTURE §6). Devuelve `false` si nadie cambió: el
 * llamante decide si es not_found, conflicto de versión o carrera de estado.
 */
export function transitionTaskStatus(db: AgentosSqliteDb, input: TransitionTaskInput): boolean {
  const res = db
    .update(tasks)
    .set({
      status: input.to,
      blockedReason: input.blockedReason ?? null,
      leaseUntil: null,
      ...(input.resetAttempts ? { attempts: 0 } : {}),
      version: sql`${tasks.version} + 1`,
      updatedAt: nowMs(),
    })
    .where(
      and(
        eq(tasks.id, input.taskId),
        eq(tasks.version, input.expectedVersion),
        eq(tasks.status, input.from),
      ),
    )
    .run();
  return res.changes > 0;
}

/**
 * Delegaciones YA hechas desde una tarea por un run (fan-out máx 4 por run,
 * ARCHITECTURE §6). `runId = null` cuenta las que no tienen run.
 */
export function countDelegations(
  db: AgentosSqliteDb,
  taskId: string,
  runId: string | null,
): number {
  const row = db
    .select({ n: sql<number>`count(*)` })
    .from(taskEvents)
    .where(
      and(
        eq(taskEvents.taskId, taskId),
        eq(taskEvents.kind, "delegated"),
        runId === null ? isNull(taskEvents.runId) : eq(taskEvents.runId, runId),
      ),
    )
    .get();
  return row?.n ?? 0;
}

/**
 * Instancias ABIERTAS (ni DONE ni CANCELLED) de una plantilla de launch en el
 * proyecto — guarda-raíl anti-bucle de la re-creación de cadencias (M6a). La
 * plantilla viaja en el `task_events.payload` del evento `created`.
 *
 * `json_extract` es de SQLite; el espejo Postgres usa el operador `->>`.
 */
export function countOpenTasksByTemplateKey(
  db: AgentosSqliteDb,
  projectId: string,
  templateKey: string,
): number {
  const row = db
    .select({ n: sql<number>`count(*)` })
    .from(tasks)
    .innerJoin(taskEvents, and(eq(taskEvents.taskId, tasks.id), eq(taskEvents.kind, "created")))
    .where(
      and(
        eq(tasks.projectId, projectId),
        notInArray(tasks.status, ["DONE", "CANCELLED"]),
        sql`json_extract(${taskEvents.payload}, '$.template_key') = ${templateKey}`,
      ),
    )
    .get();
  return row?.n ?? 0;
}

/** Artefactos de un `kind` producidos por tareas del proyecto (cierre de fase). */
export function countProjectArtifactsByKind(
  db: AgentosSqliteDb,
  projectId: string,
  kind: string,
): number {
  const row = db
    .select({ n: sql<number>`count(*)` })
    .from(artifacts)
    .innerJoin(tasks, eq(tasks.id, artifacts.taskId))
    .where(and(eq(tasks.projectId, projectId), eq(artifacts.kind, kind)))
    .get();
  return row?.n ?? 0;
}

/**
 * Último artefacto de un `kind` del proyecto (opcionalmente solo de tareas en
 * un estado dado). Desempate por `id DESC`: los ids son uuidv7, monotónicos.
 */
export function findLatestProjectArtifact(
  db: AgentosSqliteDb,
  projectId: string,
  kind: string,
  filter: { taskStatus?: TaskStatus } = {},
): Artifact | undefined {
  const conds = [eq(tasks.projectId, projectId), eq(artifacts.kind, kind)];
  if (filter.taskStatus) conds.push(eq(tasks.status, filter.taskStatus));
  const row = db
    .select()
    .from(artifacts)
    .innerJoin(tasks, eq(tasks.id, artifacts.taskId))
    .where(and(...conds))
    .orderBy(desc(artifacts.createdAt), desc(artifacts.id))
    .limit(1)
    .get();
  return row?.artifacts;
}
