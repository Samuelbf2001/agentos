/**
 * Lienzo del grafo: un único `<canvas>` DPR-aware — no un SVG con un elemento
 * por nodo/arista — para que 300 nodos no exploten el DOM ni la RAM del
 * navegador. Pan (arrastrar el fondo), zoom (rueda, centrado en el cursor) y
 * arrastre de nodos — a mano, sin librerías, como el original de WhatsAppHub
 * (`grafo.jsx`). Dibuja sobre las posiciones que calcula `useGraphSim`.
 *
 * Todo lo que cambia en cada tick de física (transform de pan/zoom, hover,
 * posiciones) vive en `useRef`, nunca en `useState`: un tick de la simulación
 * solo repinta el canvas de forma imperativa (`scheduleDraw`, coalescido en
 * un único `requestAnimationFrame` pendiente), jamás dispara un render de
 * React. Lo único que llega a estado/props del padre es la selección (lo que
 * enseña el panel).
 */
import { useCallback, useEffect, useMemo, useRef } from "react";
import { type GraphEdge, type GraphNode } from "../../../lib/brain/grafo";
import { styleForType } from "./palette";
import { useGraphSim, type GraphSimHandle, type SimNodeState } from "./useGraphSim";

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

const DEFAULT_WIDTH = 900;
const DEFAULT_HEIGHT = 600;
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 4;
const TOP_DEGREE_LABELS = 12;
const LABEL_CAP = 40;
/** Tolerancia de hit-test en píxeles de pantalla, constante pese al zoom. */
const HIT_PAD_PX = 4;
/** Margen de culling fuera del viewport, en píxeles de pantalla. */
const CULL_MARGIN_PX = 60;
/** Presupuesto corto de ticks al soltar un nodo arrastrado: reacomoda sin reiniciar la animación entera. */
const DRAG_REHEAT_TICKS = 40;
/** Umbral de movimiento (px de pantalla) para distinguir click de arrastre. */
const CLICK_MOVE_THRESHOLD_PX = 3;

