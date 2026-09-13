/**
 * 2brain › Grafo (REST): proxy de solo lectura a `/api/wiki/graph` de
 * WhatsAppHub. Conector SIEMPRE mock — ninguna llamada real sale de los
 * tests. Cubre: camino feliz + forwarding de query, whitelist (claves extra
 * del hub no llegan al cliente), validación 400 de entrada y 502 cuando el
 * hub falla.
 */
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SourceConnectorError, type WhatsAppHubConnector } from "@agentos/shared";
import { abortSignalOnClientClose } from "../src/routes/brain/grafo.js";
import { makeFixture, type TestFixture } from "./helpers.js";

interface MockState {
  raw: unknown;
  fail: boolean;
  /** Simula al hub rechazando por tamaño (>2 MB), como hace el conector real. */
  oversized: boolean;
  calls: Array<{ path: string; query: unknown; opts?: { timeoutMs?: number; maxResponseBytes?: number; signal?: AbortSignal } }>;
}

function makeMockConnector(state: MockState): WhatsAppHubConnector {
  return {
    isConfigured: () => true,
    async listMeetings() {
      throw new Error("not implemented");
    },
    async getMeeting() {
      throw new Error("not implemented");
    },
    async getMeetingMarkdown() {
      throw new Error("not implemented");
    },
    async listContacts() {
      throw new Error("not implemented");
    },
    async getDossierMarkdown() {
      throw new Error("not implemented");
    },
    async hubGetJson(path, query, opts) {
      state.calls.push({ path, query, opts });
      if (state.fail) {
        throw new SourceConnectorError(
          "unreachable",
          "No se pudo conectar con WhatsAppHub (/api/wiki/graph). ¿VPS caído? Reintenta más tarde.",
        );
      }
      if (state.oversized) {
        throw new SourceConnectorError(
          "http_error",
          "El grafo de WhatsAppHub excede el tamaño permitido",
        );
      }
      return state.raw;
    },
    async hubSendJson() {
      throw new Error("not implemented");
    },
    async hubGetText() {
      throw new Error("not implemented");
    },
    async hubGetRaw() {
      throw new Error("not implemented");
    },
  };
}

/** Grafo crudo tal como lo devolvería `graphStore.buildGraph`, con claves
 * extra a propósito (nodo, meta, arista y stats) para probar la whitelist. */
const RAW_GRAPH = {
  nodes: [
    {
      id: "contacto:1",
      type: "contacto",
      label: "Jefe de Producción ACME",
      refId: 1,
      companyIdRaw: 7, // clave extra a nivel de nodo: no debe llegar al cliente
      meta: {
        phone: "+58 412 111 1111",
        email: "jefe@acme.test",
        leadStatus: "cliente",
        msgInCount: 42,
        lastMessageAt: "2026-09-01T10:00:00.000Z",
        internalScore: 99, // clave extra en meta: no debe llegar al cliente
      },
    },
    {
      id: "nota_voz:9",
      type: "nota_voz",
      label: "Idea rápida",
      refId: 9,
      meta: { category: "idea", createdBy: "equipo@sixteam.pro", createdAt: "2026-08-20T08:00:00.000Z" },
    },
  ],
  edges: [
    // `derived` es real en el hub, pero fuera de la whitelist de aristas.
    { source: "contacto:1", target: "nota_voz:9", type: "creada-por", weight: 0.6, derived: true },
  ],
  stats: {
    nodeCount: 2,
    edgeCount: 1,
    byType: { contacto: 1, nota_voz: 1 },
    truncated: false,
    extraStat: "no-debe-llegar",
  },
};

