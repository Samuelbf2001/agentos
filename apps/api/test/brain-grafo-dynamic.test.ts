/**
 * 2brain › Grafo dinámico (REST): proxy de solo lectura a los endpoints
 * columnares del hub (`/api/wiki/graph/{skeleton,layer,neighbors/:id,search}`).
 * Conector SIEMPRE mock — ninguna llamada real sale de los tests. Cubre:
 * whitelist Zod de la entrada, coherencia del envoltorio columnar (que se
 * reenvía TAL CUAL, sin reproyectar), topes de bytes por endpoint y el aborto
 * de extremo a extremo.
 */
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SourceConnectorError, type WhatsAppHubConnector } from "@agentos/shared";
import { abortSignalOnClientClose, assertColumnarGraph } from "../src/routes/brain/grafo.js";
import { makeFixture, type TestFixture } from "./helpers.js";

interface HubCall {
  path: string;
  query: Record<string, unknown> | undefined;
  opts?: { timeoutMs?: number; maxResponseBytes?: number; signal?: AbortSignal };
}

interface MockState {
  raw: unknown;
  fail: boolean;
  calls: HubCall[];
}

function makeMockConnector(state: MockState): WhatsAppHubConnector {
  const notImplemented = async () => {
    throw new Error("not implemented");
  };
  return {
    isConfigured: () => true,
    listMeetings: notImplemented as never,
    getMeeting: notImplemented as never,
    getMeetingMarkdown: notImplemented as never,
    listContacts: notImplemented as never,
    getDossierMarkdown: notImplemented as never,
    async hubGetJson(path, query, opts) {
      state.calls.push({ path, query: query as Record<string, unknown> | undefined, opts });
      if (state.fail) {
        throw new SourceConnectorError("unreachable", "No se pudo conectar con WhatsAppHub (grafo dinámico).");
      }
      return state.raw;
    },
    hubSendJson: notImplemented as never,
    hubGetText: notImplemented as never,
    hubGetRaw: notImplemented as never,
  };
}

const TYPES = ["contacto", "empresa", "equipo", "reunion", "nota", "nota_voz", "pagina", "tema"];
const EDGE_TYPES = [
  "pertenece-a", "asignado-a", "reunion-contacto", "reunion-empresa", "nota-contacto",
  "nota-empresa", "participo-en", "tagged", "relacionada-con", "creada-por",
];

/** Envoltorio columnar conforme a §A.2: 2 nodos, 1 stub, 2 aristas. */
function columnarPayload(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    index: "default:1757700000000:1278:4210",
    refs: ["contacto:12", "empresa:1", "reunion:88"],
    nodes: { count: 2, type: [0, 1], label: ["Ana", "ACME"], ts: [1757000000000, null], deg: [7, 31] },
    stubs: { count: 1, type: [3], label: ["Kickoff ACME"], ts: [1756900000000] },
    edges: { count: 2, s: [0, 0], t: [1, 2], type: [0, 2], w: [1, 1] },
    meta: { types: TYPES, edgeTypes: EDGE_TYPES },
    ...extra,
  };
}

