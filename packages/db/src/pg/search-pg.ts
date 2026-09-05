/**
 * Búsqueda en Postgres — TODO lo específico del motor vive AQUÍ, exactamente
 * igual que FTS5 vive aislado en `src/search.ts` (ARCHITECTURE §5).
 *
 * Dos capacidades:
 *   1. **tsvector** — el equivalente exacto de FTS5 que ya estaba documentado
 *      en `search.ts`. Columnas GENERATED ALWAYS … STORED + índices GIN: en
 *      Postgres NO hacen falta los triggers espejo, la columna se mantiene sola.
 *   2. **pgvector** — búsqueda SEMÁNTICA de `knowledge_docs`. Es la ganancia que
 *      convierte el Context Hub en un "LLM wiki" por cliente: encuentra por
 *      significado, no por coincidencia de palabras.
 *
 * Igual que las tablas FTS5 no están en `schema.ts`, la columna `embedding` y
 * las columnas `*_tsv` NO están en `schema-pg.ts`: son del motor, se crean aquí
 * y se consultan aquí. Así la dimensión del vector es configurable sin tocar el
 * esquema ni regenerar migraciones.
 *
 * DEGRADACIÓN LIMPIA: si la extensión `vector` no está disponible (o no hay
 * proveedor de embeddings), `ensurePgSearch` lo reporta y toda la búsqueda sigue
 * funcionando con tsvector. Nada revienta.
 */
import { sql } from "drizzle-orm";
import type { AgentosPgDb } from "./client-pg.js";
import {
  DEFAULT_EMBEDDING_DIM,
  toPgVector,
  type EmbeddingProvider,
} from "../embeddings.js";
import type { KnowledgeSearchHit, MessageSearchHit, TaskSearchHit, TaskSearchOptions } from "../search.js";

/** Configuración de diccionario de `to_tsvector`. `spanish` viene de serie en PG. */
export const DEFAULT_TS_CONFIG = "spanish";

export interface EnsurePgSearchOptions {
  /** Dimensión de `vector(N)`. Default: `AGENTOS_EMBEDDING_DIM` o 1536. */
  embeddingDimensions?: number;
  /** Diccionario de to_tsvector. Default `spanish`. */
  textSearchConfig?: string;
  /** Índice vectorial. `hnsw` (default) es mejor en recall/latencia; `ivfflat` gasta menos RAM. */
  vectorIndex?: "hnsw" | "ivfflat" | "none";
  /** `false` = ni intentar la extensión (útil en Postgres gestionados sin pgvector). */
  enableVector?: boolean;
}

export interface PgSearchCapabilities {
  /** tsvector siempre disponible: es núcleo de Postgres. */
  textSearch: true;
  textSearchConfig: string;
  /** ¿pgvector instalado y columna `embedding` lista? */
  vector: boolean;
  /** Dimensión efectiva de la columna, o null si no hay vector. */
  embeddingDimensions: number | null;
  /** Por qué NO hay vector (para que la UI/el log lo digan claro). */
  vectorUnavailableReason?: string;
}

/**
 * Idempotente: se puede llamar en cada arranque (mismo contrato que `ensureFts`).
 */