describe("2brain › Grafo (REST)", () => {
  let fx: TestFixture;
  let state: MockState;

  beforeEach(async () => {
    state = { raw: RAW_GRAPH, fail: false, oversized: false, calls: [] };
    fx = await makeFixture({ whatsappHub: makeMockConnector(state) });
  });

  afterEach(async () => {
    await fx.close();
  });

  it("exige sesión (401 sin token)", async () => {
    const res = await fx.api.app.inject({ method: "GET", url: "/api/brain/grafo" });
    expect(res.statusCode).toBe(401);
  });

  it("acota un hub antiguo que ignora presupuestos y conserva el foco conectado", async () => {
    const nodes = Array.from({ length: 900 }, (_, i) => ({ id: `contacto:${i}`, type: "contacto", label: `Contacto ${i}`, meta: {} }));
    const edges = nodes.slice(0, -1).map(node => ({ source: "contacto:899", target: node.id, weight: 1 }));
    state.raw = { nodes, edges };
    const res = await fx.api.app.inject({ method: "GET", url: "/api/brain/grafo?maxNodes=20&maxEdges=5&focus=contacto:899&depth=2", headers: fx.authHeaders });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.nodes).toHaveLength(6);
    expect(body.nodes[0].id).toBe("contacto:899");
    expect(body.edges).toHaveLength(5);
    expect(body.stats).toMatchObject({ nodeCount: 6, edgeCount: 5, truncated: true });
    expect(state.calls[0]!.query).toMatchObject({ maxNodes: 20, maxEdges: 5 });
    expect(body.nodes.every((node: { id: string }) => node.id === "contacto:899" || body.edges.some((edge: { target: string }) => edge.target === node.id))).toBe(true);
  });

  it("rechaza colecciones enormes antes de validar cada nodo", async () => {
    state.raw = { nodes: Array.from({ length: 4201 }, () => ({})), edges: [] };
    const res = await fx.api.app.inject({ method: "GET", url: "/api/brain/grafo", headers: fx.authHeaders });
    expect(res.statusCode).toBe(502);
    expect(res.body.length).toBeLessThan(1000);
  });

  it.each(["maxNodes=301", "maxEdges=601", "maxNodes=0"])("rechaza presupuesto inválido %s", async (query) => {
    const res = await fx.api.app.inject({ method: "GET", url: `/api/brain/grafo?${query}`, headers: fx.authHeaders });
    expect(res.statusCode).toBe(400);
    expect(state.calls).toHaveLength(0);
  });

  it("camino feliz: proxea a /api/wiki/graph sin params extra por defecto", async () => {
    const res = await fx.api.app.inject({
      method: "GET",
      url: "/api/brain/grafo",
      headers: fx.authHeaders,
    });
    expect(res.statusCode).toBe(200);

    expect(state.calls).toHaveLength(1);
    expect(state.calls[0]!.path).toBe("/api/wiki/graph");
    expect(state.calls[0]!.query).toEqual({
      limitPerType: undefined,
      maxNodes: 120,
      maxEdges: 240,
      since: undefined,
      includeIsolated: false,
      focus: undefined,
      depth: undefined,
    });
    // Cancelación de extremo a extremo: el hub SIEMPRE recibe una señal
    // abortable, aunque el cliente nunca cierre la conexión.
    expect(state.calls[0]!.opts?.signal).toBeInstanceOf(AbortSignal);
    expect(state.calls[0]!.opts?.signal?.aborted).toBe(false);

    const body = res.json() as { nodes: unknown[]; edges: unknown[]; stats: Record<string, unknown> };
    expect(body.nodes).toHaveLength(2);
    expect(body.edges).toHaveLength(1);
    expect(body.stats).toMatchObject({ nodeCount: 2, edgeCount: 1, truncated: false });
  });

  it("reenvía limitPerType/since/includeIsolated/focus/depth al hub", async () => {
    const res = await fx.api.app.inject({
      method: "GET",
      url: "/api/brain/grafo?limitPerType=50&since=2026-06-01&includeIsolated=true&focus=contacto:1&depth=2",
      headers: fx.authHeaders,
    });
    expect(res.statusCode).toBe(200);
    expect(state.calls[0]!.query).toEqual({
      limitPerType: 50,
      maxNodes: 120,
      maxEdges: 240,
      since: "2026-06-01",
      includeIsolated: true,
      focus: "contacto:1",
      depth: 2,
    });
  });

  it("whitelist: descarta claves extra del hub (nodo, meta, arista y stats)", async () => {
    const res = await fx.api.app.inject({
      method: "GET",
      url: "/api/brain/grafo",
      headers: fx.authHeaders,
    });
    const body = res.json() as {
      nodes: Array<Record<string, unknown> & { meta: Record<string, unknown> }>;
      edges: Array<Record<string, unknown>>;
      stats: Record<string, unknown>;
    };

    const contacto = body.nodes.find((n) => n.id === "contacto:1")!;
    expect(contacto).not.toHaveProperty("companyIdRaw");
    expect(contacto.meta).not.toHaveProperty("internalScore");
    expect(contacto.meta).toMatchObject({ phone: "+58 412 111 1111", leadStatus: "cliente" });

    expect(body.edges[0]).not.toHaveProperty("derived");
    expect(body.edges[0]).toMatchObject({ source: "contacto:1", target: "nota_voz:9", weight: 0.6 });

    expect(body.stats).not.toHaveProperty("extraStat");
  });

  it("valida la entrada: focus sin forma tipo:id → 400", async () => {
    const res = await fx.api.app.inject({
      method: "GET",
      url: "/api/brain/grafo?focus=sin-dos-puntos",
      headers: fx.authHeaders,
    });
    expect(res.statusCode).toBe(400);
  });

  it("valida la entrada: depth fuera de rango → 400", async () => {
    const res = await fx.api.app.inject({
      method: "GET",
      url: "/api/brain/grafo?depth=9",
      headers: fx.authHeaders,
    });
    expect(res.statusCode).toBe(400);
  });

  it("valida la entrada: focus de más de 200 caracteres → 400", async () => {
    const res = await fx.api.app.inject({
      method: "GET",
      url: `/api/brain/grafo?focus=contacto:${"a".repeat(200)}`,
      headers: fx.authHeaders,
    });
    expect(res.statusCode).toBe(400);
    expect(state.calls).toHaveLength(0);
  });

  it("respuesta del hub demasiado grande (>2 MB) → 502 con connector_code", async () => {
    state.oversized = true;
    const res = await fx.api.app.inject({
      method: "GET",
      url: "/api/brain/grafo",
      headers: fx.authHeaders,
    });
    expect(res.statusCode).toBe(502);
    const body = res.json() as { error: { code: string; details?: { connector_code?: string } } };
    expect(body.error.code).toBe("provider_error");
    expect(body.error.details?.connector_code).toBe("http_error");
  });

  it("error del conector → 502 legible", async () => {
    state.fail = true;
    const res = await fx.api.app.inject({
      method: "GET",
      url: "/api/brain/grafo",
      headers: fx.authHeaders,
    });
    expect(res.statusCode).toBe(502);
    expect((res.json() as { error: { code: string } }).error.code).toBe("provider_error");
  });

  it("respuesta del hub con forma inesperada → 502 (no 500, no passthrough crudo)", async () => {
    state.raw = { nodes: [{ id: "contacto:1" /* sin type ni label */ }] };
    const res = await fx.api.app.inject({
      method: "GET",
      url: "/api/brain/grafo",
      headers: fx.authHeaders,
    });
    expect(res.statusCode).toBe(502);
    expect((res.json() as { error: { code: string } }).error.code).toBe("provider_error");
  });
});

