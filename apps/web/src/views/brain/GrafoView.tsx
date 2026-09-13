/**
 * 2brain › Grafo: contactos, empresas, equipo, reuniones, notas, notas de voz,
 * páginas y temas conectados.
 *
 * Carga progresiva, no recorte ciego: primero el esqueleto (todos los
 * primarios y sus aristas) — que se pinta de inmediato —, después tandas de
 * 300 secundarios por fecha descendente en los huecos de CPU, hasta un
 * **presupuesto de confort** que el usuario puede levantar ("cargar más
 * antiguos", "cargar todo"). El tope dejó de ser una política: es una
 * preferencia, y la vista lo dice con todas las letras.
 *
 * Lo que el usuario toca con el ratón (hover, filtros por tipo) no pasa por
 * React: baja al lienzo por `SigmaCanvas` y se resuelve en los reducers. Solo
 * la selección sube a estado, porque abre el panel lateral.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "../../lib/api";
import type { GraphNode, GraphNodeType } from "../../lib/brain/grafo";
import {
  SECONDARY_TYPE_LABELS,
  createGraphApi,
  type GraphMeta,
  type SearchHit,
} from "../../lib/brain/grafoDynamic";
import { createGraphStore } from "../../lib/brain/graphStore";
import { createGraphLoader, type GraphLoader, type LoaderProgress } from "../../lib/brain/graphLoader";
import { Card, SectionHead } from "../../components/system";
import { EmptyState, ErrorBox, Spinner } from "../../components/ui";
import { SigmaCanvas, type SigmaCanvasHandle } from "./grafo/SigmaCanvas";
import { NODE_TYPE_ORDER } from "./grafo/palette";
import { Legend } from "./grafo/Legend";
import { NodePanel } from "./grafo/NodePanel";

const numberFormat = new Intl.NumberFormat("es-CO");

/** Rango global (epoch ms) de los tipos secundarios, para el selector de fecha. */
function globalRange(meta: GraphMeta | null): { min: number | null; max: number | null } {
  let min: number | null = null;
  let max: number | null = null;
  for (const range of Object.values(meta?.range ?? {})) {
    if (range.min != null) min = min === null ? range.min : Math.min(min, range.min);
    if (range.max != null) max = max === null ? range.max : Math.max(max, range.max);
  }
  return { min, max };
}

function toDateInput(ts: number | null): string {
  if (ts === null) return "";
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
}

/**
 * Texto del indicador. Con el esqueleto puesto pero los temas todavía sin sus
 * aristas hacia páginas y notas, decirlo evita que parezca un bug (§F).
 */
export function progressLabel(progress: LoaderProgress | null): string {
  if (!progress) return "Cargando el esqueleto…";
  switch (progress.phase) {
    case "skeleton":
      return progress.total > 0
        ? `Esqueleto listo: ${numberFormat.format(progress.loaded)} nodos principales`
        : "Cargando el esqueleto…";
    case "layer": {
      const label = progress.type ? SECONDARY_TYPE_LABELS[progress.type] ?? progress.type : "nodos";
      return `Cargando: ${label} ${numberFormat.format(progress.loaded)}/${numberFormat.format(progress.total)}`;
    }
    case "neighbors":
      return "Trayendo vecinos…";
    case "done":
      return `${numberFormat.format(progress.loaded)} de ${numberFormat.format(progress.total)} nodos`;
    default:
      return `Mostrando los ${numberFormat.format(progress.budgetMax)} más recientes`;
  }
}

