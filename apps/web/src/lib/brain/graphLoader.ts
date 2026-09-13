/**
 * 2brain › Grafo dinámico: el que decide QUÉ se pide y CUÁNDO.
 *
 * Secuencia obligatoria (spec §C.1): `skeleton` → insertar → pintar YA → tandas
 * de 300 secundarios por fecha descendente global en `requestIdleCallback`
 * (fallback `setTimeout(0)`) hasta el presupuesto de confort (1.500 nodos).
 * El tope deja de ser una política ciega y pasa a ser un presupuesto que el
 * usuario puede levantar ("cargar más antiguos", "cargar todo").
 *
 * Nunca encadena una tanda con la pestaña oculta: cargar en segundo plano
 * gasta CPU del usuario sin que nadie lo vea.
 *
 * Sin React, sin sigma, sin DOM más allá de `document.hidden`.
 */
import type { GraphStore } from "./graphStore";
import {
  SECONDARY_NODE_TYPES,
  type DecodedPayload,
  type GraphApi,
  type GraphCursor,
  type GraphMeta,
  type SearchHit,
} from "./grafoDynamic";

export type LoaderPhase = "skeleton" | "layer" | "neighbors" | "idle" | "done";

export interface LoaderProgress {
  phase: LoaderPhase;
  /** Tipo dominante de la última tanda; alimenta "Cargando: reuniones recientes". */
  type?: string;
  loaded: number;
  total: number;
  budgetUsed: number;
  budgetMax: number;
}

export interface LoaderPatch {
  nodesAdded: number;
  edgesAdded: number;
}

export interface GraphLoaderOptions {
  api: GraphApi;
  store: GraphStore;
  /** Presupuesto de confort en nodos secundarios (por defecto 1.500). */
  budget?: number;
  /** Tamaño de tanda (por defecto 300). */
  batch?: number;
  onProgress?(progress: LoaderProgress): void;
  onPatch?(patch: LoaderPatch): void;
  onError?(error: unknown): void;
  /** Inyectable para tests; por defecto `requestIdleCallback` con caída a `setTimeout(0)`. */
  schedule?: (cb: () => void) => number;
  cancelSchedule?: (handle: number) => void;
}

export interface GraphLoader {
  start(signal?: AbortSignal): Promise<void>;
  loadMoreOlder(n?: number): Promise<void>;
  setDateFloor(tsMs: number | null): Promise<void>;
  setTypes(types: string[]): void;
  loadNeighbors(id: string, depth?: 1 | 2): Promise<void>;
  search(q: string): Promise<SearchHit[]>;
  cancel(): void;
  /** Metadatos del skeleton (rangos reales para "desde fecha", totales). */
  readonly meta: GraphMeta | null;
  readonly budgetUsed: number;
  readonly budgetMax: number;
}

export const DEFAULT_BUDGET = 1500;
export const DEFAULT_BATCH = 300;

function defaultSchedule(cb: () => void): number {
  const idle = (globalThis as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number })
    .requestIdleCallback;
  if (typeof idle === "function") return idle(cb, { timeout: 500 });
  return setTimeout(cb, 0) as unknown as number;
}

function defaultCancelSchedule(handle: number): void {
  const cancelIdle = (globalThis as { cancelIdleCallback?: (handle: number) => void }).cancelIdleCallback;
  if (typeof cancelIdle === "function") cancelIdle(handle);
  else clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
}

/** ¿La pestaña está oculta? (regla §C.1: no encadenar tandas invisibles). */
function documentHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

/**
 * Recorta la tanda al suelo de fecha elegido por el usuario. El orden del
 * servidor es `(ts DESC, id DESC)` global: por debajo del suelo no queda nada
 * que interese, así que además se corta la paginación.
 */
export function applyDateFloor(payload: DecodedPayload, floor: number | null): DecodedPayload {
  if (floor === null) return payload;
  const nodes = payload.nodes.filter((node) => node.ts === null || node.ts >= floor);
  if (nodes.length === payload.nodes.length) return payload;
  return { ...payload, nodes };
}

/** Tipo dominante de la tanda: el que más nodos aportó (para el indicador). */
export function dominantType(payload: DecodedPayload): string | undefined {
  let best: string | undefined;
  let bestCount = 0;
  const counts = new Map<string, number>();
  for (const node of payload.nodes) {
    const next = (counts.get(node.type) ?? 0) + 1;
    counts.set(node.type, next);
    if (next > bestCount) {
      bestCount = next;
      best = node.type;
    }
  }
  return best;
}

