import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { openDb, resolveDbPath, type AgentosDb } from "./client.js";
import { ensureFts } from "./search.js";

const MIGRATIONS_FOLDER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "drizzle",
);

/**
 * Aplica las migraciones de drizzle-kit y garantiza las estructuras FTS
 * (aisladas de las migraciones porque son específicas del motor — ver search.ts).
 */
export function runMigrations(db: AgentosDb): void {
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  ensureFts(db);
}

// Ejecutable: `pnpm --filter @agentos/db migrate` (tsx src/migrate.ts)
const isMain =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const db = openDb();
  runMigrations(db);
  console.log(`Migraciones aplicadas en ${resolveDbPath()}`);
  db.$client.close();
}
