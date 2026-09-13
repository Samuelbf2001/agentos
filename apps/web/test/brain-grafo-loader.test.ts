/**
 * 2brain › Grafo dinámico: el loader — QUÉ se pide y CUÁNDO.
 *
 * `api` siempre falso (nada de red) y `schedule` inyectado para que las tandas
 * ocurran de forma determinista en vez de depender de `requestIdleCallback`.
 * Ningún test importa sigma ni el worker de ForceAtlas2.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGraphStore } from "../src/lib/brain/graphStore";
import { createGraphLoader, dominantType } from "../src/lib/brain/graphLoader";
import { decodePayload, type DecodedPayload, type GraphApi, type LayerParams } from "../src/lib/brain/grafoDynamic";

const TYPES = ["contacto", "empresa", "equipo", "reunion", "nota", "nota_voz", "pagina", "tema"];
const EDGE_TYPES = [
  "pertenece-a", "asignado-a", "reunion-contacto", "reunion-empresa", "nota-contacto",
  "nota-empresa", "participo-en", "tagged", "relacionada-con", "creada-por",
];

interface RawNode { id: string; type: string; label: string; ts?: number | null }

function payload(
  nodes: RawNode[],
  stubs: RawNode[] = [],
  edges: Array<{ s: string; t: string; type?: string }> = [],
  extra: Record<string, unknown> = {},
): DecodedPayload {
  const refs = [...nodes.map((n) => n.id), ...stubs.map((n) => n.id)];
  return decodePayload({
    v: 1,
    index: "default:1:2:3",
    refs,
    nodes: {
      count: nodes.length,
      type: nodes.map((n) => TYPES.indexOf(n.type)),
      label: nodes.map((n) => n.label),
      ts: nodes.map((n) => n.ts ?? null),
      deg: nodes.map(() => 1),
    },
    stubs: {
      count: stubs.length,
      type: stubs.map((n) => TYPES.indexOf(n.type)),
      label: stubs.map((n) => n.label),
      ts: stubs.map((n) => n.ts ?? null),
    },
    edges: {
      count: edges.length,
      s: edges.map((e) => refs.indexOf(e.s)),
      t: edges.map((e) => refs.indexOf(e.t)),
      type: edges.map((e) => EDGE_TYPES.indexOf(e.type ?? "relacionada-con")),
      w: edges.map(() => 1),
    },
    meta: { types: TYPES, edgeTypes: EDGE_TYPES },
    ...extra,
  });
}

/** 390 reuniones que el servidor pagina en tandas de 300 por `(ts DESC, id DESC)`. */
function fakeUniverse(total = 390) {
  return Array.from({ length: total }, (_, i) => ({
    id: `reunion:${1000 - i}`,
    type: "reunion",
    label: `Reunión ${i}`,
    ts: 1_757_000_000_000 - i * 86_400_000,
  }));
}

interface Recorder {
  api: GraphApi;
  layerCalls: LayerParams[];
  neighborCalls: Array<{ id: string; depth?: 1 | 2 }>;
  searchCalls: string[];
  signals: Array<AbortSignal | undefined>;
}