export function createGraphLoader(opts: GraphLoaderOptions): GraphLoader {
  const { api, store } = opts;
  const batchSize = opts.batch ?? DEFAULT_BATCH;
  const schedule = opts.schedule ?? defaultSchedule;
  const cancelSchedule = opts.cancelSchedule ?? (opts.schedule ? () => {} : defaultCancelSchedule);

  let budget = opts.budget ?? DEFAULT_BUDGET;
  let budgetUsed = 0;
  let types: string[] = [...SECONDARY_NODE_TYPES];
  let cursor: GraphCursor["next"] = null;
  let exhausted = false;
  let dateFloor: number | null = null;
  let floorReached = false;
  let meta: GraphMeta | null = null;
  let idleHandle: number | null = null;
  let pumping = false;
  let cancelled = false;

  const controller = new AbortController();
  let externalSignal: AbortSignal | undefined;
  let onExternalAbort: (() => void) | undefined;

  const emit = (phase: LoaderPhase, type?: string, loaded = 0, total = 0): void => {
    opts.onProgress?.({ phase, type, loaded, total, budgetUsed, budgetMax: budget });
  };

  const totals = (): { loaded: number; total: number } => {
    const loaded = store.graph.order;
    return { loaded, total: meta?.totals?.nodes ?? loaded };
  };

  const idle = (): void => {
    const { loaded, total } = totals();
    const finished = exhausted || floorReached;
    emit(finished ? "done" : "idle", undefined, loaded, total);
  };

  const clearIdle = (): void => {
    if (idleHandle === null) return;
    cancelSchedule(idleHandle);
    idleHandle = null;
  };

  /** Una tanda: pide, aplica, avisa y decide si encadena la siguiente. */
  async function pullBatch(): Promise<void> {
    const payload = await api.getLayer(
      { types, before: cursor?.ts ?? undefined, beforeId: cursor?.id ?? undefined, limit: batchSize },
      controller.signal,
    );
    if (cancelled) return;
    const trimmed = applyDateFloor(payload, dateFloor);
    if (trimmed.nodes.length < payload.nodes.length) floorReached = true;

    const result = store.applyPayload(trimmed);
    budgetUsed += result.nodesAdded;
    if (!meta && trimmed.meta?.counts) meta = trimmed.meta;
    opts.onPatch?.({ nodesAdded: result.nodesAdded, edgesAdded: result.edgesAdded });

    cursor = payload.cursor?.next ?? null;
    if (payload.cursor?.done || cursor === null) exhausted = true;
    if (dateFloor !== null && cursor?.ts != null && cursor.ts < dateFloor) floorReached = true;

    const type = dominantType(trimmed);
    const loadedOfType = type ? store.loadedByType[type] ?? 0 : store.graph.order;
    const totalOfType = type ? meta?.counts?.[type] ?? loadedOfType : totals().total;
    emit("layer", type, loadedOfType, totalOfType);
  }

  function scheduleNext(): void {
    if (cancelled || exhausted || floorReached || budgetUsed >= budget) {
      idle();
      return;
    }
    // La pestaña oculta no encadena: se retoma al volver (o al pulsar un control).
    if (documentHidden()) {
      idle();
      return;
    }
    clearIdle();
    idleHandle = schedule(() => {
      idleHandle = null;
      void pump();
    });
  }

  async function pump(): Promise<void> {
    if (pumping || cancelled) return;
    pumping = true;
    try {
      await pullBatch();
    } catch (err) {
      if (!cancelled) opts.onError?.(err);
      pumping = false;
      idle();
      return;
    }
    pumping = false;
    scheduleNext();
  }

  /** Retoma la carga tras un control del usuario (más presupuesto, otra fecha…). */
  async function resume(): Promise<void> {
    if (cancelled || exhausted || floorReached || budgetUsed >= budget) {
      idle();
      return;
    }
    await pump();
  }

  const loader: GraphLoader = {
    get meta() {
      return meta;
    },
    get budgetUsed() {
      return budgetUsed;
    },
    get budgetMax() {
      return budget;
    },

    async start(signal) {
      if (signal) {
        externalSignal = signal;
        onExternalAbort = () => loader.cancel();
        if (signal.aborted) {
          loader.cancel();
          return;
        }
        signal.addEventListener("abort", onExternalAbort);
      }
      emit("skeleton", undefined, 0, 0);
      let payload: DecodedPayload;
      try {
        payload = await api.getSkeleton(controller.signal);
      } catch (err) {
        if (!cancelled) opts.onError?.(err);
        return;
      }
      if (cancelled) return;
      meta = payload.meta ?? null;
      const result = store.applyPayload(payload);
      // Pintar YA: el esqueleto no espera a ninguna tanda.
      opts.onPatch?.({ nodesAdded: result.nodesAdded, edgesAdded: result.edgesAdded });
      const { loaded, total } = totals();
      emit("skeleton", undefined, loaded, total);
      scheduleNext();
    },

    async loadMoreOlder(n = DEFAULT_BATCH) {
      budget += n;
      floorReached = false;
      await resume();
    },

    async setDateFloor(tsMs) {
      dateFloor = tsMs;
      floorReached = false;
      await resume();
    },

    setTypes(next) {
      const allowed = next.filter((type) => (SECONDARY_NODE_TYPES as readonly string[]).includes(type));
      types = allowed.length ? allowed : [...SECONDARY_NODE_TYPES];
      cursor = null;
      exhausted = false;
      floorReached = false;
    },

    async loadNeighbors(id, depth = 1) {
      if (cancelled) return;
      emit("neighbors", undefined, store.graph.order, totals().total);
      try {
        const payload = await api.getNeighbors(id, { depth, limit: 300 }, controller.signal);
        if (cancelled) return;
        const result = store.applyPayload(payload);
        budgetUsed += result.nodesAdded;
        opts.onPatch?.({ nodesAdded: result.nodesAdded, edgesAdded: result.edgesAdded });
      } catch (err) {
        if (!cancelled) opts.onError?.(err);
      }
      idle();
    },

    async search(q) {
      if (cancelled) return [];
      try {
        return await api.searchNodes(q, { limit: 50 }, controller.signal);
      } catch (err) {
        if (!cancelled) opts.onError?.(err);
        return [];
      }
    },

    cancel() {
      if (cancelled) return;
      cancelled = true;
      clearIdle();
      controller.abort();
      if (externalSignal && onExternalAbort) externalSignal.removeEventListener("abort", onExternalAbort);
    },
  };

  return loader;
}
