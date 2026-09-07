/**
 * `@agentos/db/pg` — backend Postgres/Supabase (ALTERNATIVO; SQLite sigue siendo
 * el default de cero fricción).
 *
 * Entrypoint SEPARADO a propósito: quien solo usa SQLite nunca carga
 * `postgres-js`. Se activa con `AGENTOS_DB_DRIVER=postgres` + `AGENTOS_PG_URL`.
 *
 * Regla dura heredada de §5: ninguna consulta fuera de `pg/repositories/`
 * (`search-pg.ts` es la única otra puerta, y solo para tsvector/pgvector).
 */
export {
  openPgDb,
  closePgDb,
  resolvePgUrl,
  looksLikeTransactionPooler,
  pgSchema,
  type AgentosPgDb,
  type OpenPgOptions,
} from "./client-pg.js";
export { PG_TABLE_ORDER, type PgTableName } from "./schema-pg.js";
export * from "./types-pg.js";
export { runPgMigrations, PG_MIGRATIONS_FOLDER } from "./migrate-pg.js";
export * from "./search-pg.js";
export {
  migrateSqliteToPostgres,
  copyAllTables,
  TABLE_PAIRS,
  redactUrl,
  type MigrationReport,
  type MigrateToPgOptions,
  type TableReport,
} from "./migrate-to-pg.js";

export * from "./repositories/org-graph.js";
export * from "./repositories/organizations-people.js";
export * from "./repositories/projects.js";
export * from "./repositories/providers.js";
export * from "./repositories/agents.js";
export * from "./repositories/tasks.js";
export * from "./repositories/task-assignees.js";
export * from "./repositories/task-labels.js";
export * from "./repositories/task-notifications.js";
export * from "./repositories/runs.js";
export * from "./repositories/events.js";
export * from "./repositories/threads.js";
export * from "./repositories/approvals.js";
export * from "./repositories/audit.js";
export * from "./repositories/knowledge.js";
export * from "./repositories/project-sources.js";
export * from "./repositories/processes.js";
export * from "./repositories/methodologies.js";
export * from "./repositories/modules.js";
export * from "./repositories/config.js";
export * from "./repositories/stats.js";
export * from "./repositories/notion-migration.js";

// Registro en la fachada: importar `@agentos/db/pg` es lo que habilita el
// despacho a Postgres desde `@agentos/db` (ver src/facade.ts). Va al final para
// que el módulo esté completamente evaluado antes de publicarse.
import * as self from "./index.js";
import { registerPgBackend } from "../facade.js";
registerPgBackend(self);
