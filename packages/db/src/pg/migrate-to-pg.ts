/**
 * Herramienta de migración de DATOS: copia una `agentos.db` (SQLite) existente
 * a Postgres/Supabase.
 *
 *   pnpm --filter @agentos/db migrate-to-pg [--from <ruta.db>] [--to <url>]
 *                                           [--dry-run] [--no-schema] [--embed]
 *
 * Propiedades que se garantizan:
 *  - **Orden topológico**: las tablas se copian en `PG_TABLE_ORDER`, así que
 *    ninguna FK apunta a algo que aún no existe. Las auto-FKs (`tasks.parent_task_id`,
 *    `runs.parent_run_id`, `agents.reports_to`, `module_launches.previous_launch_id`)
 *    se resuelven ordenando por fecha de creación: el padre siempre es anterior,
 *    y dentro de un mismo INSERT multi-fila Postgres valida la integridad
 *    referencial al FINAL de la sentencia (triggers AFTER ROW), no fila a fila.
 *  - **Idempotencia**: antes de insertar se leen las PKs ya presentes en destino
 *    y se filtran. Re-ejecutar no duplica ni falla; el informe distingue
 *    `insertadas` de `ya existían`.
 *  - **Sin conversiones a mano**: se lee con el esquema Drizzle de SQLite y se
 *    escribe con el de Postgres. Drizzle decodifica (0/1→boolean, TEXT→JSON) y
 *    vuelve a codificar (boolean, jsonb). Los tipos de fila son estructuralmente
 *    idénticos, así que la copia la valida el compilador.
 *
 * NO destruye nada en origen: la SQLite se abre y se cierra sin escribir.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import type { PgTable } from "drizzle-orm/pg-core";
import { closeDb, openDb, resolveDbPath, type AgentosDb } from "../client.js";
import { closePgDb, openPgDb, type AgentosPgDb } from "./client-pg.js";
import { runPgMigrations } from "./migrate-pg.js";
import { backfillKnowledgeEmbeddings } from "./search-pg.js";
import { resolveEmbeddingProvider } from "../embeddings.js";
import * as lite from "../schema.js";
import * as pg from "./schema-pg.js";

/** Emparejamiento tabla-a-tabla + cómo identificarla y ordenarla. */
interface TablePair {
  name: string;
  from: SQLiteTable;
  to: PgTable;
  /** Columna PK o columnas de la PK compuesta (para idempotencia). */
  pk: string | readonly string[];
  /** Columna por la que ordenar (auto-FKs: el padre es siempre anterior). */
  orderBy: string;
}

/** En ORDEN TOPOLÓGICO — el mismo de `PG_TABLE_ORDER`. */
export const TABLE_PAIRS: TablePair[] = [
  { name: "organizations", from: lite.organizations, to: pg.organizations, pk: "id", orderBy: "created_at" },
  { name: "people", from: lite.people, to: pg.people, pk: "id", orderBy: "created_at" },
  { name: "projects", from: lite.projects, to: pg.projects, pk: "id", orderBy: "created_at" },
  { name: "provider_profiles", from: lite.providerProfiles, to: pg.providerProfiles, pk: "id", orderBy: "created_at" },
  { name: "agents", from: lite.agents, to: pg.agents, pk: "id", orderBy: "created_at" },
  { name: "prompt_versions", from: lite.promptVersions, to: pg.promptVersions, pk: "id", orderBy: "created_at" },
  { name: "knowledge_docs", from: lite.knowledgeDocs, to: pg.knowledgeDocs, pk: "id", orderBy: "created_at" },
  { name: "project_sources", from: lite.projectSources, to: pg.projectSources, pk: "id", orderBy: "created_at" },
  { name: "processes", from: lite.processes, to: pg.processes, pk: "id", orderBy: "created_at" },
  { name: "methodologies", from: lite.methodologies, to: pg.methodologies, pk: "id", orderBy: "created_at" },
  { name: "phase_modules", from: lite.phaseModules, to: pg.phaseModules, pk: "id", orderBy: "created_at" },
  { name: "tasks", from: lite.tasks, to: pg.tasks, pk: "id", orderBy: "created_at" },
  { name: "task_assignees", from: lite.taskAssignees, to: pg.taskAssignees, pk: ["task_id", "person_id"], orderBy: "created_at" },
  { name: "task_labels", from: lite.taskLabels, to: pg.taskLabels, pk: ["task_id", "label"], orderBy: "created_at" },
  { name: "task_notification_log", from: lite.taskNotificationLog, to: pg.taskNotificationLog, pk: "id", orderBy: "created_at" },
  { name: "runs", from: lite.runs, to: pg.runs, pk: "id", orderBy: "created_at" },
  { name: "spans", from: lite.spans, to: pg.spans, pk: "id", orderBy: "started_at" },
  { name: "events", from: lite.events, to: pg.events, pk: "id", orderBy: "created_at" },
  { name: "task_events", from: lite.taskEvents, to: pg.taskEvents, pk: "id", orderBy: "created_at" },
  { name: "artifacts", from: lite.artifacts, to: pg.artifacts, pk: "id", orderBy: "created_at" },
  { name: "threads", from: lite.threads, to: pg.threads, pk: "id", orderBy: "created_at" },
  { name: "messages", from: lite.messages, to: pg.messages, pk: "id", orderBy: "created_at" },
  { name: "approvals", from: lite.approvals, to: pg.approvals, pk: "id", orderBy: "created_at" },
  { name: "audit_log", from: lite.auditLog, to: pg.auditLog, pk: "id", orderBy: "created_at" },
  { name: "app_config", from: lite.appConfig, to: pg.appConfig, pk: "key", orderBy: "updated_at" },
  { name: "module_launches", from: lite.moduleLaunches, to: pg.moduleLaunches, pk: "id", orderBy: "created_at" },
  { name: "notion_migration_runs", from: lite.notionMigrationRuns, to: pg.notionMigrationRuns, pk: "id", orderBy: "created_at" },
  { name: "notion_page_archives", from: lite.notionPageArchives, to: pg.notionPageArchives, pk: "id", orderBy: "created_at" },
  { name: "notion_import_links", from: lite.notionImportLinks, to: pg.notionImportLinks, pk: "id", orderBy: "created_at" },
  { name: "notion_identity_mappings", from: lite.notionIdentityMappings, to: pg.notionIdentityMappings, pk: "id", orderBy: "created_at" },
  { name: "notion_import_quarantine", from: lite.notionImportQuarantine, to: pg.notionImportQuarantine, pk: "id", orderBy: "created_at" },
];