function makeApi(universe: RawNode[], skeletonExtra: Record<string, unknown> = {}): Recorder {
  const layerCalls: LayerParams[] = [];
  const neighborCalls: Array<{ id: string; depth?: 1 | 2 }> = [];
  const searchCalls: string[] = [];
  const signals: Array<AbortSignal | undefined> = [];

  const skeletonMeta = {
    types: TYPES,
    edgeTypes: EDGE_TYPES,
    counts: { contacto: 2, reunion: universe.length },
    range: { reunion: { min: universe[universe.length - 1]?.ts ?? null, max: universe[0]?.ts ?? null } },
    totals: { nodes: 2 + universe.length, edges: 1 },
    ...skeletonExtra,
  };

  return {
    layerCalls,
    neighborCalls,
    searchCalls,
    signals,
    api: {
      async getSkeleton(signal) {
        signals.push(signal);
        return payload(
          [
            { id: "contacto:1", type: "contacto", label: "Ana" },
            { id: "empresa:1", type: "empresa", label: "ACME" },
          ],
          [],
          [{ s: "contacto:1", t: "empresa:1", type: "pertenece-a" }],
          { meta: skeletonMeta },
        );
      },
      async getLayer(params, signal) {
        layerCalls.push({ ...params });
        signals.push(signal);
        // Keyset: arranca estrictamente después de (before, beforeId).
        const from = params.beforeId ? universe.findIndex((n) => n.id === params.beforeId) + 1 : 0;
        const slice = universe.slice(from, from + (params.limit ?? 300));
        const last = slice[slice.length - 1];
        const remaining = Math.max(0, universe.length - (from + slice.length));
        return payload(slice, [], [], {
          meta: { types: TYPES, edgeTypes: EDGE_TYPES, counts: skeletonMeta.counts },
          cursor: {
            next: remaining > 0 && last ? { ts: last.ts ?? null, id: last.id } : null,
            remainingByType: { reunion: remaining },
            done: remaining === 0,
          },
        });
      },
      async getNeighbors(id, params, signal) {
        neighborCalls.push({ id, depth: params?.depth });
        signals.push(signal);
        return payload(
          [{ id, type: id.split(":")[0]!, label: `Nodo ${id}` }],
          [{ id: "contacto:1", type: "contacto", label: "Ana" }],
          [{ s: id, t: "contacto:1", type: "participo-en" }],
        );
      },
      async searchNodes(q, _params, signal) {
        searchCalls.push(q);
        signals.push(signal);
        return [{ id: "reunion:777", type: "reunion", label: `Resultado ${q}`, ts: 1 }];
      },
    },
  };
}

/** Cola de idle manual: `flush()` corre lo pendiente, tanda a tanda. */
function makeScheduler() {
  const queue: Array<() => void> = [];
  return {
    schedule: (cb: () => void) => {
      queue.push(cb);
      return queue.length;
    },
    cancelSchedule: () => {},
    pending: () => queue.length,
    async flush(rounds = 20): Promise<void> {
      for (let i = 0; i < rounds && queue.length > 0; i++) {
        const next = queue.shift()!;
        next();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      }
    },
  };
}

