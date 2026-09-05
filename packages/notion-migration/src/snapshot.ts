import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  AttachmentTooLargeError,
  NotionReadError,
  type JsonObject,
  type NotionReader,
  type PaginatedJson,
} from "./notion-client.js";

export interface SnapshotSource {
  databaseId: string;
  key: "projects" | "tasks";
}

export interface SnapshotOptions {
  outputDirectory: string;
  reader: NotionReader;
  runId?: string;
  sources: SnapshotSource[];
  /**
   * Descargar los adjuntos alojados en Notion con su SHA-256. Las URLs firmadas
   * caducan, así que el binario dentro del snapshot es la única conservación
   * real. Los adjuntos `external` NUNCA se descargan: son de terceros; se
   * conserva la referencia.
   */
  downloadAttachments?: boolean;
  /**
   * Intentar además las páginas archivadas / en papelera. Si la API de Notion
   * rechaza la petición, queda como excepción explícita y la corrida sigue.
   */
  includeArchived?: boolean;
}

interface CaptureException {
  category: "archived" | "attachment" | "comments" | "page" | "property" | "query" | "schema";
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
  /** Páginas capturadas que Notion marca como archivadas o en papelera. */
  archived_captured: number;
  attachments_downloaded: number;
  attachments_external: number;
  attachments_failed: number;
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

async function writeBinary(filePath: string, bytes: Uint8Array): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporary, bytes);
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

// ── Adjuntos ────────────────────────────────────────────────────────────────

/** Tipos de bloque de Notion que llevan un archivo adjunto. */
const FILE_BLOCK_TYPES = ["image", "file", "pdf", "video", "audio"] as const;

interface AttachmentRef {
  origin: "property" | "block";
  /** Nombre de la propiedad o id del bloque que contiene el archivo. */
  location: string;
  name: string | null;
  urlKind: "file" | "external";
  url: string;
  expiryTime: string | null;
}

interface AttachmentRecord extends Omit<AttachmentRef, "url"> {
  status: "downloaded" | "external_reference" | "failed" | "not_supported";
  sha256: string | null;
  bytes: number | null;
  content_type: string | null;
  stored_uri: string | null;
  reason: string | null;
  /** La URL de Notion caduca; se conserva solo como evidencia de origen. */
  source_url: string;
}

function fileRefFrom(container: JsonObject, origin: AttachmentRef["origin"], location: string): AttachmentRef | undefined {
  const kind = stringValue(container.type);
  if (kind === "file") {
    const file = asRecord(container.file);
    const url = stringValue(file.url);
    if (!url) return undefined;
    return {
      origin,
      location,
      name: stringValue(container.name) ?? null,
      urlKind: "file",
      url,
      expiryTime: stringValue(file.expiry_time) ?? null,
    };
  }
  if (kind === "external") {
    const url = stringValue(asRecord(container.external).url);
    if (!url) return undefined;
    return {
      origin,
      location,
      name: stringValue(container.name) ?? null,
      urlKind: "external",
      url,
      expiryTime: null,
    };
  }
  return undefined;
}

/** Adjuntos de las propiedades `files` de la página. */
function attachmentsFromProperties(page: JsonObject): AttachmentRef[] {
  const refs: AttachmentRef[] = [];
  for (const [name, definition] of Object.entries(asRecord(page.properties))) {
    const property = asRecord(definition);
    if (stringValue(property.type) !== "files") continue;
    for (const entry of asArray(property.files)) {
      const ref = fileRefFrom(asRecord(entry), "property", name);
      if (ref) refs.push(ref);
    }
  }
  return refs;
}

