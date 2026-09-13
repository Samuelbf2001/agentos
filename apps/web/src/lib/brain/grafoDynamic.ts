/**
 * 2brain › Grafo dinámico: cliente del proxy `/api/brain/grafo/*` y decodificador
 * del envoltorio columnar del hub.
 *
 * El servidor manda columnas paralelas (`refs`, `nodes.type[]`, `edges.s[]`…)
 * en vez de objetos: un nodo cuesta ~78 B en vez de ~400 B y el navegador no
 * paga un objeto por nodo antes de tiempo. Aquí se valida que el envoltorio
 * sea coherente (si no, se lanza) y se traduce a la forma mínima que consume
 * `graphStore`. Nada de este módulo toca sigma ni el DOM: es puro y testeable.
 */
import { apiRequest } from "../api";
import type { GraphNodeType } from "./grafo";

/** Tipos que el skeleton entrega completos; los demás llegan por capas. */
export const PRIMARY_NODE_TYPES = ["contacto", "empresa", "equipo", "tema"] as const;
/** Tipos paginados por fecha descendente global. */
export const SECONDARY_NODE_TYPES = ["reunion", "pagina", "nota", "nota_voz"] as const;
export type SecondaryNodeType = (typeof SECONDARY_NODE_TYPES)[number];

/** Nombre legible del tipo para el indicador de carga ("reuniones recientes"). */
export const SECONDARY_TYPE_LABELS: Record<string, string> = {
  reunion: "reuniones recientes",
  pagina: "páginas recientes",
  nota: "notas recientes",
  nota_voz: "notas de voz recientes",
};

export interface GraphRange {
  min: number | null;
  max: number | null;
}

export interface GraphMeta {
  /** Diccionario de códigos → tipo de nodo; viaja en TODAS las respuestas. */
  types: string[];
  /** Diccionario de códigos → tipo de arista. */
  edgeTypes: string[];
  /** Totales del índice completo del servidor, por tipo. */
  counts?: Record<string, number>;
  /** Entregados en esta respuesta, por tipo. */
  loaded?: Record<string, number>;
  /** Rango real (epoch ms) por tipo secundario: alimenta el selector "desde fecha". */
  range?: Record<string, GraphRange>;
  totals?: { nodes: number; edges: number };
}

export interface GraphCursor {
  next: { ts: number | null; id: string } | null;
  remainingByType: Record<string, number>;
  done: boolean;
}

export interface DecodedNode {
  id: string;
  type: GraphNodeType;
  label: string;
  /** Epoch ms o null — el protocolo nunca manda ISO. */
  ts: number | null;
  deg: number;
}

export interface DecodedEdge {
  source: string;
  target: string;
  type: string;
  weight: number;
}

export interface DecodedPayload {
  index: string;
  nodes: DecodedNode[];
  /** Ids referidos por aristas pero NO entregados: jamás se insertan como nodos. */
  stubIds: string[];
  edges: DecodedEdge[];
  meta?: GraphMeta;
  cursor?: GraphCursor;
}

export interface SearchHit {
  id: string;
  type: string;
  label: string;
  ts: number | null;
}

/** Error de contrato: el envoltorio columnar no se decodifica solo. */
export class GraphPayloadError extends Error {
  constructor(detail: string) {
    super(`Envoltorio de grafo incoherente: ${detail}`);
    this.name = "GraphPayloadError";
  }
}

function column(raw: unknown, key: string, length: number, kind: "number" | "string" | "ts"): unknown[] {
  if (!Array.isArray(raw) || raw.length !== length) throw new GraphPayloadError(`columna ${key} descuadrada`);
  for (const item of raw) {
    if (kind === "number" && (typeof item !== "number" || !Number.isFinite(item))) {
      throw new GraphPayloadError(`columna ${key} con un valor no numérico`);
    }
    if (kind === "string" && typeof item !== "string") throw new GraphPayloadError(`columna ${key} con un valor no textual`);
    if (kind === "ts" && item !== null && (typeof item !== "number" || !Number.isFinite(item))) {
      throw new GraphPayloadError(`columna ${key} debe ser epoch ms o null`);
    }
  }
  return raw as unknown[];
}

/**
 * Decodifica el envoltorio columnar. Lanza `GraphPayloadError` si algo no
 * cuadra: mejor un error claro que un grafo silenciosamente mutilado.
 */
