/**
 * Conector WhatsAppHub: métodos genéricos para los módulos de 2brain
 * (`hubGetJson`/`hubSendJson`/`hubGetText`/`hubGetRaw`). Fetch SIEMPRE
 * inyectado — ninguna llamada real sale de este test.
 */
import { describe, expect, it } from "vitest";
import { SourceConnectorError } from "@agentos/shared";
import { createWhatsAppHubConnector } from "../src/connectors/whatsapphub.js";

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

interface FakeResponse {
  status: number;
  body?: unknown;
  raw?: Uint8Array | string;
  contentType?: string;
}

function fakeFetch(handler: (req: CapturedRequest) => FakeResponse): {
  fetchFn: typeof fetch;
  calls: CapturedRequest[];
} {
  const calls: CapturedRequest[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers as Record<string, string>) ?? {})) {
      headers[key.toLowerCase()] = value;
    }
    const captured: CapturedRequest = {
      url: String(input),
      method: (init?.method ?? "GET").toUpperCase(),
      headers,
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    calls.push(captured);
    const result = handler(captured);
    if (result.raw !== undefined) {
      const bytes = typeof result.raw === "string" ? new TextEncoder().encode(result.raw) : result.raw;
      return new Response(bytes, {
        status: result.status,
        headers: result.contentType ? { "content-type": result.contentType } : {},
      });
    }
    return new Response(JSON.stringify(result.body ?? {}), {
      status: result.status,
      headers: { "content-type": result.contentType ?? "application/json" },
    });
  }) as typeof fetch;
  return { fetchFn, calls };
}

