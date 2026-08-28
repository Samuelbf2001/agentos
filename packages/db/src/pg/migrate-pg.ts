/**
 * Migraciones de esquema para Postgres — espejo de `src/migrate.ts`.
 * Carpeta APARTE (`drizzle-pg/`): el historial de SQLite no se toca.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { closePgDb, openPgDb, type AgentosPgDb } from "./client-pg.js";
import {
  ensurePgSearch,
  type EnsurePgSearchOptions,
  type PgSearchCapabilities,
} from "./search-pg.js";

export const PG_MIGRATIONS_FOLDER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "drizzle-pg",
);

/**
 * Aplica las migraciones y garantiza las estructuras de búsqueda (tsvector +
 * pgvector), que viven fuera de las migraciones por ser específicas del motor
 * — misma frontera que FTS5 en SQLite (ARCHITECTURE §5).
 */
export async function runPgMigrations(
  db: AgentosPgDb,
  opts: EnsurePgSearchOptions = {},
): Promise<PgSearchCapabilities> {
  await migrate(db, { migrationsFolder: PG_MIGRATIONS_FOLDER });
  return ensurePgSearch(db, opts);
}

// Ejecutable: `pnpm --filter @agentos/db migrate:pg`
const isMain =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const db = openPgDb();
  try {
    const caps = await runPgMigrations(db);
    console.log("Migraciones Postgres aplicadas.");
    console.log(`  búsqueda por texto : tsvector (${caps.textSearchConfig})`);
    console.log(
      caps.vector
        ? `  búsqueda semántica : pgvector vector(${caps.embeddingDimensions}) + HNSW`
        : `  búsqueda semántica : NO disponible — ${caps.vectorUnavailableReason ?? "desconocido"}`,
    );
  } finally {
    await closePgDb(db);
  }
}
