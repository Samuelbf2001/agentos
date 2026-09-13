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
 *  3. Un nodo nuevo aterriza **alrededor** del centroide de sus vecinos ya
 *     colocados, en una espiral de Fermat (ángulo áureo, radio ∝ √n): el
 *     layout solo tiene que afinar, no recolocar el grafo entero.
 *  4. Un nodo YA cargado nunca cambia de tipo ni de etiqueta por una respuesta
 *     posterior — solo su propia ego-red (`neighbors/:id`) puede refrescarlo.
 *     Los stubs jamás se insertan: solo existen para casar aristas aparcadas.
 *
 * Sin React, sin sigma, sin DOM: se prueba entero en jsdom.
 */
import { MultiGraph } from "graphology";
import type { GraphNodeType } from "./grafo";
import type { DecodedEdge, DecodedPayload } from "./grafoDynamic";

/** Orden fijo de tipos: fija también el anillo de aterrizaje de los huérfanos. */
const TYPE_RING_ORDER = ["contacto", "empresa", "equipo", "reunion", "nota", "nota_voz", "pagina", "tema"];

const JITTER = 12;
/**
 * Los huérfanos (sin ningún vecino ya colocado) aterrizan en una BANDA por
 * tipo. Antes era una circunferencia exacta por tipo y a radios muy grandes:
 * los 319 temas nacían todos a 735 unidades del centro, en fila, y ForceAtlas2
 * no conseguía traerlos en 8 s — quedaban de aro decorativo alrededor del
 * grafo. Ahora cada tipo ocupa un DISCO (radio ∝ √n desde su base) y las bases
 * están cerca unas de otras: el layout solo tiene que expandir, no rescatar.
 */
const RING_BASE_RADIUS = 40;
const RING_STEP = 25;
/** Ángulo áureo: reparte el anillo sin huecos aunque no sepamos cuántos vienen. */
const GOLDEN_ANGLE = 2.399963229728653;
/**
 * Separación entre hermanos que aterrizan sobre el MISMO centroide. Un hub de
 * grado 229 traía 229 hojas al centroide exacto del hub: con un jitter de ±12
 * quedaban todas dentro de la misma bolita y TAPABAN al hub (el contacto se
 * veía del color de sus reuniones y "desaparecía" al ocultar Reunión). Con
 * radio ∝ √n la corona reparte a los hermanos a esta distancia media unos de
 * otros, y ForceAtlas2 solo tiene que afinarla.
 */
const SIBLING_SPREAD = 14;
/** Precisión de la celda que identifica un centroide compartido (unidades de mundo). */
const CENTROID_CELL = 8;

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
  /**
   * Nodos ya cargados que llegaban con OTRO tipo o etiqueta y se ignoraron
   * (regla 4). Debería ser siempre 0 contra el servidor real: si sube, el
   * índice del hub cambió a media carga o alguien mezcló diccionarios.
   */
  conflictsIgnored: number;
}

export interface ApplyOptions {
  /**
   * Id del nodo cuya ego-red es este payload (`neighbors/:id`). Es la ÚNICA
   * respuesta autorizada a refrescar el tipo y la etiqueta de ese nodo.
   */
  egoOf?: string;
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
  applyPayload(payload: DecodedPayload, opts?: ApplyOptions): ApplyResult;
  placeNode(id: string): { x: number; y: number };
  setTypeFilter(types: Set<string> | null): void;
  visibleTypes: Set<string> | null;
  typeCounts(): Record<string, number>;
  /** Nodos sin ninguna conexión en el índice del servidor (el anillo de fuera). */
  isolatedCount(): number;
  has(id: string): boolean;
  clear(): void;
}

export const NODE_SIZE_MIN = 2;
export const NODE_SIZE_MAX = 11;

/**
 * Tamaño por grado (§C.5): crece con la raíz y queda acotado en [2, 11] px de
 * sigma. El techo anterior (18) hacía que los dos hubs del grafo real (grado
 * 229 y 100) ocuparan medio lienzo; con este reparto el salto del percentil 50
 * (grado 1) al máximo son 8 px, suficiente para leer la jerarquía sin tapar.
 */