/** Adjuntos del árbol de bloques ya capturado (no vuelve a llamar a Notion). */
function attachmentsFromBlocks(tree: unknown): AttachmentRef[] {
  const refs: AttachmentRef[] = [];
  const walk = (node: unknown): void => {
    const record = asRecord(node);
    for (const response of asArray(record.responses)) {
      for (const block of asArray(asRecord(response).results)) {
        const item = asRecord(block);
        const type = stringValue(item.type);
        if (!type || !(FILE_BLOCK_TYPES as readonly string[]).includes(type)) continue;
        const ref = fileRefFrom(asRecord(item[type]), "block", stringValue(item.id) ?? type);
        if (ref) refs.push(ref);
      }
    }
    for (const child of asArray(record.children)) walk(child);
  };
  walk(tree);
  return refs;
}

const EXTENSION_BY_CONTENT_TYPE: Readonly<Record<string, string>> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "application/pdf": ".pdf",
  "text/plain": ".txt",
  "video/mp4": ".mp4",
  "audio/mpeg": ".mp3",
};

/**
 * Las URLs de adjunto de Notion son S3 firmadas: `host+pathname` identifica el
 * objeto; la query trae la firma temporal, que caduca y no debe quedar
 * archivada como si fuera una credencial reutilizable. La descarga en sí usa
 * la URL completa (sin sanear) — solo lo que se ARCHIVA se recorta.
 */
function sanitizeSourceUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}

function extensionFor(name: string | null, contentType: string | null): string {
  const fromName = name ? path.extname(name) : "";
  if (/^\.[A-Za-z0-9]{1,8}$/u.test(fromName)) return fromName.toLowerCase();
  const base = contentType?.split(";")[0]?.trim().toLowerCase();
  return (base ? EXTENSION_BY_CONTENT_TYPE[base] : undefined) ?? ".bin";
}

/**
 * Descarga los adjuntos alojados en Notion y escribe el manifiesto por página.
 * Un fallo NUNCA descarta el adjunto: queda con `status:"failed"` y su motivo.
 */