describe("2brain › Grafo dinámico (REST)", () => {
  let fx: TestFixture;
  let state: MockState;

  beforeEach(async () => {
    state = { raw: columnarPayload(), fail: false, calls: [] };
    fx = await makeFixture({ whatsappHub: makeMockConnector(state) });
  });

  afterEach(async () => {
    await fx.close();
  });

  it.each([
    "/api/brain/grafo/skeleton",
    "/api/brain/grafo/layer",
    "/api/brain/grafo/neighbors/reunion:88",
    "/api/brain/grafo/search?q=acme",
  ])("exige sesión (401 sin token) en %s", async (url) => {
    const res = await fx.api.app.inject({ method: "GET", url });
    expect(res.statusCode).toBe(401);
    expect(state.calls).toHaveLength(0);
  });

  it("skeleton: reenvía el envoltorio columnar TAL CUAL, con su tope de 1 MB y 20 s", async () => {
    const res = await fx.api.app.inject({
      method: "GET",
      url: "/api/brain/grafo/skeleton?locationId=default",
      headers: fx.authHeaders,
    });
    expect(res.statusCode).toBe(200);
    // Nada de reproyectar a objetos: sale la misma forma columnar que entró.
    expect(res.json()).toEqual(columnarPayload());

    expect(state.calls).toHaveLength(1);
    expect(state.calls[0]!.path).toBe("/api/wiki/graph/skeleton");
    expect(state.calls[0]!.query).toEqual({ locationId: "default" });
    expect(state.calls[0]!.opts).toMatchObject({ timeoutMs: 20_000, maxResponseBytes: 1024 * 1024 });
    expect(state.calls[0]!.opts?.signal).toBeInstanceOf(AbortSignal);
  });

  it("layer: normaliza types/limit y manda el cursor keyset al hub (tope 768 KB, 12 s)", async () => {
    const res = await fx.api.app.inject({
      method: "GET",
      url: "/api/brain/grafo/layer?types=reunion,pagina,reunion&before=1757000000000&beforeId=reunion:88&limit=300",
      headers: fx.authHeaders,
    });
    expect(res.statusCode).toBe(200);
    expect(state.calls[0]!.path).toBe("/api/wiki/graph/layer");
    expect(state.calls[0]!.query).toEqual({
      locationId: undefined,
      types: "reunion,pagina",
      before: 1757000000000,
      beforeId: "reunion:88",
      limit: 300,
    });
    expect(state.calls[0]!.opts).toMatchObject({ timeoutMs: 12_000, maxResponseBytes: 768 * 1024 });
  });

  it("layer: limit por defecto 300 cuando no viene", async () => {
    await fx.api.app.inject({ method: "GET", url: "/api/brain/grafo/layer", headers: fx.authHeaders });
    expect(state.calls[0]!.query).toMatchObject({ limit: 300, types: undefined });
  });

  it.each(["limit=501", "limit=0", "types=contacto", "types=reunion,contacto", "before=-1", "beforeId=sin-dos-puntos"])(
    "layer rechaza entrada inválida (%s) sin llamar al hub",
    async (query) => {
      const res = await fx.api.app.inject({
        method: "GET",
        url: `/api/brain/grafo/layer?${query}`,
        headers: fx.authHeaders,
      });
      expect(res.statusCode).toBe(400);
      expect(state.calls).toHaveLength(0);
    },
  );

  it("descarta claves fuera de la whitelist (no viajan al hub)", async () => {
    await fx.api.app.inject({
      method: "GET",
      url: "/api/brain/grafo/layer?types=nota&limit=10&sql=DROP&offset=99",
      headers: fx.authHeaders,
    });
    expect(Object.keys(state.calls[0]!.query ?? {}).sort()).toEqual(["before", "beforeId", "limit", "locationId", "types"]);
  });

  it("neighbors: valida id y profundidad, tope 512 KB", async () => {
    const res = await fx.api.app.inject({
      method: "GET",
      url: "/api/brain/grafo/neighbors/reunion:88?depth=2&limit=500",
      headers: fx.authHeaders,
    });
    expect(res.statusCode).toBe(200);
    expect(state.calls[0]!.path).toBe("/api/wiki/graph/neighbors/reunion%3A88");
    expect(state.calls[0]!.query).toEqual({ locationId: undefined, depth: 2, limit: 500 });
    expect(state.calls[0]!.opts).toMatchObject({ timeoutMs: 12_000, maxResponseBytes: 512 * 1024 });
  });

  it.each(["depth=3", "depth=0", "limit=501"])("neighbors rechaza %s", async (query) => {
    const res = await fx.api.app.inject({
      method: "GET",
      url: `/api/brain/grafo/neighbors/reunion:88?${query}`,
      headers: fx.authHeaders,
    });
    expect(res.statusCode).toBe(400);
    expect(state.calls).toHaveLength(0);
  });

  it("neighbors rechaza un id sin forma tipo:id", async () => {
    const res = await fx.api.app.inject({
      method: "GET",
      url: "/api/brain/grafo/neighbors/sindospuntos",
      headers: fx.authHeaders,
    });
    expect(res.statusCode).toBe(400);
    expect(state.calls).toHaveLength(0);
  });

  it("search: lista corta validada, tope 64 KB", async () => {
    state.raw = {
      v: 1,
      index: "default:1757700000000:1278:4210",
      results: [{ id: "empresa:1", type: "empresa", label: "ACME", ts: null }],
      secretoInterno: "no debe llegar",
    };
    const res = await fx.api.app.inject({
      method: "GET",
      url: "/api/brain/grafo/search?q=acm&limit=10",
      headers: fx.authHeaders,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      v: 1,
      index: "default:1757700000000:1278:4210",
      results: [{ id: "empresa:1", type: "empresa", label: "ACME", ts: null }],
    });
    expect(state.calls[0]!.opts).toMatchObject({ maxResponseBytes: 64 * 1024 });
  });

  it("search filtra por CUALQUIER tipo de nodo (el índice del hub es completo)", async () => {
    state.raw = { v: 1, index: "default:1:2:3", results: [] };
    const res = await fx.api.app.inject({
      method: "GET",
      url: "/api/brain/grafo/search?q=acme&types=tema,contacto",
      headers: fx.authHeaders,
    });
    expect(res.statusCode).toBe(200);
    expect(state.calls[0]!.query).toMatchObject({ types: "tema,contacto" });
  });

  it("search rechaza un tipo de nodo desconocido", async () => {
    const res = await fx.api.app.inject({
      method: "GET",
      url: "/api/brain/grafo/search?q=acme&types=inventado",
      headers: fx.authHeaders,
    });
    expect(res.statusCode).toBe(400);
    expect(state.calls).toHaveLength(0);
  });

  it.each(["q=a", "q=", "limit=51"])("search rechaza %s", async (query) => {
    const res = await fx.api.app.inject({
      method: "GET",
      url: `/api/brain/grafo/search?${query}`,
      headers: fx.authHeaders,
    });
    expect(res.statusCode).toBe(400);
    expect(state.calls).toHaveLength(0);
  });

  it("envoltorio incoherente del hub → 502 (PROVIDER_ERROR)", async () => {
    state.raw = columnarPayload({ refs: ["contacto:12", "empresa:1"] }); // refs ≠ nodes + stubs
    const res = await fx.api.app.inject({
      method: "GET",
      url: "/api/brain/grafo/skeleton",
      headers: fx.authHeaders,
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe("provider_error");
  });

  it("hub caído → 502 con mensaje legible", async () => {
    state.fail = true;
    const res = await fx.api.app.inject({
      method: "GET",
      url: "/api/brain/grafo/skeleton",
      headers: fx.authHeaders,
    });
    expect(res.statusCode).toBe(502);
  });

  it("la ruta vieja /api/brain/grafo sigue en pie junto a las nuevas", async () => {
    state.raw = { nodes: [], edges: [], stats: { nodeCount: 0, edgeCount: 0, byType: {}, truncated: false } };
    const res = await fx.api.app.inject({ method: "GET", url: "/api/brain/grafo", headers: fx.authHeaders });
    expect(res.statusCode).toBe(200);
    expect(state.calls[0]!.path).toBe("/api/wiki/graph");
  });
});

describe("assertColumnarGraph", () => {
  it("acepta el envoltorio del contrato y devuelve el MISMO objeto (sin copiar)", () => {
    const payload = columnarPayload();
    expect(assertColumnarGraph(payload)).toBe(payload);
  });

  it.each([
    ["refs no cuadra", { refs: ["contacto:12"] }],
    ["columna de nodes corta", { nodes: { count: 2, type: [0], label: ["Ana", "ACME"], ts: [1, 2], deg: [1, 2] } }],
    ["columna de stubs corta", { stubs: { count: 1, type: [], label: ["x"], ts: [1] } }],
    ["arista fuera de rango", { edges: { count: 1, s: [0], t: [9], type: [0], w: [1] } }],
    ["ts en ISO en vez de epoch", { nodes: { count: 2, type: [0, 1], label: ["A", "B"], ts: ["2026-01-01", null], deg: [1, 2] } }],
    ["sin index", { index: undefined }],
    ["meta sin diccionarios", { meta: { types: TYPES } }],
  ])("rechaza %s", (_name, patch) => {
    expect(() => assertColumnarGraph(columnarPayload(patch as Record<string, unknown>))).toThrow();
  });

  it("rechaza una respuesta vacía", () => {
    expect(() => assertColumnarGraph(null)).toThrow();
  });

  // Formas REALES del hub (WhatsAppHub e4974d8): meta extendido solo en el
  // skeleton, cursor solo en layer, y neighbors con los diccionarios pelados.
  it("acepta el skeleton real (meta con counts/loaded/range/totals, 0 stubs)", () => {
    expect(() =>
      assertColumnarGraph({
        v: 1,
        index: "default:1757700000000:1547:4009",
        refs: ["contacto:1", "empresa:1"],
        nodes: { count: 2, type: [0, 1], label: ["Ana", "ACME"], ts: [1757000000000, null], deg: [3, 9] },
        stubs: { count: 0, type: [], label: [], ts: [] },
        edges: { count: 1, s: [0], t: [1], type: [0], w: [1] },
        meta: {
          types: TYPES,
          edgeTypes: EDGE_TYPES,
          counts: { contacto: 363, empresa: 1, equipo: 6, tema: 319, reunion: 390, nota: 7, nota_voz: 6, pagina: 455 },
          loaded: { contacto: 363, empresa: 1, equipo: 6, tema: 319, reunion: 0, nota: 0, nota_voz: 0, pagina: 0 },
          range: { reunion: { min: 1700000000000, max: 1757000000000 } },
          totals: { nodes: 1547, edges: 4009 },
        },
      }),
    ).not.toThrow();
  });

  it("acepta una capa real (stubs + cursor) y una ego-red real (solo diccionarios)", () => {
    const layer = columnarPayload({
      cursor: { next: { ts: 1756900000000, id: "reunion:88" }, remainingByType: { reunion: 90 }, done: false },
    });
    expect(() => assertColumnarGraph(layer)).not.toThrow();
    const neighbors = columnarPayload();
    delete (neighbors as Record<string, unknown>).cursor;
    expect(() => assertColumnarGraph(neighbors)).not.toThrow();
  });
});

describe("abortSignalOnClientClose (grafo dinámico)", () => {
  it("propaga el cierre del cliente como abort y suelta el listener", () => {
    const raw = new EventEmitter();
    const { signal, dispose } = abortSignalOnClientClose(raw);
    expect(signal.aborted).toBe(false);
    raw.emit("close");
    expect(signal.aborted).toBe(true);
    dispose();
    expect(raw.listenerCount("close")).toBe(0);
  });
});
