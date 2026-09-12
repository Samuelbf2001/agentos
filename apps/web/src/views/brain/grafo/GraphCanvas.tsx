/**
 * Lienzo SVG del grafo: pan (arrastrar el fondo), zoom (rueda, centrado en el
 * cursor) y arrastre de nodos — a mano, sin librerías, como el original de
 * WhatsAppHub (`grafo.jsx`). Dibuja sobre las posiciones que calcula
 * `useGraphSim`, releído en cada tick vía `onTick` (las posiciones viven en
 * refs; solo se re-renderiza para mover los círculos, nunca se recrea la
 * simulación).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type GraphEdge, type GraphNode } from "../../../lib/brain/grafo";
import { styleForType } from "./palette";
import { useGraphSim, type GraphSimHandle } from "./useGraphSim";

export interface Transform {
  x: number;
  y: number;
  k: number;
}

export interface GraphCanvasHandle {
  /** Vuelve a x=0,y=0,k=1 (botón "Reencuadrar"). */
  resetView: () => void;
  /** Centra el nodo en el viewport, sin cambiar el zoom (para la búsqueda). */
  focusOn: (id: string) => void;
}

export interface GraphCanvasProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  degreeById: Map<string, number>;
  selectedId: string | null;
  searchMatches: Set<string>;
  onSelect: (id: string) => void;
  onReady?: (handle: GraphCanvasHandle) => void;
}

