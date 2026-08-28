/** Espejo Postgres de src/repositories/audit.ts — misma superficie, asíncrona (§NFR-9). */
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { newId, nowMs } from "@agentos/shared";
import type { AgentosPgDb } from "../client-pg.js";
import { auditLog } from "../schema-pg.js";
import type { AuditEntry, NewAuditEntry } from "../types-pg.js";

/**
 * Auditoría append-only. Patrón del gateway (ARCHITECTURE §4):
 * se escribe ANTES de actuar; si la acción falla se escribe una segunda fila.
 * No existe update ni delete de auditoría en ninguna capa.
 */
export async function appendAudit(
  db: AgentosPgDb,
  input: Omit<NewAuditEntry, "id" | "createdAt"> & { id?: string },
): Promise<AuditEntry> {
  const row: NewAuditEntry = { ...input, id: input.id ?? newId(), createdAt: nowMs() };
  await db.insert(auditLog).values(row);
  const [inserted] = await db.select().from(auditLog).where(eq(auditLog.id, row.id!)).limit(1);
  return inserted!;
}

export async function queryAudit(
  db: AgentosPgDb,
  filter: {
    entityType?: string;
    entityId?: string;
    action?: string;
    actor?: string;
    sinceMs?: number;
    limit?: number;
  } = {},
): Promise<AuditEntry[]> {
  const conds = [];
  if (filter.entityType) conds.push(eq(auditLog.entityType, filter.entityType));
  if (filter.entityId) conds.push(eq(auditLog.entityId, filter.entityId));
  if (filter.action) conds.push(eq(auditLog.action, filter.action));
  if (filter.actor) conds.push(eq(auditLog.actor, filter.actor));
  if (filter.sinceMs !== undefined) conds.push(gte(auditLog.createdAt, filter.sinceMs));
  const base = db.select().from(auditLog);
  const q = conds.length > 0 ? base.where(and(...conds)) : base;
  return await q.orderBy(desc(auditLog.createdAt)).limit(filter.limit ?? 100);
}

export async function getAuditEntry(db: AgentosPgDb, id: string): Promise<AuditEntry | undefined> {
  const [row] = await db.select().from(auditLog).where(eq(auditLog.id, id)).limit(1);
  return row;
}

/**
 * Idempotencia de mutaciones (ARCHITECTURE §7): el llamador registra la clave
 * dentro del JSON `after` (`idempotency_key`) y ANTES de repetir la mutación
 * busca aquí. Si hay fila previa con la misma (action, idempotency_key), la
 * mutación ya ocurrió — se devuelve la entrada para recuperar la entidad.
 */
export async function findAuditByIdempotencyKey(
  db: AgentosPgDb,
  action: string,
  idempotencyKey: string,
): Promise<AuditEntry | undefined> {
  const [row] = await db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.action, action),
        sql`${auditLog.after}->>'idempotency_key' = ${idempotencyKey}`,
      ),
    )
    .orderBy(desc(auditLog.createdAt))
    .limit(1);
  return row;
}
