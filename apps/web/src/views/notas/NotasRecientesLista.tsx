/**
 * Lista de notas recientes: aparte para que el aside de escritorio y el
 * Inicio del celular pinten exactamente lo mismo (título, estado, hace
 * cuánto) sin duplicar el JSX.
 */
import { timeAgo } from "../../components/ui";
import type { CanvasNote } from "../../lib/types";
import { STATUS_LABELS } from "./estado-nota";

export function NotasRecientesLista({
  notes,
  activeNoteId,
  onSelect,
  titulo = "Notas recientes",
}: {
  notes: CanvasNote[];
  activeNoteId: string | null;
  onSelect: (noteId: string) => void;
  titulo?: string;
}) {
  return (
    <section className="rounded-panel border border-line bg-surface p-3">
      <h2 className="text-label uppercase tracking-wide text-muted">{titulo}</h2>
      <ul className="mt-2 flex flex-col gap-1">
        {notes.map((note) => (
          <li key={note.id}>
            <button
              type="button"
              onClick={() => onSelect(note.id)}
              aria-current={note.id === activeNoteId ? "true" : undefined}
              className={`press flex min-h-10 w-full flex-col items-start rounded-tight px-2.5 py-1.5 text-left hover:bg-surface-2 ${
                note.id === activeNoteId ? "bg-link-bg text-link" : "text-ink-2"
              }`}
            >
              <span className="w-full truncate text-small font-semibold">{note.title}</span>
              <span className="text-label text-muted">
                {STATUS_LABELS[note.status]} · {timeAgo(note.updatedAt)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
