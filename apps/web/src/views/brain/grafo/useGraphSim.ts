/**
 * Simulación force-layout en 2D, sin dependencias externas (Coulomb + resorte
 * + centro + damping). Port literal a TS de `WhatsAppHub/web/src/pages/grafo/useGraphSim.js`:
 * misma física, mismos umbrales, mismo auto-stop por energía.
 *
 * Mantiene el estado (posiciones/velocidades) en refs para no re-renderizar en
 * cada tick; el consumidor decide cuándo leer las posiciones (típicamente en
 * `onTick`, disparando un re-render propio). Se auto-detiene cuando la energía
 * cinética cae por debajo de un umbral, y puede reactivarse (`reheat`) al
 * cambiar datos/filtros o al arrastrar un nodo.
 */
import { useCallback, useEffect, useRef } from "react";

const REPULSION = 2600;
const SPRING_LENGTH = 90;
const SPRING_STRENGTH = 0.02;
const CENTER_STRENGTH = 0.004;
const DAMPING = 0.85;
const KINETIC_THRESHOLD = 0.02;
const LARGE_GRAPH_THRESHOLD = 400;
const MAX_DELTA = 1.6;

export interface SimInputNode {
  id: string;
}

export interface SimInputEdge {
  source: string;
  target: string;
  weight?: number;
}

export interface SimNodeState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  fixed: boolean;
}

interface SimEdgeState {
  source: string;
  target: string;
  weight: number;
}

export interface UseGraphSimOptions {
  width?: number;
  height?: number;
  onTick?: (nodes: Map<string, SimNodeState>) => void;
}

export interface GraphSimHandle {
  setData: (nodes: SimInputNode[], edges: SimInputEdge[]) => void;
  start: () => void;
  stop: () => void;
  /** Reactiva la simulación (tras cambiar datos/filtros o iniciar un drag). */
  reheat: () => void;
  getPosition: (id: string) => SimNodeState | null;
  setFixed: (id: string, x: number, y: number) => void;
  releaseFixed: (id: string) => void;
}

