/**
 * Notas manuscritas (fase 1). Ernesto escribe con la tableta en un lienzo
 * Excalidraw; la escena se autoguarda sola y "Terminar notas" exporta un PNG
 * limpio (3×, fondo blanco, recortado al contenido) que queda guardado para
 * que la fase 2 lo transcriba.
 *
 * Decisiones de esta vista:
 * - El lienzo entra por `React.lazy`: es la dependencia más pesada de la app y
 *   nadie que no abra /notas debe pagarla.
 * - Autoguardado amortiguado (2 s) con `expected_version`: dos pestañas sobre
 *   la misma nota dan 409 y se relee, nunca last-write-wins silencioso.
 * - El panel lateral transcribe la imagen con el modelo de visión y deja el
 *   texto EDITABLE: la lectura de una letra siempre puede fallar, así que el
 *   humano corrige y su corrección se guarda (PATCH con `transcription`). Si
 *   el proveedor falla, se enseña el error: nunca se rellena con algo inventado.
 */
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Check, FileImage, Plus, Wand2 } from "lucide-react";
import { useStore } from "../state/store";
import { EmptyState, ErrorBox, Spinner, fmtDate, timeAgo } from "../components/ui";
import { api } from "../lib/api";
import type { CanvasNote, CanvasScene } from "../lib/types";
import type { LienzoHandle } from "./notas/Lienzo";

const Lienzo = lazy(() => import("./notas/Lienzo"));

/** Espera antes de guardar: suficiente para no llamar por trazo, corto para no perder trabajo. */
export const AUTOSAVE_MS = 2_000;

const STATUS_LABELS: Record<CanvasNote["status"], string> = {
  draft: "Borrador",
  captured: "Terminada",
  transcribed: "Transcrita",
};

const STATUS_CLASSES: Record<CanvasNote["status"], string> = {
  draft: "border-line bg-surface-2 text-muted",
  captured: "border-done-line bg-done-bg text-done",
  transcribed: "border-link bg-link-bg text-link",
};

/** Blob → base64 sin cadenas gigantes en memoria (FileReader lo hace en nativo). */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("No se pudo leer la imagen exportada"));
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.readAsDataURL(blob);
  });
}

