import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { openDb, resolveDbPath, type AgentosSqliteDb } from "./client.js";
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
export function runMigrations(db: AgentosSqliteDb): void {
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  ensureTaskTrashColumns(db);
  ensureFts(db);
}

/**
 * Red de seguridad de la migración `0014_tareas_papelera` (idempotente).
 *
 * Drizzle NO aplica una migración cuyo `when` sea menor o igual que el
 * `created_at` de la ÚLTIMA fila de `__drizzle_migrations` (ver
 * test/migration-journal-order.test.ts). La papelera se escribió en paralelo
 * con otra rama (feat/organigrama-vivo) que reservó 0012–0013 con `when`
 * posteriores al de la 0014: si esa rama llega antes a una base, la 0014 se
 * saltaría EN SILENCIO. Este paso deja columnas e índice garantizados sea cual
 * sea el orden de merge, sin tocar el journal de nadie. Si ya están, no hace nada.
 */
export function ensureTaskTrashColumns(db: AgentosSqliteDb): void {
  const columns = (db.$client.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]).map(
    (c) => c.name,
  );
  if (!columns.includes("deleted_at")) db.$client.exec("ALTER TABLE tasks ADD deleted_at integer");
  if (!columns.includes("deleted_by")) db.$client.exec("ALTER TABLE tasks ADD deleted_by text");
  db.$client.exec("CREATE INDEX IF NOT EXISTS idx_tasks_deleted_at ON tasks (deleted_at)");
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
