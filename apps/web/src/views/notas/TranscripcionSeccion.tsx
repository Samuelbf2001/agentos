/**
 * Bloque «Transcripción»: texto leído (editable), dudas del modelo y el
 * enlace a la imagen guardada. Aparte para que el aside de escritorio y la
 * pestaña «Texto» del celular pinten lo mismo sin duplicar el JSX; en la
 * pestaña de celular además vive aquí el botón «Terminar nota» (`terminar`),
 * que en escritorio está en la cabecera.
 */
import { Check, ChevronRight, FileImage } from "lucide-react";
import { api } from "../../lib/api";
import type { CanvasNote } from "../../lib/types";

export function TranscripcionSeccion({
  activeNote,
  borrador,
  onBorradorChange,
  onGuardar,
  noteTranscribing,
  noteTranscribeError,
  noteDudas,
  terminar,
}: {
  activeNote: CanvasNote | null;
  borrador: string;
  onBorradorChange: (value: string) => void;
  onGuardar: () => void;
  noteTranscribing: boolean;
  noteTranscribeError: string | null;
  noteDudas: string[];
  /** Sólo la pestaña «Texto» del celular lo pasa: en escritorio vive en la cabecera. */
  terminar?: { onClick: () => void; disabled: boolean; label: string };
}) {
  return (
    <section className="rounded-panel border border-line bg-surface p-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-label uppercase tracking-wide text-muted">Transcripción</h2>
      </div>

      {noteTranscribing ? (
        <p className="mt-2 text-small text-muted" role="status">
          Leyendo la letra… el modelo tarda unos segundos.
        </p>
      ) : null}

      {noteTranscribeError ? (
        <p
          data-testid="error-transcripcion"
          className="mt-2 rounded-tight border border-broken-line bg-broken-bg px-2.5 py-2 text-small text-broken"
        >
          {noteTranscribeError}
        </p>
      ) : null}

      {activeNote && (activeNote.transcription !== null || borrador !== "") ? (
        <textarea
          key={activeNote.id}
          aria-label="Transcripción de la nota"
          value={borrador}
          onChange={(e) => onBorradorChange(e.target.value)}
          onBlur={onGuardar}
          rows={12}
          className="mt-2 w-full resize-y rounded-tight border border-line bg-canvas p-2 text-body text-ink-2 focus:border-link focus:outline-none"
        />
      ) : (
        <p className="mt-2 text-small text-muted">
          {activeNote?.status === "draft"
            ? "Transcripción pendiente: pulsa «Transcribir» para leer lo que hay en el lienzo."
            : "Todavía sin transcribir: pulsa «Transcribir» para leer la imagen."}
        </p>
      )}
      {/*
        Lo que el modelo no leyó con seguridad. El texto llega ya sin
        marcadores `[?]` (la lectura elegida basta); la lista vive solo en
        memoria, de la última transcripción: al recargar no se enseña.
      */}
      {activeNote && noteDudas.length > 0 ? (
        <details className="mt-2" data-testid="dudas-transcripcion">
          <summary className="flex min-h-10 cursor-pointer list-none items-center gap-1.5 rounded-tight px-1 text-small text-muted hover:text-ink-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-link [&::-webkit-details-marker]:hidden">
            <ChevronRight
              size={14}
              strokeWidth={1.75}
              aria-hidden="true"
              className="transition-transform [details[open]_&]:rotate-90"
            />
            {noteDudas.length === 1 ? "1 lectura con duda" : `${noteDudas.length} lecturas con duda`}
          </summary>
          <ul className="mb-1 ml-5 list-disc text-small text-ink-2">
            {noteDudas.map((duda, i) => (
              <li key={`${i}-${duda}`}>{duda}</li>
            ))}
          </ul>
        </details>
      ) : null}
      {activeNote?.imagePath ? (
        <a
          href={api.noteImageUrl(activeNote.id)}
          target="_blank"
          rel="noreferrer"
          className="mt-3 inline-flex min-h-10 items-center gap-1.5 rounded-tight border border-line px-3 text-small font-semibold text-link hover:bg-link-bg"
        >
          <FileImage size={15} strokeWidth={1.75} aria-hidden="true" />
          Ver la imagen guardada
        </a>
      ) : null}

      {terminar ? (
        <button
          type="button"
          onClick={terminar.onClick}
          disabled={terminar.disabled}
          className="press mt-3 inline-flex min-h-11 w-full items-center justify-center gap-1.5 rounded-tight bg-ink px-4 text-small font-semibold text-surface hover:bg-ink-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-link disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Check size={15} strokeWidth={2} aria-hidden="true" />
          {terminar.label}
        </button>
      ) : null}
    </section>
  );
}