export interface TableReport {
  table: string;
  /** Filas en la SQLite de origen. */
  source: number;
  /** Filas que ya existían en destino (por PK) y se saltaron. */
  skipped: number;
  /** Filas insertadas en esta ejecución. */
  inserted: number;
  /** Total en destino tras la copia (verificación). */
  target: number;
}

export interface MigrationReport {
  driver: "postgres";
  dryRun: boolean;
  tables: TableReport[];
  totalSource: number;
  totalInserted: number;
  totalTarget: number;
  /** true si para cada tabla `target >= source` (nada se perdió). */
  complete: boolean;
  durationMs: number;
  embeddings?: { embedded: number; skipped: number; reason?: string };
}

export interface MigrateToPgOptions {
  /** Ruta de la SQLite origen (default: `AGENTOS_DB_PATH`). */
  sqlitePath?: string;
  /** URL de destino (default: `AGENTOS_PG_URL`). */
  pgUrl?: string;
  /** `false` = no aplicar migraciones de esquema antes de copiar. */
  applySchema?: boolean;
  /** Solo contar, sin escribir. */
  dryRun?: boolean;
  /** Vectorizar `knowledge_docs` al terminar (requiere proveedor de embeddings). */
  embedAfter?: boolean;
  batchSize?: number;
  log?: (line: string) => void;
}

const BATCH = 500;

/**
 * Copia los datos. Recibe conexiones ya abiertas (así los tests reutilizan las
 * suyas); `migrateSqliteToPostgres` es el envoltorio que las abre y cierra.
 */
export async function copyAllTables(
  lite_: AgentosDb,
  pg_: AgentosPgDb,
  opts: { dryRun?: boolean; batchSize?: number; log?: (line: string) => void } = {},
): Promise<TableReport[]> {
  const log = opts.log ?? (() => {});
  const batchSize = opts.batchSize ?? BATCH;
  const reports: TableReport[] = [];

  for (const pair of TABLE_PAIRS) {
    const rows = readAll(lite_, pair);
    const existing = await existingKeys(pg_, pair);

    // La mayoría de PKs son `id` (y `key` en app_config); task_assignees usa
    // una PK compuesta. `rowKey` mantiene ambos casos idempotentes.
    const pending = rows.filter((r) => !existing.has(rowKey(r, pair.pk)));
    let inserted = 0;

    if (!opts.dryRun && pending.length > 0) {
      for (let i = 0; i < pending.length; i += batchSize) {
        const chunk = pending.slice(i, i + batchSize);
        await pg_.insert(pair.to).values(chunk);
        inserted += chunk.length;
      }
    }

    const target = opts.dryRun ? existing.size : await countRows(pg_, pair.name);
    reports.push({
      table: pair.name,
      source: rows.length,
      skipped: rows.length - pending.length,
      inserted,
      target,
    });
    log(
      `  ${pair.name.padEnd(20)} origen=${String(rows.length).padStart(6)}  ` +
        `insertadas=${String(inserted).padStart(6)}  ya estaban=${String(rows.length - pending.length).padStart(6)}  destino=${String(target).padStart(6)}`,
    );
  }

  return reports;
}

