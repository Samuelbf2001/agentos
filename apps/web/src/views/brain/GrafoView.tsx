/**
 * 2brain › Grafo: contactos, empresas, equipo, reuniones, notas, notas de voz,
 * páginas y temas conectados. Port a TS del lienzo SVG de WhatsAppHub
 * (`web/src/pages/grafo/grafo.jsx`): pan/zoom/drag a mano, filtros por tipo,
 * foco por profundidad y búsqueda — sin librerías de grafos.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "../../lib/api";
import { getGraph, type Graph, type GraphNodeType } from "../../lib/brain/grafo";
import { Card, SectionHead } from "../../components/system";
import { EmptyState, ErrorBox, Spinner } from "../../components/ui";
import { GraphCanvas, type GraphCanvasHandle } from "./grafo/GraphCanvas";
import { Legend } from "./grafo/Legend";
import { NodePanel } from "./grafo/NodePanel";

const LIMIT_OPTIONS = [50, 120, 200];
const DEFAULT_SINCE = "2026-06-01";

const EMPTY_GRAPH: Graph = { nodes: [], edges: [], stats: { nodeCount: 0, edgeCount: 0, byType: {}, truncated: false } };

interface FocusParams {
  focus: string;
  depth: 1 | 2;
}

export default function GrafoView() {
  const [graph, setGraph] = useState<Graph>(EMPTY_GRAPH);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [maxNodes, setMaxNodes] = useState(120);
  const [since, setSince] = useState(DEFAULT_SINCE);
  const [includeIsolated, setIncludeIsolated] = useState(false);
  const [hiddenTypes, setHiddenTypes] = useState<Set<GraphNodeType>>(() => new Set());
  const [search, setSearch] = useState("");
  const [focusParams, setFocusParams] = useState<FocusParams | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const canvasHandleRef = useRef<GraphCanvasHandle | null>(null);
  const onCanvasReady = useCallback((handle: GraphCanvasHandle) => {
    canvasHandleRef.current = handle;
  }, []);

  // "Refrescar" no repite la lógica de carga: solo cambia esta llave para que
  // el efecto de abajo vuelva a disparar con los mismos filtros.
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await getGraph({
          limitPerType: 150,
          maxNodes,
          maxEdges: maxNodes * 2,
          since: since || DEFAULT_SINCE,
          includeIsolated,
          ...(focusParams ? { focus: focusParams.focus, depth: focusParams.depth } : {}),
        }, controller.signal);
        if (!cancelled && !controller.signal.aborted) setGraph(data);
      } catch (err) {
        if (!cancelled) setError(controller.signal.aborted ? "La carga tardó demasiado. Intenta refrescar." : err instanceof ApiError ? err.message : "No se pudo cargar el grafo.");
      } finally {
        clearTimeout(timeout);
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      clearTimeout(timeout);
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [maxNodes, since, includeIsolated, focusParams, reloadKey]);

  // ── Filtrado en cliente por tipo oculto ─────────────────────────────────
  const visibleNodes = useMemo(() => graph.nodes.filter((n) => !hiddenTypes.has(n.type)), [graph.nodes, hiddenTypes]);
  const visibleNodeIds = useMemo(() => new Set(visibleNodes.map((n) => n.id)), [visibleNodes]);
  const visibleEdges = useMemo(
    () => graph.edges.filter((e) => visibleNodeIds.has(e.source) && visibleNodeIds.has(e.target)),
    [graph.edges, visibleNodeIds],
  );

  const degreeById = useMemo(() => {
    const map = new Map<string, number>();
    for (const e of visibleEdges) {
      map.set(e.source, (map.get(e.source) ?? 0) + 1);
      map.set(e.target, (map.get(e.target) ?? 0) + 1);
    }
    return map;
  }, [visibleEdges]);

  const nodesById = useMemo(() => {
    const map = new Map(graph.nodes.map((n) => [n.id, n] as const));
    return map;
  }, [graph.nodes]);

  // ── Búsqueda: resalta y centra el primer resultado ──────────────────────
  const searchMatches = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return new Set<string>();
    return new Set(visibleNodes.filter((n) => n.label.toLowerCase().includes(q)).map((n) => n.id));
  }, [search, visibleNodes]);

  // Solo centra cuando cambia el TEXTO de búsqueda, no en cada recarga del
  // grafo (que produce un `searchMatches` nuevo con los mismos ids y volvería
  // a centrar la vista sin que el usuario haya tocado el buscador).
  const searchMatchesRef = useRef(searchMatches);
  searchMatchesRef.current = searchMatches;
  useEffect(() => {
    const matches = searchMatchesRef.current;
    if (matches.size === 0) return;
    const [firstId] = matches;
    if (firstId) canvasHandleRef.current?.focusOn(firstId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  // Aviso discreto de recorte: usa `stats.total` si el servidor lo informa
  // (N de M); si no, cae a solo N cuando `stats.truncated` viene en true.
  const truncationNotice = useMemo(() => {
    const { nodeCount, total, truncated } = graph.stats;
    if (typeof total === "number" && total > nodeCount) return `Mostrando ${nodeCount} de ${total} nodos principales`;
    if (truncated) return `Mostrando ${nodeCount} nodos principales`;
    return null;
  }, [graph.stats]);

  const toggleType = useCallback((type: GraphNodeType) => {
    setHiddenTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }, []);

  const selectedNode = selectedId ? nodesById.get(selectedId) ?? null : null;

  const handleEnfocarAqui = useCallback(() => {
    if (!selectedId) return;
    setHiddenTypes(new Set());
    setFocusParams({ focus: selectedId, depth: 1 });
  }, [selectedId]);

  const clearFocus = useCallback(() => setFocusParams(null), []);
  const closePanel = useCallback(() => setSelectedId(null), []);

  return (
    <div className="mx-auto max-w-[1180px] px-4 pb-20 pt-6 sm:px-5">
      <h1 className="text-display text-ink">Grafo</h1>
      <p className="mt-1.5 max-w-[60ch] text-body text-muted">
        Contactos, empresas, equipo, reuniones, notas, notas de voz, páginas y temas: cómo se conectan entre sí.
      </p>

      <Card className="mt-6 flex flex-col gap-3 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar en esta vista…"
            aria-label="Buscar en esta vista"
            className="min-h-9 w-56 rounded-tight border border-line bg-canvas px-3 text-small text-ink placeholder:text-faint focus:border-link focus:outline-none"
          />
          <select
            value={maxNodes}
            onChange={(e) => setMaxNodes(Number(e.target.value))}
            aria-label="Máximo de nodos visibles"
            className="min-h-9 rounded-tight border border-line bg-canvas px-2.5 text-small text-ink focus:border-link focus:outline-none"
          >
            {LIMIT_OPTIONS.map((opt) => (
              <option key={opt} value={opt}>
                Hasta {opt} nodos
              </option>
            ))}
          </select>
          <label className="flex items-center gap-1.5 text-label text-muted">
            <span>Desde</span>
            <input
              type="date"
              value={since}
              onChange={(e) => setSince(e.target.value || DEFAULT_SINCE)}
              className="min-h-9 rounded-tight border border-line bg-canvas px-2.5 text-small text-ink focus:border-link focus:outline-none"
            />
          </label>
          <label className="flex items-center gap-1.5 text-label text-muted select-none">
            <input type="checkbox" checked={includeIsolated} onChange={(e) => setIncludeIsolated(e.target.checked)} />
            <span>Mostrar nodos sueltos</span>
          </label>
          <button
            type="button"
            onClick={() => canvasHandleRef.current?.resetView()}
            className="press min-h-9 rounded-tight border border-line px-3 text-small font-semibold text-ink-2 hover:bg-surface-2"
          >
            Reencuadrar
          </button>
          {focusParams ? (
            <button
              type="button"
              onClick={clearFocus}
              className="press min-h-9 rounded-tight border border-link px-3 text-small font-semibold text-link hover:bg-link-bg"
            >
              Quitar foco
            </button>
          ) : null}
          <button
            type="button"
            onClick={reload}
            disabled={loading}
            className="press min-h-9 rounded-tight border border-line px-3 text-small font-semibold text-ink-2 hover:bg-surface-2 disabled:opacity-60"
          >
            {loading ? "Actualizando…" : "Refrescar"}
          </button>
          <div className="ml-auto flex items-center gap-2 text-label text-muted">
            <span>
              {graph.stats.nodeCount} nodos · {graph.stats.edgeCount} aristas
            </span>
            {truncationNotice ? <span className="font-semibold text-work">{truncationNotice}</span> : null}
          </div>
        </div>

        <Legend counts={graph.stats.byType} hidden={hiddenTypes} onToggle={toggleType} />
      </Card>

      {error ? (
        <div className="mt-4">
          <ErrorBox message={error} onRetry={reload} />
        </div>
      ) : null}

      <SectionHead label="Lienzo" />

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[1fr_320px]">
        <Card className="h-[calc(100vh-22rem)] min-h-[420px] overflow-hidden lg:h-[calc(100vh-23.5rem)]">
          {loading && graph.nodes.length === 0 ? (
            <div className="flex h-full items-center justify-center">
              <Spinner label="Cargando el grafo…" />
            </div>
          ) : graph.nodes.length === 0 ? (
            <div className="flex h-full items-center justify-center p-8">
              <EmptyState title="Todavía no hay datos para graficar" hint="Ajusta los filtros o vuelve más tarde." />
            </div>
          ) : (
            <GraphCanvas
              nodes={visibleNodes}
              edges={visibleEdges}
              degreeById={degreeById}
              selectedId={selectedId}
              searchMatches={searchMatches}
              onSelect={setSelectedId}
              onReady={onCanvasReady}
            />
          )}
        </Card>

        <Card className="min-h-[200px] p-4">
          <NodePanel
            node={selectedNode}
            degree={selectedId ? degreeById.get(selectedId) ?? 0 : 0}
            hasFocus={Boolean(focusParams)}
            onClose={closePanel}
            onFocus={handleEnfocarAqui}
            onClearFocus={clearFocus}
          />
        </Card>
      </div>
    </div>
  );
}