export async function ensurePgSearch(
  db: AgentosPgDb,
  opts: EnsurePgSearchOptions = {},
): Promise<PgSearchCapabilities> {
  const cfg = opts.textSearchConfig ?? DEFAULT_TS_CONFIG;
  assertSafeIdentifier(cfg, "textSearchConfig");

  // ── 1. tsvector: columnas generadas + GIN ────────────────────────────────
  await db.execute(sql`
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS content_tsv tsvector
      GENERATED ALWAYS AS (to_tsvector(${sql.raw(`'${cfg}'`)}, coalesce(content, ''))) STORED
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_messages_tsv ON messages USING GIN (content_tsv)`);

  await db.execute(sql`
    ALTER TABLE knowledge_docs ADD COLUMN IF NOT EXISTS doc_tsv tsvector
      GENERATED ALWAYS AS (
        to_tsvector(${sql.raw(`'${cfg}'`)}, coalesce(title, '') || ' ' || coalesce(body_md, ''))
      ) STORED
  `);
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS idx_knowledge_tsv ON knowledge_docs USING GIN (doc_tsv)`,
  );

  // Tareas: la ficha (título + descripción + DoD) y los comentarios, que en
  // ambos motores viven dentro del payload del evento, no en una columna.
  await db.execute(sql`
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS task_tsv tsvector
      GENERATED ALWAYS AS (
        to_tsvector(${sql.raw(`'${cfg}'`)},
          coalesce(title, '') || ' ' || coalesce(description, '') || ' ' || coalesce(definition_of_done, ''))
      ) STORED
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_tasks_tsv ON tasks USING GIN (task_tsv)`);

  await db.execute(sql`
    ALTER TABLE task_events ADD COLUMN IF NOT EXISTS comment_tsv tsvector
      GENERATED ALWAYS AS (
        to_tsvector(${sql.raw(`'${cfg}'`)}, coalesce(payload ->> 'body', ''))
      ) STORED
  `);
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS idx_task_events_comment_tsv ON task_events USING GIN (comment_tsv)`,
  );

  const caps: PgSearchCapabilities = {
    textSearch: true,
    textSearchConfig: cfg,
    vector: false,
    embeddingDimensions: null,
  };

  if (opts.enableVector === false) {
    caps.vectorUnavailableReason = "desactivado por configuración (enableVector: false)";
    return caps;
  }

  // ── 2. pgvector ─────────────────────────────────────────────────────────
  try {
    await db.execute(sql`CREATE EXTENSION IF NOT EXISTS vector`);
  } catch (err) {
    caps.vectorUnavailableReason =
      `la extensión "vector" no se pudo instalar (${(err as Error).message}). ` +
      `Usa la imagen pgvector/pgvector o actívala en Supabase → Database → Extensions.`;
    return caps;
  }

  const dim = opts.embeddingDimensions ?? envDimensions();
  if (!Number.isInteger(dim) || dim <= 0 || dim > 16000) {
    throw new Error(`Dimensión de embedding inválida: ${dim} (pgvector admite 1..16000).`);
  }

  const existing = await currentEmbeddingDimension(db);
  if (existing !== null && existing !== dim) {
    throw new Error(
      `knowledge_docs.embedding ya existe con dimensión ${existing} y se pidió ${dim}. ` +
        `Cambiar de modelo de embeddings exige recrear la columna: ` +
        `ALTER TABLE knowledge_docs DROP COLUMN embedding; y volver a indexar (ver docs/POSTGRES.md).`,
    );
  }

  if (existing === null) {
    await db.execute(
      sql`ALTER TABLE knowledge_docs ADD COLUMN embedding ${sql.raw(`vector(${dim})`)}`,
    );
  }
  // Trazabilidad: con qué modelo y cuándo se vectorizó cada doc (reindexado selectivo).
  await db.execute(sql`ALTER TABLE knowledge_docs ADD COLUMN IF NOT EXISTS embedding_model text`);
  await db.execute(sql`ALTER TABLE knowledge_docs ADD COLUMN IF NOT EXISTS embedded_at bigint`);

  const indexKind = opts.vectorIndex ?? "hnsw";
  if (indexKind === "hnsw") {
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS idx_knowledge_embedding_hnsw
        ON knowledge_docs USING hnsw (embedding vector_cosine_ops)
    `);
  } else if (indexKind === "ivfflat") {
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS idx_knowledge_embedding_ivfflat
        ON knowledge_docs USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)
    `);
  }

  caps.vector = true;
  caps.embeddingDimensions = dim;
  return caps;
}

/** Dimensión declarada de `knowledge_docs.embedding`, o null si la columna no existe. */
export async function currentEmbeddingDimension(db: AgentosPgDb): Promise<number | null> {
  const rows = await db.execute<{ dim: number | null }>(sql`
    SELECT CASE WHEN a.atttypmod > 0 THEN a.atttypmod ELSE NULL END AS dim
    FROM pg_attribute a
    WHERE a.attrelid = 'knowledge_docs'::regclass
      AND a.attname = 'embedding'
      AND NOT a.attisdropped
  `);
  const first = rows[0];
  if (!first) return null;
  return first.dim === null ? null : Number(first.dim);
}

// ── Búsqueda por palabras (equivalente exacto de FTS5) ──────────────────────

/**
 * Nota de portabilidad del `rank`: en FTS5 el rank es **menor = mejor**; en
 * Postgres `ts_rank` es **mayor = mejor**. Devolvemos `-ts_rank` para que el
 * contrato ("ordenar por rank ascendente = mejores primero") sea idéntico en
 * los dos motores y el llamante no tenga que saber cuál hay debajo.
 */
