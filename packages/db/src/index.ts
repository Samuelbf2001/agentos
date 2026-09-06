/**
 * `@agentos/db` — persistencia AgentOS. **Superficie ASÍNCRONA única** para los
 * dos motores (rama feat/postgres-async):
 *
 *   SQLite (default, cero fricción)  →  src/repositories/*      (síncronos)
 *   Postgres/Supabase (opt-in)       →  src/pg/repositories/*   (asíncronos)
 *
 * Los nombres, los argumentos y los tipos de fila son los MISMOS de siempre
 * (NFR-9). Lo único que el llamante nota es que ahora hay que `await`: es el
 * precio irreducible de que no exista driver Postgres síncrono en Node
 * (docs/POSTGRES.md §5). El despacho por motor vive en `facade.ts` y NO se
 * filtra: `apps/api`, `packages/core`, `packages/tools` y `apps/mcp-admin`
 * llaman siempre igual.
 *
 * Regla dura (ARCHITECTURE §5): NINGUNA consulta fuera de `repositories/`
 * (`search.ts` / `pg/search-pg.ts` son la única otra puerta, y solo para
 * búsqueda de texto). El backend Postgres vive en el entrypoint SEPARADO
 * `@agentos/db/pg` para que quien use SQLite jamás cargue `postgres-js`.
 */
export { openDb, closeDb, resolveDbPath, REPO_ROOT, schema } from "./client.js";
export type { AgentosSqliteDb } from "./client.js";
/** Handle de DB del motor configurado — es lo que circula por toda la app. */
export type { AnyDb, AnyDb as AgentosDb, PgBackend } from "./facade.js";
export { isPgDb, withTransaction, markPgDb, requirePgBackend } from "./facade.js";
export { resolveDriver, isPostgresDriver, type DbDriver } from "./driver.js";
export {
  openConfiguredDb,
  closeAnyDb,
  applyMigrations,
  type OpenConfiguredOptions,
} from "./open.js";
// Embeddings: agnósticos del motor (el mock no toca red; sin key, `null` limpio).
export * from "./embeddings.js";
export { runMigrations } from "./migrate.js";
export * from "./types.js";
export { ensureFts, type MessageSearchHit, type KnowledgeSearchHit } from "./search.js";
export * from "./seed-sources.js";

// Repositorios duales (SQLite síncrono / Postgres asíncrono, misma firma).
export * from "./repos.js";

// Motor de launch de Módulos de Fase (§13.3) y seed: escritos UNA vez contra
// la fachada, valen para los dos motores.
export * from "./modules/launch.js";
export {
  seed,
  seedCatalog,
  seedDemo,
  type SeedCounts,
  type CatalogSeedResult,
} from "./seed.js";