function truncateLabel(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function radiusForDegree(degree: number): number {
  const r = 5 + Math.sqrt(degree) * 3;
  return Math.max(5, Math.min(14, r));
}

export function GraphCanvas({ nodes, edges, degreeById, selectedId, searchMatches, onSelect, onReady }: GraphCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [size, setSize] = useState({ width: 900, height: 600 });
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [transform, setTransform] = useState<Transform>({ x: 0, y: 0, k: 1 });
  const transformRef = useRef(transform);
  useEffect(() => {
    transformRef.current = transform;
  }, [transform]);

  const [, forceRedraw] = useState(0);

  const dragRef = useRef<
    | { type: "pan"; startX: number; startY: number; origX: number; origY: number }
    | { type: "node"; id: string; startX: number; startY: number; origX: number; origY: number }
    | null
  >(null);

  const sim: GraphSimHandle = useGraphSim({
    width: size.width,
    height: size.height,
    onTick: () => forceRedraw((t) => t + 1),
  });

  // Tamaño real del contenedor (el lienzo llena el alto disponible del Card).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) setSize({ width, height });
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    sim.setData(nodes, edges);
    sim.reheat();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges, size.width, size.height]);

  const resetView = useCallback(() => setTransform({ x: 0, y: 0, k: 1 }), []);

  const focusOn = useCallback(
    (id: string) => {
      const pos = sim.getPosition(id);
      if (!pos) return;
      setTransform((t) => ({ ...t, x: size.width / 2 - pos.x * t.k, y: size.height / 2 - pos.y * t.k }));
    },
    [sim, size.width, size.height],
  );

  useEffect(() => {
    onReady?.({ resetView, focusOn });
  }, [onReady, resetView, focusOn]);

  const onWheel = useCallback((e: React.WheelEvent<SVGSVGElement>) => {
    e.preventDefault();
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    setTransform((t) => {
      const factor = e.deltaY > 0 ? 0.9 : 1.1;
      const k = Math.max(0.2, Math.min(4, t.k * factor));
      // Zoom hacia el cursor: mantiene el punto bajo el mouse fijo.
      const wx = (mx - t.x) / t.k;
      const wy = (my - t.y) / t.k;
      return { k, x: mx - wx * k, y: my - wy * k };
    });
  }, []);

  const onBackgroundPointerDown = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    if (e.target !== svgRef.current && !(e.target as HTMLElement).dataset?.background) return;
    dragRef.current = {
      type: "pan",
      startX: e.clientX,
      startY: e.clientY,
      origX: transformRef.current.x,
      origY: transformRef.current.y,
    };
    (e.currentTarget as unknown as { setPointerCapture?: (id: number) => void }).setPointerCapture?.(e.pointerId);
  }, []);

  const onNodePointerDown = useCallback(
    (e: React.PointerEvent<SVGGElement>, node: GraphNode) => {
      e.stopPropagation();
      const pos = sim.getPosition(node.id);
      if (!pos) return;
      dragRef.current = { type: "node", id: node.id, startX: e.clientX, startY: e.clientY, origX: pos.x, origY: pos.y };
      sim.setFixed(node.id, pos.x, pos.y);
      sim.reheat();
      (e.currentTarget as unknown as { setPointerCapture?: (id: number) => void }).setPointerCapture?.(e.pointerId);
    },
    [sim],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      const drag = dragRef.current;
      if (!drag) return;
      const t = transformRef.current;
      if (drag.type === "pan") {
        setTransform((cur) => ({ ...cur, x: drag.origX + (e.clientX - drag.startX), y: drag.origY + (e.clientY - drag.startY) }));
      } else {
        const dx = (e.clientX - drag.startX) / t.k;
        const dy = (e.clientY - drag.startY) / t.k;
        sim.setFixed(drag.id, drag.origX + dx, drag.origY + dy);
        forceRedraw((v) => v + 1);
      }
    },
    [sim],
  );

  const onPointerUp = useCallback(() => {
    const drag = dragRef.current;
    if (drag?.type === "node") {
      sim.releaseFixed(drag.id);
      sim.reheat();
    }
    dragRef.current = null;
  }, [sim]);

  const onNodeKeyDown = useCallback(
    (e: React.KeyboardEvent<SVGGElement>, node: GraphNode) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onSelect(node.id);
      }
    },
    [onSelect],
  );

  const showLabelsAlways = transform.k > 0.8;

  const visibleNodeIds = useMemo(() => new Set(nodes.map((n) => n.id)), [nodes]);

  return (
    <div ref={containerRef} className="relative h-full w-full">
      <svg
        ref={svgRef}
        data-background="true"
        width={size.width}
        height={size.height}
        role="presentation"
        className="cursor-grab touch-none select-none active:cursor-grabbing"
        onWheel={onWheel}
        onPointerDown={onBackgroundPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
      >
        <g transform={`translate(${transform.x},${transform.y}) scale(${transform.k})`}>
          {edges.map((edge, i) => {
            if (!visibleNodeIds.has(edge.source) || !visibleNodeIds.has(edge.target)) return null;
            const a = sim.getPosition(edge.source);
            const b = sim.getPosition(edge.target);
            if (!a || !b) return null;
            const dimmed = searchMatches.size > 0 && !(searchMatches.has(edge.source) && searchMatches.has(edge.target));
            return (
              <line
                key={`${edge.source}-${edge.target}-${edge.type ?? ""}-${i}`}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke="var(--color-line)"
                strokeOpacity={dimmed ? 0.08 : Math.max(0.15, Math.min(0.6, (edge.weight ?? 1) * 0.6))}
                strokeWidth={1}
              />
            );
          })}
          {nodes.map((node) => {
            const pos = sim.getPosition(node.id);
            if (!pos) return null;
            const style = styleForType(node.type);
            const degree = degreeById.get(node.id) ?? 0;
            const r = radiusForDegree(degree);
            const isSelected = node.id === selectedId;
            const isHover = node.id === hoverId;
            const isMatch = searchMatches.has(node.id);
            const dimmed = searchMatches.size > 0 && !isMatch;
            const showLabel = showLabelsAlways || isSelected || isHover;
            return (
              <g
                key={node.id}
                role="button"
                tabIndex={0}
                aria-label={`${style.label}: ${node.label}`}
                aria-pressed={isSelected}
                transform={`translate(${pos.x},${pos.y})`}
                onPointerDown={(e) => onNodePointerDown(e, node)}
                onPointerEnter={() => setHoverId(node.id)}
                onPointerLeave={() => setHoverId((cur) => (cur === node.id ? null : cur))}
                onFocus={() => setHoverId(node.id)}
                onBlur={() => setHoverId((cur) => (cur === node.id ? null : cur))}
                onClick={() => onSelect(node.id)}
                onKeyDown={(e) => onNodeKeyDown(e, node)}
                style={{ cursor: "pointer", opacity: dimmed ? 0.25 : 1, outline: "none" }}
              >
                {isMatch ? <circle r={r + 5} fill="none" stroke="var(--color-link)" strokeWidth={2} opacity={0.8} /> : null}
                {isSelected ? <circle r={r + 3} fill="none" stroke="var(--color-ink)" strokeWidth={1.5} opacity={0.6} /> : null}
                <circle r={r} fill={style.color} stroke="var(--color-surface)" strokeWidth={1.5} />
                {showLabel ? (
                  <text
                    x={r + 4}
                    y={4}
                    fontSize={11}
                    fill="var(--color-ink)"
                    style={{ pointerEvents: "none", paintOrder: "stroke", stroke: "var(--color-surface)", strokeWidth: 3 }}
                  >
                    {truncateLabel(node.label, 28)}
                  </text>
                ) : null}
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}

export default GraphCanvas;