export function sizeForDegree(deg: number): number {
  return Math.max(NODE_SIZE_MIN, Math.min(NODE_SIZE_MAX, NODE_SIZE_MIN + 0.6 * Math.sqrt(Math.max(0, deg))));
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
  /** Cuántos hermanos han aterrizado ya sobre cada centroide (celda redondeada). */
  const centroidSlots = new Map<string, number>();
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
        // Corona alrededor del centroide, no un punto con jitter: los 229
        // hermanos de un hub caían todos dentro de ±12 y lo sepultaban. La
        // espiral de Fermat (ángulo áureo, radio ∝ √n) los reparte con una
        // separación media constante y sin huecos, sepas o no cuántos vienen.
        const cx = sumX / found;
        const cy = sumY / found;
        const cell = `${Math.round(cx / CENTROID_CELL)}|${Math.round(cy / CENTROID_CELL)}`;
        const slot = centroidSlots.get(cell) ?? 0;
        centroidSlots.set(cell, slot + 1);
        const radius = SIBLING_SPREAD * Math.sqrt(slot + 0.5);
        const angle = slot * GOLDEN_ANGLE;
        return {
          x: cx + Math.cos(angle) * radius + (hashUnit(id, 1) * 2 - 1) * (JITTER / 4),
          y: cy + Math.sin(angle) * radius + (hashUnit(id, 2) * 2 - 1) * (JITTER / 4),
        };
      }
      // Sin vecinos conocidos: disco por tipo, también en espiral de Fermat.
      const type = typeFromId(id);
      const ringIndex = TYPE_RING_ORDER.indexOf(type);
      const base = RING_BASE_RADIUS + (ringIndex < 0 ? TYPE_RING_ORDER.length : ringIndex) * RING_STEP;
      const slot = ringCount[type] ?? 0;
      ringCount[type] = slot + 1;
      const radius = base + SIBLING_SPREAD * Math.sqrt(slot);
      const angle = slot * GOLDEN_ANGLE;
      return {
        x: Math.cos(angle) * radius + (hashUnit(id, 3) * 2 - 1) * JITTER,
        y: Math.sin(angle) * radius + (hashUnit(id, 4) * 2 - 1) * JITTER,
      };
    },

    applyPayload(payload, opts) {
      batch += 1;
      if (payload.index) store.indexVersion = payload.index;
      let nodesAdded = 0;
      let edgesAdded = 0;
      let unparked = 0;
      let conflictsIgnored = 0;

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
          // Regla 4: un nodo ya cargado conserva su tipo y su etiqueta. Solo el
          // payload de su PROPIA ego-red puede refrescarlos; cualquier otra
          // tanda que traiga otro tipo se anota y se descarta (si se aceptara,
          // un contacto acabaría pintado y filtrado como una reunión).
          const mine = opts?.egoOf === node.id;
          const current = graph.getNodeAttributes(node.id);
          if (current.type !== node.type || current.label !== node.label) {
            if (mine) {
              graph.setNodeAttribute(node.id, "type", node.type);
              graph.setNodeAttribute(node.id, "label", node.label);
            } else {
              conflictsIgnored++;
            }
          }
          // El grado sí crece con cualquier respuesta: nadie lo ve a la baja.
          if (node.deg > current.deg) {
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

      return { nodesAdded, edgesAdded, unparked, conflictsIgnored };
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

    isolatedCount() {
      let total = 0;
      graph.forEachNode((_id, attrs) => {
        if (attrs.deg === 0) total++;
      });
      return total;
    },

    has(id) {
      return graph.hasNode(id);
    },

    clear() {
      graph.clear();
      pendingEdges.clear();
      centroidSlots.clear();
      store.loadedByType = {};
      store.indexVersion = null;
      store.visibleTypes = null;
      for (const key of Object.keys(ringCount)) delete ringCount[key];
      batch = 0;
    },
  };

  return store;
}