export default function GrafoView() {
  const store = useMemo(() => createGraphStore(), []);
  const canvasRef = useRef<SigmaCanvasHandle | null>(null);
  const loaderRef = useRef<GraphLoader | null>(null);

  const [progress, setProgress] = useState<LoaderProgress | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [edgeCount, setEdgeCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [hiddenTypes, setHiddenTypes] = useState<Set<GraphNodeType>>(() => new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [dateFloor, setDateFloorState] = useState<string>("");
  const [engineDown, setEngineDown] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const meta = loaderRef.current?.meta ?? null;

  // ── Ciclo de vida: un loader por montaje; al salir no queda nada vivo ────
  useEffect(() => {
    const controller = new AbortController();
    const loader = createGraphLoader({
      api: createGraphApi(),
      store,
      onProgress: (next) => setProgress(next),
      onPatch: () => {
        // Repintar y recalentar brevemente: nunca reiniciar el layout entero.
        canvasRef.current?.refresh({ skipIndexation: false, reheat: true });
        setCounts(store.typeCounts());
        setEdgeCount(store.graph.size);
      },
      onError: (err) => {
        console.error("[grafo] fallo al cargar", err);
        setError(err instanceof ApiError ? err.message : "No se pudo cargar el grafo.");
      },
    });
    loaderRef.current = loader;
    void loader.start(controller.signal);

    return () => {
      controller.abort();
      loader.cancel();
      loaderRef.current = null;
      canvasRef.current?.destroy();
      canvasRef.current = null;
      store.clear();
    };
  }, [store, reloadKey]);

  const onCanvasReady = useCallback((handle: SigmaCanvasHandle) => {
    canvasRef.current = handle;
    handle.refresh({ skipIndexation: false });
  }, []);

  // Los filtros por tipo bajan al lienzo como reducers, no como re-render.
  useEffect(() => {
    const visible = new Set(NODE_TYPE_ORDER.filter((type) => !hiddenTypes.has(type)) as string[]);
    canvasRef.current?.setTypeFilter(visible.size === NODE_TYPE_ORDER.length ? null : visible);
  }, [hiddenTypes]);

  useEffect(() => {
    canvasRef.current?.setSelected(selectedId);
  }, [selectedId]);

  const toggleType = useCallback((type: GraphNodeType) => {
    setHiddenTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }, []);

  const loadMore = useCallback(() => {
    setError(null);
    void loaderRef.current?.loadMoreOlder(300);
  }, []);

  const loadEverything = useCallback(() => {
    setError(null);
    void loaderRef.current?.loadMoreOlder(Number.MAX_SAFE_INTEGER);
  }, []);

  const onDateFloor = useCallback((value: string) => {
    setDateFloorState(value);
    const ts = value ? Date.parse(`${value}T00:00:00.000Z`) : NaN;
    void loaderRef.current?.setDateFloor(Number.isNaN(ts) ? null : ts);
  }, []);

  const runSearch = useCallback(async () => {
    const q = search.trim();
    if (q.length < 2) {
      setHits(null);
      canvasRef.current?.setSearchHit(null);
      return;
    }
    const results = (await loaderRef.current?.search(q)) ?? [];
    setHits(results);
  }, [search]);

  /** Al elegir un resultado: si el nodo no está, se trae su ego-red primero. */
  const pickHit = useCallback(
    async (hit: SearchHit) => {
      if (!store.has(hit.id)) await loaderRef.current?.loadNeighbors(hit.id, 1);
      canvasRef.current?.setSearchHit(hit.id);
      canvasRef.current?.fit(hit.id);
      setSelectedId(store.has(hit.id) ? hit.id : null);
    },
    [store],
  );

  /** "Ver vecinos": MEZCLA la ego-red en el grafo, nunca reemplaza la vista. */
  const showNeighbors = useCallback(() => {
    if (!selectedId) return;
    void loaderRef.current?.loadNeighbors(selectedId, 1);
  }, [selectedId]);

  const selectedNode: GraphNode | null = useMemo(() => {
    if (!selectedId || !store.graph.hasNode(selectedId)) return null;
    const attrs = store.graph.getNodeAttributes(selectedId);
    return {
      id: selectedId,
      type: attrs.type,
      label: attrs.label,
      refId: selectedId.split(":").slice(1).join(":"),
      meta: {},
    };
  }, [selectedId, store, counts]);

  const selectedDegree = selectedId && store.graph.hasNode(selectedId) ? store.graph.degree(selectedId) : 0;
  const nodeCount = Object.values(counts).reduce((sum, n) => sum + n, 0);
  const range = globalRange(meta);
  const budgetReached = progress?.phase === "idle" && (progress?.budgetUsed ?? 0) >= (progress?.budgetMax ?? 0);

  return (
    <div className="mx-auto max-w-[1180px] px-4 pb-20 pt-6 sm:px-5">
      <h1 className="text-display text-ink">Grafo</h1>
      <p className="mt-1.5 max-w-[60ch] text-body text-muted">
        Contactos, empresas, equipo, reuniones, notas, notas de voz, páginas y temas: cómo se conectan entre sí. Lo
        principal se pinta primero; el resto entra por tandas, de lo más reciente a lo más antiguo.
      </p>

      <Card className="mt-6 flex flex-col gap-3 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void runSearch();
            }}
          >
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar en todo el grafo…"
              aria-label="Buscar en todo el grafo"
              className="min-h-9 w-56 rounded-tight border border-line bg-canvas px-3 text-small text-ink placeholder:text-faint focus:border-link focus:outline-none"
            />
            <button
              type="submit"
              className="press min-h-9 rounded-tight border border-line px-3 text-small font-semibold text-ink-2 hover:bg-surface-2"
            >
              Buscar
            </button>
          </form>

          <label className="flex items-center gap-1.5 text-label text-muted">
            <span>Desde</span>
            <input
              type="date"
              value={dateFloor}
              min={toDateInput(range.min)}
              max={toDateInput(range.max)}
              onChange={(e) => onDateFloor(e.target.value)}
              aria-label="Desde fecha"
              className="min-h-9 rounded-tight border border-line bg-canvas px-2.5 text-small text-ink focus:border-link focus:outline-none"
            />
          </label>

          <button
            type="button"
            onClick={loadMore}
            className="press min-h-9 rounded-tight border border-line px-3 text-small font-semibold text-ink-2 hover:bg-surface-2"
          >
            Cargar más antiguos
          </button>
          <button
            type="button"
            onClick={() => canvasRef.current?.fit()}
            className="press min-h-9 rounded-tight border border-line px-3 text-small font-semibold text-ink-2 hover:bg-surface-2"
          >
            Reencuadrar
          </button>
          <button
            type="button"
            onClick={() => setReloadKey((k) => k + 1)}
            className="press min-h-9 rounded-tight border border-line px-3 text-small font-semibold text-ink-2 hover:bg-surface-2"
          >
            Refrescar
          </button>

          <div className="ml-auto flex items-center gap-2 text-label text-muted">
            <span data-testid="grafo-conteo">
              {numberFormat.format(nodeCount)} nodos · {numberFormat.format(edgeCount)} aristas
            </span>
            <span className="font-semibold text-work" data-testid="grafo-progreso">
              {progressLabel(progress)}
            </span>
            {budgetReached ? (
              <button
                type="button"
                onClick={loadEverything}
                className="press rounded-tight border border-link px-2 py-0.5 text-label font-semibold text-link hover:bg-link-bg"
              >
                Cargar todo
              </button>
            ) : null}
          </div>
        </div>

        <Legend counts={counts} hidden={hiddenTypes} onToggle={toggleType} />
      </Card>

      {error ? (
        <div className="mt-4">
          <ErrorBox message={error} onRetry={() => setReloadKey((k) => k + 1)} />
        </div>
      ) : null}

      {hits ? (
        <Card className="mt-4 p-3">
          {hits.length === 0 ? (
            <p className="text-small text-muted">Sin resultados para «{search}».</p>
          ) : (
            <ul className="flex flex-wrap gap-2" aria-label="Resultados de búsqueda">
              {hits.map((hit) => (
                <li key={hit.id}>
                  <button
                    type="button"
                    onClick={() => void pickHit(hit)}
                    className="press rounded-tight border border-line px-2.5 py-1 text-small text-ink-2 hover:bg-surface-2"
                  >
                    {hit.label}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      ) : null}

      <SectionHead label="Lienzo" />

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[1fr_320px]">
        <Card className="h-[calc(100vh-22rem)] min-h-[420px] overflow-hidden lg:h-[calc(100vh-23.5rem)]">
          {nodeCount === 0 && !error ? (
            <div className="flex h-full items-center justify-center">
              <Spinner label="Cargando el grafo…" />
            </div>
          ) : engineDown ? (
            <div className="flex h-full items-center justify-center p-8">
              <EmptyState
                title="El lienzo no pudo arrancar"
                hint="Este navegador no expone WebGL. Los datos están cargados; prueba en otro navegador."
              />
            </div>
          ) : (
            <SigmaCanvas
              store={store}
              onSelect={setSelectedId}
              onReady={onCanvasReady}
              onEngineUnavailable={() => setEngineDown(true)}
              ariaLabel={`Grafo con ${numberFormat.format(nodeCount)} nodos y ${numberFormat.format(edgeCount)} aristas`}
            />
          )}
        </Card>

        <Card className="min-h-[200px] p-4">
          <NodePanel node={selectedNode} degree={selectedDegree} onClose={() => setSelectedId(null)} onFocus={showNeighbors} />
        </Card>
      </div>
    </div>
  );
}
