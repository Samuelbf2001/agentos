/**
 * CLI del importador. NO habla con Notion: solo lee un snapshot de disco y
 * escribe en la base que se le indique explícitamente con `--db`.
 *
 *   tsx src/import-cli.ts --snapshot <dir> --db <ruta> [--pilot 10,3] [--dry-run]
 *
 * `--db` es obligatorio y sin default a propósito: la base viva de AgentOS no
 * se toca por accidente. Para el piloto se importa sobre una COPIA.
 *
 * Con `AGENTOS_DB_DRIVER=postgres` (o `--pg <url>`) el destino es Postgres y
 * `--db` deja de tener sentido: la fachada dual de `@agentos/db` hace que el
 * importador sea el mismo código para los dos motores.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { applyMigrations, closeAnyDb, openConfiguredDb, resolveDriver } from "@agentos/db";
import { importNotionSnapshot, type PilotLimits } from "./importer.js";
import { SnapshotReader, SnapshotReadError } from "./snapshot-reader.js";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function has(name: string): boolean {
  return process.argv.includes(name);
}

function help(): void {
  console.log(
    "Uso: tsx src/import-cli.ts --snapshot <dir> --db <ruta> [--pilot tareas,proyectos] [--dry-run] [--org <nombre>] [--identity-map <archivo.json>] [--confirmo-produccion]",
  );
  console.log("Lee el snapshot en disco y escribe SOLO en la base indicada. No contacta a Notion.");
  console.log("--identity-map: JSON {\"notion_person_id_o_correo\": \"people.id\"} con decisiones del administrador.");
  console.log("--confirmo-produccion: obligatorio si --db apunta a data/agentos.db (la base viva).");
  console.log("--pg <url>: importa contra Postgres (equivale a AGENTOS_DB_DRIVER=postgres + AGENTOS_PG_URL).");
}

/** `--pilot 10,3` = 10 tareas y 3 proyectos. */
function parsePilot(raw: string | undefined): PilotLimits | undefined {
  if (!raw) return undefined;
  const parts = raw.split(",").map((value) => Number.parseInt(value.trim(), 10));
  const tasks = parts[0];
  const projects = parts[1];
  if (
    tasks === undefined ||
    projects === undefined ||
    !Number.isInteger(tasks) ||
    !Number.isInteger(projects) ||
    tasks < 0 ||
    projects < 0
  ) {
    throw new Error("--pilot espera 'tareas,proyectos' con enteros no negativos (ej. 10,3)");
  }
  return { tasks, projects };
}

async function loadIdentityMap(file: string | undefined): Promise<Map<string, string> | undefined> {
  if (!file) return undefined;
  const parsed = JSON.parse(await readFile(path.resolve(file), "utf8")) as Record<string, unknown>;
  const map = new Map<string, string>();
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "string" && value) map.set(key.toLowerCase(), value);
  }
  return map;
}

if (has("--help") || has("-h")) {
  help();
  process.exit(0);
}

const snapshotDir = option("--snapshot");
const pgUrl = option("--pg");
// Postgres solo si se pide explícitamente: con `--pg` o con el driver del entorno.
const usePostgres = pgUrl !== undefined || resolveDriver() === "postgres";
const dbPath = option("--db");
if (!snapshotDir || (!dbPath && !usePostgres)) {
  console.error("Faltan --snapshot y/o --db. Ambos son obligatorios (salvo con --pg / driver postgres).");
  help();
  process.exit(2);
}

let resolvedDbPath = "";
if (!usePostgres) {
  // Salvaguarda: `data/agentos.db` es la base viva de AgentOS. Escribir ahí es
  // un acto deliberado del operador, no el resultado de un `--db` mal copiado.
  resolvedDbPath = path.resolve(dbPath!);
  if (/[/\\]data[/\\]agentos\.db$/iu.test(resolvedDbPath) && !has("--confirmo-produccion")) {
    console.error(
      "Se ha apuntado a la base VIVA de AgentOS. Para la copia de piloto usa otra ruta;\n" +
        "si de verdad es la importación a producción aprobada, para apps/api, haz backup\n" +
        "y vuelve a lanzar con --confirmo-produccion.",
    );
    process.exit(2);
  }

  // El fichero debe existir YA: `openDb` lo crearía en blanco si no, y una base
  // nueva por un `--db` mal tecleado pasaría desapercibida (salvo en dry-run,
  // que no escribe nada y por tanto puede correr contra una ruta que aún no
  // existe, solo para ver el informe).
  if (!has("--dry-run") && !existsSync(resolvedDbPath)) {
    console.error(
      `No existe el fichero de base de datos: ${resolvedDbPath}\n` +
        "Este comando nunca crea una base nueva por un typo en --db; si es a propósito, créala primero.",
    );
    process.exit(2);
  }
}

// Un solo punto de apertura para los dos motores (fachada dual de @agentos/db).
const db = await openConfiguredDb(
  usePostgres
    ? { driver: "postgres", ...(pgUrl ? { pgUrl } : {}) }
    : { driver: "sqlite", dbPath: resolvedDbPath },
);
try {
  // Las tablas de linaje pueden no existir todavía en una copia recién hecha.
  await applyMigrations(db);
  const pilot = parsePilot(option("--pilot"));
  const adminDecisions = await loadIdentityMap(option("--identity-map"));
  const report = await importNotionSnapshot({
    db,
    reader: new SnapshotReader(path.resolve(snapshotDir)),
    dryRun: has("--dry-run"),
    ...(pilot ? { pilot } : {}),
    ...(option("--org") ? { organizationName: option("--org")! } : {}),
    ...(adminDecisions ? { adminDecisions } : {}),
  });
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  const message =
    error instanceof SnapshotReadError
      ? error.message
      : `Importación abortada: ${error instanceof Error ? `${error.name}: ${error.message}` : "error desconocido"}`;
  console.error(message);
  process.exitCode = 1;
} finally {
  await closeAnyDb(db);
}