function truncateLabel(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function radiusForDegree(degree: number): number {
  const r = 5 + Math.sqrt(degree) * 3;
  return Math.max(5, Math.min(14, r));
}

/** Nodo más cercano a (worldX,worldY) dentro de su radio + tolerancia; escaneo lineal, n≤300. */
function findNearestNode(
  nodes: GraphNode[],
  getPosition: (id: string) => SimNodeState | null,
  degreeById: Map<string, number>,
  worldX: number,
  worldY: number,
  hitPadWorld: number,
): string | null {
  let bestId: string | null = null;
  let bestDist = Infinity;
  for (const node of nodes) {
    const pos = getPosition(node.id);
    if (!pos) continue;
    const dist = Math.hypot(pos.x - worldX, pos.y - worldY);
    const r = radiusForDegree(degreeById.get(node.id) ?? 0) + hitPadWorld;
    if (dist <= r && dist < bestDist) {
      bestDist = dist;
      bestId = node.id;
    }
  }
  return bestId;
}

interface CanvasColors {
  ink: string;
  surface: string;
  line: string;
  link: string;
}

const FALLBACK_COLORS: CanvasColors = { ink: "#111318", surface: "#ffffff", line: "#d8dbe6", link: "#2563eb" };

function readColors(): CanvasColors {
  if (typeof getComputedStyle === "undefined") return FALLBACK_COLORS;
  const styles = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback;
  return {
    ink: read("--color-ink", FALLBACK_COLORS.ink),
    surface: read("--color-surface", FALLBACK_COLORS.surface),
    line: read("--color-line", FALLBACK_COLORS.line),
    link: read("--color-link", FALLBACK_COLORS.link),
  };
}

type DragState =
  | { type: "pan"; startX: number; startY: number; origX: number; origY: number; moved: boolean }
  | { type: "node"; id: string; startX: number; startY: number; origX: number; origY: number; moved: boolean };

export function GraphCanvas({ nodes, edges, degreeById, selectedId, searchMatches, onSelect, onReady }: GraphCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);

  // Tamaño (px CSS) y transform (pan/zoom): en refs a propósito — cambiarlos
  // nunca dispara un render de React, solo un repintado imperativo.
  const sizeRef = useRef({ width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT });
  const transformRef = useRef<Transform>({ x: 0, y: 0, k: 1 });
  const hoverIdRef = useRef<string | null>(null);
  const colorsRef = useRef<CanvasColors>(FALLBACK_COLORS);

  // Última foto de las props: `draw()` (invocado desde rAF) siempre lee el
  // dato vigente sin que haga falta recrearlo en cada render.
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  const degreeByIdRef = useRef(degreeById);
  const selectedIdRef = useRef(selectedId);
  const searchMatchesRef = useRef(searchMatches);
  nodesRef.current = nodes;
  edgesRef.current = edges;
  degreeByIdRef.current = degreeById;
  selectedIdRef.current = selectedId;
  searchMatchesRef.current = searchMatches;

  const topDegreeRef = useRef<Set<string>>(new Set());
  topDegreeRef.current = useMemo(
    () =>
      new Set(
        [...nodes]
          .sort((a, b) => (degreeById.get(b.id) ?? 0) - (degreeById.get(a.id) ?? 0))
          .slice(0, TOP_DEGREE_LABELS)
          .map((node) => node.id),
      ),
    [nodes, degreeById],
  );

  const dragRef = useRef<DragState | null>(null);
  const rafRef = useRef<number | null>(null);
  const drawRef = useRef<() => void>(() => {});

  const scheduleDraw = useCallback(() => {
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      drawRef.current();
    });
  }, []);

  const sim: GraphSimHandle = useGraphSim({
    width: sizeRef.current.width,
    height: sizeRef.current.height,
    onTick: scheduleDraw,
  });

  // Reasignado en cada render para que siempre vea las refs/props actuales,
  // pero la función en sí nunca causa un render: solo pinta píxeles.
  drawRef.current = () => {
    const ctx = ctxRef.current;
    if (!ctx) return; // jsdom (tests) no implementa canvas 2d: no truena, no dibuja.
    const { width, height } = sizeRef.current;
    const dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
    const t = transformRef.current;
    const colors = colorsRef.current;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, width * dpr, height * dpr);
    ctx.setTransform(t.k * dpr, 0, 0, t.k * dpr, t.x * dpr, t.y * dpr);

    const margin = CULL_MARGIN_PX / t.k;
    const minX = -t.x / t.k - margin;
    const minY = -t.y / t.k - margin;
    const maxX = (width - t.x) / t.k + margin;
    const maxY = (height - t.y) / t.k + margin;
    const inView = (x: number, y: number) => x >= minX && x <= maxX && y >= minY && y <= maxY;

    const currentNodes = nodesRef.current;
    const currentEdges = edgesRef.current;
    const degrees = degreeByIdRef.current;
    const selected = selectedIdRef.current;
    const hovered = hoverIdRef.current;
    const matches = searchMatchesRef.current;
    const visibleIds = new Set(currentNodes.map((node) => node.id));

    // ── Aristas: agrupadas en dos trazos (atenuado / normal) en vez de uno por arista. ──
    const dimmedPath = new Path2D();
    const normalPath = new Path2D();
    let hasDimmed = false;
    let hasNormal = false;
    for (const edge of currentEdges) {
      if (!visibleIds.has(edge.source) || !visibleIds.has(edge.target)) continue;
      const a = sim.getPosition(edge.source);
      const b = sim.getPosition(edge.target);
      if (!a || !b) continue;
      if (!inView(a.x, a.y) && !inView(b.x, b.y)) continue;
      const dimmed = matches.size > 0 && !(matches.has(edge.source) && matches.has(edge.target));
      const path = dimmed ? dimmedPath : normalPath;
      path.moveTo(a.x, a.y);
      path.lineTo(b.x, b.y);
      if (dimmed) hasDimmed = true;
      else hasNormal = true;
    }
    ctx.lineWidth = 1 / t.k;
    ctx.strokeStyle = colors.line;
    if (hasNormal) {
      ctx.globalAlpha = 0.45;
      ctx.stroke(normalPath);
    }
    if (hasDimmed) {
      ctx.globalAlpha = 0.1;
      ctx.stroke(dimmedPath);
    }
    ctx.globalAlpha = 1;

    // ── Nodos: un Path2D por color de tipo (arcos en lote); las coincidencias
    // de búsqueda se sacan del lote y se pintan aparte, a color pleno. ──
    const searching = matches.size > 0;
    const groups = new Map<string, Path2D>();
    const groupOrder: string[] = [];
    const highlighted: GraphNode[] = [];
    for (const node of currentNodes) {
      const pos = sim.getPosition(node.id);
      if (!pos || !inView(pos.x, pos.y)) continue;
      if (searching && matches.has(node.id)) {
        highlighted.push(node);
        continue;
      }
      const color = styleForType(node.type).color;
      let path = groups.get(color);
      if (!path) {
        path = new Path2D();
        groups.set(color, path);
        groupOrder.push(color);
      }
      const r = radiusForDegree(degrees.get(node.id) ?? 0);
      path.moveTo(pos.x + r, pos.y);
      path.arc(pos.x, pos.y, r, 0, Math.PI * 2);
    }
    ctx.globalAlpha = searching ? 0.25 : 1;
    for (const color of groupOrder) {
      const path = groups.get(color);
      if (!path) continue;
      ctx.fillStyle = color;
      ctx.fill(path);
      ctx.lineWidth = 1.5 / t.k;
      ctx.strokeStyle = colors.surface;
      ctx.stroke(path);
    }
    ctx.globalAlpha = 1;
    for (const node of highlighted) {
      const pos = sim.getPosition(node.id);
      if (!pos) continue;
      const r = radiusForDegree(degrees.get(node.id) ?? 0);
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
      ctx.fillStyle = styleForType(node.type).color;
      ctx.fill();
      ctx.lineWidth = 1.5 / t.k;
      ctx.strokeStyle = colors.surface;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, r + 5, 0, Math.PI * 2);
      ctx.lineWidth = 2 / t.k;
      ctx.strokeStyle = colors.link;
      ctx.globalAlpha = 0.8;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // Anillo de selección / hover, por encima de todo lo anterior.
    for (const id of new Set([hovered, selected])) {
      if (!id) continue;
      const pos = sim.getPosition(id);
      if (!pos) continue;
      const r = radiusForDegree(degrees.get(id) ?? 0);
      const isSelected = id === selected;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, r + (isSelected ? 3 : 5), 0, Math.PI * 2);
      ctx.lineWidth = (isSelected ? 1.5 : 2) / t.k;
      ctx.strokeStyle = isSelected ? colors.ink : colors.link;
      ctx.globalAlpha = isSelected ? 0.6 : 0.8;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // ── Etiquetas: prioridad (seleccionado, hover, búsqueda, top por grado),
    // tope ~40, colisión voraz — la seleccionada y la de hover siempre se
    // dibujan; el resto se descarta si su rectángulo en pantalla se cruza
    // con uno ya dibujado. ──
    const labelOrder: string[] = [];
    const queuedIds = new Set<string>();
    const queueLabel = (id: string | null) => {
      if (!id || queuedIds.has(id)) return;
      queuedIds.add(id);
      labelOrder.push(id);
    };
    queueLabel(selected);
    queueLabel(hovered);
    for (const id of matches) {
      if (labelOrder.length >= LABEL_CAP) break;
      queueLabel(id);
    }
    if (t.k > 0.8) {
      for (const id of topDegreeRef.current) {
        if (labelOrder.length >= LABEL_CAP) break;
        queueLabel(id);
      }
    }
    if (labelOrder.length > 0) {
      const nodeById = new Map(currentNodes.map((node) => [node.id, node] as const));
      const fontSize = 11;
      ctx.font = `${fontSize}px system-ui, sans-serif`;
      ctx.lineWidth = 3 / t.k;
      ctx.strokeStyle = colors.surface;
      ctx.fillStyle = colors.ink;
      const drawnRects: Array<{ minX: number; minY: number; maxX: number; maxY: number }> = [];
      const overlaps = (rect: { minX: number; minY: number; maxX: number; maxY: number }) =>
        drawnRects.some((d) => rect.minX < d.maxX && rect.maxX > d.minX && rect.minY < d.maxY && rect.maxY > d.minY);
      for (const id of labelOrder) {
        const node = nodeById.get(id);
        if (!node) continue;
        const pos = sim.getPosition(id);
        if (!pos || !inView(pos.x, pos.y)) continue;
        const r = radiusForDegree(degrees.get(id) ?? 0);
        const label = truncateLabel(node.label, 28);
        const textX = pos.x + r + 4;
        const textY = pos.y + 4;
        const width = ctx.measureText(label).width;
        const rect = { minX: textX, minY: textY - fontSize, maxX: textX + width, maxY: textY + 3 };
        const alwaysDraw = id === selected || id === hovered;
        if (!alwaysDraw && overlaps(rect)) continue;
        ctx.strokeText(label, textX, textY);
        ctx.fillText(label, textX, textY);
        drawnRects.push(rect);
      }
    }
  };

  const updateCursor = useCallback((hovering: boolean, dragging: "pan" | "node" | null) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.style.cursor = dragging ? "grabbing" : hovering ? "pointer" : "grab";
  }, []);

  const applySize = useCallback((width: number, height: number) => {
    sizeRef.current = { width, height };
    sim.setSize(width, height);
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Montaje: contexto 2d, colores resueltos, tamaño inicial y el ResizeObserver
  // que llena el alto disponible del Card. El observer SOLO actualiza sizeRef
  // y repinta — nunca reinicia la simulación (eso solo pasa si cambian datos).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas) ctxRef.current = canvas.getContext("2d");
    colorsRef.current = readColors();
    updateCursor(false, null);

    const container = containerRef.current;
    if (container) {
      const rect = container.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) applySize(Math.round(rect.width), Math.round(rect.height));
    }
    scheduleDraw();

    if (typeof ResizeObserver === "undefined" || !container) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width <= 0 || height <= 0) continue;
        const next = { width: Math.round(width), height: Math.round(height) };
        if (next.width === sizeRef.current.width && next.height === sizeRef.current.height) continue;
        applySize(next.width, next.height);
        scheduleDraw();
      }
    });
    observer.observe(container);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Solo cambios de datos reinician la simulación; el resize NO (antes lo hacía).
  useEffect(() => {
    sim.setData(nodes, edges);
    sim.reheat();
    scheduleDraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges]);

  // Selección/búsqueda/grado no tocan la simulación, pero sí lo que se ve.
  useEffect(() => {
    scheduleDraw();
  }, [selectedId, searchMatches, degreeById, scheduleDraw]);

  // Wheel a mano: React marca "wheel" pasivo por defecto y `preventDefault`
  // dentro de un handler pasivo no hace nada (la página haría scroll al zoom).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const t = transformRef.current;
      const factor = e.deltaY > 0 ? 1 / 1.1 : 1.1;
      const k = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, t.k * factor));
      // Zoom hacia el cursor: mantiene el punto bajo el mouse fijo.
      const wx = (mx - t.x) / t.k;
      const wy = (my - t.y) / t.k;
      transformRef.current = { k, x: mx - wx * k, y: my - wy * k };
      scheduleDraw();
    };
    canvas.addEventListener("wheel", handleWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", handleWheel);
  }, [scheduleDraw]);

  // Cleanup total al desmontar: sin esto, un rAF de dibujo puede quedar vivo
  // más allá del ciclo de vida del componente (useGraphSim ya para su propio
  // runner, pero el rAF coalescido de `scheduleDraw` es independiente de él).
  useEffect(
    () => () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      sim.stop();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const resetView = useCallback(() => {
    transformRef.current = { x: 0, y: 0, k: 1 };
    scheduleDraw();
  }, [scheduleDraw]);

  const focusOn = useCallback(
    (id: string) => {
      const pos = sim.getPosition(id);
      if (!pos) return;
      const t = transformRef.current;
      const { width, height } = sizeRef.current;
      transformRef.current = { ...t, x: width / 2 - pos.x * t.k, y: height / 2 - pos.y * t.k };
      scheduleDraw();
    },
    [sim, scheduleDraw],
  );

  useEffect(() => {
    onReady?.({ resetView, focusOn });
  }, [onReady, resetView, focusOn]);

  const toWorld = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    const rect = canvas ? canvas.getBoundingClientRect() : { left: 0, top: 0 };
    const t = transformRef.current;
    return { x: (clientX - rect.left - t.x) / t.k, y: (clientY - rect.top - t.y) / t.k };
  }, []);

  const hitTestAt = useCallback(
    (clientX: number, clientY: number) => {
      const world = toWorld(clientX, clientY);
      const hitPadWorld = HIT_PAD_PX / transformRef.current.k;
      return findNearestNode(nodesRef.current, sim.getPosition, degreeByIdRef.current, world.x, world.y, hitPadWorld);
    },
    [sim, toWorld],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const hitId = hitTestAt(e.clientX, e.clientY);
      if (hitId) {
        const pos = sim.getPosition(hitId);
        if (pos) {
          dragRef.current = { type: "node", id: hitId, startX: e.clientX, startY: e.clientY, origX: pos.x, origY: pos.y, moved: false };
          sim.setFixed(hitId, pos.x, pos.y);
          sim.reheat(DRAG_REHEAT_TICKS);
        }
      } else {
        const t = transformRef.current;
        dragRef.current = { type: "pan", startX: e.clientX, startY: e.clientY, origX: t.x, origY: t.y, moved: false };
      }
      updateCursor(Boolean(hitId), hitId ? "node" : "pan");
      (e.currentTarget as unknown as { setPointerCapture?: (id: number) => void }).setPointerCapture?.(e.pointerId);
    },
    [hitTestAt, sim, updateCursor],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const drag = dragRef.current;
      if (!drag) {
        const hitId = hitTestAt(e.clientX, e.clientY);
        if (hitId !== hoverIdRef.current) {
          hoverIdRef.current = hitId;
          updateCursor(Boolean(hitId), null);
          scheduleDraw();
        }
        return;
      }
      const dxScreen = e.clientX - drag.startX;
      const dyScreen = e.clientY - drag.startY;
      if (Math.abs(dxScreen) > CLICK_MOVE_THRESHOLD_PX || Math.abs(dyScreen) > CLICK_MOVE_THRESHOLD_PX) drag.moved = true;
      if (drag.type === "pan") {
        transformRef.current = { ...transformRef.current, x: drag.origX + dxScreen, y: drag.origY + dyScreen };
      } else {
        const k = transformRef.current.k;
        sim.setFixed(drag.id, drag.origX + dxScreen / k, drag.origY + dyScreen / k);
      }
      scheduleDraw();
    },
    [hitTestAt, scheduleDraw, sim, updateCursor],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const drag = dragRef.current;
      dragRef.current = null;
      if (drag?.type === "node") {
        sim.releaseFixed(drag.id);
        sim.reheat(DRAG_REHEAT_TICKS);
        if (!drag.moved) onSelect(drag.id);
      }
      const hitId = hitTestAt(e.clientX, e.clientY);
      hoverIdRef.current = hitId;
      updateCursor(Boolean(hitId), null);
      scheduleDraw();
    },
    [hitTestAt, onSelect, scheduleDraw, sim, updateCursor],
  );

  const cancelInteraction = useCallback(() => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (drag?.type === "node") {
      sim.releaseFixed(drag.id);
      sim.reheat(DRAG_REHEAT_TICKS);
    }
    hoverIdRef.current = null;
    updateCursor(false, null);
    scheduleDraw();
  }, [scheduleDraw, sim, updateCursor]);

  return (
    <div ref={containerRef} className="relative h-full w-full">
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={`Grafo de conocimiento: ${nodes.length} nodos, ${edges.length} conexiones`}
        className="h-full w-full touch-none select-none outline-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={cancelInteraction}
        onPointerLeave={cancelInteraction}
      />
    </div>
  );
}

export default GraphCanvas;
