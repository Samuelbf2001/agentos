/**
 * 2brain › Grafo: el lienzo WebGL (sigma v3) sobre el grafo vivo de `graphStore`.
 *
 * Reglas que definen este archivo:
 *  - **Cero `setState` por hover o por tick.** El resaltado, los filtros por
 *    tipo, la selección y el resultado de búsqueda viven en un contexto mutable
 *    que leen los reducers (`./lod`); cada cambio termina en
 *    `sigma.refresh({ skipIndexation: true })`, nunca en un render de React.
 *  - **El motor se carga en diferido** (`await import("sigma")`) y solo cuando
 *    el contenedor tiene tamaño real: en jsdom (tests, smoke de vistas) no hay
 *    WebGL ni medidas, así que sencillamente no se instancia nada y el
 *    componente se queda en su marco vacío sin romper.
 *  - **Al desmontar no queda nada vivo**: layout muerto, sigma muerto,
 *    ResizeObserver desconectado.
 */
import { useEffect, useRef } from "react";
import type { GraphStore } from "../../../lib/brain/graphStore";
import { createLayout, INITIAL_RUN_MS, REHEAT_MS, type GraphLayout } from "./useGraphLayout";
import { emptyContext, reduceEdge, reduceNode, type LodContext } from "./lod";

export interface SigmaCanvasHandle {
  /** Repinta tras una tanda; `reheat` recalienta el layout 1,2 s. */
  refresh(opts?: { skipIndexation?: boolean; reheat?: boolean }): void;
  setHighlight(id: string | null): void;
  setTypeFilter(types: Set<string> | null): void;
  setSearchHit(id: string | null): void;
  setSelected(id: string | null): void;
  /** Centra la cámara en un nodo (búsqueda) o reencuadra si no se pasa id. */
  fit(id?: string): void;
  destroy(): void;
}

export interface SigmaCanvasProps {
  store: GraphStore;
  onSelect: (id: string | null) => void;
  onReady?: (handle: SigmaCanvasHandle) => void;
  /** Aviso para la vista cuando el motor no arranca (sin WebGL, por ejemplo). */
  onEngineUnavailable?: () => void;
  ariaLabel: string;
}

interface SigmaLike {
  refresh(opts?: { skipIndexation?: boolean }): unknown;
  getCamera(): { ratio: number; animatedReset(): Promise<void>; animate(state: Record<string, number>, opts?: Record<string, unknown>): Promise<void> };
  getNodeDisplayData(id: string): { x: number; y: number } | undefined;
  on(event: string, handler: (payload: { node: string }) => void): unknown;
  kill(): void;
}

export function SigmaCanvas({ store, onSelect, onReady, onEngineUnavailable, ariaLabel }: SigmaCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Refs y no estado: nada de lo que hay aquí debe re-renderizar React.
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const onUnavailableRef = useRef(onEngineUnavailable);
  onUnavailableRef.current = onEngineUnavailable;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;
    let sigma: SigmaLike | null = null;
    let layout: GraphLayout | null = null;
    const ctx: LodContext = emptyContext();

    const paint = (skipIndexation = true): void => {
      if (!sigma) return;
      ctx.graphSize = store.graph.size;
      ctx.cameraRatio = sigma.getCamera().ratio;
      sigma.refresh({ skipIndexation });
    };

    const handle: SigmaCanvasHandle = {
      refresh(opts) {
        paint(opts?.skipIndexation ?? false);
        if (opts?.reheat) layout?.start(REHEAT_MS);
      },
      setHighlight(id) {
        ctx.hoveredId = id;
        ctx.hoveredNeighbors = id && store.graph.hasNode(id) ? new Set(store.graph.neighbors(id)) : null;
        paint(true);
      },
      setTypeFilter(types) {
        ctx.visibleTypes = types;
        store.setTypeFilter(types);
        paint(true);
      },
      setSearchHit(id) {
        ctx.searchHitId = id;
        paint(true);
      },
      setSelected(id) {
        ctx.selectedId = id;
        paint(true);
      },
      fit(id) {
        if (!sigma) return;
        if (!id || !store.graph.hasNode(id)) {
          void sigma.getCamera().animatedReset();
          return;
        }
        const position = sigma.getNodeDisplayData(id);
        if (position) void sigma.getCamera().animate({ ...position, ratio: 0.4 }, { duration: 420 });
      },
      destroy() {
        disposed = true;
        layout?.kill();
        layout = null;
        sigma?.kill();
        sigma = null;
      },
    };

    // El motor solo se carga si hay lienzo real: jsdom mide 0×0 y aquí se para.
    const boot = async (): Promise<void> => {
      if (disposed || sigma) return;
      const { width, height } = container.getBoundingClientRect();
      if (width < 2 || height < 2) return;
      try {
        const { default: Sigma } = (await import("sigma")) as unknown as {
          default: new (graph: unknown, container: HTMLElement, settings: Record<string, unknown>) => SigmaLike;
        };
        if (disposed) return;
        sigma = new Sigma(store.graph, container, {
          renderLabels: true,
          labelRenderedSizeThreshold: 10,
          labelDensity: 0.6,
          labelGridCellSize: 80,
          hideLabelsOnMove: true,
          hideEdgesOnMove: true,
          zIndex: true,
          nodeReducer: (node: string, data: { type: string; size: number; label: string }) => reduceNode(node, data, ctx),
          edgeReducer: (edge: string, data: { type: string; weight: number }) => {
            const [source, target] = store.graph.extremities(edge);
            return reduceEdge(edge, {
              ...data,
              source: source!,
              target: target!,
              sourceType: store.graph.getNodeAttribute(source!, "type"),
              targetType: store.graph.getNodeAttribute(target!, "type"),
            }, ctx);
          },
        });

        sigma.on("enterNode", ({ node }) => handle.setHighlight(node));
        sigma.on("leaveNode", () => handle.setHighlight(null));
        sigma.on("clickNode", ({ node }) => {
          ctx.selectedId = node;
          paint(true);
          onSelectRef.current(node); // única subida a estado de React: la selección
        });
        sigma.on("clickStage", () => {
          ctx.selectedId = null;
          paint(true);
          onSelectRef.current(null);
        });

        layout = createLayout(store.graph);
        layout.start(INITIAL_RUN_MS);
        paint(false);
        onReadyRef.current?.(handle);
      } catch {
        if (!disposed) onUnavailableRef.current?.();
      }
    };

    void boot();
    // El contenedor puede nacer sin medidas (pestaña oculta, layout diferido).
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(() => void boot()) : null;
    observer?.observe(container);

    return () => {
      disposed = true;
      observer?.disconnect();
      layout?.kill();
      layout = null;
      sigma?.kill();
      sigma = null;
    };
    // El grafo vive fuera de React: este efecto corre UNA vez por montaje.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store]);

  return <div ref={containerRef} className="h-full w-full" role="img" aria-label={ariaLabel} data-testid="grafo-lienzo" />;
}

export default SigmaCanvas;
