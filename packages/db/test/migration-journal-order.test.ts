import path from "node:path";
import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { describe, expect, it } from "vitest";
import { openDb, type AgentosSqliteDb } from "../src/client.js";
import { runMigrations } from "../src/migrate.js";

const MIGRATIONS_FOLDER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "drizzle",
);

const NOTION_LINEAGE_TABLES = [
  "notion_migration_runs",
  "notion_page_archives",
  "notion_import_links",
  "notion_identity_mappings",
  "notion_import_quarantine",
];

function tableNames(db: AgentosSqliteDb): string[] {
  return (
    db.$client
      .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
      .all() as { name: string }[]
  ).map((r) => r.name);
}

describe("orden de aplicación de migraciones (B1)", () => {
  // Drizzle decide qué migraciones aplicar comparando el `created_at` de la
  // ÚLTIMA fila de __drizzle_migrations contra el `when` (folderMillis) de
  // cada migración del journal — no por índice/orden en el array (ver
  // node_modules/drizzle-orm sqlite-core/dialect.js: SQLiteSyncDialect.migrate,
  // `ORDER BY created_at DESC LIMIT 1` + `lastDbMigration.created_at < folderMillis`).
  // Si otra rama (feat/tareas-ui) ya aplicó su 0006 con un `when` posterior al
  // `when` que tenía nuestra 0007 antes del fix, esta jamás se aplicaría.
  it("aplica 0007_notion_linaje aunque ya haya una migración registrada con created_at posterior (0006 de otra rama)", () => {
    const db = openDb(":memory:");

    // 1) Aplica de verdad las migraciones previas a la de linaje (0000-0005),
    // registrando su hash/created_at reales en __drizzle_migrations —
    // exactamente como quedaría una DB ya migrada en producción.
    const allMigrations = readMigrationFiles({ migrationsFolder: MIGRATIONS_FOLDER });
    const priorMigrations = allMigrations.filter((m) => m.folderMillis < 1787950000000);
    expect(priorMigrations.length).toBeGreaterThan(0);

    db.$client.exec(`
      CREATE TABLE IF NOT EXISTS __drizzle_migrations (
        id SERIAL PRIMARY KEY,
        hash text NOT NULL,
        created_at numeric
      )
    `);
    const insertMigrationRow = db.$client.prepare(
      `INSERT INTO __drizzle_migrations ("hash", "created_at") VALUES (?, ?)`,
    );
    db.$client.transaction(() => {
      for (const migration of priorMigrations) {
        for (const stmt of migration.sql) db.$client.exec(stmt);
        insertMigrationRow.run(migration.hash, migration.folderMillis);
      }
    })();

    // 2) Simula que otra rama ya corrió su migración 0006 sobre esta misma
    // DB, dejando registrado un created_at posterior al `when` original
    // (sin fix) de nuestra 0007 (1787960000000).
    insertMigrationRow.run("otra-rama-0006", 1788000000000);

    // 3) Corre nuestras migraciones (incluida 0007_notion_linaje) tal como
    // lo haría el arranque real de la app.
    runMigrations(db);

    const names = tableNames(db);
    for (const t of NOTION_LINEAGE_TABLES) {
      expect(names, `falta tabla ${t} — 0007 no se aplicó`).toContain(t);
    }
  });
});
