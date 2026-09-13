/**
 * 2brain › Grafo dinámico: el grafo vivo (graphology) al que se le van
 * pegando tandas de nodos sin reiniciar nada.
 *
 * Tres reglas que justifican todo lo demás:
 *  1. Los **stubs** (nodos referidos por una arista pero no entregados) nunca
 *     se insertan como nodos: pintarían bolitas sin datos.
 *  2. Una arista con un extremo ausente se **aparca** en `pendingEdges` bajo
 *     ese id y entra sola cuando llega el nodo — así una capa posterior conecta
 *     con lo ya pintado sin volver a pedir nada.
 *  3. Un nodo nuevo aterriza en el **centroide de sus vecinos ya colocados**
 *     (más un jitter determinista): el layout solo tiene que afinar, no
 *     recolocar el grafo entero.
 *
 * Sin React, sin sigma, sin DOM: se prueba entero en jsdom.
 */
import { MultiGraph } from "graphology";
import type { GraphNodeType } from "./grafo";
import type { DecodedEdge, DecodedPayload } from "./grafoDynamic";

/** Orden fijo de tipos: fija también el anillo de aterrizaje de los huérfanos. */
const TYPE_RING_ORDER = ["contacto", "empresa", "equipo", "reunion", "nota", "nota_voz", "pagina", "tema"];

const JITTER = 12;
const RING_BASE_RADIUS = 140;
const RING_STEP = 85;
/** Ángulo áureo: reparte el anillo sin huecos aunque no sepamos cuántos vienen. */
const GOLDEN_ANGLE = 2.399963229728653;

export interface GraphNodeAttributes {
  label: string;
  type: GraphNodeType;
  ts: number | null;
  deg: number;
  x: number;
  y: number;
  size: number;
}

export interface GraphEdgeAttributes {
  type: string;
  weight: number;
}

export interface ApplyResult {
  nodesAdded: number;
  edgesAdded: number;
  /** Aristas aparcadas en tandas ANTERIORES que entraron en esta. */
  unparked: number;
}

interface ParkedEdge extends DecodedEdge {
  /** Nº de tanda en que se aparcó, para no contar como "unparked" la propia. */
  batch: number;
}

export type GraphologyGraph = MultiGraph<GraphNodeAttributes, GraphEdgeAttributes>;

export interface GraphStore {
  graph: GraphologyGraph;
  indexVersion: string | null;
  pendingEdges: Map<string, ParkedEdge[]>;
  loadedByType: Record<string, number>;
  applyPayload(payload: DecodedPayload, opts?: { stubPolicy?: "park" }): ApplyResult;
  placeNode(id: string): { x: number; y: number };
  setTypeFilter(types: Set<string> | null): void;
  visibleTypes: Set<string> | null;
  typeCounts(): Record<string, number>;
  has(id: string): boolean;
  clear(): void;
}

/** Tamaño por grado (§C.5): crece con la raíz, acotado para no tapar el lienzo. */
export function sizeForDegree(deg: number): number {
  return Math.max(3, Math.min(18, 3 + 1.8 * Math.sqrt(Math.max(0, deg))));
}

/** El tipo viaja en el propio id (`reunion:88`), igual que en el hub. */
export function typeFromId(id: string): string {
  const cut = id.indexOf(":");
  return cut === -1 ? id : id.slice(0, cut);
}

/**
 * Jitter determinista a partir del id: mismo nodo, misma desviación en cada
 * carga — así una recarga no baila y los tests pueden afirmar posiciones.
 */
function hashUnit(id: string, salt: number): number {
  let hash = 2166136261 ^ salt;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 10000) / 10000;
}

