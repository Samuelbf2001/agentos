/**
 * Búsqueda de texto completo — TODO lo específico de FTS5 vive AQUÍ (ARCHITECTURE §5).
 * El resto del código llama a searchMessages/searchKnowledge sin saber qué motor hay debajo.
 *
 * Equivalente Postgres documentado (para la migración por disparadores de §5):
 *
 *   -- messages: columna generada + índice GIN
 *   ALTER TABLE messages ADD COLUMN content_tsv tsvector
 *     GENERATED ALWAYS AS (to_tsvector('spanish', coalesce(content, ''))) STORED;
 *   CREATE INDEX idx_messages_tsv ON messages USING GIN (content_tsv);
 *   -- consulta: WHERE content_tsv @@ websearch_to_tsquery('spanish', :q)
 *   --           ORDER BY ts_rank(content_tsv, websearch_to_tsquery('spanish', :q)) DESC
 *
 *   -- knowledge_docs: igual con title || ' ' || body_md
 *   ALTER TABLE knowledge_docs ADD COLUMN doc_tsv tsvector
 *     GENERATED ALWAYS AS (to_tsvector('spanish', coalesce(title,'') || ' ' || coalesce(body_md,''))) STORED;
 *   CREATE INDEX idx_knowledge_tsv ON knowledge_docs USING GIN (doc_tsv);
 *
 * En Postgres NO hacen falta los triggers espejo: la columna generada se mantiene sola.
 */
import type { AgentosSqliteDb } from "./client.js";

/**
 * Crea las tablas virtuales FTS5 (contenido externo, clave rowid) y los triggers
 * espejo. Idempotente: se puede llamar en cada arranque. Estos triggers NO son
 * lógica de negocio — solo mantienen el índice espejo (permitido por §5).
 */
export function ensureFts(db: AgentosSqliteDb): void {
  const sql = db.$client;

  sql.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      content,
      content='messages',
      content_rowid='rowid'
    );

    CREATE TRIGGER IF NOT EXISTS trg_messages_fts_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
    END;
    CREATE TRIGGER IF NOT EXISTS trg_messages_fts_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
    END;
    CREATE TRIGGER IF NOT EXISTS trg_messages_fts_au AFTER UPDATE OF content ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
      INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
    END;

    CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
      title,
      body_md,
      content='knowledge_docs',
      content_rowid='rowid'
    );

    CREATE TRIGGER IF NOT EXISTS trg_knowledge_fts_ai AFTER INSERT ON knowledge_docs BEGIN
      INSERT INTO knowledge_fts(rowid, title, body_md) VALUES (new.rowid, new.title, new.body_md);
    END;
    CREATE TRIGGER IF NOT EXISTS trg_knowledge_fts_ad AFTER DELETE ON knowledge_docs BEGIN
      INSERT INTO knowledge_fts(knowledge_fts, rowid, title, body_md) VALUES ('delete', old.rowid, old.title, old.body_md);
    END;
    CREATE TRIGGER IF NOT EXISTS trg_knowledge_fts_au AFTER UPDATE OF title, body_md ON knowledge_docs BEGIN
      INSERT INTO knowledge_fts(knowledge_fts, rowid, title, body_md) VALUES ('delete', old.rowid, old.title, old.body_md);
      INSERT INTO knowledge_fts(rowid, title, body_md) VALUES (new.rowid, new.title, new.body_md);
    END;
  `);
}

export interface MessageSearchHit {
  id: string;
  threadId: string;
  content: string;
  createdAt: number;
  rank: number;
}

export function searchMessages(db: AgentosSqliteDb, query: string, limit = 20): MessageSearchHit[] {
  const rows = db.$client
    .prepare(
      `SELECT m.id, m.thread_id AS threadId, m.content, m.created_at AS createdAt, f.rank
       FROM messages_fts f
       JOIN messages m ON m.rowid = f.rowid
       WHERE messages_fts MATCH ?
       ORDER BY f.rank
       LIMIT ?`,
    )
    .all(sanitizeFtsQuery(query), limit);
  return rows as MessageSearchHit[];
}

export interface KnowledgeSearchHit {
  id: string;
  orgId: string | null;
  projectId: string | null;
  kind: string;
  title: string;
  /** Extracto del body_md alrededor del match (H3): contexto útil sin leer el doc entero. */
  snippet: string;
  rank: number;
}

export function searchKnowledge(db: AgentosSqliteDb, query: string, limit = 20): KnowledgeSearchHit[] {
  // snippet(): columna 1 = body_md, marcadores « », elipsis, ~24 tokens de contexto.
  // Equivalente Postgres: ts_headline('spanish', body_md, websearch_to_tsquery('spanish', :q),
  //   'StartSel=«, StopSel=», MaxWords=24').
  const rows = db.$client
    .prepare(
      `SELECT k.id, k.org_id AS orgId, k.project_id AS projectId, k.kind, k.title,
              snippet(knowledge_fts, 1, '«', '»', ' … ', 24) AS snippet, f.rank
       FROM knowledge_fts f
       JOIN knowledge_docs k ON k.rowid = f.rowid
       WHERE knowledge_fts MATCH ?
       ORDER BY f.rank
       LIMIT ?`,
    )
    .all(sanitizeFtsQuery(query), limit);
  return rows as KnowledgeSearchHit[];
}

/**
 * Convierte texto libre del usuario en una consulta FTS5 segura:
 * cada término entre comillas (evita interpretar operadores) unido por AND implícito.
 */
function sanitizeFtsQuery(query: string): string {
  const terms = query
    .split(/\s+/)
    .map((t) => t.replace(/"/g, "").trim())
    .filter(Boolean);
  if (terms.length === 0) return '""';
  return terms.map((t) => `"${t}"`).join(" ");
}
