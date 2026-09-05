/**
 * Lectura de un snapshot en disco. Solo lee: nunca escribe en la carpeta del
 * snapshot ni vuelve a llamar a Notion. Es la única puerta entre el archivo
 * inmutable y el importador.
 */
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { JsonObject } from "./notion-client.js";

export type SnapshotSourceKey = "tasks" | "projects";

export interface SnapshotSourceSummary {
  database_id: string;
  key: string;
  pages_captured: number;
  page_ids: string[];
  exceptions: unknown[];
  /** Presentes solo en snapshots del capturador ampliado. */
  archived_captured?: number;
  attachments_downloaded?: number;
  attachments_failed?: number;
}

export interface SnapshotManifestFile {
  captured_at: string;
  manifest_hash: string;
  run_id: string;
  sources: SnapshotSourceSummary[];
  status: string;
  version: number;
}

export interface SnapshotPage {
  notionPageId: string;
  /** Objeto `page` completo tal como lo devolvió Notion. */
  page: JsonObject;
  /** Propiedades paginadas que excedían el límite de la respuesta de página. */
  properties: Record<string, unknown>;
  blocks: unknown;
  comments: unknown;
  /** Manifiesto de adjuntos del capturador ampliado (`files/<id>.json`). */
  files: unknown;
  uris: {
    page: string;
    blocks: string | null;
    comments: string | null;
    files: string | null;
  };
}

export class SnapshotReadError extends Error {
  override name = "SnapshotReadError";
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, "utf8")) as unknown;
}

async function readJsonOrNull(filePath: string): Promise<unknown> {
  return (await exists(filePath)) ? readJson(filePath) : null;
}

export function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export class SnapshotReader {
  constructor(readonly root: string) {}

  /** Manifiesto global; su ausencia significa "corrida incompleta, no importar". */
  async manifest(): Promise<SnapshotManifestFile> {
    const file = path.join(this.root, "manifest.json");
    if (!(await exists(file))) {
      throw new SnapshotReadError(
        `El snapshot ${path.basename(this.root)} no tiene manifest.json: la captura no terminó y no se importa`,
      );
    }
    return (await readJson(file)) as SnapshotManifestFile;
  }

  async schema(source: SnapshotSourceKey): Promise<JsonObject> {
    const file = path.join(this.root, source, "schema.json");
    if (!(await exists(file))) {
      throw new SnapshotReadError(`Falta ${source}/schema.json en el snapshot`);
    }
    return (await readJson(file)) as JsonObject;
  }

  /** Ids de página capturados, en el orden estable del sistema de archivos. */
  async pageIds(source: SnapshotSourceKey): Promise<string[]> {
    const dir = path.join(this.root, source, "pages");
    if (!(await exists(dir))) return [];
    const entries = await readdir(dir);
    return entries
      .filter((name) => name.endsWith(".page.json"))
      .map((name) => name.slice(0, -".page.json".length))
      .sort();
  }

  async page(source: SnapshotSourceKey, notionPageId: string): Promise<SnapshotPage> {
    const base = path.join(this.root, source);
    const pageFile = path.join(base, "pages", `${notionPageId}.page.json`);
    const page = (await readJson(pageFile)) as JsonObject;

    const propertiesDir = path.join(base, "properties", notionPageId);
    const properties: Record<string, unknown> = {};
    if (await exists(propertiesDir)) {
      for (const entry of await readdir(propertiesDir)) {
        if (!entry.endsWith(".json")) continue;
        properties[entry.slice(0, -".json".length)] = await readJson(
          path.join(propertiesDir, entry),
        );
      }
    }

    const blocksFile = path.join(base, "blocks", `${notionPageId}.json`);
    const commentsFile = path.join(base, "comments", `${notionPageId}.json`);
    const filesFile = path.join(base, "files", `${notionPageId}.json`);
    return {
      notionPageId,
      page,
      properties,
      blocks: await readJsonOrNull(blocksFile),
      comments: await readJsonOrNull(commentsFile),
      files: await readJsonOrNull(filesFile),
      uris: {
        page: path.posix.join(source, "pages", `${notionPageId}.page.json`),
        blocks: (await exists(blocksFile)) ? path.posix.join(source, "blocks", `${notionPageId}.json`) : null,
        comments: (await exists(commentsFile))
          ? path.posix.join(source, "comments", `${notionPageId}.json`)
          : null,
        files: (await exists(filesFile)) ? path.posix.join(source, "files", `${notionPageId}.json`) : null,
      },
    };
  }
}

/**
 * Huella del esquema de origen: hash de las dos `schema.json`. Si Notion cambia
 * una propiedad, dos corridas dejan de ser comparables y esto lo delata.
 */
export function sourceSchemaVersion(schemas: Record<string, JsonObject>): string {
  const stable = Object.keys(schemas)
    .sort()
    .map((key) => [key, schemas[key]]);
  return sha256(stable);
}
