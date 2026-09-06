/**
 * Caja de búsqueda de tareas. El índice (FTS5 en SQLite, tsvector en Postgres)
 * vive en la API; aquí sólo se antirrebota la escritura y se pinta el resultado
 * con lo justo para decidir: proyecto, estado y el fragmento que coincidió.
 */
import { useEffect, useRef, useState } from "react";
import { useStore } from "../state/store";
import { StatusPill } from "../components/ui";
import { STAGE_LABELS } from "../components/system";
import type { TaskSearchHit } from "../lib/types";

export const SEARCH_DEBOUNCE_MS = 250;

export function SearchHitRow({ hit, onOpen }: { hit: TaskSearchHit; onOpen: (id: string) => void }) {
  return (
    <li>
      <button
        type="button"
        data-testid={`search-hit-${hit.id}`}
        onClick={() => onOpen(hit.id)}
        className="flex w-full flex-col gap-1 rounded-soft px-3 py-2 text-left hover:bg-surface-2 focus:outline-none focus:ring-2 focus:ring-link"
      >
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-small font-semibold text-ink">{hit.title}</span>
          <StatusPill status={hit.status} />
        </span>
        <span className="flex flex-wrap items-center gap-1.5 text-label text-muted">
          {hit.project_name ? <span className="truncate">{hit.project_name}</span> : null}
          <span className="rounded-full bg-line-soft px-1 py-0.5">{STAGE_LABELS[hit.stage]}</span>
          {hit.source === "comment" ? (
            <span className="rounded-full bg-decide-bg px-1 py-0.5 text-decide">en un comentario</span>
          ) : null}
          {(hit.labels ?? []).map((label) => (
            <span key={label} className="rounded-full bg-link-bg px-1.5 py-0.5 text-link">
              {label}
            </span>
          ))}
        </span>
        {hit.snippet ? (
          <span className="line-clamp-2 text-label text-muted">{hit.snippet}</span>
        ) : null}
      </button>
    </li>
  );
}

export function TaskSearchBox({
  projectId,
  mine = false,
  label = "Buscar tareas",
  placeholder = "Buscar en títulos, descripciones y comentarios…",
}: {
  projectId?: string | undefined;
  mine?: boolean;
  label?: string;
  placeholder?: string;
}) {
  const searchTasks = useStore((state) => state.searchTasks);
  const clearTaskSearch = useStore((state) => state.clearTaskSearch);
  const results = useStore((state) => state.taskSearchResults);
  const loading = useStore((state) => state.taskSearchLoading);
  const error = useStore((state) => state.taskSearchError);
  const openTask = useStore((state) => state.openTask);
  const [value, setValue] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    const trimmed = value.trim();
    if (!trimmed) {
      clearTaskSearch();
      return;
    }
    // Antirrebote: una pulsación no es una intención de búsqueda todavía.
    timer.current = setTimeout(() => {
      void searchTasks(trimmed, { ...(projectId ? { projectId } : {}), ...(mine ? { mine } : {}) });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [value, projectId, mine]);

  useEffect(() => () => clearTaskSearch(), []);

  const showPanel = value.trim().length > 0;

  return (
    <div className="relative">
      <label htmlFor="task-search" className="sr-only">
        {label}
      </label>
      <input
        id="task-search"
        data-testid="task-search"
        type="search"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder={placeholder}
        className="min-h-9 w-full rounded-full border border-line bg-surface px-3.5 py-1.5 text-small focus:border-link focus:outline-none focus:ring-2 focus:ring-link"
      />
      {showPanel ? (
        <div
          className="absolute left-0 right-0 z-30 mt-1 max-h-80 overflow-y-auto rounded-panel bg-surface py-1 shadow-float"
          data-testid="task-search-results"
          role="listbox"
          aria-label="Resultados de búsqueda"
        >
          {loading ? <p className="px-3 py-2 text-small text-faint">Buscando…</p> : null}
          {!loading && error ? (
            <p className="px-3 py-2 text-small text-broken" role="alert">
              {error}
            </p>
          ) : null}
          {!loading && !error && results.length === 0 ? (
            <p className="px-3 py-2 text-small text-faint">Sin resultados para «{value.trim()}».</p>
          ) : null}
          <ul>
            {results.map((hit) => (
              <SearchHitRow
                key={hit.id}
                hit={hit}
                onOpen={(id) => {
                  setValue("");
                  clearTaskSearch();
                  void openTask(id);
                }}
              />
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

export default TaskSearchBox;
