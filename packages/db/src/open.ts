/**
 * Apertura y migración de la DB **según el driver configurado**. Es el único
 * sitio del monorepo donde se decide el motor: `apps/api` (y los tests) piden
 * "la DB" y reciben la del driver activo (NFR-9).
 *
 * `postgres-js` solo entra al proceso si el driver es `postgres`: el backend PG
 * se carga con un import dinámico de `@agentos/db/pg`.
 */
import { openDb, type AgentosSqliteDb } from "./client.js";
import { resolveDriver, type DbDriver } from "./driver.js";
import { requirePgBackend, isPgDb, type AnyDb } from "./facade.js";
import { runMigrations } from "./migrate.js";

export interface OpenConfiguredOptions {
  /** Driver explícito; por defecto `AGENTOS_DB_DRIVER` (sqlite). */
  driver?: DbDriver;
  /** Ruta SQLite (default `AGENTOS_DB_PATH` o ./data/agentos.db). */
  dbPath?: string;
  /** URL Postgres (default `AGENTOS_PG_URL`). Obligatoria con driver postgres. */
  pgUrl?: string;
}

/** Abre la DB del driver configurado. */
export async function openConfiguredDb(opts: OpenConfiguredOptions = {}): Promise<AnyDb> {
  const driver = opts.driver ?? resolveDriver();
  if (driver === "postgres") {
    const pg = await requirePgBackend();
    return pg.openPgDb(opts.pgUrl);
  }
  return openDb(opts.dbPath);
}

/**
 * Aplica migraciones + estructuras de búsqueda del motor que sea (FTS5 en
 * SQLite; tsvector/pgvector en Postgres). Idempotente: se llama en cada arranque.
 */
export async function applyMigrations(db: AnyDb): Promise<void> {
  if (isPgDb(db)) {
    const pg = await requirePgBackend();
    await pg.runPgMigrations(db);
    return;
  }
  runMigrations(db as AgentosSqliteDb);
}

/** Cierra la conexión del motor que sea. */
export async function closeAnyDb(db: AnyDb): Promise<void> {
  if (isPgDb(db)) {
    const pg = await requirePgBackend();
    await pg.closePgDb(db);
    return;
  }
  (db as AgentosSqliteDb).$client.close();
}