async function captureAttachments(
  reader: NotionReader,
  sourceRoot: string,
  page: JsonObject,
  blocks: unknown,
  safeId: string,
  download: boolean,
): Promise<{ records: AttachmentRecord[]; downloaded: number; external: number; failed: number }> {
  const refs = [...attachmentsFromProperties(page), ...attachmentsFromBlocks(blocks)];
  const records: AttachmentRecord[] = [];
  let downloaded = 0;
  let external = 0;
  let failed = 0;

  for (const ref of refs) {
    const { url, ...rest } = ref;
    const base: AttachmentRecord = {
      ...rest,
      status: "not_supported",
      sha256: null,
      bytes: null,
      content_type: null,
      stored_uri: null,
      reason: null,
      source_url: sanitizeSourceUrl(url),
    };
    if (ref.urlKind === "external") {
      external += 1;
      records.push({ ...base, status: "external_reference", reason: "archivo_externo_no_alojado_en_notion" });
      continue;
    }
    if (!download || !reader.downloadFile) {
      records.push({ ...base, reason: download ? "lector_sin_descarga" : "descarga_desactivada" });
      continue;
    }
    try {
      const file = await reader.downloadFile(url);
      const digest = createHash("sha256").update(file.bytes).digest("hex");
      const relative = path.posix.join("files", safeId, `${digest}${extensionFor(ref.name, file.contentType)}`);
      await writeBinary(path.join(sourceRoot, relative), file.bytes);
      downloaded += 1;
      records.push({
        ...base,
        status: "downloaded",
        sha256: digest,
        bytes: file.bytes.byteLength,
        content_type: file.contentType,
        stored_uri: relative,
      });
    } catch (error) {
      failed += 1;
      records.push({
        ...base,
        status: "failed",
        reason:
          error instanceof AttachmentTooLargeError
            ? "adjunto_supera_tope_de_tamano"
            : error instanceof NotionReadError
              ? `http_${error.status}`
              : "descarga_fallida",
      });
    }
  }

  if (records.length > 0) {
    await writeJson(path.join(sourceRoot, "files", `${safeId}.json`), {
      page_id: stringValue(page.id) ?? safeId,
      attachments: records,
    });
  }
  return { records, downloaded, external, failed };
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

interface PageCaptureResult {
  id: string;
  archived: boolean;
  attachments: { downloaded: number; external: number; failed: number };
}

async function capturePage(
  reader: NotionReader,
  sourceRoot: string,
  schemaIds: Record<string, string>,
  queryPage: JsonObject,
  source: string,
  exceptions: CaptureException[],
  downloadAttachments: boolean,
): Promise<PageCaptureResult | undefined> {
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

    let blocks: unknown = null;
    try {
      blocks = await captureBlocks(reader, id);
      await writeJson(path.join(sourceRoot, "blocks", `${safeId}.json`), blocks);
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

    let attachments = { downloaded: 0, external: 0, failed: 0 };
    try {
      const captured = await captureAttachments(reader, sourceRoot, fullPage, blocks, safeId, downloadAttachments);
      attachments = {
        downloaded: captured.downloaded,
        external: captured.external,
        failed: captured.failed,
      };
    } catch (error) {
      exceptions.push(exceptionFrom("attachment", source, error, { pageId: id }));
    }

    return {
      id,
      archived: fullPage.archived === true || fullPage.in_trash === true,
      attachments,
    };
  } catch (error) {
    exceptions.push(exceptionFrom("page", source, error, { pageId: id }));
    return undefined;
  }
}

export async function createNotionSnapshot(options: SnapshotOptions): Promise<{ manifest: SnapshotManifest; runDirectory: string }> {
  const runId = options.runId ?? `notion-${new Date().toISOString().replace(/[:.]/gu, "-")}`;
  const runDirectory = path.resolve(options.outputDirectory, runId);
  await mkdir(runDirectory, { recursive: false });
  const downloadAttachments = options.downloadAttachments !== false;
  const includeArchived = options.includeArchived !== false;
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
      sources.push({
        database_id: source.databaseId,
        exceptions,
        key: source.key,
        pages_captured: 0,
        page_ids: [],
        archived_captured: 0,
        attachments_downloaded: 0,
        attachments_external: 0,
        attachments_failed: 0,
      });
      continue;
    }

    const capturedIds: string[] = [];
    const seen = new Set<string>();
    let archivedCaptured = 0;
    let downloaded = 0;
    let external = 0;
    let failed = 0;
    const ids = schemaPropertyIds(schema);

    const consume = (result: PageCaptureResult | undefined): void => {
      if (!result || seen.has(result.id)) return;
      seen.add(result.id);
      capturedIds.push(result.id);
      if (result.archived) archivedCaptured += 1;
      downloaded += result.attachments.downloaded;
      external += result.attachments.external;
      failed += result.attachments.failed;
    };

    try {
      for await (const queryPage of options.reader.queryDatabase(source.databaseId)) {
        consume(
          await capturePage(options.reader, sourceRoot, ids, queryPage, source.key, exceptions, downloadAttachments),
        );
      }
    } catch (error) {
      // Si la paginación de la consulta se corta, se conserva lo ya capturado y
      // la corrida queda marcada como incompleta en vez de perderse entera.
      exceptions.push(exceptionFrom("query", source.key, error));
    }

    if (includeArchived) {
      // Segunda pasada explícita. La API pública no promete listar la papelera:
      // si la rechaza, se registra el límite en vez de afirmar que no había nada.
      try {
        for await (const queryPage of options.reader.queryDatabase(source.databaseId, { archived: true })) {
          const id = stringValue(queryPage.id);
          if (id && seen.has(id)) continue;
          consume(
            await capturePage(options.reader, sourceRoot, ids, queryPage, source.key, exceptions, downloadAttachments),
          );
        }
      } catch (error) {
        exceptions.push(exceptionFrom("archived", source.key, error));
      }
    }

    const summary: SourceSummary = {
      database_id: source.databaseId,
      exceptions,
      key: source.key,
      pages_captured: capturedIds.length,
      page_ids: capturedIds,
      archived_captured: archivedCaptured,
      attachments_downloaded: downloaded,
      attachments_external: external,
      attachments_failed: failed,
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