function prefersDark(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export default function NotasView() {
  const notes = useStore((s) => s.notes);
  const notesLoading = useStore((s) => s.notesLoading);
  const notesError = useStore((s) => s.notesError);
  const activeNoteId = useStore((s) => s.activeNoteId);
  const noteSaving = useStore((s) => s.noteSaving);
  const noteSavedAt = useStore((s) => s.noteSavedAt);
  const noteCapturing = useStore((s) => s.noteCapturing);
  const loadNotes = useStore((s) => s.loadNotes);
  const createNote = useStore((s) => s.createNote);
  const openNote = useStore((s) => s.openNote);
  const saveNote = useStore((s) => s.saveNote);
  const captureNote = useStore((s) => s.captureNote);
  const transcribeNote = useStore((s) => s.transcribeNote);
  const noteTranscribing = useStore((s) => s.noteTranscribing);
  const noteTranscribeError = useStore((s) => s.noteTranscribeError);

  const [searchParams, setSearchParams] = useSearchParams();
  const urlNote = searchParams.get("nota");

  const handleRef = useRef<LienzoHandle | null>(null);
  const pendingScene = useRef<CanvasScene | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  const activeNote = useMemo(
    () => notes.find((n) => n.id === activeNoteId) ?? null,
    [notes, activeNoteId],
  );

  // Borrador local del texto: el humano corrige a mano y se guarda al salir del
  // campo. Se resincroniza cuando llega otra transcripción (o se cambia de nota).
  const [borrador, setBorrador] = useState("");
  const transcripcionServidor = activeNote?.transcription ?? "";
  useEffect(() => {
    setBorrador(transcripcionServidor);
  }, [activeNoteId, transcripcionServidor]);

  useEffect(() => {
    void loadNotes();
  }, [loadNotes]);

  // La URL manda al montar y al navegar; si no dice nada, se abre la más
  // reciente (la lista ya viene ordenada por la API).
  useEffect(() => {
    if (urlNote && urlNote !== activeNoteId) {
      openNote(urlNote);
      return;
    }
    if (!urlNote && !activeNoteId && notes.length > 0) openNote(notes[0]!.id);
  }, [urlNote, activeNoteId, notes, openNote]);

  const selectNote = useCallback(
    (noteId: string) => {
      openNote(noteId);
      setSearchParams((params) => {
        const next = new URLSearchParams(params);
        next.set("nota", noteId);
        return next;
      });
    },
    [openNote, setSearchParams],
  );

  /** Escribe lo que quede pendiente AHORA (al cambiar de nota, al terminar, al salir). */
  const flush = useCallback(async () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const scene = pendingScene.current;
    const noteId = activeNoteId;
    pendingScene.current = null;
    if (!scene || !noteId) return;
    await saveNote(noteId, { scene });
  }, [activeNoteId, saveNote]);

  const onSceneChange = useCallback(
    (scene: CanvasScene) => {
      if (!activeNoteId) return;
      pendingScene.current = scene;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        void flush();
      }, AUTOSAVE_MS);
    },
    [activeNoteId, flush],
  );

  // Salir de la vista con trabajo pendiente no puede perderlo.
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const onReady = useCallback((handle: LienzoHandle) => {
    handleRef.current = handle;
  }, []);

  const nuevaNota = useCallback(async () => {
    await flush();
    const note = await createNote();
    if (note) selectNote(note.id);
  }, [createNote, flush, selectNote]);

  const terminar = useCallback(async () => {
    const handle = handleRef.current;
    if (!handle || !activeNoteId) return;
    setExportError(null);
    if (handle.estaVacio()) {
      setExportError("El lienzo está vacío: escribe algo antes de terminar.");
      return;
    }
    await flush();
    try {
      const blob = await handle.exportarPng();
      const dataUrl = await blobToBase64(blob);
      await captureNote(activeNoteId, dataUrl);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : "No se pudo exportar la imagen");
    }
  }, [activeNoteId, captureNote, flush]);

  const transcribir = useCallback(async () => {
    if (!activeNoteId) return;
    await transcribeNote(activeNoteId);
  }, [activeNoteId, transcribeNote]);

  /** El texto corregido a mano se guarda al salir del campo, no en cada tecla. */
  const guardarTranscripcion = useCallback(async () => {
    if (!activeNote) return;
    const limpio = borrador.trim();
    if (limpio === (activeNote.transcription ?? "").trim()) return;
    await saveNote(activeNote.id, { transcription: limpio });
  }, [activeNote, borrador, saveNote]);

  const puedeTranscribir = !!activeNote && activeNote.status !== "draft" && !!activeNote.imagePath;

  const savedLabel = noteSaving
    ? "Guardando…"
    : noteSavedAt
      ? `Guardado ${fmtDate(noteSavedAt)}`
      : activeNote
        ? `Última edición ${timeAgo(activeNote.updatedAt)}`
        : "";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b border-line bg-surface px-4 py-3">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-title text-ink">{activeNote?.title ?? "Notas a mano"}</h1>
          <p className="text-label text-muted">
            Escribe con la tableta; se guarda solo. Al terminar queda una imagen lista para transcribir.
          </p>
        </div>

        {activeNote ? (
          <span
            className={`inline-flex items-center rounded-full border px-2.5 py-1 text-label ${STATUS_CLASSES[activeNote.status]}`}
          >
            {STATUS_LABELS[activeNote.status]}
          </span>
        ) : null}

        <span
          aria-live="polite"
          data-testid="indicador-guardado"
          className="text-label text-muted"
        >
          {savedLabel}
        </span>

        <button
          type="button"
          onClick={() => void nuevaNota()}
          className="press inline-flex min-h-10 items-center gap-1.5 rounded-tight border border-line bg-surface px-3 text-small font-semibold text-ink-2 hover:bg-surface-2"
        >
          <Plus size={15} strokeWidth={1.75} aria-hidden="true" />
          Nueva nota
        </button>

        <button
          type="button"
          onClick={() => void terminar()}
          disabled={!activeNote || noteCapturing}
          className="press inline-flex min-h-10 items-center gap-1.5 rounded-tight bg-ink px-4 text-small font-semibold text-surface hover:bg-ink-2 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Check size={15} strokeWidth={2} aria-hidden="true" />
          {noteCapturing ? "Terminando…" : "Terminar notas"}
        </button>
      </header>

      {exportError ? (
        <div className="border-b border-broken-line bg-broken-bg px-4 py-2 text-small text-broken">
          {exportError}
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        <section className="min-w-0 flex-1 bg-surface">
          {notesLoading && notes.length === 0 ? (
            <div className="flex h-full items-center justify-center">
              <Spinner label="Cargando las notas…" />
            </div>
          ) : notesError ? (
            <div className="p-6">
              <ErrorBox message={notesError} onRetry={() => void loadNotes()} />
            </div>
          ) : !activeNote ? (
            <div className="flex h-full items-center justify-center p-6">
              <EmptyState
                title="Todavía no hay notas"
                hint="Crea una y empieza a escribir con la tableta."
              />
            </div>
          ) : (
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center">
                  <Spinner label="Abriendo el lienzo…" />
                </div>
              }
            >
              <Lienzo
                key={activeNote.id}
                initialScene={activeNote.scene}
                onSceneChange={onSceneChange}
                onReady={onReady}
                theme={prefersDark() ? "dark" : "light"}
              />
            </Suspense>
          )}
        </section>

        <aside className="hidden w-80 shrink-0 flex-col gap-3 overflow-auto border-l border-line bg-canvas p-3 lg:flex">
          <section className="rounded-panel border border-line bg-surface p-3">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-label uppercase tracking-wide text-muted">Transcripción</h2>
              {puedeTranscribir ? (
                <button
                  type="button"
                  onClick={() => void transcribir()}
                  disabled={noteTranscribing}
                  className="press inline-flex min-h-8 items-center gap-1.5 rounded-tight border border-line px-2.5 text-label font-semibold text-ink-2 hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Wand2 size={14} strokeWidth={1.75} aria-hidden="true" />
                  {noteTranscribing
                    ? "Transcribiendo…"
                    : activeNote?.transcription
                      ? "Rehacer"
                      : "Transcribir"}
                </button>
              ) : null}
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
                onChange={(e) => setBorrador(e.target.value)}
                onBlur={() => void guardarTranscripcion()}
                rows={12}
                className="mt-2 w-full resize-y rounded-tight border border-line bg-canvas p-2 text-body text-ink-2 focus:border-link focus:outline-none"
              />
            ) : (
              <p className="mt-2 text-small text-muted">
                {activeNote?.status === "draft"
                  ? "Transcripción pendiente: termina las notas para dejar la imagen lista."
                  : "Todavía sin transcribir: pulsa «Transcribir» para leer la imagen."}
              </p>
            )}
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
          </section>

          <section className="rounded-panel border border-line bg-surface p-3">
            <h2 className="text-label uppercase tracking-wide text-muted">Notas recientes</h2>
            <ul className="mt-2 flex flex-col gap-1">
              {notes.map((note) => (
                <li key={note.id}>
                  <button
                    type="button"
                    onClick={() => void selectNote(note.id)}
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
        </aside>
      </div>
    </div>
  );
}
