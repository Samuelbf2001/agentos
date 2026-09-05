/**
 * `NotionApiReader.downloadFile`: tope de tamaño de adjunto (por defecto
 * 50 MB, configurable). Superarlo nunca debe cargar el binario entero en
 * memoria — se corta apenas se sabe que excede el tope.
 */
import { describe, expect, it } from "vitest";
import { AttachmentTooLargeError, DEFAULT_MAX_ATTACHMENT_BYTES, NotionApiReader } from "../src/notion-client.js";

function readerWithFetch(fetchImpl: typeof fetch, maxAttachmentBytes?: number): NotionApiReader {
  return new NotionApiReader({
    apiVersion: "2022-06-28",
    token: "test-token",
    fetchFn: fetchImpl,
    minIntervalMs: 0,
    ...(maxAttachmentBytes !== undefined ? { maxAttachmentBytes } : {}),
  });
}

describe("downloadFile — tope de tamaño de adjunto", () => {
  it("por defecto usa DEFAULT_MAX_ATTACHMENT_BYTES (50 MB)", () => {
    expect(DEFAULT_MAX_ATTACHMENT_BYTES).toBe(50 * 1024 * 1024);
  });

  it("corta por el Content-Length declarado, sin leer el cuerpo", async () => {
    const body = new Uint8Array(100).fill(1);
    const fetchImpl = (async () =>
      new Response(body, {
        status: 200,
        headers: { "content-length": "100", "content-type": "application/octet-stream" },
      })) as unknown as typeof fetch;
    const reader = readerWithFetch(fetchImpl, 10);

    await expect(reader.downloadFile("https://s3.example/grande.bin")).rejects.toThrow(AttachmentTooLargeError);
  });

  it("corta en streaming cuando no hay Content-Length y el cuerpo supera el tope", async () => {
    const chunks = [new Uint8Array(6).fill(1), new Uint8Array(6).fill(2)]; // 12 bytes, tope 10
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
    const fetchImpl = (async () =>
      new Response(stream, { status: 200, headers: { "content-type": "application/octet-stream" } })) as unknown as typeof fetch;
    const reader = readerWithFetch(fetchImpl, 10);

    await expect(reader.downloadFile("https://s3.example/streaming.bin")).rejects.toThrow(AttachmentTooLargeError);
  });

  it("un adjunto dentro del tope se descarga entero y conserva su tipo", async () => {
    const body = new Uint8Array([1, 2, 3, 4]);
    const fetchImpl = (async () =>
      new Response(body, { status: 200, headers: { "content-type": "image/png" } })) as unknown as typeof fetch;
    const reader = readerWithFetch(fetchImpl, 1024);

    const file = await reader.downloadFile("https://s3.example/chico.png");
    expect(new Uint8Array(file.bytes)).toEqual(body);
    expect(file.contentType).toBe("image/png");
  });
});
