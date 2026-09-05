/**
 * Capturador ampliado: adjuntos con SHA-256 y segunda pasada de archivadas.
 * Lector FAKE — ninguna llamada real sale a Notion desde la suite.
 */
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  NotionReadError,
  type DownloadedFile,
  type JsonObject,
  type NotionReader,
  type PaginatedJson,
  type QueryDatabaseOptions,
} from "../src/notion-client.js";
import { createNotionSnapshot } from "../src/snapshot.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const LIVE_PAGE = "11111111-1111-1111-1111-111111111111";
const TRASHED_PAGE = "22222222-2222-2222-2222-222222222222";
const IMAGE_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);

interface FakeOptions {
  /** La consulta de archivadas responde 400, como puede hacer Notion. */
  archivedRejected?: boolean;
  /** El lector no sabe descargar (capacidad opcional del contrato). */
  withoutDownload?: boolean;
  /** La descarga falla con 403 (URL firmada caducada). */
  downloadFails?: boolean;
}

class FakeReader implements NotionReader {
  readonly downloadedUrls: string[] = [];

  constructor(private readonly options: FakeOptions = {}) {
    if (options.withoutDownload) {
      (this as { downloadFile?: unknown }).downloadFile = undefined;
    }
  }

  getDatabase(databaseId: string): Promise<JsonObject> {
    return Promise.resolve({ id: databaseId, properties: { Name: { id: "title", type: "title" } } });
  }

  async *queryDatabase(_databaseId: string, options: QueryDatabaseOptions = {}): AsyncIterable<JsonObject> {
    if (options.archived) {
      if (this.options.archivedRejected) throw new NotionReadError(400);
      yield { id: TRASHED_PAGE };
      return;
    }
    yield { id: LIVE_PAGE };
  }

  getPage(pageId: string): Promise<JsonObject> {
    return Promise.resolve({
      id: pageId,
      archived: pageId === TRASHED_PAGE,
      in_trash: pageId === TRASHED_PAGE,
      properties: {
        Adjuntos: {
          id: "att",
          type: "files",
          files: [
            { name: "contrato.pdf", type: "file", file: { url: "https://s3.example/contrato.pdf?firma=1" } },
            { name: "guia", type: "external", external: { url: "https://drive.example/guia" } },
          ],
        },
      },
    });
  }

  getPageProperty(): Promise<PaginatedJson> {
    return Promise.resolve({ items: [], pages: [] });
  }

  getBlockChildren(blockId: string): Promise<PaginatedJson> {
    if (blockId !== LIVE_PAGE) {
      return Promise.resolve({ items: [], pages: [{ object: "list", results: [] }] });
    }
    const block = {
      object: "block",
      id: "block-imagen",
      type: "image",
      has_children: false,
      image: { type: "file", file: { url: "https://s3.example/foto.png?firma=2" } },
    };
    return Promise.resolve({ items: [block], pages: [{ object: "list", results: [block] }] });
  }

  getComments(): Promise<PaginatedJson> {
    return Promise.resolve({ items: [], pages: [{ object: "list", results: [] }] });
  }

  downloadFile(url: string): Promise<DownloadedFile> {
    this.downloadedUrls.push(url);
    if (this.options.downloadFails) return Promise.reject(new NotionReadError(403));
    return Promise.resolve({ bytes: IMAGE_BYTES, contentType: "image/png" });
  }
}

async function snapshot(reader: NotionReader, options: { includeArchived?: boolean; downloadAttachments?: boolean } = {}) {
  const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "agentos-notion-adjuntos-"));
  temporaryDirectories.push(outputDirectory);
  return createNotionSnapshot({
    outputDirectory,
    reader,
    runId: "notion-test-adjuntos",
    sources: [{ key: "tasks", databaseId: "tasks-db" }],
    ...options,
  });
}

interface AttachmentManifest {
  page_id: string;
  attachments: {
    origin: string;
    status: string;
    sha256: string | null;
    bytes: number | null;
    stored_uri: string | null;
    reason: string | null;
    source_url: string;
  }[];
}

async function attachmentsOf(runDirectory: string, pageId: string): Promise<AttachmentManifest> {
  return JSON.parse(
    await readFile(path.join(runDirectory, "tasks", "files", `${pageId}.json`), "utf8"),
  ) as AttachmentManifest;
}