export async function searchMessagesPg(
  db: AgentosPgDb,
  query: string,
  limit = 20,
  cfg = DEFAULT_TS_CONFIG,
): Promise<MessageSearchHit[]> {
  assertSafeIdentifier(cfg, "textSearchConfig");
  const q = sql.raw(`'${cfg}'`);
  const rows = await db.execute(sql`
    SELECT m.id,
           m.thread_id  AS "threadId",
           m.content,
           m.created_at AS "createdAt",
           -ts_rank(m.content_tsv, websearch_to_tsquery(${q}, ${query})) AS rank
    FROM messages m
    WHERE m.content_tsv @@ websearch_to_tsquery(${q}, ${query})
    ORDER BY rank
    LIMIT ${limit}
  `);
  return rows.map((r) => ({
    id: String(r.id),
    threadId: String(r.threadId),
    content: String(r.content),
    createdAt: Number(r.createdAt),
    rank: Number(r.rank),
  }));
}

export async function searchKnowledgePg(
  db: AgentosPgDb,
  query: string,
  limit = 20,
  cfg = DEFAULT_TS_CONFIG,
): Promise<KnowledgeSearchHit[]> {
  assertSafeIdentifier(cfg, "textSearchConfig");
  const q = sql.raw(`'${cfg}'`);
  // ts_headline con los MISMOS marcadores que snippet() de FTS5: « … ».
  const rows = await db.execute(sql`
    SELECT k.id,
           k.org_id     AS "orgId",
           k.project_id AS "projectId",
           k.kind,
           k.title,
           ts_headline(${q}, k.body_md, websearch_to_tsquery(${q}, ${query}),
                       'StartSel=«, StopSel=», MaxWords=24, MinWords=8, MaxFragments=1') AS snippet,
           -ts_rank(k.doc_tsv, websearch_to_tsquery(${q}, ${query})) AS rank
    FROM knowledge_docs k
    WHERE k.doc_tsv @@ websearch_to_tsquery(${q}, ${query})
    ORDER BY rank
    LIMIT ${limit}
  `);
  return rows.map(toKnowledgeHit);
}

export interface TaskSearchPgOptions extends TaskSearchOptions {
  /** Diccionario de to_tsvector; el mismo que usó `ensurePgSearch`. */
  textSearchConfig?: string;
  /**
   * `tsvector` (default) usa las columnas generadas; `ilike` es el plan B
   * portátil para una base donde `ensurePgSearch` todavía no ha corrido.
   */
  mode?: "tsvector" | "ilike";
}

/**
 * Equivalente Postgres de `searchTasks` (FTS5). Devuelve exactamente la misma
 * forma, incluido el criterio de rank (menor = mejor, ver la nota de
 * portabilidad de arriba). Si las columnas generadas aún no existen, cae a
 * ILIKE en vez de romper la búsqueda.
 */
export async function searchTasksPg(
  db: AgentosPgDb,
  query: string,
  options: TaskSearchPgOptions = {},
): Promise<TaskSearchHit[]> {
  const cfg = options.textSearchConfig ?? DEFAULT_TS_CONFIG;
  assertSafeIdentifier(cfg, "textSearchConfig");
  const trimmed = query.trim();
  if (!trimmed) return [];
  if (options.mode === "ilike") return searchTasksIlike(db, trimmed, options);
  try {
    return await searchTasksTsv(db, trimmed, options, cfg);
  } catch {
    // Base sin `ensurePgSearch`: la búsqueda sigue respondiendo, más lenta.
    return searchTasksIlike(db, trimmed, options);
  }
}

function taskScope(options: TaskSearchOptions) {
  return {
    project: options.projectId ? sql` AND t.project_id = ${options.projectId}` : sql``,
    person: options.personId
      ? sql` AND EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = t.id AND ta.person_id = ${options.personId})`
      : sql``,
  };
}

