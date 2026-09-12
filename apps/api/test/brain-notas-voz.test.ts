/**
 * 2brain › Notas de voz (proxy REST): listado/detalle/auditoría/media y el
 * ingreso desde la Grabadora. Conector SIEMPRE mock — ninguna llamada real
 * sale de los tests.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SourceConnectorError, type WhatsAppHubConnector } from "@agentos/shared";
import { makeFixture, type TestFixture } from "./helpers.js";

interface MockState {
  calls: { path: string; query?: Record<string, unknown>; body?: unknown }[];
  failNext: boolean;
}

function notImplemented(): never {
  throw new Error("not implemented");
}

function makeMockHub(state: MockState): WhatsAppHubConnector {
  return {
    isConfigured: () => true,
    listMeetings: notImplemented,
    getMeeting: notImplemented,
    getMeetingMarkdown: notImplemented,
    listContacts: notImplemented,
    getDossierMarkdown: notImplemented,

    async hubGetJson(path, query) {
      state.calls.push({ path, query });
      if (state.failNext) {
        state.failNext = false;
        throw new SourceConnectorError("unreachable", "No se pudo conectar con WhatsAppHub (mock caído).");
      }
      if (path === "/api/notes") {
        return {
          notes: [
            {
              id: 1,
              location_id: "default",
              source: "pwa",
              title: "Llamar al proveedor",
              summary: "Confirmar entrega del lote 42.",
              action_items: [{ text: "Llamar al proveedor" }],
              ideas: [],
              category: "tarea",
              duration_sec: 34,
              created_at: "2026-09-10T10:00:00.000Z",
              routed: {
                wikiNoteId: 7,
                notionTasks: [{ text: "Llamar al proveedor", ok: true, url: "https://notion.so/x", error: null }],
              },
              // Clave desconocida: NO debe llegar al cliente (whitelist).
              secreto_interno: "no-debe-salir",
            },
          ],
        };
      }
      if (path === "/api/notes/status") {
        return { transcription: true, vision: false, router_llm: true, notion: true, extra_field: "fuera" };
      }
      if (path === "/api/notes/audit") {
        return {
          page: 1,
          limit: query?.limit ?? 50,
          total: 1,
          totalPages: 1,
          notes: [
            {
              id: 1,
              title: "Llamar al proveedor",
              category: "tarea",
              createdAt: "2026-09-10T10:00:00.000Z",
              durationSec: 34,
              hasTranscript: true,
              summary: "Confirmar entrega del lote 42.",
              imagesCount: 0,
              wikiNoteId: 7,
              notionTasks: [{ text: "Llamar al proveedor", ok: true, url: "https://notion.so/x", error: null }],
              actionItemsCount: 1,
              createdBy: "voz",
              source: "pwa",
            },
          ],
        };
      }
      if (path === "/api/notes/1") {
        return {
          note: {
            id: 1,
            title: "Llamar al proveedor",
            transcript: "Hay que llamar al proveedor por el lote 42.",
            summary: "Confirmar entrega del lote 42.",
            action_items: [{ text: "Llamar al proveedor", due: null }],
            ideas: ["Pedir descuento por volumen"],
            category: "tarea",
            duration_sec: 34,
            created_at: "2026-09-10T10:00:00.000Z",
            source: "pwa",
            images: [
              { url: "https://hub.example.com/media/foto-1.jpg", caption: "Etiqueta del lote", mimetype: "image/jpeg" },
              { url: null, caption: null, mimetype: null },
            ],
            routed: {
              wikiNoteId: 7,
              notionTasks: [{ text: "Llamar al proveedor", ok: true, url: "https://notion.so/x", error: null }],
            },
          },
        };
      }
      throw new Error(`ruta no esperada en el mock: ${path}`);
    },

    async hubSendJson(method, path, body) {
      state.calls.push({ path, body });
      if (state.failNext) {
        state.failNext = false;
        throw new SourceConnectorError("unreachable", "No se pudo conectar con WhatsAppHub (mock caído).");
      }
      if (method === "POST" && path === "/api/notes/1/retry-notion") {
        return { ok: true, notionTasks: [{ text: "Llamar al proveedor", ok: true, url: "https://notion.so/x", error: null }] };
      }
      if (method === "POST" && path === "/api/notes/voice") {
        return {
          ok: true,
          voiceNoteId: 9,
          title: "Nota nueva",
          summary: "Resumen generado",
          category: "nota",
          model: "heuristic",
          action_items: [{ text: "Revisar contrato" }],
          ideas: ["Idea suelta"],
          images: [{ url: "https://hub.example.com/media/foto-2.jpg", caption: null }],
          notionTasks: [{ text: "Revisar contrato", ok: true, url: "https://notion.so/y", error: null }],
          wikiNoteId: 8,
        };
      }
      throw new Error(`ruta no esperada en el mock: ${path}`);
    },

    async hubGetText() {
      return notImplemented();
    },

    async hubGetRaw(path) {
      state.calls.push({ path });
      if (state.failNext) {
        state.failNext = false;
        throw new SourceConnectorError("unreachable", "No se pudo conectar con WhatsAppHub (mock caído).");
      }
      if (path === "/media/foto-1.jpg") {
        return { status: 200, contentType: "image/jpeg", body: new Uint8Array([1, 2, 3]) };
      }
      throw new Error(`ruta no esperada en el mock: ${path}`);
    },
  };
}

describe("2brain › Notas de voz (REST)", () => {
  let fx: TestFixture;
  let state: MockState;

  beforeEach(async () => {
    state = { calls: [], failNext: false };
    fx = await makeFixture({ whatsappHub: makeMockHub(state) });
  });

  afterEach(async () => {
    await fx.close();
  });

  it("exige sesión (401 sin token)", async () => {
    const res = await fx.api.app.inject({ method: "GET", url: "/api/brain/notas-voz" });
    expect(res.statusCode).toBe(401);
  });

  it("lista notas → hub GET /api/notes, y descarta claves fuera de la whitelist", async () => {
    const res = await fx.api.app.inject({
      method: "GET",
      url: "/api/brain/notas-voz",
      headers: fx.authHeaders,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { notes: Record<string, unknown>[] };
    expect(body.notes).toHaveLength(1);
    expect(body.notes[0]).toMatchObject({ id: "1", title: "Llamar al proveedor", category: "tarea" });
    expect(body.notes[0]).not.toHaveProperty("secreto_interno");
    expect((body.notes[0]!.routed as { wikiNoteId: number }).wikiNoteId).toBe(7);
  });

  it("status → hub GET /api/notes/status, whitelist de 4 booleanos", async () => {
    const res = await fx.api.app.inject({
      method: "GET",
      url: "/api/brain/notas-voz/status",
      headers: fx.authHeaders,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ transcription: true, vision: false, router_llm: true, notion: true });
  });

  it("auditoría → hub GET /api/notes/audit?limit=, con el limit pedido", async () => {
    const res = await fx.api.app.inject({
      method: "GET",
      url: "/api/brain/notas-voz/audit?limit=10",
      headers: fx.authHeaders,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { notes: Record<string, unknown>[] };
    expect(body.notes[0]).toMatchObject({ id: "1", createdBy: "voz" });
    expect(state.calls[0]!.query).toEqual({ limit: 10 });
  });

  it("auditoría: limit fuera de 1..200 es 400", async () => {
    const res = await fx.api.app.inject({
      method: "GET",
      url: "/api/brain/notas-voz/audit?limit=500",
      headers: fx.authHeaders,
    });
    expect(res.statusCode).toBe(400);
  });

  it("detalle → hub GET /api/notes/:id, y reescribe la URL de imagen a la ruta propia", async () => {
    const res = await fx.api.app.inject({
      method: "GET",
      url: "/api/brain/notas-voz/1",
      headers: fx.authHeaders,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { note: { images: { url: string | null }[]; transcript: string } };
    expect(body.note.transcript).toContain("lote 42");
    expect(body.note.images[0]!.url).toBe("/api/brain/notas-voz/media/foto-1.jpg");
    expect(body.note.images[1]!.url).toBeNull();
  });

  it("media: passthrough del binario con su content-type", async () => {
    const res = await fx.api.app.inject({
      method: "GET",
      url: "/api/brain/notas-voz/media/foto-1.jpg",
      headers: fx.authHeaders,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/jpeg");
    expect(res.rawPayload).toEqual(Buffer.from([1, 2, 3]));
  });

  it("media: rechaza rutas con '..'", async () => {
    const res = await fx.api.app.inject({
      method: "GET",
      url: "/api/brain/notas-voz/media/..%2Fetc",
      headers: fx.authHeaders,
    });
    expect(res.statusCode).toBe(400);
  });

  it("reintentar Notion → hub POST /api/notes/:id/retry-notion + auditoría", async () => {
    const res = await fx.api.app.inject({
      method: "POST",
      url: "/api/brain/notas-voz/1/retry-notion",
      headers: fx.authHeaders,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
    expect(state.calls.some((c) => c.path === "/api/notes/1/retry-notion")).toBe(true);
  });

  it("ingesta de voz (Grabadora) → hub POST /api/notes/voice con source:agentos y timeout largo", async () => {
    const res = await fx.api.app.inject({
      method: "POST",
      url: "/api/brain/notas-voz/voice",
      headers: fx.authHeaders,
      payload: {
        transcript: "Nota dictada",
        durationSec: 12,
        images: [{ dataUrl: "data:image/jpeg;base64,Zm9v", caption: "Foto 1" }],
        source: "agentos",
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { voiceNoteId: number; images: { url: string | null }[] };
    expect(body.voiceNoteId).toBe(9);
    expect(body.images[0]!.url).toBe("/api/brain/notas-voz/media/foto-2.jpg");
    const sent = state.calls.find((c) => c.path === "/api/notes/voice")!;
    expect((sent.body as { source: string }).source).toBe("agentos");
    expect((sent.body as { images: { base64: string }[] }).images[0]!.base64).toBe("data:image/jpeg;base64,Zm9v");
  });

  it("400 si la nota de voz no trae transcript, audio ni fotos", async () => {
    const res = await fx.api.app.inject({
      method: "POST",
      url: "/api/brain/notas-voz/voice",
      headers: fx.authHeaders,
      payload: { source: "agentos" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("error del conector → 502 legible (no cuelga)", async () => {
    state.failNext = true;
    const res = await fx.api.app.inject({
      method: "GET",
      url: "/api/brain/notas-voz",
      headers: fx.authHeaders,
    });
    expect(res.statusCode).toBe(502);
    expect((res.json() as { error: { code: string } }).error.code).toBe("provider_error");
  });
});
