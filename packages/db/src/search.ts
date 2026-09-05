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
import type { AgentosDb } from "./client.js";

/**
 * Crea las tablas virtuales FTS5 (contenido externo, clave rowid) y los triggers
 * espejo. Idempotente: se puede llamar en cada arranque. Estos triggers NO son
 * lógica de negocio — solo mantienen el índice espejo (permitido por §5).
 */
export function ensureFts(db: AgentosDb): void {
  const sql = db.$client;
  const exists = (name: string): boolean =>
    sql.prepare(`SELECT 1 FROM sqlite_master WHERE name = ?`).get(name) !== undefined;
  // Las tablas de tareas se crean sobre bases ya pobladas: hay que sembrarlas
  // la primera vez o la búsqueda mentiría diciendo "sin resultados".
  const tasksFtsIsNew = !exists("tasks_fts");
  const commentsFtsIsNew = !exists("task_comments_fts");

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

    CREATE VIRTUAL TABLE IF NOT EXISTS tasks_fts USING fts5(
      title,
      description,
      definition_of_done,
      content='tasks',
      content_rowid='rowid'
    );

    CREATE TRIGGER IF NOT EXISTS trg_tasks_fts_ai AFTER INSERT ON tasks BEGIN
      INSERT INTO tasks_fts(rowid, title, description, definition_of_done)
        VALUES (new.rowid, new.title, new.description, new.definition_of_done);
    END;
    CREATE TRIGGER IF NOT EXISTS trg_tasks_fts_ad AFTER DELETE ON tasks BEGIN
      INSERT INTO tasks_fts(tasks_fts, rowid, title, description, definition_of_done)
        VALUES ('delete', old.rowid, old.title, old.description, old.definition_of_done);
    END;
    CREATE TRIGGER IF NOT EXISTS trg_tasks_fts_au
      AFTER UPDATE OF title, description, definition_of_done ON tasks BEGIN
      INSERT INTO tasks_fts(tasks_fts, rowid, title, description, definition_of_done)
        VALUES ('delete', old.rowid, old.title, old.description, old.definition_of_done);
      INSERT INTO tasks_fts(rowid, title, description, definition_of_done)
        VALUES (new.rowid, new.title, new.description, new.definition_of_done);
    END;

    -- Los comentarios viven dentro de task_events.payload (JSON), no en una
    -- columna: por eso este índice NO es de contenido externo y los triggers
    -- extraen el cuerpo. task_events es append-only, así que no hace falta
    -- espejo de UPDATE.
    CREATE VIRTUAL TABLE IF NOT EXISTS task_comments_fts USING fts5(
      task_id UNINDEXED,
      event_id UNINDEXED,
      body
    );

    CREATE TRIGGER IF NOT EXISTS trg_task_comments_fts_ai
      AFTER INSERT ON task_events WHEN new.kind = 'comment' BEGIN
      INSERT INTO task_comments_fts(task_id, event_id, body)
        VALUES (new.task_id, new.id, json_extract(new.payload, '$.body'));
    END;
    CREATE TRIGGER IF NOT EXISTS trg_task_comments_fts_ad
      AFTER DELETE ON task_events WHEN old.kind = 'comment' BEGIN
      DELETE FROM task_comments_fts WHERE event_id = old.id;
    END;
  `);

  if (tasksFtsIsNew) {
    sql.exec(`INSERT INTO tasks_fts(tasks_fts) VALUES('rebuild');`);
  }
  if (commentsFtsIsNew) {
    sql.exec(
      `INSERT INTO task_comments_fts(task_id, event_id, body)
       SELECT task_id, id, json_extract(payload, '$.body')
         FROM task_events
        WHERE kind = 'comment' AND json_extract(payload, '$.body') IS NOT NULL;`,
    );
  }
}

export interface MessageSearchHit {
  id: string;
  threadId: string;
  content: string;
  createdAt: number;
  rank: number;
}

export function searchMessages(db: AgentosDb, query: string, limit = 20): MessageSearchHit[] {
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

export function searchKnowledge(db: AgentosDb, query: string, limit = 20): KnowledgeSearchHit[] {
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

export interface TaskSearchHit {
  id: string;
  projectId: string;
  title: string;
  status: string;
  stage: string;
  dueAt: number | null;
  /** Extracto donde cayó el match; en un comentario, el propio comentario. */
  snippet: string;
  /** Qué parte de la tarea coincidió: su ficha o uno de sus comentarios. */
  source: "task" | "comment";
  rank: number;
}

export interface TaskSearchOptions {
  limit?: number;
  projectId?: string;
  /** Restringe a las tareas de una persona (tabla puente task_assignees). */
  personId?: string;
}

/**
 * Busca tareas por título, descripción, definición de terminado y comentarios.
 *
 * Son dos índices distintos (la ficha vive en `tasks`, el comentario en el
 * payload JSON de `task_events`), así que se consultan por separado y se
 * fusionan quedándose con el mejor rank por tarea. El equivalente Postgres
 * está en `pg/search-pg.ts` y devuelve exactamente esta forma.
 */
export function searchTasks(
  db: AgentosDb,
  query: string,
  options: TaskSearchOptions = {},
): TaskSearchHit[] {
  const limit = options.limit ?? 20;
  const match = sanitizeFtsQuery(query);
  if (match === '""') return [];
  // Se pide de más en cada índice porque el filtro por proyecto/persona y la
  // fusión por tarea reducen el conjunto antes de recortar al límite final.
  const perIndex = limit * 4;
  const scopeSql = `${options.projectId ? " AND t.project_id = @projectId" : ""}${
    options.personId
      ? " AND EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = t.id AND ta.person_id = @personId)"
      : ""
  }`;
  const params: Record<string, unknown> = { match, perIndex };
  if (options.projectId) params.projectId = options.projectId;
  if (options.personId) params.personId = options.personId;

  const fromTasks = db.$client
    .prepare(
      `SELECT t.id, t.project_id AS projectId, t.title, t.status, t.stage, t.due_at AS dueAt,
              snippet(tasks_fts, 1, '«', '»', ' … ', 20) AS snippet, f.rank
         FROM tasks_fts f
         JOIN tasks t ON t.rowid = f.rowid
        WHERE tasks_fts MATCH @match${scopeSql}
        ORDER BY f.rank
        LIMIT @perIndex`,
    )
    .all(params) as Omit<TaskSearchHit, "source">[];

  const fromComments = db.$client
    .prepare(
      `SELECT t.id, t.project_id AS projectId, t.title, t.status, t.stage, t.due_at AS dueAt,
              snippet(task_comments_fts, 2, '«', '»', ' … ', 20) AS snippet, c.rank
         FROM task_comments_fts c
         JOIN tasks t ON t.id = c.task_id
        WHERE task_comments_fts MATCH @match${scopeSql}
        ORDER BY c.rank
        LIMIT @perIndex`,
    )
    .all(params) as Omit<TaskSearchHit, "source">[];

  const best = new Map<string, TaskSearchHit>();
  for (const row of fromTasks) best.set(row.id, { ...row, source: "task" });
  for (const row of fromComments) {
    const previous = best.get(row.id);
    // La ficha gana si su rank es mejor; el comentario solo aporta cuando la
    // ficha no coincidía o coincidía peor.
    if (!previous || row.rank < previous.rank) best.set(row.id, { ...row, source: "comment" });
  }
  return [...best.values()].sort((a, b) => a.rank - b.rank).slice(0, limit);
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