async function searchTasksTsv(
  db: AgentosPgDb,
  query: string,
  options: TaskSearchOptions,
  cfg: string,
): Promise<TaskSearchHit[]> {
  const limit = options.limit ?? 20;
  const q = sql.raw(`'${cfg}'`);
  const scope = taskScope(options);
  const rows = await db.execute(sql`
    SELECT t.id,
           t.project_id AS "projectId",
           t.title,
           t.status,
           t.stage,
           t.due_at AS "dueAt",
           ts_headline(${q}, coalesce(t.description, t.title),
                       websearch_to_tsquery(${q}, ${query}),
                       'StartSel=«, StopSel=», MaxWords=20, MinWords=5, MaxFragments=1') AS snippet,
           -ts_rank(t.task_tsv, websearch_to_tsquery(${q}, ${query})) AS rank,
           'task' AS source
    FROM tasks t
    WHERE t.task_tsv @@ websearch_to_tsquery(${q}, ${query})${scope.project}${scope.person}
    UNION ALL
    SELECT t.id,
           t.project_id AS "projectId",
           t.title,
           t.status,
           t.stage,
           t.due_at AS "dueAt",
           ts_headline(${q}, coalesce(e.payload ->> 'body', ''),
                       websearch_to_tsquery(${q}, ${query}),
                       'StartSel=«, StopSel=», MaxWords=20, MinWords=5, MaxFragments=1') AS snippet,
           -ts_rank(e.comment_tsv, websearch_to_tsquery(${q}, ${query})) AS rank,
           'comment' AS source
    FROM task_events e
    JOIN tasks t ON t.id = e.task_id
    WHERE e.kind = 'comment'
      AND e.comment_tsv @@ websearch_to_tsquery(${q}, ${query})${scope.project}${scope.person}
    ORDER BY rank
    LIMIT ${limit * 4}
  `);
  return mergeTaskHits(rows, limit);
}