describe("conector WhatsAppHub — métodos genéricos de 2brain", () => {
  it("lee JSON pequeño con presupuesto y rechaza stream grande sin Content-Length", async () => {
    let cancelled = false;
    const fetchFn = (async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new TextEncoder().encode("x".repeat(64))); },
      cancel() { cancelled = true; },
    }))) as typeof fetch;
    const connector = createWhatsAppHubConnector({ baseUrl: "https://hub.test", apiKey: "test-only", fetchFn });
    await expect(connector.hubGetJson!("/api/wiki/graph", {}, { maxResponseBytes: 100 })).rejects.toThrow("excede el tamaño permitido");
    expect(cancelled).toBe(true);
    const small = fakeFetch(() => ({ status: 200, body: { nodes: [], edges: [] } }));
    const healthy = createWhatsAppHubConnector({ baseUrl: "https://hub.test", apiKey: "test-only", fetchFn: small.fetchFn });
    await expect(healthy.hubGetJson!("/api/wiki/graph", {}, { maxResponseBytes: 100 })).resolves.toEqual({ nodes: [], edges: [] });
  });

  it("mantiene el timeout activo mientras llegan los bytes del grafo", async () => {
    const fetchFn = (async (_input, init) => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        init?.signal?.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")), { once: true });
      },
    }))) as typeof fetch;
    const connector = createWhatsAppHubConnector({ baseUrl: "https://hub.test", apiKey: "test-only", fetchFn });
    await expect(connector.hubGetJson!("/api/wiki/graph", {}, { maxResponseBytes: 100, timeoutMs: 20 })).rejects.toMatchObject({ code: "timeout" });
  });

  it("un AbortSignal externo cancela la llamada aunque no haya vencido el timeout interno", async () => {
    const externalController = new AbortController();
    let sawAbort = false;
    const fetchFn = (async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          sawAbort = true;
          reject(new DOMException("Aborted", "AbortError"));
        });
      })) as typeof fetch;
    const connector = createWhatsAppHubConnector({ baseUrl: "https://hub.test", apiKey: "test-only", fetchFn });

    const promise = connector.hubGetJson!("/api/wiki/graph", {}, { signal: externalController.signal, timeoutMs: 5_000 });
    externalController.abort();

    await expect(promise).rejects.toBeInstanceOf(SourceConnectorError);
    await expect(promise).rejects.toMatchObject({ code: "timeout" });
    expect(sawAbort).toBe(true);
  });

  it("hubGetJson serializa la query (omite undefined) y manda x-wiki-key", async () => {
    const { fetchFn, calls } = fakeFetch(() => ({ status: 200, body: { ok: true } }));
    const connector = createWhatsAppHubConnector({ baseUrl: "https://hub.test", apiKey: "secret-key", fetchFn });

    const result = await connector.hubGetJson!("/api/brain/notas", {
      q: "hola",
      page: 2,
      activo: true,
      vacio: undefined,
    });

    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]!.url);
    expect(url.origin + url.pathname).toBe("https://hub.test/api/brain/notas");
    expect(url.searchParams.get("q")).toBe("hola");
    expect(url.searchParams.get("page")).toBe("2");
    expect(url.searchParams.get("activo")).toBe("true");
    expect(url.searchParams.has("vacio")).toBe(false);
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.headers["x-wiki-key"]).toBe("secret-key");
  });

  it("hubSendJson manda PUT con el body serializado y content-type json", async () => {
    const { fetchFn, calls } = fakeFetch(() => ({ status: 200, body: { saved: true } }));
    const connector = createWhatsAppHubConnector({ baseUrl: "https://hub.test", apiKey: "secret-key", fetchFn });

    const result = await connector.hubSendJson!("PUT", "/api/brain/notas/n1", { title: "Nota" });

    expect(result).toEqual({ saved: true });
    expect(calls[0]!.method).toBe("PUT");
    expect(calls[0]!.headers["content-type"]).toBe("application/json");
    expect(calls[0]!.headers["x-wiki-key"]).toBe("secret-key");
    expect(JSON.parse(calls[0]!.body ?? "{}")).toEqual({ title: "Nota" });
  });

  it("hubGetText devuelve el cuerpo de texto tal cual", async () => {
    const { fetchFn } = fakeFetch(() => ({
      status: 200,
      raw: "# Transcripción\nHola",
      contentType: "text/markdown",
    }));
    const connector = createWhatsAppHubConnector({ baseUrl: "https://hub.test", apiKey: "secret-key", fetchFn });

    const text = await connector.hubGetText!("/api/brain/notas/n1/markdown");
    expect(text).toBe("# Transcripción\nHola");
  });

  it("hubGetRaw devuelve status, content-type y los bytes del cuerpo", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const { fetchFn } = fakeFetch(() => ({ status: 200, raw: bytes, contentType: "image/png" }));
    const connector = createWhatsAppHubConnector({ baseUrl: "https://hub.test", apiKey: "secret-key", fetchFn });

    const raw = await connector.hubGetRaw!("/api/brain/videos/v1/keyframe");
    expect(raw.status).toBe(200);
    expect(raw.contentType).toBe("image/png");
    expect(Array.from(raw.body)).toEqual([1, 2, 3, 4]);
  });

  it("hubGetRaw lanza http_error igual que el resto del conector si el status no es 2xx", async () => {
    const { fetchFn } = fakeFetch(() => ({ status: 500, raw: "boom" }));
    const connector = createWhatsAppHubConnector({ baseUrl: "https://hub.test", apiKey: "secret-key", fetchFn });

    await expect(connector.hubGetRaw!("/api/brain/videos/v1/keyframe")).rejects.toMatchObject({
      name: "SourceConnectorError",
      code: "http_error",
      status: 500,
    });
  });

  it("sin URL/key los cuatro métodos genéricos fallan con not_configured", async () => {
    const { fetchFn } = fakeFetch(() => ({ status: 200, body: {} }));
    const connector = createWhatsAppHubConnector({ baseUrl: "", apiKey: "", fetchFn });

    await expect(connector.hubGetJson!("/api/brain/notas")).rejects.toBeInstanceOf(SourceConnectorError);
    await expect(connector.hubGetJson!("/api/brain/notas")).rejects.toMatchObject({ code: "not_configured" });
    await expect(connector.hubSendJson!("POST", "/api/brain/notas", {})).rejects.toMatchObject({
      code: "not_configured",
    });
    await expect(connector.hubGetText!("/api/brain/notas/n1/markdown")).rejects.toMatchObject({
      code: "not_configured",
    });
    await expect(connector.hubGetRaw!("/api/brain/videos/v1/keyframe")).rejects.toMatchObject({
      code: "not_configured",
    });
  });
});
