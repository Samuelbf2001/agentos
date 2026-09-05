import { and, asc, eq, sql } from "drizzle-orm";
import { newId, nowMs, type KnowledgeKind } from "@agentos/shared";
import type { AgentosSqliteDb } from "../client.js";
import { knowledgeDocs } from "../schema.js";
import { searchKnowledge, type KnowledgeSearchHit } from "../search.js";
import type { KnowledgeDoc, NewKnowledgeDoc } from "../types.js";

/**
 * Context Hub (ARCHITECTURE §8b): todo artefacto relevante de un agente se
 * registra aquí TIPADO y con fuente — la conversación es efímera, el contexto no.
 */
export function createDoc(
  db: AgentosSqliteDb,
  input: Omit<NewKnowledgeDoc, "id" | "createdAt" | "updatedAt"> & { id?: string },
): KnowledgeDoc {
  const now = nowMs();
  const row: NewKnowledgeDoc = { ...input, id: input.id ?? newId(), createdAt: now, updatedAt: now };
  db.insert(knowledgeDocs).values(row).run();
  return getDoc(db, row.id!)!;
}

export function upsertDoc(
  db: AgentosSqliteDb,
  input: Omit<NewKnowledgeDoc, "id" | "createdAt" | "updatedAt"> & { id?: string },
): KnowledgeDoc {
  if (input.id) {
    const existing = getDoc(db, input.id);
    if (existing) {
      db.update(knowledgeDocs)
        .set({ ...input, updatedAt: nowMs() })
        .where(eq(knowledgeDocs.id, input.id))
        .run();
      return getDoc(db, input.id)!;
    }
  }
  return createDoc(db, input);
}

export function getDoc(db: AgentosSqliteDb, id: string): KnowledgeDoc | undefined {
  return db.select().from(knowledgeDocs).where(eq(knowledgeDocs.id, id)).get();
}

export function listDocs(
  db: AgentosSqliteDb,
  filter: { orgId?: string; projectId?: string; kind?: KnowledgeKind } = {},
): KnowledgeDoc[] {
  const conds = [];
  if (filter.orgId) conds.push(eq(knowledgeDocs.orgId, filter.orgId));
  if (filter.projectId) conds.push(eq(knowledgeDocs.projectId, filter.projectId));
  if (filter.kind) conds.push(eq(knowledgeDocs.kind, filter.kind));
  const base = db.select().from(knowledgeDocs);
  const q = conds.length > 0 ? base.where(and(...conds)) : base;
  return q.orderBy(asc(knowledgeDocs.createdAt)).all();
}

/** Búsqueda FTS — delega en search.ts (única puerta al motor de búsqueda). */
export function searchDocs(db: AgentosSqliteDb, query: string, limit = 20): KnowledgeSearchHit[] {
  return searchKnowledge(db, query, limit);
}

/** Conteo de docs del Context Hub (cierre de fase — CA-M3.1). */
export function countDocs(
  db: AgentosSqliteDb,
  filter: { orgId?: string; projectId?: string; kind?: KnowledgeKind } = {},
): number {
  const conds = [];
  if (filter.orgId) conds.push(eq(knowledgeDocs.orgId, filter.orgId));
  if (filter.projectId) conds.push(eq(knowledgeDocs.projectId, filter.projectId));
  if (filter.kind) conds.push(eq(knowledgeDocs.kind, filter.kind));
  const base = db.select({ n: sql<number>`count(*)` }).from(knowledgeDocs);
  const row = (conds.length > 0 ? base.where(and(...conds)) : base).get();
  return row?.n ?? 0;
}
