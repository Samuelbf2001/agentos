import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { NotionReadError, type JsonObject, type NotionReader, type PaginatedJson } from "./notion-client.js";

export interface SnapshotSource {
  databaseId: string;
  key: "projects" | "tasks";
}

export interface SnapshotOptions {
  outputDirectory: string;
  reader: NotionReader;
  runId?: string;
  sources: SnapshotSource[];
}

interface CaptureException {
  category: "comments" | "page" | "property" | "query" | "schema";
  pageId?: string;
  property?: string;
  source: string;
  status?: number;
}

interface SourceSummary {
  database_id: string;
  exceptions: CaptureException[];
  key: string;
  pages_captured: number;
  page_ids: string[];
}

export interface SnapshotManifest {
  captured_at: string;
  manifest_hash: string;
  run_id: string;
  sources: SourceSummary[];
  status: "completed" | "completed_with_exceptions";
  version: 1;
}

function asRecord(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function pageId(value: JsonObject): string {
  const id = stringValue(value.id);
  if (!id) throw new Error("Página de Notion sin id");
  return id;
}

function safePageId(value: string): string {
  if (!/^[A-Za-z0-9-]{8,128}$/u.test(value)) throw new Error("Identificador de Notion no seguro");
  return value;
}

function safePropertyId(value: string): string {
  return encodeURIComponent(value);
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, filePath);
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function shouldCapturePropertyItem(property: JsonObject): boolean {
  if (property.has_more === true) return true;
  const type = stringValue(property.type);
  if (!type) return false;
  const list = asArray(property[type]);
  return ["people", "relation", "rich_text", "title"].includes(type) && list.length >= 25;
}

function schemaPropertyIds(schema: JsonObject): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [name, definition] of Object.entries(asRecord(schema.properties))) {
    const id = stringValue(asRecord(definition).id);
    if (id) output[name] = id;
  }
  return output;
}

async function captureBlocks(reader: NotionReader, rootId: string, visited = new Set<string>()): Promise<JsonObject> {
  if (visited.has(rootId)) return { block_id: rootId, cycle_or_reuse: true };
  visited.add(rootId);
  const listing = await reader.getBlockChildren(rootId);
  const children: JsonObject[] = [];
  for (const block of listing.items) {
    const id = stringValue(block.id);
    if (id && block.has_children === true) children.push(await captureBlocks(reader, id, visited));
  }
  return { block_id: rootId, responses: listing.pages, children };
}

function exceptionFrom(
  category: CaptureException["category"],
  source: string,
  error: unknown,
  details: Pick<CaptureException, "pageId" | "property"> = {},
): CaptureException {
  return {
    category,
    source,
    ...details,
    ...(error instanceof NotionReadError ? { status: error.status } : {}),
  };
}

async function capturePage(
  reader: NotionReader,
  sourceRoot: string,
  schemaIds: Record<string, string>,
  queryPage: JsonObject,
  source: string,
  exceptions: CaptureException[],
): Promise<string | undefined> {
  const id = pageId(queryPage);
  const safeId = safePageId(id);
  try {
    const fullPage = await reader.getPage(id);
    await writeJson(path.join(sourceRoot, "pages", `${safeId}.query.json`), queryPage);
    await writeJson(path.join(sourceRoot, "pages", `${safeId}.page.json`), fullPage);

    for (const [name, property] of Object.entries(asRecord(fullPage.properties))) {
      if (!shouldCapturePropertyItem(asRecord(property))) continue;
      const propertyId = schemaIds[name];
      if (!propertyId) {
        exceptions.push({ category: "property", source, pageId: id, property: name });
        continue;
      }
      try {
        const complete = await reader.getPageProperty(id, propertyId);
        await writeJson(path.join(sourceRoot, "properties", safeId, `${safePropertyId(propertyId)}.json`), complete.pages);
      } catch (error) {
        exceptions.push(exceptionFrom("property", source, error, { pageId: id, property: name }));
      }
    }

    try {
      await writeJson(path.join(sourceRoot, "blocks", `${safeId}.json`), await captureBlocks(reader, id));
    } catch (error) {
      exceptions.push(exceptionFrom("page", source, error, { pageId: id }));
    }

    try {
      const comments = await reader.getComments(id);
      await writeJson(path.join(sourceRoot, "comments", `${safeId}.json`), comments.pages);
    } catch (error) {
      // Comments need a separate Notion capability. The page snapshot remains usable.
      exceptions.push(exceptionFrom("comments", source, error, { pageId: id }));
    }
    return id;
  } catch (error) {
    exceptions.push(exceptionFrom("page", source, error, { pageId: id }));
    return undefined;
  }
}

export async function createNotionSnapshot(options: SnapshotOptions): Promise<{ manifest: SnapshotManifest; runDirectory: string }> {
  const runId = options.runId ?? `notion-${new Date().toISOString().replace(/[:.]/gu, "-")}`;
  const runDirectory = path.resolve(options.outputDirectory, runId);
  await mkdir(runDirectory, { recursive: false });
  const sources: SourceSummary[] = [];

  for (const source of options.sources) {
    const sourceRoot = path.join(runDirectory, source.key);
    const exceptions: CaptureException[] = [];
    let schema: JsonObject;
    try {
      schema = await options.reader.getDatabase(source.databaseId);
      await writeJson(path.join(sourceRoot, "schema.json"), schema);
    } catch (error) {
      exceptions.push(exceptionFrom("schema", source.key, error));
      sources.push({ database_id: source.databaseId, exceptions, key: source.key, pages_captured: 0, page_ids: [] });
      continue;
    }

    const capturedIds: string[] = [];
    const ids = schemaPropertyIds(schema);
    try {
      for await (const queryPage of options.reader.queryDatabase(source.databaseId)) {
        const captured = await capturePage(options.reader, sourceRoot, ids, queryPage, source.key, exceptions);
        if (captured) capturedIds.push(captured);
      }
    } catch (error) {
      // Si la paginación de la consulta se corta, se conserva lo ya capturado y
      // la corrida queda marcada como incompleta en vez de perderse entera.
      exceptions.push(exceptionFrom("query", source.key, error));
    }
    const summary: SourceSummary = {
      database_id: source.databaseId,
      exceptions,
      key: source.key,
      pages_captured: capturedIds.length,
      page_ids: capturedIds,
    };
    await writeJson(path.join(sourceRoot, "manifest.json"), summary);
    sources.push(summary);
  }

  const withoutHash = {
    captured_at: new Date().toISOString(),
    run_id: runId,
    sources,
    status: sources.some((source) => source.exceptions.length > 0) ? "completed_with_exceptions" as const : "completed" as const,
    version: 1 as const,
  };
  const manifest: SnapshotManifest = { ...withoutHash, manifest_hash: hash(withoutHash) };
  await writeJson(path.join(runDirectory, "manifest.json"), manifest);
  return { manifest, runDirectory };
}