describe("graphLoader", () => {
  beforeEach(() => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("secuencia: skeleton primero, pintado inmediato y solo después las tandas", async () => {
    const store = createGraphStore();
    const rec = makeApi(fakeUniverse());
    const scheduler = makeScheduler();
    const phases: string[] = [];
    const patches: number[] = [];

    const loader = createGraphLoader({
      api: rec.api,
      store,
      schedule: scheduler.schedule,
      cancelSchedule: scheduler.cancelSchedule,
      onProgress: (p) => phases.push(p.phase),
      onPatch: (p) => patches.push(p.nodesAdded),
    });

    await loader.start();
    // Al volver de start() el esqueleto YA está pintado y ninguna tanda ha corrido.
    expect(store.graph.order).toBe(2);
    expect(patches).toEqual([2]);
    expect(rec.layerCalls).toHaveLength(0);
    expect(phases.slice(0, 2)).toEqual(["skeleton", "skeleton"]);
    expect(scheduler.pending()).toBe(1);

    await scheduler.flush(1);
    expect(rec.layerCalls).toHaveLength(1);
    expect(store.graph.order).toBe(302);
  });

  it("pagina 390 reuniones en tandas de 300 con cursor keyset, sin huecos ni repetidos", async () => {
    const universe = fakeUniverse(390);
    const store = createGraphStore();
    const rec = makeApi(universe);
    const scheduler = makeScheduler();

    const loader = createGraphLoader({
      api: rec.api,
      store,
      schedule: scheduler.schedule,
      cancelSchedule: scheduler.cancelSchedule,
    });
    await loader.start();
    await scheduler.flush();

    expect(rec.layerCalls).toHaveLength(2);
    expect(rec.layerCalls[0]).toMatchObject({ limit: 300, beforeId: undefined, before: undefined });
    expect(rec.layerCalls[1]).toMatchObject({ limit: 300, beforeId: universe[299]!.id, before: universe[299]!.ts });
    // 2 primarios + 390 reuniones, cada una una sola vez.
    expect(store.graph.order).toBe(392);
    expect(store.loadedByType.reunion).toBe(390);
    expect(scheduler.pending()).toBe(0);
  });

  it("respeta el presupuesto: para al alcanzarlo y 'cargar más antiguos' lo levanta", async () => {
    const universe = fakeUniverse(1200);
    const store = createGraphStore();
    const rec = makeApi(universe);
    const scheduler = makeScheduler();
    const progress: Array<{ phase: string; budgetUsed: number }> = [];

    const loader = createGraphLoader({
      api: rec.api,
      store,
      budget: 600,
      batch: 300,
      schedule: scheduler.schedule,
      cancelSchedule: scheduler.cancelSchedule,
      onProgress: (p) => progress.push({ phase: p.phase, budgetUsed: p.budgetUsed }),
    });
    await loader.start();
    await scheduler.flush();

    expect(rec.layerCalls).toHaveLength(2);
    expect(loader.budgetUsed).toBe(600);
    expect(store.loadedByType.reunion).toBe(600);
    // Con el presupuesto agotado el loader queda en reposo, no "done".
    expect(progress.at(-1)!.phase).toBe("idle");

    await loader.loadMoreOlder(300);
    await scheduler.flush();
    expect(rec.layerCalls).toHaveLength(3);
    expect(store.loadedByType.reunion).toBe(900);
    expect(loader.budgetMax).toBe(900);
  });

  it("el indicador dice tipo y avance reales de la tanda ('reuniones 300/390')", async () => {
    const store = createGraphStore();
    const rec = makeApi(fakeUniverse(390));
    const scheduler = makeScheduler();
    const progress: Array<{ phase: string; type?: string; loaded: number; total: number }> = [];

    const loader = createGraphLoader({
      api: rec.api,
      store,
      schedule: scheduler.schedule,
      cancelSchedule: scheduler.cancelSchedule,
      onProgress: (p) => progress.push({ phase: p.phase, type: p.type, loaded: p.loaded, total: p.total }),
    });
    await loader.start();
    await scheduler.flush(1);

    const layer = progress.find((p) => p.phase === "layer")!;
    expect(layer).toMatchObject({ type: "reunion", loaded: 300, total: 390 });

    await scheduler.flush();
    const done = progress.at(-1)!;
    expect(done.phase).toBe("done");
    expect(done).toMatchObject({ loaded: 392, total: 392 });
  });

  it("no encadena tandas con la pestaña oculta", async () => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const store = createGraphStore();
    const rec = makeApi(fakeUniverse());
    const scheduler = makeScheduler();

    const loader = createGraphLoader({
      api: rec.api,
      store,
      schedule: scheduler.schedule,
      cancelSchedule: scheduler.cancelSchedule,
    });
    await loader.start();

    expect(scheduler.pending()).toBe(0);
    expect(rec.layerCalls).toHaveLength(0);
    expect(store.graph.order).toBe(2); // el esqueleto sí se pinta
  });

  it("aristas huérfanas: la que apunta a un stub entra al llegar el nodo", async () => {
    const store = createGraphStore();
    const rec = makeApi([]);
    const loader = createGraphLoader({ api: rec.api, store, schedule: () => 0, cancelSchedule: () => {} });
    await loader.start();

    // Nota que cita una reunión todavía no entregada (llega como stub).
    store.applyPayload(
      payload(
        [{ id: "nota:5", type: "nota", label: "Acta" }],
        [{ id: "reunion:88", type: "reunion", label: "Kickoff" }],
        [{ s: "nota:5", t: "reunion:88" }],
      ),
    );
    expect(store.has("reunion:88")).toBe(false);
    expect(store.graph.size).toBe(1); // solo la arista del esqueleto

    const merged = store.applyPayload(payload([{ id: "reunion:88", type: "reunion", label: "Kickoff" }]));
    expect(merged.unparked).toBe(1);
    expect(store.graph.size).toBe(2);
  });

  it("'desde fecha' recorta la tanda y detiene la paginación bajo el suelo", async () => {
    const universe = fakeUniverse(390);
    const floor = universe[99]!.ts!; // solo los 100 más recientes quedan por encima
    const store = createGraphStore();
    const rec = makeApi(universe);
    const scheduler = makeScheduler();

    const loader = createGraphLoader({
      api: rec.api,
      store,
      schedule: scheduler.schedule,
      cancelSchedule: scheduler.cancelSchedule,
    });
    await loader.setDateFloor(floor);
    await loader.start();
    await scheduler.flush();

    expect(store.loadedByType.reunion).toBe(100);
    expect(rec.layerCalls).toHaveLength(1); // no sigue pidiendo lo que ya no cabe
  });

  it("'ver vecinos' mezcla la ego-red sin reemplazar la vista", async () => {
    const store = createGraphStore();
    const rec = makeApi(fakeUniverse(10));
    const loader = createGraphLoader({ api: rec.api, store, schedule: () => 0, cancelSchedule: () => {} });
    await loader.start();
    const before = store.graph.order;

    await loader.loadNeighbors("reunion:500", 1);

    expect(rec.neighborCalls).toEqual([{ id: "reunion:500", depth: 1 }]);
    expect(store.graph.order).toBe(before + 1);
    expect(store.has("contacto:1")).toBe(true); // lo de antes sigue ahí
    expect(store.graph.hasEdge("reunion:500|contacto:1|participo-en")).toBe(true);
  });

  it("la búsqueda consulta al servidor", async () => {
    const store = createGraphStore();
    const rec = makeApi([]);
    const loader = createGraphLoader({ api: rec.api, store, schedule: () => 0, cancelSchedule: () => {} });
    await loader.start();

    const hits = await loader.search("acme");
    expect(rec.searchCalls).toEqual(["acme"]);
    expect(hits).toHaveLength(1);
  });

  it("cancel() aborta las peticiones en vuelo y no encadena nada más", async () => {
    const store = createGraphStore();
    const rec = makeApi(fakeUniverse());
    const scheduler = makeScheduler();
    const loader = createGraphLoader({
      api: rec.api,
      store,
      schedule: scheduler.schedule,
      cancelSchedule: scheduler.cancelSchedule,
    });
    await loader.start();

    const signal = rec.signals[0]!;
    expect(signal.aborted).toBe(false);
    loader.cancel();
    expect(signal.aborted).toBe(true);

    await scheduler.flush();
    expect(rec.layerCalls).toHaveLength(0);
  });

  it("el abort externo (desmontaje de la vista) cancela igual", async () => {
    const store = createGraphStore();
    const rec = makeApi(fakeUniverse());
    const scheduler = makeScheduler();
    const controller = new AbortController();
    const loader = createGraphLoader({
      api: rec.api,
      store,
      schedule: scheduler.schedule,
      cancelSchedule: scheduler.cancelSchedule,
    });
    await loader.start(controller.signal);

    controller.abort();
    expect(rec.signals[0]!.aborted).toBe(true);
    await scheduler.flush();
    expect(rec.layerCalls).toHaveLength(0);
  });

  it("un error del servidor se reporta y no deja el bucle girando", async () => {
    const store = createGraphStore();
    const rec = makeApi(fakeUniverse());
    const scheduler = makeScheduler();
    const errors: unknown[] = [];
    const failing: GraphApi = { ...rec.api, async getLayer() { throw new Error("502"); } };

    const loader = createGraphLoader({
      api: failing,
      store,
      schedule: scheduler.schedule,
      cancelSchedule: scheduler.cancelSchedule,
      onError: (err) => errors.push(err),
    });
    await loader.start();
    await scheduler.flush();

    expect(errors).toHaveLength(1);
    expect(scheduler.pending()).toBe(0);
  });

  it("dominantType nombra el tipo que más aportó a la tanda", () => {
    const batch = payload([
      { id: "reunion:1", type: "reunion", label: "a" },
      { id: "reunion:2", type: "reunion", label: "b" },
      { id: "pagina:1", type: "pagina", label: "c" },
    ]);
    expect(dominantType(batch)).toBe("reunion");
    expect(dominantType(payload([]))).toBeUndefined();
  });
});
