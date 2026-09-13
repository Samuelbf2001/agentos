/**
 * Física del lienzo del grafo (Coulomb + resorte + centro + damping) fuera de
 * React: las posiciones viven en un `Map` mutado en el sitio y el motor de
 * animación (`createLayoutRunner`, en `graphLayout.ts`) corre sobre
 * `requestAnimationFrame` con tope de ticks/tiempo. `onTick` es la única
 * salida hacia el componente — en `GraphCanvas` es `scheduleDraw`, nunca un
 * `setState`, así un tick de física jamás dispara un render de React.
 * `setSize` actualiza el tamaño del lienzo por fuera de props/estado: lo
 * llama el `ResizeObserver` de `GraphCanvas` directamente, sin recrear la
 * simulación.
 */
import { useCallback, useEffect, useRef } from "react";
import { HARD_MAX_NODES, HARD_MAX_EDGES } from "../../../lib/brain/grafo";
import { createLayoutRunner, stepLayout } from "./graphLayout";

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

export interface UseGraphSimOptions {
  width?: number;
  height?: number;
  onTick?: (nodes: Map<string, SimNodeState>) => void;
}

export interface GraphSimHandle {
  setData: (nodes: SimInputNode[], edges: SimInputEdge[]) => void;
  start: () => void;
  stop: () => void;
  /** Reactiva la simulación; sin argumento usa el presupuesto completo (ver `createLayoutRunner`). */
  reheat: (budgetTicks?: number) => void;
  getPosition: (id: string) => SimNodeState | null;
  setFixed: (id: string, x: number, y: number) => void;
  releaseFixed: (id: string) => void;
  /** Actualiza el tamaño del lienzo sin re-renderizar (lo llama el ResizeObserver de GraphCanvas). */
  setSize: (width: number, height: number) => void;
}

export function useGraphSim({ width = 800, height = 600, onTick }: UseGraphSimOptions = {}): GraphSimHandle {
  const nodesRef = useRef(new Map<string, SimNodeState>());
  const edgesRef = useRef<SimInputEdge[]>([]);
  const sizeRef = useRef({ width, height });
  const onTickRef = useRef(onTick);
  sizeRef.current = { width, height };
  onTickRef.current = onTick;
  const runnerRef = useRef<ReturnType<typeof createLayoutRunner> | null>(null);
  if (!runnerRef.current) {
    runnerRef.current = createLayoutRunner({
      step: (tick) => stepLayout(nodesRef.current, edgesRef.current, sizeRef.current.width, sizeRef.current.height, tick).kinetic,
      draw: () => onTickRef.current?.(nodesRef.current),
      requestFrame: (cb) => requestAnimationFrame(cb),
      cancelFrame: (id) => cancelAnimationFrame(id),
      now: () => performance.now(),
      hidden: () => document.hidden,
    });
  }
  const stop = useCallback(() => runnerRef.current!.stop(), []);
  const reheat = useCallback((budgetTicks?: number) => runnerRef.current!.reheat(budgetTicks), []);
  const setSize = useCallback((w: number, h: number) => {
    sizeRef.current = { width: w, height: h };
  }, []);
  const setData = useCallback(
    (nodeList: SimInputNode[], edgeList: SimInputEdge[]) => {
      stop();
      const { width: w, height: h } = sizeRef.current;
      const next = new Map<string, SimNodeState>();
      const list = (nodeList || []).slice(0, HARD_MAX_NODES);
      for (let i = 0; i < list.length; i++) {
        const node = list[i]!;
        const prev = nodesRef.current.get(node.id);
        const angle = i * 2.399963229728653;
        const radius = Math.sqrt((i + 1) / Math.max(1, list.length)) * Math.min(w, h) * 0.38;
        next.set(
          node.id,
          prev
            ? { ...prev, vx: 0, vy: 0, fixed: false }
            : {
                x: w / 2 + Math.cos(angle) * radius,
                y: h / 2 + Math.sin(angle) * radius,
                vx: 0,
                vy: 0,
                fixed: false,
              },
        );
      }
      nodesRef.current = next;
      edgesRef.current = (edgeList || []).slice(0, HARD_MAX_EDGES);
      onTickRef.current?.(next);
    },
    [stop],
  );
  const getPosition = useCallback((id: string) => nodesRef.current.get(id) || null, []);
  const setFixed = useCallback((id: string, x: number, y: number) => {
    const node = nodesRef.current.get(id);
    if (node) {
      Object.assign(node, { x, y, vx: 0, vy: 0, fixed: true });
      onTickRef.current?.(nodesRef.current);
    }
  }, []);
  const releaseFixed = useCallback((id: string) => {
    const node = nodesRef.current.get(id);
    if (node) node.fixed = false;
  }, []);
  useEffect(() => {
    const visibility = () => runnerRef.current!.visibilityChanged();
    document.addEventListener("visibilitychange", visibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [stop]);
  return { setData, start: reheat, stop, reheat, getPosition, setFixed, releaseFixed, setSize };
}

export default useGraphSim;
