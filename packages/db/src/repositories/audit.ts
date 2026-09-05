import { and, desc, eq, gte, sql } from "drizzle-orm";
import { newId, nowMs } from "@agentos/shared";
import type { AgentosSqliteDb } from "../client.js";
import { auditLog } from "../schema.js";
import type { AuditEntry, NewAuditEntry } from "../types.js";

/**
 * Auditoría append-only. Patrón del gateway (ARCHITECTURE §4):
 * se escribe ANTES de actuar; si la acción falla se escribe una segunda fila.
 * No existe update ni delete de auditoría en ninguna capa.
 */
export function appendAudit(
  db: AgentosSqliteDb,
  input: Omit<NewAuditEntry, "id" | "createdAt"> & { id?: string },
): AuditEntry {
  const row: NewAuditEntry = { ...input, id: input.id ?? newId(), createdAt: nowMs() };
  db.insert(auditLog).values(row).run();
  return db.select().from(auditLog).where(eq(auditLog.id, row.id!)).get()!;
}

export function queryAudit(
  db: AgentosSqliteDb,
  filter: {
    entityType?: string;
    entityId?: string;
    action?: string;
    actor?: string;
    sinceMs?: number;
    limit?: number;
  } = {},
): AuditEntry[] {
  const conds = [];
  if (filter.entityType) conds.push(eq(auditLog.entityType, filter.entityType));
  if (filter.entityId) conds.push(eq(auditLog.entityId, filter.entityId));
  if (filter.action) conds.push(eq(auditLog.action, filter.action));
  if (filter.actor) conds.push(eq(auditLog.actor, filter.actor));
  if (filter.sinceMs !== undefined) conds.push(gte(auditLog.createdAt, filter.sinceMs));
  const base = db.select().from(auditLog);
  const q = conds.length > 0 ? base.where(and(...conds)) : base;
  return q.orderBy(desc(auditLog.createdAt)).limit(filter.limit ?? 100).all();
}

export function getAuditEntry(db: AgentosSqliteDb, id: string): AuditEntry | undefined {
  return db.select().from(auditLog).where(eq(auditLog.id, id)).get();
}

/**
 * Idempotencia de mutaciones (ARCHITECTURE §7): el llamador registra la clave
 * dentro del JSON `after` (`idempotency_key`) y ANTES de repetir la mutación
 * busca aquí. Si hay fila previa con la misma (action, idempotency_key), la
 * mutación ya ocurrió — se devuelve la entrada para recuperar la entidad.
 */
export function findAuditByIdempotencyKey(
  db: AgentosSqliteDb,
  action: string,
  idempotencyKey: string,
): AuditEntry | undefined {
  return db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.action, action),
        sql`json_extract(${auditLog.after}, '$.idempotency_key') = ${idempotencyKey}`,
      ),
    )
    .orderBy(desc(auditLog.createdAt))
    .limit(1)
    .get();
}
