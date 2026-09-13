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

/**
 * Sigma detecta el nodo bajo el cursor leyendo un píxel del framebuffer de
 * picking (`readPixels`, lectura síncrona GPU→CPU que espera al render entero)
 * en CADA mousemove, también arrastrando: con 1.500 nodos eso deja el pan/zoom
 * por debajo de 15 FPS. Con la cámara en movimiento no se lee nada y, quieta,
 * como mucho una lectura por este intervalo.
 */
const PICK_INTERVAL_MS = 80;

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
  getCamera(): {
    ratio: number;
    isAnimated(): boolean;
    animatedReset(): Promise<void>;
    animate(state: Record<string, number>, opts?: Record<string, unknown>): Promise<void>;
  };
  getMouseCaptor(): { isMoving: boolean; currentWheelDirection: number };
  getNodeAtPosition(position: { x: number; y: number }): string | null;
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
    let unbindPick: (() => void) | null = null;
    const ctx: LodContext = emptyContext();

    // Un repintado con `skipIndexation` sigue pasando por todos los reducers y
    // por `process()` (sigma 3.0.3 lo marca igual), ~50 ms con 1.500 nodos: se
    // coalescen a uno por frame para que barrer el ratón por un racimo denso
    // (enter/leave en cadena) no encadene repintados síncronos.
    let paintFrame: number | null = null;
    const paint = (skipIndexation = true): void => {
      if (!sigma) return;
      ctx.graphSize = store.graph.size;
      ctx.cameraRatio = sigma.getCamera().ratio;
      if (!skipIndexation) {
        if (paintFrame !== null) {
          cancelAnimationFrame(paintFrame);
          paintFrame = null;
        }
        sigma.refresh({ skipIndexation: false });
        return;
      }
      if (paintFrame !== null) return;
      paintFrame = requestAnimationFrame(() => {
        paintFrame = null;
        if (!sigma) return;
        sigma.refresh({ skipIndexation: true });
      });
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
    // `booting` cierra la carrera entre el arranque directo y el primer aviso
    // del ResizeObserver: los dos pasaban el guard antes de que resolviera el
    // `import` y nacían DOS motores (14 canvases) con dos layouts, uno huérfano.
    let booting = false;
    const boot = async (): Promise<void> => {
      if (disposed || sigma || booting) return;
      const { width, height } = container.getBoundingClientRect();
      if (width < 2 || height < 2) return;
      booting = true;
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
          // En sigma v3 lo que devuelve el reducer SUSTITUYE a los atributos del
          // nodo/arista (x, y incluidos): hay que fusionar sobre `data`, si no
          // sigma aborta con "could not find a valid position (x, y)". Y el
          // atributo `type` es para sigma el PROGRAMA de render (circle, line…),
          // no nuestro tipo de dominio (tema, contacto, tagged…): se retira para
          // que use el programa por defecto.
          nodeReducer: (node: string, data: { type: string; size: number; label: string }) => {
            const { type: _domainType, ...rest } = data;
            return { ...rest, ...reduceNode(node, data, ctx) };
          },
          edgeReducer: (edge: string, data: { type: string; weight: number }) => {
            const [source, target] = store.graph.extremities(edge);
            const { type: _domainType, ...rest } = data;
            return {
              ...rest,
              ...reduceEdge(edge, {
                ...data,
                source: source!,
                target: target!,
                sourceType: store.graph.getNodeAttribute(source!, "type"),
                targetType: store.graph.getNodeAttribute(target!, "type"),
              }, ctx),
            };
          },
        });

        const pickOriginal = sigma.getNodeAtPosition.bind(sigma);
        let pickAt = 0;
        let pickX = Number.NaN;
        let pickY = Number.NaN;
        let pickResult: string | null = null;
        sigma.getNodeAtPosition = (position) => {
          if (!sigma) return null;
          const captor = sigma.getMouseCaptor();
          if (captor.isMoving || captor.currentWheelDirection !== 0 || sigma.getCamera().isAnimated()) {
            return ctx.hoveredId; // sin lecturas de GPU mientras la cámara se mueve
          }
          const now = performance.now();
          const samePoint = Math.abs(position.x - pickX) < 1 && Math.abs(position.y - pickY) < 1;
          if (samePoint || now - pickAt < PICK_INTERVAL_MS) return pickResult;
          pickAt = now;
          pickX = position.x;
          pickY = position.y;
          pickResult = pickOriginal(position);
          return pickResult;
        };
        // Un clic siempre resuelve con una lectura fresca, nunca con la caché.
        const resetPick = (): void => {
          pickAt = 0;
          pickX = Number.NaN;
          pickY = Number.NaN;
        };
        container.addEventListener("mousedown", resetPick, true);
        unbindPick = () => container.removeEventListener("mousedown", resetPick, true);

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
      } catch (err) {
        console.error("[grafo] el motor no arrancó", err);
        if (!disposed) onUnavailableRef.current?.();
      } finally {
        booting = false;
      }
    };

    void boot();
    // El contenedor puede nacer sin medidas (pestaña oculta, layout diferido).
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(() => void boot()) : null;
    observer?.observe(container);

    return () => {
      disposed = true;
      observer?.disconnect();
      unbindPick?.();
      unbindPick = null;
      if (paintFrame !== null) {
        cancelAnimationFrame(paintFrame);
        paintFrame = null;
      }
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