describe("adjuntos", () => {
  it("descarga los archivos alojados en Notion y los guarda por SHA-256", async () => {
    const reader = new FakeReader();
    const result = await snapshot(reader);

    const manifest = await attachmentsOf(result.runDirectory, LIVE_PAGE);
    const downloaded = manifest.attachments.filter((item) => item.status === "downloaded");
    expect(downloaded).toHaveLength(2); // uno de propiedad + uno de bloque

    const expected = createHash("sha256").update(IMAGE_BYTES).digest("hex");
    expect(downloaded.every((item) => item.sha256 === expected)).toBe(true);
    expect(downloaded.every((item) => item.bytes === IMAGE_BYTES.byteLength)).toBe(true);

    // El binario está realmente en disco y su contenido coincide.
    const stored = downloaded[0]!.stored_uri!;
    const bytes = await readFile(path.join(result.runDirectory, "tasks", stored));
    expect(new Uint8Array(bytes)).toEqual(IMAGE_BYTES);
    // El nombre del binario es su hash: el mismo contenido no se guarda dos
    // veces por adjunto, solo cambia la extensión deducida del nombre o del tipo.
    expect((await readdir(path.join(result.runDirectory, "tasks", "files", LIVE_PAGE))).sort()).toEqual(
      [`${expected}.pdf`, `${expected}.png`],
    );

    // Totales de la fuente: 2 de la página viva + 1 de la archivada.
    expect(result.manifest.sources[0]?.attachments_downloaded).toBe(3);
    expect(result.manifest.sources[0]?.attachments_external).toBe(2);
    expect(result.manifest.sources[0]?.attachments_failed).toBe(0);
  });

  it("los adjuntos externos se referencian, no se descargan", async () => {
    const reader = new FakeReader();
    const result = await snapshot(reader);
    const manifest = await attachmentsOf(result.runDirectory, LIVE_PAGE);
    const external = manifest.attachments.find((item) => item.status === "external_reference");
    expect(external).toBeDefined();
    expect(external?.stored_uri).toBeNull();
    expect(external?.reason).toBe("archivo_externo_no_alojado_en_notion");
    expect(reader.downloadedUrls.some((url) => url.includes("drive.example"))).toBe(false);
  });

  it("una descarga fallida queda registrada con su motivo, nunca se descarta", async () => {
    const result = await snapshot(new FakeReader({ downloadFails: true }));
    const manifest = await attachmentsOf(result.runDirectory, LIVE_PAGE);
    const failed = manifest.attachments.filter((item) => item.status === "failed");
    expect(failed).toHaveLength(2);
    expect(failed[0]?.reason).toBe("http_403");
    // La URL de origen se conserva como evidencia aunque caduque, pero SIN la
    // query: es una firma temporal de S3, no una credencial para archivar.
    expect(failed[0]?.source_url).toContain("https://s3.example/");
    expect(failed[0]?.source_url).not.toContain("?");
    expect(failed[0]?.source_url).not.toContain("firma=");
    // 2 de la página viva (propiedad + bloque) y 1 de la archivada (propiedad).
    expect(result.manifest.sources[0]?.attachments_failed).toBe(3);
  });

  it("un lector sin capacidad de descarga deja el motivo, no un vacío", async () => {
    const result = await snapshot(new FakeReader({ withoutDownload: true }));
    const manifest = await attachmentsOf(result.runDirectory, LIVE_PAGE);
    expect(manifest.attachments.some((item) => item.reason === "lector_sin_descarga")).toBe(true);
    expect(result.manifest.sources[0]?.attachments_downloaded).toBe(0);
  });

  it("--no-attachments conserva los metadatos sin bajar binarios", async () => {
    const reader = new FakeReader();
    const result = await snapshot(reader, { downloadAttachments: false });
    const manifest = await attachmentsOf(result.runDirectory, LIVE_PAGE);
    expect(reader.downloadedUrls).toHaveLength(0);
    expect(manifest.attachments.some((item) => item.reason === "descarga_desactivada")).toBe(true);
    expect(result.manifest.sources[0]?.attachments_downloaded).toBe(0);
  });
});

describe("páginas archivadas", () => {
  it("la segunda pasada captura la página en papelera y la cuenta aparte", async () => {
    const result = await snapshot(new FakeReader());
    const source = result.manifest.sources[0]!;
    expect(source.pages_captured).toBe(2);
    expect(source.page_ids).toContain(TRASHED_PAGE);
    expect(source.archived_captured).toBe(1);
  });

  it("si Notion rechaza la consulta de archivadas, queda una excepción explícita", async () => {
    const result = await snapshot(new FakeReader({ archivedRejected: true }));
    const source = result.manifest.sources[0]!;
    expect(source.pages_captured).toBe(1);
    expect(source.archived_captured).toBe(0);
    const archived = source.exceptions.filter((item) => item.category === "archived");
    expect(archived).toHaveLength(1);
    expect(archived[0]?.status).toBe(400);
    expect(result.manifest.status).toBe("completed_with_exceptions");
  });

  it("--no-archived no intenta la segunda pasada", async () => {
    const result = await snapshot(new FakeReader({ archivedRejected: true }), { includeArchived: false });
    expect(result.manifest.sources[0]?.pages_captured).toBe(1);
    expect(result.manifest.status).toBe("completed");
  });
});