export function decodePayload(raw: unknown): DecodedPayload {
  const payload = raw as Record<string, unknown> | null;
  if (!payload || typeof payload !== "object") throw new GraphPayloadError("respuesta vacía");
  if (typeof payload.index !== "string") throw new GraphPayloadError("falta index");

  const refs = payload.refs;
  if (!Array.isArray(refs) || refs.some((ref) => typeof ref !== "string")) throw new GraphPayloadError("refs inválido");
  const refIds = refs as string[];

  const nodesCol = (payload.nodes ?? {}) as Record<string, unknown>;
  const stubsCol = (payload.stubs ?? {}) as Record<string, unknown>;
  const edgesCol = (payload.edges ?? {}) as Record<string, unknown>;
  const nodeCount = nodesCol.count;
  const stubCount = stubsCol.count;
  const edgeCount = edgesCol.count;
  if (typeof nodeCount !== "number" || typeof stubCount !== "number" || typeof edgeCount !== "number") {
    throw new GraphPayloadError("falta algún count");
  }
  if (refIds.length !== nodeCount + stubCount) {
    throw new GraphPayloadError("refs.length no cuadra con nodes.count + stubs.count");
  }

  const meta = payload.meta as GraphMeta | undefined;
  const typeDict = meta?.types;
  const edgeTypeDict = meta?.edgeTypes;
  if (!Array.isArray(typeDict) || !Array.isArray(edgeTypeDict)) {
    throw new GraphPayloadError("meta.types y meta.edgeTypes son obligatorios en cada respuesta");
  }

  const nodeType = column(nodesCol.type, "nodes.type", nodeCount, "number") as number[];
  const nodeLabel = column(nodesCol.label, "nodes.label", nodeCount, "string") as string[];
  const nodeTs = column(nodesCol.ts, "nodes.ts", nodeCount, "ts") as Array<number | null>;
  const nodeDeg = column(nodesCol.deg, "nodes.deg", nodeCount, "number") as number[];
  column(stubsCol.type, "stubs.type", stubCount, "number");
  column(stubsCol.label, "stubs.label", stubCount, "string");
  column(stubsCol.ts, "stubs.ts", stubCount, "ts");
  const edgeS = column(edgesCol.s, "edges.s", edgeCount, "number") as number[];
  const edgeT = column(edgesCol.t, "edges.t", edgeCount, "number") as number[];
  const edgeType = column(edgesCol.type, "edges.type", edgeCount, "number") as number[];
  const edgeW = column(edgesCol.w, "edges.w", edgeCount, "number") as number[];

  const nodes: DecodedNode[] = new Array(nodeCount);
  for (let i = 0; i < nodeCount; i++) {
    const type = typeDict[nodeType[i]!];
    if (type === undefined) throw new GraphPayloadError(`código de tipo ${nodeType[i]} fuera del diccionario`);
    nodes[i] = { id: refIds[i]!, type: type as GraphNodeType, label: nodeLabel[i]!, ts: nodeTs[i]!, deg: nodeDeg[i]! };
  }

  const edges: DecodedEdge[] = new Array(edgeCount);
  for (let i = 0; i < edgeCount; i++) {
    const s = edgeS[i]!;
    const t = edgeT[i]!;
    if (!Number.isInteger(s) || !Number.isInteger(t) || s < 0 || t < 0 || s >= refIds.length || t >= refIds.length) {
      throw new GraphPayloadError("edges.s/t fuera del rango de refs");
    }
    const type = edgeTypeDict[edgeType[i]!];
    if (type === undefined) throw new GraphPayloadError(`código de arista ${edgeType[i]} fuera del diccionario`);
    edges[i] = { source: refIds[s]!, target: refIds[t]!, type, weight: edgeW[i]! };
  }

  return {
    index: payload.index,
    nodes,
    stubIds: refIds.slice(nodeCount),
    edges,
    meta,
    cursor: payload.cursor as GraphCursor | undefined,
  };
}

// ── Cliente HTTP ────────────────────────────────────────────────────────────

export interface LayerParams {
  types?: readonly string[];
  before?: number | null;
  beforeId?: string | null;
  limit?: number;
}

export interface GraphApi {
  getSkeleton(signal?: AbortSignal): Promise<DecodedPayload>;
  getLayer(params: LayerParams, signal?: AbortSignal): Promise<DecodedPayload>;
  getNeighbors(id: string, params?: { depth?: 1 | 2; limit?: number }, signal?: AbortSignal): Promise<DecodedPayload>;
  searchNodes(q: string, params?: { limit?: number }, signal?: AbortSignal): Promise<SearchHit[]>;
}

function qs(entries: Record<string, string | number | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(entries)) {
    if (value === undefined || value === null || value === "") continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

/** Implementación real contra el proxy de AgentOS. */
export function createGraphApi(locationId?: string): GraphApi {
  return {
    async getSkeleton(signal) {
      return decodePayload(await apiRequest(`/api/brain/grafo/skeleton${qs({ locationId })}`, { signal }));
    },
    async getLayer(params, signal) {
      const path = `/api/brain/grafo/layer${qs({
        locationId,
        types: params.types?.length ? params.types.join(",") : undefined,
        before: params.before ?? undefined,
        beforeId: params.beforeId ?? undefined,
        limit: params.limit,
      })}`;
      return decodePayload(await apiRequest(path, { signal }));
    },
    async getNeighbors(id, params, signal) {
      const path = `/api/brain/grafo/neighbors/${encodeURIComponent(id)}${qs({
        locationId,
        depth: params?.depth,
        limit: params?.limit,
      })}`;
      return decodePayload(await apiRequest(path, { signal }));
    },
    async searchNodes(q, params, signal) {
      const raw = await apiRequest<{ results?: SearchHit[] }>(
        `/api/brain/grafo/search${qs({ locationId, q, limit: params?.limit })}`,
        { signal },
      );
      return Array.isArray(raw?.results) ? raw.results : [];
    },
  };
}
