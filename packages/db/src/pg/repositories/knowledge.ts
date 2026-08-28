/** Espejo Postgres de src/repositories/knowledge.ts — misma superficie, asíncrona (§NFR-9). */
import { and, asc, eq } from "drizzle-orm";
import { newId, nowMs, type KnowledgeKind } from "@agentos/shared";
import type { AgentosPgDb } from "../client-pg.js";
import { knowledgeDocs } from "../schema-pg.js";
import {
  embedKnowledgeDoc,
  knowledgeSemanticSearch,
  searchKnowledgePg,
  type KnowledgeSemanticResult,
  type SemanticSearchOptions,
} from "../search-pg.js";
import type { EmbeddingProvider } from "../../embeddings.js";
import type { KnowledgeSearchHit } from "../../search.js";
import type { KnowledgeDoc, NewKnowledgeDoc } from "../types-pg.js";

/**
 * Context Hub (ARCHITECTURE §8b). Además de lo que hace la versión SQLite,
 * aquí se puede pasar un `embedder`: al crear/actualizar un doc se recalcula su
 * vector. Si no hay embedder, todo funciona igual — solo sin semántica.
 */
export interface KnowledgeWriteOptions {
  embedder?: EmbeddingProvider | null;
}

export async function createDoc(
  db: AgentosPgDb,
  input: Omit<NewKnowledgeDoc, "id" | "createdAt" | "updatedAt"> & { id?: string },
  opts: KnowledgeWriteOptions = {},
): Promise<KnowledgeDoc> {
  const now = nowMs();
  const row: NewKnowledgeDoc = { ...input, id: input.id ?? newId(), createdAt: now, updatedAt: now };
  await db.insert(knowledgeDocs).values(row);
  if (opts.embedder) await embedKnowledgeDoc(db, row.id!, opts.embedder);
  return (await getDoc(db, row.id!))!;
}

export async function upsertDoc(
  db: AgentosPgDb,
  input: Omit<NewKnowledgeDoc, "id" | "createdAt" | "updatedAt"> & { id?: string },
  opts: KnowledgeWriteOptions = {},
): Promise<KnowledgeDoc> {
  if (input.id) {
    const existing = await getDoc(db, input.id);
    if (existing) {
      await db
        .update(knowledgeDocs)
        .set({ ...input, updatedAt: nowMs() })
        .where(eq(knowledgeDocs.id, input.id));
      if (opts.embedder) await embedKnowledgeDoc(db, input.id, opts.embedder);
      return (await getDoc(db, input.id))!;
    }
  }
  return createDoc(db, input, opts);
}

export async function getDoc(db: AgentosPgDb, id: string): Promise<KnowledgeDoc | undefined> {
  const [row] = await db.select().from(knowledgeDocs).where(eq(knowledgeDocs.id, id)).limit(1);
  return row;
}

export async function listDocs(
  db: AgentosPgDb,
  filter: { orgId?: string; projectId?: string; kind?: KnowledgeKind } = {},
): Promise<KnowledgeDoc[]> {
  const conds = [];
  if (filter.orgId) conds.push(eq(knowledgeDocs.orgId, filter.orgId));
  if (filter.projectId) conds.push(eq(knowledgeDocs.projectId, filter.projectId));
  if (filter.kind) conds.push(eq(knowledgeDocs.kind, filter.kind));
  const base = db.select().from(knowledgeDocs);
  const q = conds.length > 0 ? base.where(and(...conds)) : base;
  return q.orderBy(asc(knowledgeDocs.createdAt));
}

/** Búsqueda por palabras (tsvector) — mismo contrato que `searchDocs` de SQLite. */
export async function searchDocs(
  db: AgentosPgDb,
  query: string,
  limit = 20,
): Promise<KnowledgeSearchHit[]> {
  return searchKnowledgePg(db, query, limit);
}

/**
 * Búsqueda SEMÁNTICA del Context Hub (pgvector). Sin embedder configurado
 * devuelve `mode: 'keyword'` con los resultados de tsvector: degradación
 * limpia, el llamante no tiene que ramificar.
 */
export async function semanticSearchDocs(
  db: AgentosPgDb,
  query: string,
  k = 10,
  opts: SemanticSearchOptions = {},
): Promise<KnowledgeSemanticResult> {
  return knowledgeSemanticSearch(db, query, k, opts);
}
