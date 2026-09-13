/**
 * 2brain › Grafo: nivel de detalle (LOD) y resaltado, como funciones PURAS.
 *
 * Todo lo que sigue lo consumen los `nodeReducer`/`edgeReducer` de sigma en
 * cada frame: hover, filtros por tipo, selección y búsqueda NO pasan por
 * `setState` de React — se recalculan aquí y se pintan con
 * `sigma.refresh({ skipIndexation: true })`. Sin este módulo, cada movimiento
 * del ratón sería un render del árbol de React con 1.500 nodos detrás.
 *
 * No importa sigma: solo devuelve objetos planos, así se prueba en jsdom.
 */
import type { GraphNodeType } from "../../../lib/brain/grafo";
import { styleForType } from "./palette";

/** Por encima de este tamaño, y con la cámara lejos, las aristas estorban. */
export const EDGE_HIDE_GRAPH_SIZE = 2500;
export const EDGE_HIDE_CAMERA_RATIO = 1.2;

export interface LodContext {
  /** `null` = todos los tipos visibles. */
  visibleTypes: Set<string> | null;
  /**
   * Los ≈360 nodos de grado 0 forman un anillo exterior que no dice nada y
   * roba la mitad del encuadre. Por defecto `false`: fuera del lienzo, con su
   * casilla en la leyenda. La selección y la búsqueda los traen igualmente.
   */
  showIsolated: boolean;
  /** Nodo bajo el ratón (o `null`): él y sus vecinos quedan en primer plano. */
  hoveredId: string | null;
  /** Vecinos del nodo bajo el ratón, precalculados una vez por hover. */
  hoveredNeighbors: Set<string> | null;
  selectedId: string | null;
  searchHitId: string | null;
  /** `graph.size` (nº de aristas) y zoom actual, para decidir si se ocultan. */
  graphSize: number;
  cameraRatio: number;
}

export interface NodeInput {
  type: GraphNodeType | string;
  size: number;
  label: string;
  /** Grado en el índice COMPLETO del servidor (0 = aislado de verdad). */
  deg?: number;
}

/** A partir de este grado, el nodo es un hub y se dibuja por encima de sus hojas. */
export const HUB_DEGREE = 20;

export interface NodeDisplay {
  color: string;
  size: number;
  label: string | null;
  hidden: boolean;
  forceLabel: boolean;
  zIndex: number;
}

export interface EdgeDisplay {
  hidden: boolean;
  color: string;
  size: number;
}

export const emptyContext = (): LodContext => ({
  visibleTypes: null,
  showIsolated: false,
  hoveredId: null,
  hoveredNeighbors: null,
  selectedId: null,
  searchHitId: null,
  graphSize: 0,
  cameraRatio: 1,
});

export function isTypeVisible(type: string, visibleTypes: Set<string> | null): boolean {
  return visibleTypes === null || visibleTypes.has(type);
}

/** §C.5: aristas fuera cuando el grafo es grande Y la cámara está lejos. */
export function shouldHideEdges(graphSize: number, cameraRatio: number): boolean {
  return graphSize > EDGE_HIDE_GRAPH_SIZE && cameraRatio > EDGE_HIDE_CAMERA_RATIO;
}

/** Atenuado a gris cuando hay un hover y este nodo no está en su vecindad. */
const DIMMED_NODE = "#d3d6df";
const DIMMED_EDGE = "#e6e8ee";
const EDGE_COLOR = "#c9ccd6";
const HIGHLIGHT_EDGE = "#5b6bff";

export function reduceNode(id: string, data: NodeInput, ctx: LodContext): NodeDisplay {
  const isSelected = ctx.selectedId === id;
  const isHit = ctx.searchHitId === id;
  const isHovered = ctx.hoveredId === id;
  const invoked = isSelected || isHit || isHovered;

  if (!isTypeVisible(data.type, ctx.visibleTypes)) {
    return { color: DIMMED_NODE, size: data.size, label: null, hidden: true, forceLabel: false, zIndex: 0 };
  }
  // Aislados fuera salvo que el usuario los pida… o que sean justo el que
  // acaba de buscar o seleccionar: esconder lo que alguien acaba de pedir es
  // peor que el anillo.
  if (data.deg === 0 && !ctx.showIsolated && !invoked) {
    return { color: DIMMED_NODE, size: data.size, label: null, hidden: true, forceLabel: false, zIndex: 0 };
  }

  const inNeighborhood = isHovered || (ctx.hoveredNeighbors?.has(id) ?? false);
  const dimmed = ctx.hoveredId !== null && !inNeighborhood;
  // Los hubs se dibujan DESPUÉS de sus hojas. Sin esto, sigma pinta en orden de
  // llegada: el esqueleto primero y las 390 reuniones encima, de modo que un
  // contacto de grado 229 quedaba sepultado bajo sus propias reuniones.
  const isHub = (data.deg ?? 0) >= HUB_DEGREE;

  return {
    color: dimmed ? DIMMED_NODE : styleForType(data.type as GraphNodeType).color,
    size: isSelected || isHit ? data.size * 1.6 : data.size,
    label: dimmed ? null : data.label,
    hidden: false,
    forceLabel: invoked,
    zIndex: isSelected || isHit ? 4 : inNeighborhood ? 3 : isHub ? 2 : 1,
  };
}

export function reduceEdge(
  _id: string,
  data: { sourceType: string; targetType: string; source: string; target: string },
  ctx: LodContext,
): EdgeDisplay {
  if (shouldHideEdges(ctx.graphSize, ctx.cameraRatio)) {
    return { hidden: true, color: DIMMED_EDGE, size: 1 };
  }
  if (!isTypeVisible(data.sourceType, ctx.visibleTypes) || !isTypeVisible(data.targetType, ctx.visibleTypes)) {
    return { hidden: true, color: DIMMED_EDGE, size: 1 };
  }
  if (ctx.hoveredId === null) return { hidden: false, color: EDGE_COLOR, size: 1 };
  const touchesHover = data.source === ctx.hoveredId || data.target === ctx.hoveredId;
  return touchesHover
    ? { hidden: false, color: HIGHLIGHT_EDGE, size: 1.6 }
    : { hidden: false, color: DIMMED_EDGE, size: 1 };
}
