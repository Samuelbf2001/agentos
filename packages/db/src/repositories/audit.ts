import { and, desc, eq } from "drizzle-orm";
import { newId, nowMs } from "@agentos/shared";
import type { AgentosDb } from "../client.js";
import { auditLog } from "../schema.js";
import type { AuditEntry, NewAuditEntry } from "../types.js";

/**
 * Auditoría append-only. Patrón del gateway (ARCHITECTURE §4):
 * se escribe ANTES de actuar; si la acción falla se escribe una segunda fila.
 * No existe update ni delete de auditoría en ninguna capa.
 */
export function appendAudit(
  db: AgentosDb,
  input: Omit<NewAuditEntry, "id" | "createdAt"> & { id?: string },
): AuditEntry {
  const row: NewAuditEntry = { ...input, id: input.id ?? newId(), createdAt: nowMs() };
  db.insert(auditLog).values(row).run();
  return db.select().from(auditLog).where(eq(auditLog.id, row.id!)).get()!;
}

export function queryAudit(
  db: AgentosDb,
  filter: { entityType?: string; entityId?: string; limit?: number } = {},
): AuditEntry[] {
  const conds = [];
  if (filter.entityType) conds.push(eq(auditLog.entityType, filter.entityType));
  if (filter.entityId) conds.push(eq(auditLog.entityId, filter.entityId));
  const base = db.select().from(auditLog);
  const q = conds.length > 0 ? base.where(and(...conds)) : base;
  return q.orderBy(desc(auditLog.createdAt)).limit(filter.limit ?? 100).all();
}