export async function migrateSqliteToPostgres(
  opts: MigrateToPgOptions = {},
): Promise<MigrationReport> {
  const started = Date.now();
  const log = opts.log ?? ((line: string) => console.log(line));

  const sqlitePath = resolveDbPath(opts.sqlitePath);
  log(`Origen  : ${sqlitePath}`);
  log(`Destino : ${redactUrl(opts.pgUrl ?? process.env.AGENTOS_PG_URL ?? "")}`);
  if (opts.dryRun) log("Modo    : DRY RUN (no se escribe nada)");

  const source = openDb(sqlitePath);
  const target = openPgDb(opts.pgUrl);
  try {
    if (opts.applySchema !== false && !opts.dryRun) {
      const caps = await runPgMigrations(target);
      log(
          `Esquema : 25 tablas aplicadas · tsvector(${caps.textSearchConfig}) · ` +
          (caps.vector ? `pgvector(${caps.embeddingDimensions})` : "sin pgvector"),
      );
    }

    log("Copiando (orden topológico):");
    const tables = await copyAllTables(source, target, {
      dryRun: opts.dryRun,
      batchSize: opts.batchSize,
      log,
    });

    const report: MigrationReport = {
      driver: "postgres",
      dryRun: opts.dryRun === true,
      tables,
      totalSource: tables.reduce((a, t) => a + t.source, 0),
      totalInserted: tables.reduce((a, t) => a + t.inserted, 0),
      totalTarget: tables.reduce((a, t) => a + t.target, 0),
      complete: tables.every((t) => t.target >= t.source),
      durationMs: Date.now() - started,
    };

    if (opts.embedAfter && !opts.dryRun) {
      const embedder = resolveEmbeddingProvider();
      const res = await backfillKnowledgeEmbeddings(target, embedder);
      report.embeddings = res;
      log(
        embedder
          ? `Embeddings: ${res.embedded} documentos vectorizados con ${embedder.id}`
          : `Embeddings: omitidos — ${res.reason}`,
      );
    }

    return report;
  } finally {
    closeDb(source);
    await closePgDb(target);
  }
}

// ── Internos ────────────────────────────────────────────────────────────────

/**
 * Lee la tabla completa CON el decodificador de Drizzle (0/1→boolean,
 * TEXT→objeto JSON) y ordenada por su columna temporal, que es lo que
 * garantiza padre-antes-que-hijo en las auto-FKs.
 */
function readAll(db: AgentosDb, pair: TablePair): Record<string, unknown>[] {
  return db
    .select()
    .from(pair.from)
    .orderBy(sql.raw(`${quoteIdent(pair.orderBy)} ASC`))
    .all() as Record<string, unknown>[];
}

async function existingKeys(db: AgentosPgDb, pair: TablePair): Promise<Set<string>> {
  const columns = Array.isArray(pair.pk) ? pair.pk : [pair.pk];
  const projection = columns.map(quoteIdent).join(", ");
  const rows = await db.execute<Record<string, unknown>>(
    sql`SELECT ${sql.raw(projection)} FROM ${sql.raw(quoteIdent(pair.name))}`,
  );
  return new Set(rows.map((r) => rowKey(r, pair.pk)));
}

function rowKey(row: Record<string, unknown>, pk: string | readonly string[]): string {
  const columns = Array.isArray(pk) ? pk : [pk];
  // JSON encoding keeps null, separators and numeric/text values unambiguous.
  return JSON.stringify(columns.map((column) => row[column] ?? row[snakeToCamel(column)] ?? null));
}

function snakeToCamel(name: string): string {
  return name.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

async function countRows(db: AgentosPgDb, table: string): Promise<number> {
  const rows = await db.execute<{ n: string | number }>(
    sql`SELECT count(*) AS n FROM ${sql.raw(quoteIdent(table))}`,
  );
  return Number(rows[0]?.n ?? 0);
}

/** Los nombres vienen de `TABLE_PAIRS` (constantes del código), nunca del usuario. */
function quoteIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`Identificador inesperado: ${name}`);
  return `"${name}"`;
}

/** Nunca imprimir la contraseña de la URL de conexión. */
export function redactUrl(url: string): string {
  if (!url) return "(AGENTOS_PG_URL sin configurar)";
  return url.replace(/\/\/([^:@/]+):([^@/]*)@/, "//$1:***@");
}

// ── Ejecutable ──────────────────────────────────────────────────────────────

const isMain =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const report = await migrateSqliteToPostgres({
    sqlitePath: flag("from"),
    pgUrl: flag("to"),
    dryRun: argv.includes("--dry-run"),
    applySchema: !argv.includes("--no-schema"),
    embedAfter: argv.includes("--embed"),
  });
  console.log("");
  console.log(
    `Total: ${report.totalInserted} filas insertadas de ${report.totalSource} en origen ` +
      `(${report.durationMs} ms). Integridad: ${report.complete ? "OK ✓" : "INCOMPLETA ✗"}`,
  );
  if (!report.complete) process.exitCode = 1;
}
