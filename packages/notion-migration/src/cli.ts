import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseEnvText, resolveSnapshotSettings, SnapshotConfigError } from "./config.js";
import { NotionApiReader, NotionReadError } from "./notion-client.js";
import { createNotionSnapshot } from "./snapshot.js";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function has(name: string): boolean {
  return process.argv.includes(name);
}

function help(): void {
  console.log("Uso: pnpm notion:snapshot -- --env-file <ruta-secreta> [--output-dir <ruta>] [--use-operational-token]");
  console.log("Lee exclusivamente Tasks y Projects; no crea ni modifica páginas de Notion.");
}

if (has("--help") || has("-h")) {
  help();
  process.exit(0);
}

const envFile = option("--env-file");
if (!envFile) {
  console.error("Falta --env-file. El secreto no se recibe por argumentos ni se guarda en el repositorio.");
  process.exit(2);
}

try {
  const loaded = parseEnvText(await readFile(path.resolve(envFile), "utf8"));
  const settings = resolveSnapshotSettings(loaded, {
    allowOperationalToken: has("--use-operational-token"),
    outputDirectory: option("--output-dir"),
  });
  const reader = new NotionApiReader({ apiVersion: settings.apiVersion, token: settings.token });
  const result = await createNotionSnapshot({
    outputDirectory: settings.outputDirectory,
    reader,
    sources: [
      { key: "tasks", databaseId: settings.tasksDatabaseId },
      { key: "projects", databaseId: settings.projectsDatabaseId },
    ],
  });
  const counts = result.manifest.sources.map((source) => `${source.key}=${source.pages_captured}`).join(" ");
  const exceptions = result.manifest.sources.reduce((total, source) => total + source.exceptions.length, 0);
  console.log(`Snapshot ${result.manifest.status}: ${counts} excepciones=${exceptions}`);
  console.log(`Archivo local: ${result.runDirectory}`);
} catch (error) {
  // El motivo se informa sin exponer el secreto ni el contenido capturado.
  const message = error instanceof SnapshotConfigError
    ? error.message
    : error instanceof NotionReadError
      ? `Notion respondió ${error.status}; el snapshot quedó incompleto`
      : `No fue posible completar el snapshot de Notion: ${error instanceof Error ? error.name : "error desconocido"}`;
  console.error(message);
  process.exit(1);
}