/**
 * Mecánica de cancelación de extremo a extremo, probada directamente contra
 * `req.raw` (un `EventEmitter`, la superficie real que expone Fastify): un
 * `GET` sin cuerpo nunca dispara la lectura del stream mock de fastify.inject,
 * así que `simulate.close` de light-my-request no es un camino fiable para
 * probar esto end-to-end. Se prueba la unidad que sí importa: que 'close'
 * aborta la señal y que `dispose()` siempre quita el listener.
 */
describe("abortSignalOnClientClose (cancelación de extremo a extremo)", () => {
  it("el cierre del cliente aborta la señal; dispose() quita el listener al terminar", () => {
    const raw = new EventEmitter();
    const { signal, dispose } = abortSignalOnClientClose(raw);

    expect(signal.aborted).toBe(false);
    expect(raw.listenerCount("close")).toBe(1);

    raw.emit("close");
    expect(signal.aborted).toBe(true);

    dispose();
    expect(raw.listenerCount("close")).toBe(0);
  });

  it("dispose() antes del cierre evita que una desconexión tardía aborte la señal", () => {
    const raw = new EventEmitter();
    const { signal, dispose } = abortSignalOnClientClose(raw);

    dispose();
    raw.emit("close");

    expect(signal.aborted).toBe(false);
  });
});
