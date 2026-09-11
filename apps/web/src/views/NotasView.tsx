/**
 * Notas manuscritas. Ernesto escribe con la tableta en un lienzo Excalidraw;
 * la escena se autoguarda sola y dos botones leen lo escrito con el modelo de
 * visión (PNG limpio 3×, fondo blanco, recortado al contenido):
 *
 * - «Transcribir»: mientras se sigue escribiendo. Captura lo que hay, lo
 *   transcribe y pone el texto EN EL LIENZO, debajo de cada región de trazos;
 *   la nota sigue en borrador y se puede repetir (reemplaza el texto anterior).
 * - «Terminar nota»: lo mismo, y además la deja `transcribed`, lista para
 *   proponer tareas.
 *
 * Decisiones de esta vista:
 * - El lienzo entra por `React.lazy`: es la dependencia más pesada de la app y
 *   nadie que no abra /notas debe pagarla.
 * - Autoguardado amortiguado (2 s) con `expected_version`: dos pestañas sobre
 *   la misma nota dan 409 y se relee, nunca last-write-wins silencioso.
 * - El panel lateral enseña el Markdown de la transcripción y lo deja
 *   EDITABLE: la lectura de una letra siempre puede fallar, así que el humano
 *   corrige y su corrección se guarda (PATCH con `transcription`). Si el
 *   proveedor falla, se enseña el error: nunca se rellena con algo inventado.
 * - Bajo la transcripción, «Tareas propuestas» (fase 3, `PropuestasPanel`):
 *   el modelo propone, el humano revisa y NADA se crea sin pulsar «Crear».
 * - El lienzo llena TODO el alto disponible (la vista es `h-full` dentro del
 *   <main> del shell y recorta con `overflow-hidden`: nunca scroll de página)
 *   y el panel derecho no lo estrecha por debajo del 60 % del ancho.
 * - «Pantalla completa» (Maximize2 / Esc) es layout, no la Fullscreen API del
 *   navegador (falla en iframes y tabletas): la vista pide el modo inmersivo
 *   al shell (`useShell`), que deja de pintar menú y cabecera, y aquí se
 *   esconde el panel derecho. Queda el lienzo y una barra mínima con
 *   Transcribir / Terminar nota / Salir. El lienzo NO se remonta al entrar o
 *   salir: mantiene la misma posición en el árbol.
 */
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Check, ChevronRight, FileImage, Maximize2, Minimize2, Plus, Wand2 } from "lucide-react";
import { useStore } from "../state/store";
import { useShell } from "../state/shell";
import { EmptyState, ErrorBox, Spinner, fmtDate, timeAgo } from "../components/ui";
import { api } from "../lib/api";
import type { CanvasNote, CanvasScene, NoteTranscribeMode } from "../lib/types";
import type { LienzoHandle } from "./notas/Lienzo";
import { PropuestasPanel } from "./notas/PropuestasPanel";

const Lienzo = lazy(() => import("./notas/Lienzo"));

/** Espera antes de guardar: suficiente para no llamar por trazo, corto para no perder trabajo. */
export const AUTOSAVE_MS = 2_000;

const STATUS_LABELS: Record<CanvasNote["status"], string> = {
  draft: "Borrador",
  captured: "Terminada",
  transcribed: "Transcrita",
  converted: "Con tareas",
};

