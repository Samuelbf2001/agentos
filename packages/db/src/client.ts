import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

export type AgentosSqliteDb = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

/** Raíz del repo (packages/db/src → ../../..). */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/**
 * Resuelve la ruta de la DB. `AGENTOS_DB_PATH` relativa se interpreta contra la
 * RAÍZ del repo (no contra el cwd), para que `pnpm --filter @agentos/db seed`
 * cree siempre `<repo>/data/agentos.db`.
 */
export function resolveDbPath(dbPath?: string): string {
  const raw = dbPath ?? process.env.AGENTOS_DB_PATH ?? "./data/agentos.db";
  if (raw === ":memory:") return raw;
  return path.isAbsolute(raw) ? raw : path.resolve(REPO_ROOT, raw);
}

/**
 * Abre la base de datos con los pragmas obligatorios (ARCHITECTURE §5):
 * WAL, foreign_keys ON, busy_timeout.
 */
export function openDb(dbPath?: string): AgentosSqliteDb {
  const file = resolveDbPath(dbPath);
  if (file !== ":memory:") {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const client = new Database(file);
  client.pragma("journal_mode = WAL");
  client.pragma("foreign_keys = ON");
  client.pragma("busy_timeout = 5000");
  client.pragma("synchronous = NORMAL");
  return drizzle(client, { schema });
}

export function closeDb(db: AgentosSqliteDb): void {
  db.$client.close();
}

export { schema };