export function createGraphStore(): GraphStore {
  const graph: GraphologyGraph = new MultiGraph<GraphNodeAttributes, GraphEdgeAttributes>({
    type: "undirected",
    allowSelfLoops: false,
  });
  const pendingEdges = new Map<string, ParkedEdge[]>();
  const ringCount: Record<string, number> = {};
  let batch = 0;

  const store: GraphStore = {
    graph,
    indexVersion: null,
    pendingEdges,
    loadedByType: {},
    visibleTypes: null,

    placeNode(id) {
      // Vecinos ya colocados: los que asoman en las aristas aparcadas bajo este id.
      let sumX = 0;
      let sumY = 0;
      let found = 0;
      for (const edge of pendingEdges.get(id) ?? []) {
        const other = edge.source === id ? edge.target : edge.source;
        if (!graph.hasNode(other)) continue;
        sumX += graph.getNodeAttribute(other, "x");
        sumY += graph.getNodeAttribute(other, "y");
        found++;
      }
      if (found > 0) {
        return {
          x: sumX / found + (hashUnit(id, 1) * 2 - 1) * JITTER,
          y: sumY / found + (hashUnit(id, 2) * 2 - 1) * JITTER,
        };
      }
      // Sin vecinos conocidos: anillo por tipo a radio fijo.
      const type = typeFromId(id);
      const ringIndex = TYPE_RING_ORDER.indexOf(type);
      const radius = RING_BASE_RADIUS + (ringIndex < 0 ? TYPE_RING_ORDER.length : ringIndex) * RING_STEP;
      const slot = ringCount[type] ?? 0;
      ringCount[type] = slot + 1;
      const angle = slot * GOLDEN_ANGLE;
      return {
        x: Math.cos(angle) * radius + (hashUnit(id, 3) * 2 - 1) * JITTER,
        y: Math.sin(angle) * radius + (hashUnit(id, 4) * 2 - 1) * JITTER,
      };
    },

    applyPayload(payload) {
      batch += 1;
      if (payload.index) store.indexVersion = payload.index;
      let nodesAdded = 0;
      let edgesAdded = 0;
      let unparked = 0;

      const park = (edge: DecodedEdge, missing: string, from = batch): void => {
        const list = pendingEdges.get(missing);
        const parked: ParkedEdge = { ...edge, batch: from };
        if (!list) {
          pendingEdges.set(missing, [parked]);
          return;
        }
        // Una arista con los DOS extremos ausentes se aparca bajo ambos; al
        // llegar el primero se reaparca bajo el segundo. Sin este filtro, la
        // lista del segundo acumularía copias de la misma arista.
        const already = list.some((e) => e.source === edge.source && e.target === edge.target && e.type === edge.type);
        if (!already) list.push(parked);
      };

      const link = (edge: DecodedEdge): boolean => {
        if (edge.source === edge.target) return false;
        const key = `${edge.source}|${edge.target}|${edge.type}`;
        if (graph.hasEdge(key)) return false;
        graph.addEdgeWithKey(key, edge.source, edge.target, { type: edge.type, weight: edge.weight });
        return true;
      };

      // 1) Aristas primero: las que ya se pueden unir se unen; las huérfanas se
      //    aparcan para que `placeNode` sepa dónde aterrizar a sus extremos.
      for (const edge of payload.edges) {
        const hasSource = graph.hasNode(edge.source);
        const hasTarget = graph.hasNode(edge.target);
        if (hasSource && hasTarget) {
          if (link(edge)) edgesAdded++;
          continue;
        }
        if (!hasSource) park(edge, edge.source);
        if (!hasTarget) park(edge, edge.target);
      }

      // 2) Nodos: los stubs NO entran (payload.stubIds se ignora a propósito).
      const arrived: string[] = [];
      for (const node of payload.nodes) {
        if (graph.hasNode(node.id)) {
          // Tanda repetida o ego-red que re-entrega un nodo: solo refresca grado.
          if (node.deg > graph.getNodeAttribute(node.id, "deg")) {
            graph.setNodeAttribute(node.id, "deg", node.deg);
            graph.setNodeAttribute(node.id, "size", sizeForDegree(node.deg));
          }
          continue;
        }
        const { x, y } = store.placeNode(node.id);
        graph.addNode(node.id, {
          label: node.label,
          type: node.type,
          ts: node.ts,
          deg: node.deg,
          size: sizeForDegree(node.deg),
          x,
          y,
        });
        store.loadedByType[node.type] = (store.loadedByType[node.type] ?? 0) + 1;
        nodesAdded++;
        arrived.push(node.id);
      }

      // 3) Desaparcar lo que ya tiene sus dos extremos.
      for (const id of arrived) {
        const waiting = pendingEdges.get(id);
        if (!waiting) continue;
        pendingEdges.delete(id);
        for (const edge of waiting) {
          const other = edge.source === id ? edge.target : edge.source;
          if (!graph.hasNode(other)) {
            park(edge, other, edge.batch); // sigue faltando el otro extremo: se reaparca allí
            continue;
          }
          if (link(edge)) {
            edgesAdded++;
            if (edge.batch < batch) unparked++;
          }
        }
      }

      return { nodesAdded, edgesAdded, unparked };
    },

    setTypeFilter(types) {
      store.visibleTypes = types;
    },

    typeCounts() {
      const counts: Record<string, number> = {};
      graph.forEachNode((_id, attrs) => {
        counts[attrs.type] = (counts[attrs.type] ?? 0) + 1;
      });
      return counts;
    },

    has(id) {
      return graph.hasNode(id);
    },

    clear() {
      graph.clear();
      pendingEdges.clear();
      store.loadedByType = {};
      store.indexVersion = null;
      store.visibleTypes = null;
      for (const key of Object.keys(ringCount)) delete ringCount[key];
      batch = 0;
    },
  };

  return store;
}
