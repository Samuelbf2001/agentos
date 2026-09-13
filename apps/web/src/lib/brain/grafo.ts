/**
 * 2brain › Grafo: cliente del proxy `/api/brain/grafo` (que a su vez lee el
 * "Grafo de conocimiento" de WhatsAppHub). Tipos y forma exactamente iguales
 * a la whitelist que valida `apps/api/src/routes/brain/grafo.ts`.
 */
import { apiRequest } from "../api";

export const GRAPH_NODE_TYPES = [
  "contacto",
  "empresa",
  "equipo",
  "reunion",
  "nota",
  "nota_voz",
  "pagina",
  "tema",
] as const;

export type GraphNodeType = (typeof GRAPH_NODE_TYPES)[number];

/** Solo los campos que el panel de nodo enseña; varían según `type`. */
export interface GraphNodeMeta {
  phone?: string | null;
  email?: string | null;
  leadStatus?: string | null;
  msgInCount?: number | null;
  lastMessageAt?: string | null;
  domain?: string | null;
  industry?: string | null;
  role?: string | null;
  source?: string | null;
  meetingDate?: string | null;
  isInternal?: boolean | null;
  participantsCount?: number | null;
  kind?: string | null;
  tags?: string[] | null;
  createdAt?: string | null;
  category?: string | null;
  createdBy?: string | null;
  pageType?: string | null;
}

export interface GraphNode {
  id: string;
  type: GraphNodeType;
  label: string;
  /** Id "crudo" en su tabla de origen (número, slug o tag); no siempre presente. */
  refId?: string | number;
  meta: GraphNodeMeta;
}

export interface GraphEdge {
  source: string;
  target: string;
  type?: string;
  weight?: number;
}

export interface GraphStats {
  nodeCount: number;
  edgeCount: number;
  byType: Record<string, number>;
  truncated: boolean;
  /** Total de nodos disponibles en el servidor, si lo informa (aviso "N de M" en la vista). */
  total?: number;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: GraphStats;
}

export interface GetGraphParams {
  maxNodes?: number;
  maxEdges?: number;
  limitPerType?: number;
  since?: string;
  includeIsolated?: boolean;
  /** `${tipo}:${id}` de un nodo ya cargado. */
  focus?: string;
  depth?: 1 | 2;
}

export async function getGraph(params: GetGraphParams = {}, signal?: AbortSignal): Promise<Graph> {
  const search = new URLSearchParams();
  search.set("maxNodes", String(params.maxNodes ?? DEFAULT_MAX_NODES));
  search.set("maxEdges", String(params.maxEdges ?? (params.maxNodes ?? DEFAULT_MAX_NODES) * 2));
  if (params.limitPerType) search.set("limitPerType", String(params.limitPerType));
  if (params.since) search.set("since", params.since);
  if (params.includeIsolated) search.set("includeIsolated", "true");
  if (params.focus) {
    search.set("focus", params.focus);
    search.set("depth", String(params.depth ?? 1));
  }
  const qs = search.toString();
  const data = await apiRequest<Partial<Graph>>(`/api/brain/grafo${qs ? `?${qs}` : ""}`, { signal });
  return boundGraph(data, params);
}

export const DEFAULT_MAX_NODES = 120;
export const HARD_MAX_NODES = 300;
export const HARD_MAX_EDGES = 600;

// Acota los datos retenidos incluso contra un servidor viejo; nunca ordena el payload completo.
export function boundGraph(data: Partial<Graph> | null, { maxNodes = DEFAULT_MAX_NODES, maxEdges = maxNodes * 2, focus }: GetGraphParams = {}): Graph {
  const nodeLimit = Math.max(1, Math.min(HARD_MAX_NODES, Number(maxNodes) || DEFAULT_MAX_NODES));
  const edgeLimit = Math.max(0, Math.min(HARD_MAX_EDGES, Number(maxEdges) || 0));
  const sourceNodes = Array.isArray(data?.nodes) ? data.nodes : [];
  const sourceEdges = Array.isArray(data?.edges) ? data.edges : [];
  const nodes: GraphNode[] = [];
  const ids = new Set<string>();
  const add = (node: GraphNode | undefined) => {
    if (!node || typeof node.id !== "string" || ids.has(node.id)) return;
    ids.add(node.id);
    nodes.push(node);
  };
  if (focus) add(sourceNodes.find((node) => node?.id === focus));
  for (const node of sourceNodes) {
    if (nodes.length >= nodeLimit) break;
    add(node);
  }
  const edges: GraphEdge[] = [];
  for (const edge of sourceEdges) {
    if (edges.length >= edgeLimit) break;
    if (edge && ids.has(edge.source) && ids.has(edge.target) && edge.source !== edge.target) edges.push(edge);
  }
  const byType: Record<string, number> = {};
  for (const node of nodes) byType[node.type] = (byType[node.type] || 0) + 1;
  return {
    nodes,
    edges,
    stats: {
      ...data?.stats,
      nodeCount: nodes.length,
      edgeCount: edges.length,
      byType,
      // El hub informa el total de candidatos como `totalNodes`.
      total: data?.stats?.total ?? (data?.stats as { totalNodes?: number } | undefined)?.totalNodes,
      truncated: Boolean(data?.stats?.truncated || nodes.length < sourceNodes.length || edges.length < sourceEdges.length),
    },
  };
}