export function useGraphSim({ width = 800, height = 600, onTick }: UseGraphSimOptions = {}): GraphSimHandle {
  const nodesRef = useRef<Map<string, SimNodeState>>(new Map());
  const edgesRef = useRef<SimEdgeState[]>([]);
  const rafRef = useRef<number | null>(null);
  const runningRef = useRef(false);
  const frameParityRef = useRef(0);
  const sizeRef = useRef({ width, height });
  const onTickRef = useRef(onTick);

  useEffect(() => {
    onTickRef.current = onTick;
  }, [onTick]);
  useEffect(() => {
    sizeRef.current = { width, height };
  }, [width, height]);

  const stop = useCallback(() => {
    runningRef.current = false;
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  const tick = useCallback(() => {
    const nodes = nodesRef.current;
    const edges = edgesRef.current;
    const { width: w, height: h } = sizeRef.current;
    const cx = w / 2;
    const cy = h / 2;
    const entries = Array.from(nodes.entries());
    const n = entries.length;

    if (n === 0) {
      runningRef.current = false;
      rafRef.current = null;
      return;
    }

    // Con muchos nodos, aplica la repulsión O(n²) solo cada dos frames para aliviar CPU.
    const applyRepulsion = !(n > LARGE_GRAPH_THRESHOLD && frameParityRef.current % 2 === 1);
    frameParityRef.current++;

    if (applyRepulsion) {
      for (let i = 0; i < n; i++) {
        const [, a] = entries[i]!;
        for (let j = i + 1; j < n; j++) {
          const [, b] = entries[j]!;
          let dx = a.x - b.x;
          let dy = a.y - b.y;
          let distSq = dx * dx + dy * dy;
          if (distSq < 0.01) {
            dx = (Math.random() - 0.5) * 0.1;
            dy = (Math.random() - 0.5) * 0.1;
            distSq = 0.01;
          }
          const dist = Math.sqrt(distSq);
          const force = REPULSION / distSq;
          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;
          if (!a.fixed) {
            a.vx += fx;
            a.vy += fy;
          }
          if (!b.fixed) {
            b.vx -= fx;
            b.vy -= fy;
          }
        }
      }
    }

    // Atracción tipo resorte por arista
    for (const edge of edges) {
      const a = nodes.get(edge.source);
      const b = nodes.get(edge.target);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const displacement = dist - SPRING_LENGTH;
      const strength = SPRING_STRENGTH * edge.weight;
      const fx = (dx / dist) * displacement * strength;
      const fy = (dy / dist) * displacement * strength;
      if (!a.fixed) {
        a.vx += fx;
        a.vy += fy;
      }
      if (!b.fixed) {
        b.vx -= fx;
        b.vy -= fy;
      }
    }

    // Fuerza suave hacia el centro + damping + integración
    let kinetic = 0;
    for (const [, node] of entries) {
      if (!node.fixed) {
        node.vx += (cx - node.x) * CENTER_STRENGTH;
        node.vy += (cy - node.y) * CENTER_STRENGTH;
        node.vx *= DAMPING;
        node.vy *= DAMPING;
        node.vx = Math.max(-MAX_DELTA * 10, Math.min(MAX_DELTA * 10, node.vx));
        node.vy = Math.max(-MAX_DELTA * 10, Math.min(MAX_DELTA * 10, node.vy));
        node.x += node.vx;
        node.y += node.vy;
        kinetic += node.vx * node.vx + node.vy * node.vy;
      }
    }

    onTickRef.current?.(nodes);

    if (kinetic / n < KINETIC_THRESHOLD) {
      runningRef.current = false;
      rafRef.current = null;
      return;
    }
    rafRef.current = requestAnimationFrame(tick);
  }, []);

  const start = useCallback(() => {
    if (runningRef.current) return;
    runningRef.current = true;
    rafRef.current = requestAnimationFrame(tick);
  }, [tick]);

  /**
   * Reinicializa (o fusiona) el conjunto de nodos/aristas de la simulación.
   * Los nodos ya existentes conservan posición/velocidad (para no "saltar" al
   * refiltrar); los nuevos se colocan cerca del centro con jitter aleatorio.
   */
  const setData = useCallback((nodeList: SimInputNode[], edgeList: SimInputEdge[]) => {
    const { width: w, height: h } = sizeRef.current;
    const cx = w / 2;
    const cy = h / 2;
    const next = new Map<string, SimNodeState>();
    for (const node of nodeList) {
      const prev = nodesRef.current.get(node.id);
      if (prev) {
        next.set(node.id, prev);
      } else {
        const angle = Math.random() * Math.PI * 2;
        const radius = 40 + Math.random() * 120;
        next.set(node.id, {
          x: cx + Math.cos(angle) * radius,
          y: cy + Math.sin(angle) * radius,
          vx: 0,
          vy: 0,
          fixed: false,
        });
      }
    }
    nodesRef.current = next;
    edgesRef.current = edgeList.map((e) => ({ source: e.source, target: e.target, weight: e.weight ?? 1 }));
  }, []);

  const reheat = useCallback(() => {
    for (const [, node] of nodesRef.current) {
      node.vx += (Math.random() - 0.5) * 2;
      node.vy += (Math.random() - 0.5) * 2;
    }
    start();
  }, [start]);

  const getPosition = useCallback((id: string): SimNodeState | null => nodesRef.current.get(id) ?? null, []);

  const setFixed = useCallback((id: string, x: number, y: number) => {
    const node = nodesRef.current.get(id);
    if (!node) return;
    node.x = x;
    node.y = y;
    node.vx = 0;
    node.vy = 0;
    node.fixed = true;
  }, []);

  const releaseFixed = useCallback((id: string) => {
    const node = nodesRef.current.get(id);
    if (node) node.fixed = false;
  }, []);

  useEffect(() => stop, [stop]);

  return { setData, start, stop, reheat, getPosition, setFixed, releaseFixed };
}

export default useGraphSim;
