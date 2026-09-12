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
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: GraphStats;
}

export interface GetGraphParams {
  limitPerType?: number;
  since?: string;
  includeIsolated?: boolean;
  /** `${tipo}:${id}` de un nodo ya cargado. */
  focus?: string;
  depth?: 1 | 2;
}

const EMPTY_STATS: GraphStats = { nodeCount: 0, edgeCount: 0, byType: {}, truncated: false };

export async function getGraph(params: GetGraphParams = {}): Promise<Graph> {
  const search = new URLSearchParams();
  if (params.limitPerType) search.set("limitPerType", String(params.limitPerType));
  if (params.since) search.set("since", params.since);
  if (params.includeIsolated) search.set("includeIsolated", "true");
  if (params.focus) {
    search.set("focus", params.focus);
    search.set("depth", String(params.depth ?? 1));
  }
  const qs = search.toString();
  const data = await apiRequest<Partial<Graph>>(`/api/brain/grafo${qs ? `?${qs}` : ""}`);
  return {
    nodes: Array.isArray(data.nodes) ? data.nodes : [],
    edges: Array.isArray(data.edges) ? data.edges : [],
    stats: data.stats ?? EMPTY_STATS,
  };
}