async function searchTasksIlike(
  db: AgentosPgDb,
  query: string,
  options: TaskSearchOptions,
): Promise<TaskSearchHit[]> {
  const limit = options.limit ?? 20;
  const like = `%${query.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  const scope = taskScope(options);
  const rows = await db.execute(sql`
    SELECT t.id,
           t.project_id AS "projectId",
           t.title,
           t.status,
           t.stage,
           t.due_at AS "dueAt",
           coalesce(t.description, t.title) AS snippet,
           0 AS rank,
           'task' AS source
    FROM tasks t
    WHERE (t.title ILIKE ${like} OR t.description ILIKE ${like} OR t.definition_of_done ILIKE ${like})
      ${scope.project}${scope.person}
    UNION ALL
    SELECT t.id,
           t.project_id AS "projectId",
           t.title,
           t.status,
           t.stage,
           t.due_at AS "dueAt",
           coalesce(e.payload ->> 'body', '') AS snippet,
           1 AS rank,
           'comment' AS source
    FROM task_events e
    JOIN tasks t ON t.id = e.task_id
    WHERE e.kind = 'comment' AND e.payload ->> 'body' ILIKE ${like}
      ${scope.project}${scope.person}
    ORDER BY rank
    LIMIT ${limit * 4}
  `);
  return mergeTaskHits(rows, limit);
}

/** Una fila por tarea, quedándose con el mejor rank (mismo criterio que FTS5). */
function mergeTaskHits(rows: Record<string, unknown>[], limit: number): TaskSearchHit[] {
  const best = new Map<string, TaskSearchHit>();
  for (const r of rows) {
    const hit: TaskSearchHit = {
      id: String(r.id),
      projectId: String(r.projectId),
      title: String(r.title),
      status: String(r.status),
      stage: String(r.stage),
      dueAt: r.dueAt === null || r.dueAt === undefined ? null : Number(r.dueAt),
      snippet: String(r.snippet ?? ""),
      source: r.source === "comment" ? "comment" : "task",
      rank: Number(r.rank),
    };
    const previous = best.get(hit.id);
    if (!previous || hit.rank < previous.rank) best.set(hit.id, hit);
  }
  return [...best.values()].sort((a, b) => a.rank - b.rank).slice(0, limit);
}

/** Normaliza una fila cruda de tsvector/pgvector al contrato de `KnowledgeSearchHit`. */
function toKnowledgeHit(r: Record<string, unknown>): KnowledgeSearchHit {
  return {
    id: String(r.id),
    orgId: r.orgId === null || r.orgId === undefined ? null : String(r.orgId),
    projectId: r.projectId === null || r.projectId === undefined ? null : String(r.projectId),
    kind: String(r.kind),
    title: String(r.title),
    snippet: String(r.snippet ?? ""),
    rank: Number(r.rank),
  };
}

// ── Búsqueda SEMÁNTICA (pgvector) — la ganancia del Context Hub ─────────────

export interface KnowledgeSemanticHit extends KnowledgeSearchHit {
  /** Distancia coseno de pgvector (0 = idéntico, 2 = opuesto). Menor = mejor. */
  distance: number;
  /** Similitud 1 - distancia, para mostrar en UI. */
  score: number;
}

export interface KnowledgeSemanticResult {
  /** `vector` = se usó pgvector; `keyword` = degradación limpia a tsvector. */
  mode: "vector" | "keyword";
  hits: KnowledgeSemanticHit[];
  /** Presente cuando `mode === 'keyword'`: por qué no hubo semántica. */
  degradedReason?: string;
}

export interface SemanticSearchOptions {
  /** Proveedor inyectado. `null`/ausente ⇒ degradación a tsvector. */
  embedder?: EmbeddingProvider | null;
  orgId?: string;
  projectId?: string;
  /** Descarta resultados con similitud por debajo de este umbral (0..1). */
  minScore?: number;
  textSearchConfig?: string;
}

/**
 * Busca los `k` documentos del Context Hub más cercanos SEMÁNTICAMENTE a la
 * consulta. Si no hay embedder o no hay pgvector, cae a tsvector y lo dice
 * (`mode: 'keyword'`) — nunca lanza por falta de configuración.
 */
export async function knowledgeSemanticSearch(
  db: AgentosPgDb,
  query: string,
  k = 10,
  opts: SemanticSearchOptions = {},
): Promise<KnowledgeSemanticResult> {
  const cfg = opts.textSearchConfig ?? DEFAULT_TS_CONFIG;
  const embedder = opts.embedder ?? null;

  const degrade = async (reason: string): Promise<KnowledgeSemanticResult> => {
    const hits = await searchKnowledgePg(db, query, k, cfg);
    return {
      mode: "keyword",
      degradedReason: reason,
      hits: hits.map((h) => ({ ...h, distance: Number.NaN, score: Number.NaN })),
    };
  };

  if (!embedder) return degrade("no hay proveedor de embeddings configurado (OPENAI_API_KEY vacía)");

  const dim = await currentEmbeddingDimension(db);
  if (dim === null) return degrade("pgvector no está activo en esta base (falta ensurePgSearch)");
  if (dim !== embedder.dimensions) {
    return degrade(
      `la columna embedding es vector(${dim}) y el proveedor produce ${embedder.dimensions}`,
    );
  }

  const [vec] = await embedder.embed([query]);
  if (!vec) return degrade("el proveedor de embeddings no devolvió vector");
  const literal = toPgVector(vec);

  const orgFilter = opts.orgId ? sql`AND k.org_id = ${opts.orgId}` : sql``;
  const projectFilter = opts.projectId ? sql`AND k.project_id = ${opts.projectId}` : sql``;

  const rows = await db.execute(sql`
    SELECT k.id,
           k.org_id     AS "orgId",
           k.project_id AS "projectId",
           k.kind,
           k.title,
           left(k.body_md, 240) AS snippet,
           (k.embedding <=> ${literal}::vector) AS distance,
           0::float8 AS rank
    FROM knowledge_docs k
    WHERE k.embedding IS NOT NULL
      ${orgFilter}
      ${projectFilter}
    ORDER BY k.embedding <=> ${literal}::vector
    LIMIT ${k}
  `);

  const hits = rows
    .map((r) => {
      const distance = Number(r.distance);
      // `rank` mantiene el contrato compartido "menor = mejor" (aquí, distancia).
      return { ...toKnowledgeHit(r), rank: distance, distance, score: 1 - distance };
    })
    .filter((h) => (opts.minScore === undefined ? true : h.score >= opts.minScore));

  return { mode: "vector", hits };
}

// ── Indexado de embeddings ──────────────────────────────────────────────────

export interface EmbedResult {
  /** Documentos vectorizados en esta pasada. */
  embedded: number;
  /** Documentos que quedaron sin vectorizar (sin embedder o sin pgvector). */
  skipped: number;
  reason?: string;
}

/** Texto que se vectoriza de un doc: mismo criterio que el índice tsvector. */
export function knowledgeEmbeddingText(title: string, bodyMd: string): string {
  return `${title}\n\n${bodyMd}`.slice(0, 8000);
}

/** Vectoriza (o revectoriza) un documento concreto. No-op si no hay embedder. */
export async function embedKnowledgeDoc(
  db: AgentosPgDb,
  docId: string,
  embedder: EmbeddingProvider | null,
): Promise<EmbedResult> {
  if (!embedder) return { embedded: 0, skipped: 1, reason: "sin proveedor de embeddings" };
  const dim = await currentEmbeddingDimension(db);
  if (dim === null) return { embedded: 0, skipped: 1, reason: "pgvector no activo" };
  if (dim !== embedder.dimensions) {
    return { embedded: 0, skipped: 1, reason: `dimensión ${embedder.dimensions} ≠ vector(${dim})` };
  }

  const rows = await db.execute<{ title: string; body_md: string }>(
    sql`SELECT title, body_md FROM knowledge_docs WHERE id = ${docId}`,
  );
  const doc = rows[0];
  if (!doc) return { embedded: 0, skipped: 1, reason: "documento inexistente" };

  const [vec] = await embedder.embed([knowledgeEmbeddingText(doc.title, doc.body_md)]);
  if (!vec) return { embedded: 0, skipped: 1, reason: "el proveedor no devolvió vector" };

  await db.execute(sql`
    UPDATE knowledge_docs
       SET embedding = ${toPgVector(vec)}::vector,
           embedding_model = ${embedder.id},
           embedded_at = ${Date.now()}
     WHERE id = ${docId}
  `);
  return { embedded: 1, skipped: 0 };
}

/**
 * Backfill: vectoriza los docs que aún no lo están (o cuyo modelo cambió).
 * Pensado para correr tras `migrate-to-pg` o tras cambiar de modelo.
 */
export async function backfillKnowledgeEmbeddings(
  db: AgentosPgDb,
  embedder: EmbeddingProvider | null,
  opts: { batchSize?: number; limit?: number; onProgress?: (done: number) => void } = {},
): Promise<EmbedResult> {
  if (!embedder) return { embedded: 0, skipped: 0, reason: "sin proveedor de embeddings" };
  const dim = await currentEmbeddingDimension(db);
  if (dim === null) return { embedded: 0, skipped: 0, reason: "pgvector no activo" };
  if (dim !== embedder.dimensions) {
    return { embedded: 0, skipped: 0, reason: `dimensión ${embedder.dimensions} ≠ vector(${dim})` };
  }

  const batchSize = opts.batchSize ?? 32;
  let embedded = 0;

  for (;;) {
    if (opts.limit !== undefined && embedded >= opts.limit) break;
    const take = opts.limit === undefined ? batchSize : Math.min(batchSize, opts.limit - embedded);
    const pending = await db.execute<{ id: string; title: string; body_md: string }>(sql`
      SELECT id, title, body_md FROM knowledge_docs
       WHERE embedding IS NULL OR embedding_model IS DISTINCT FROM ${embedder.id}
       ORDER BY created_at
       LIMIT ${take}
    `);
    if (pending.length === 0) break;

    const vectors = await embedder.embed(
      pending.map((d) => knowledgeEmbeddingText(d.title, d.body_md)),
    );
    const at = Date.now();
    for (let i = 0; i < pending.length; i++) {
      const doc = pending[i];
      const vec = vectors[i];
      if (!doc || !vec) continue;
      await db.execute(sql`
        UPDATE knowledge_docs
           SET embedding = ${toPgVector(vec)}::vector,
               embedding_model = ${embedder.id},
               embedded_at = ${at}
         WHERE id = ${doc.id}
      `);
      embedded++;
    }
    opts.onProgress?.(embedded);
  }

  return { embedded, skipped: 0 };
}

// ── Utilidades ──────────────────────────────────────────────────────────────

function envDimensions(): number {
  const raw = process.env.AGENTOS_EMBEDDING_DIM;
  return raw ? Number(raw) : DEFAULT_EMBEDDING_DIM;
}

/**
 * El nombre del diccionario va INTERPOLADO en SQL (no puede ser parámetro en
 * una columna generada), así que se valida con lista blanca de caracteres.
 */
function assertSafeIdentifier(value: string, what: string): void {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) {
    throw new Error(`${what}="${value}" no es un identificador válido de Postgres.`);
  }
}