const STATUS_CLASSES: Record<CanvasNote["status"], string> = {
  draft: "border-line bg-surface-2 text-muted",
  captured: "border-done-line bg-done-bg text-done",
  transcribed: "border-link bg-link-bg text-link",
  converted: "border-done-line bg-done-bg text-done",
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
  const noteDudas = useStore((s) => s.noteDudas);

  const [searchParams, setSearchParams] = useSearchParams();
  const urlNote = searchParams.get("nota");

  const handleRef = useRef<LienzoHandle | null>(null);
  const pendingScene = useRef<CanvasScene | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  /** Qué botón está en vuelo: los dos comparten el camino, pero cada uno enseña su propio «…ndo». */
  const [accion, setAccion] = useState<"transcribir" | "terminar" | null>(null);

  // Lienzo a pantalla completa: el shell deja de pintar menú y cabecera
  // mientras dure, y se apaga sin falta al salir de la vista (navegar con el
  // modo puesto no puede dejar la app sin menú).
  const [pantallaCompleta, setPantallaCompleta] = useState(false);
  const setInmersivo = useShell((s) => s.setInmersivo);
  useEffect(() => {
    setInmersivo(pantallaCompleta);
  }, [pantallaCompleta, setInmersivo]);
  useEffect(() => () => setInmersivo(false), [setInmersivo]);
  useEffect(() => {
    if (!pantallaCompleta) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Dentro de un texto del lienzo, Esc termina la edición: no debe además
      // sacar del modo. Un segundo Esc, ya fuera del campo, sí sale.
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable) return;
      setPantallaCompleta(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pantallaCompleta]);

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

  /**
   * El mismo camino para «Transcribir» y «Terminar nota»: exportar el PNG →
   * capturarlo → transcribirlo → poner el texto en el lienzo. Sólo cambia el
   * modo: `interim` no toca el estado (la nota sigue editable) y `final` la
   * deja `transcribed`. El texto cae DEBAJO de cada región de trazos y el
   * lienzo lo autoguarda como cualquier otro cambio.
   */
  const leerLienzo = useCallback(
    async (mode: NoteTranscribeMode) => {
      const handle = handleRef.current;
      if (!handle || !activeNoteId || accion) return;
      setExportError(null);
      if (handle.estaVacio()) {
        setExportError("El lienzo está vacío: escribe algo antes de transcribir.");
        return;
      }
      setAccion(mode === "final" ? "terminar" : "transcribir");
      try {
        await flush();
        const blob = await handle.exportarPng();
        const dataUrl = await blobToBase64(blob);
        // Intermedia: el borrador sigue siendo borrador. Final: pasa a `captured`
        // y la transcripción lo deja en `transcribed`.
        const capturada = await captureNote(activeNoteId, dataUrl, {
          keepStatus: mode === "interim",
        });
        if (!capturada) return;
        const resultado = await transcribeNote(activeNoteId, mode);
        if (!resultado.ok) return;
        handle.insertarTranscripcion(resultado.bloques, resultado.alturaTipica);
      } catch (err) {
        setExportError(err instanceof Error ? err.message : "No se pudo exportar la imagen");
      } finally {
        setAccion(null);
      }
    },
    [accion, activeNoteId, captureNote, flush, transcribeNote],
  );

  // «Transcribir» sobre una nota ya terminada la rehace en modo final: no hay
  // borrador al que volver, y `converted` no admite intermedias.
  const modoTranscribir: NoteTranscribeMode = activeNote?.status === "draft" ? "interim" : "final";
  const transcribir = useCallback(() => leerLienzo(modoTranscribir), [leerLienzo, modoTranscribir]);
  const terminar = useCallback(() => leerLienzo("final"), [leerLienzo]);

  /** El texto corregido a mano se guarda al salir del campo, no en cada tecla. */
  const guardarTranscripcion = useCallback(async () => {
    if (!activeNote) return;
    const limpio = borrador.trim();
    if (limpio === (activeNote.transcription ?? "").trim()) return;
    await saveNote(activeNote.id, { transcription: limpio });
  }, [activeNote, borrador, saveNote]);

  const ocupado = accion !== null || noteCapturing || noteTranscribing;

  const savedLabel = noteSaving
    ? "Guardando…"
    : noteSavedAt
      ? `Guardado ${fmtDate(noteSavedAt)}`
      : activeNote
        ? `Última edición ${timeAgo(activeNote.updatedAt)}`
        : "";

  const focoVisible =
    "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-link";

  /** Los dos botones de lectura: los mismos en la cabecera normal y en la barra mínima. */
  const botonesLectura = (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => void transcribir()}
        disabled={!activeNote || ocupado}
        className={`press inline-flex min-h-10 items-center gap-1.5 rounded-tight border border-line bg-surface px-3 text-small font-semibold text-ink-2 hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40 ${focoVisible}`}
      >
        <Wand2 size={15} strokeWidth={1.75} aria-hidden="true" />
        {accion === "transcribir" ? "Transcribiendo…" : "Transcribir"}
      </button>
      <button
        type="button"
        onClick={() => void terminar()}
        disabled={!activeNote || ocupado}
        className={`press inline-flex min-h-10 items-center gap-1.5 rounded-tight bg-ink px-4 text-small font-semibold text-surface hover:bg-ink-2 disabled:cursor-not-allowed disabled:opacity-40 ${focoVisible}`}
      >
        <Check size={15} strokeWidth={2} aria-hidden="true" />
        {accion === "terminar" ? "Terminando…" : "Terminar nota"}
      </button>
    </div>
  );

  return (
    // `h-full` del <main> del shell + `overflow-hidden`: el lienzo recibe todo
    // el alto restante y la página nunca hace scroll vertical.
    <div
      className="flex h-full min-h-0 flex-col overflow-hidden"
      data-testid="notas-vista"
      data-pantalla-completa={pantallaCompleta ? "true" : undefined}
    >
      {pantallaCompleta ? (
        <header className="flex shrink-0 items-center gap-2 border-b border-line bg-surface px-3 py-1.5">
          <h1 className="min-w-0 flex-1 truncate text-small font-semibold text-ink">
            {activeNote?.title ?? "Notas a mano"}
          </h1>
          <span
            aria-live="polite"
            data-testid="indicador-guardado"
            className="hidden text-label text-muted sm:inline"
          >
            {savedLabel}
          </span>
          {botonesLectura}
          <button
            type="button"
            onClick={() => setPantallaCompleta(false)}
            aria-label="Salir de pantalla completa"
            title="Salir de pantalla completa (Esc)"
            className={`press inline-flex min-h-10 items-center gap-1.5 rounded-tight border border-line bg-surface px-3 text-small font-semibold text-ink-2 hover:bg-surface-2 ${focoVisible}`}
          >
            <Minimize2 size={15} strokeWidth={1.75} aria-hidden="true" />
            Salir
          </button>
        </header>
      ) : (
        <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-line bg-surface px-4 py-2.5">
          <h1
            className="min-w-0 flex-1 truncate text-title text-ink"
            title="Escribe con la tableta; se guarda solo. Transcribe cuando quieras y el texto queda en el lienzo."
          >
            {activeNote?.title ?? "Notas a mano"}
          </h1>

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
            className={`press inline-flex min-h-10 items-center gap-1.5 rounded-tight border border-line bg-surface px-3 text-small font-semibold text-ink-2 hover:bg-surface-2 ${focoVisible}`}
          >
            <Plus size={15} strokeWidth={1.75} aria-hidden="true" />
            Nueva nota
          </button>

          <div className="flex flex-col items-end gap-1">
            <div className="flex items-center gap-2">
              {botonesLectura}
              <button
                type="button"
                onClick={() => setPantallaCompleta(true)}
                disabled={!activeNote}
                aria-label="Pantalla completa"
                title="Solo el lienzo: sin menú, cabecera ni panel (Esc para salir)"
                className={`press inline-flex min-h-10 min-w-10 items-center justify-center gap-1.5 rounded-tight border border-line bg-surface px-2.5 text-small font-semibold text-ink-2 hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40 ${focoVisible}`}
              >
                <Maximize2 size={15} strokeWidth={1.75} aria-hidden="true" />
                <span className="hidden xl:inline">Pantalla completa</span>
              </button>
            </div>
            <p className="text-label text-muted">
              Transcribir: lee lo que hay y pone el texto en el lienzo; puedes seguir escribiendo.
              {" · "}
              Terminar nota: transcribe y la deja lista para proponer tareas.
            </p>
          </div>
        </header>
      )}

      {exportError ? (
        <div className="border-b border-broken-line bg-broken-bg px-4 py-2 text-small text-broken">
          {exportError}
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        {/* El lienzo nunca baja del 60 % del ancho en escritorio: el panel
            (w-80, max 40 %) cede antes. `min-h-0` + `overflow-hidden` para que
            Excalidraw reciba una altura definida y no empuje la página. */}
        <section className="min-h-0 min-w-0 flex-1 overflow-hidden bg-surface lg:min-w-[60%]">
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

        {pantallaCompleta ? null : (
        <aside
          data-testid="panel-lateral-notas"
          className="hidden w-80 max-w-[40%] shrink-0 flex-col gap-3 overflow-auto border-l border-line bg-canvas p-3 lg:flex"
        >
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
                onChange={(e) => setBorrador(e.target.value)}
                onBlur={() => void guardarTranscripcion()}
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
                  {noteDudas.length === 1
                    ? "1 lectura con duda"
                    : `${noteDudas.length} lecturas con duda`}
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
          </section>

          {activeNote ? <PropuestasPanel key={activeNote.id} note={activeNote} /> : null}

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
        )}
      </div>
    </div>
  );
}
