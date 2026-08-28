/**
 * Contexto compartido del MCP admin: DB abierta + BoardEngine de @agentos/core
 * + perfil (`rw`/`ro`) + actor del operador.
 *
 * Capa FINA (ARCHITECTURE §7): aquí no viven reglas de dominio — solo se
 * resuelve infraestructura y atribución. Las reglas están en core/repositorios.
 */
import {
  appendAudit,
  appendEvent,
  findAuditByIdempotencyKey,
  getPerson,
  openDb,
  runMigrations,
  type AgentosDb,
  type AuditEntry,
  type Person,
} from "@agentos/db";
import { createBoardEngine, noopEventSink, type BoardEngine, type EventSink } from "@agentos/core";
import { errors } from "@agentos/shared";

export type AdminProfile = "rw" | "ro";

export interface AdminContext {
  db: AgentosDb;
  engine: BoardEngine;
  sink: EventSink;
  profile: AdminProfile;
  /** ActorRef del operador: `person:<id>` (AGENTOS_MCP_PERSON_ID) o `system:mcp-admin`. */
  actor: string;
}

export interface CreateAdminContextOptions {
  /** DB ya abierta (tests). Si no, se abre con `dbPath`/AGENTOS_DB_PATH. */
  db?: AgentosDb;
  dbPath?: string;
  profile: AdminProfile;
  /** person_id del operador para atribución de mutaciones. */
  personId?: string | null;
  /** Aplica migraciones al abrir (idempotente). Default true. */
  migrate?: boolean;
  /** Sink de eventos. Default: persistencia en la tabla `events` (topics AG-UI). */
  sink?: EventSink;
}

export function parseProfile(raw: string | undefined): AdminProfile {
  if (raw === "rw" || raw === "ro") return raw;
  if (raw === undefined || raw === "") return "ro"; // fail-closed: sin perfil, solo lectura
  throw errors.validation(`AGENTOS_MCP_PROFILE inválido: "${raw}" (esperado rw|ro)`);
}

/**
 * Sink que persiste los eventos de dominio en la tabla `events` (via repositorio).
 * El MCP admin es otro proceso: no puede empujar al WS de la API, pero la tabla
 * `events` ES la fuente de verdad del stream (ARCHITECTURE §2) — la API los
 * recoge por `since_seq` y CA-8.3 se cumple sin acoplar procesos.
 */
export function persistentEventSink(db: AgentosDb): EventSink {
  return {
    publish(topic, event) {
      try {
        appendEvent(db, {
          topic,
          type: event.type,
          payload: event.payload ?? null,
          runId: event.runId ?? null,
        });
      } catch (err) {
        // Un fallo del sink jamás tumba la mutación ya hecha.
        process.stderr.write(`[mcp-admin] sink error en ${topic}: ${String(err)}\n`);
      }
    },
  };
}

export function createAdminContext(opts: CreateAdminContextOptions): AdminContext {
  const db = opts.db ?? openDb(opts.dbPath);
  if (opts.migrate !== false) runMigrations(db);
  const sink = opts.sink ?? persistentEventSink(db);
  const engine = createBoardEngine({ db, sink });
  const actor = opts.personId ? `person:${opts.personId}` : "system:mcp-admin";
  return { db, engine, sink, profile: opts.profile, actor };
}

export { noopEventSink };

// ── Helpers de atribución y auditoría comunes a todas las tools ─────────────

export function mustGetPerson(db: AgentosDb, personId: string): Person {
  const person = getPerson(db, personId);
  if (!person) throw errors.notFound("person", personId);
  return person;
}

export interface AuditMutationInput {
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  reason?: string | null;
  idempotencyKey?: string | null;
  runId?: string | null;
}

/**
 * Toda mutación del MCP escribe audit_log before/after con source 'mcp'
 * (regla dura de §7). La idempotency_key viaja dentro de `after` para que
 * `findAuditByIdempotencyKey` la recupere.
 */
export function auditMutation(ctx: AdminContext, input: AuditMutationInput): AuditEntry {
  const after = {
    ...(input.after ?? {}),
    ...(input.idempotencyKey ? { idempotency_key: input.idempotencyKey } : {}),
  };
  return appendAudit(ctx.db, {
    actor: ctx.actor,
    source: "mcp",
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    before: input.before ?? null,
    after,
    reason: input.reason ?? null,
    runId: input.runId ?? null,
  });
}

/** Mutación ya aplicada con esta clave → su entrada de auditoría (o undefined). */
export function findIdempotentMutation(
  ctx: AdminContext,
  action: string,
  idempotencyKey: string | undefined | null,
): AuditEntry | undefined {
  if (!idempotencyKey) return undefined;
  return findAuditByIdempotencyKey(ctx.db, action, idempotencyKey);
}
