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
 *   salir: mantiene la misma posición en el árbol. Sólo existe en escritorio.
 * - «Foto» (pizarra, tablero, cuaderno fotografiado con el celular): abre un
 *   menú con «Tomar foto» (cámara trasera) y «Subir imagen» (galería), reduce
 *   el archivo, lo pega en el lienzo a la derecha de lo que ya hay y encadena
 *   el MISMO camino que «Transcribir» — sin duplicar esa lógica.
 * - **Celular** (`useEsCelular`, < 1024px): el aside no cabe y el lienzo es
 *   incómodo con el dedo, así que la vista cambia a tres pantallas propias —
 *   Inicio (fotografiar/subir/nota a mano + recientes), Revisar fotos (antes
 *   de crear la nota) y la nota abierta con pestañas Foto/Texto/Tareas—. El
 *   lienzo NUNCA se desmonta al cambiar de pestaña (perdería el handle de
 *   Excalidraw): se oculta con `hidden` y se refresca (`refrescar()`) al
 *   volver a verse. `TranscripcionSeccion` y `NotasRecientesLista` son los
 *   mismos fragmentos que pinta el aside de escritorio, no una copia.
 */
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { ArrowLeft, Camera, Check, FileImage, Maximize2, Minimize2, Plus, Wand2 } from "lucide-react";
import { useStore } from "../state/store";
import { useShell } from "../state/shell";
import { EmptyState, ErrorBox, Spinner, fmtDate, timeAgo } from "../components/ui";
import type { CanvasNote, CanvasScene, NoteTranscribeMode } from "../lib/types";
import type { LienzoHandle } from "./notas/Lienzo";
import { reducirFoto, type FotoReducida } from "./notas/foto";
import { PropuestasPanel } from "./notas/PropuestasPanel";
import { TranscripcionSeccion } from "./notas/TranscripcionSeccion";
import { NotasRecientesLista } from "./notas/NotasRecientesLista";
import { STATUS_CLASSES, STATUS_LABELS } from "./notas/estado-nota";
import { useEsCelular } from "./notas/useEsCelular";
import { tituloTablero } from "./notas/titulo-tablero";

const Lienzo = lazy(() => import("./notas/Lienzo"));

/** Espera antes de guardar: suficiente para no llamar por trazo, corto para no perder trabajo. */
export const AUTOSAVE_MS = 2_000;

/** Botones e inputs comparten estas clases: focus visible consistente en toda la vista. */
const focoVisible =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-link";

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

/** A. Inicio del celular: fotografiar, subir, nota a mano y recientes. Nunca crea nada al montar. */
function InicioMovil({
  personName,
  notes,
  activeNoteId,
  onSelectNote,
  onFotografiar,
  onSubirImagen,
  onNotaAMano,
  creandoNota,
}: {
  personName: string | null;
  notes: CanvasNote[];
  activeNoteId: string | null;
  onSelectNote: (noteId: string) => void;
  onFotografiar: () => void;
  onSubirImagen: () => void;
  onNotaAMano: () => void;
  creandoNota: boolean;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto bg-canvas">
      <header className="shrink-0 border-b border-line bg-surface px-4 pb-3 pt-[calc(env(safe-area-inset-top)+0.75rem)]">
        <h1 className="text-title text-ink">Notas</h1>
        {personName ? <p className="text-small text-muted">Sesión de {personName}</p> : null}
      </header>
      <div className="flex flex-col gap-3 p-4">
        <button
          type="button"
          onClick={onFotografiar}
          className={`press flex min-h-[120px] w-full flex-col items-center justify-center gap-2 rounded-panel bg-ink text-surface hover:bg-ink-2 ${focoVisible}`}
        >
          <Camera size={30} strokeWidth={1.75} aria-hidden="true" />
          <span className="text-body font-semibold">Fotografiar tablero</span>
        </button>
        <button
          type="button"
          onClick={onSubirImagen}
          className={`press flex min-h-14 w-full items-center justify-center gap-2 rounded-tight border border-line bg-surface text-small font-semibold text-ink-2 hover:bg-surface-2 ${focoVisible}`}
        >
          <FileImage size={18} strokeWidth={1.75} aria-hidden="true" />
          Subir imagen
        </button>
        <button
          type="button"
          onClick={onNotaAMano}
          disabled={creandoNota}
          className={`press flex min-h-12 w-full items-center justify-center gap-2 rounded-tight text-small font-semibold text-link hover:bg-link-bg disabled:cursor-not-allowed disabled:opacity-40 ${focoVisible}`}
        >
          <Plus size={16} strokeWidth={1.75} aria-hidden="true" />
          Nota a mano
        </button>
      </div>
      <div className="px-4 pb-6">
        <NotasRecientesLista notes={notes} activeNoteId={activeNoteId} onSelect={onSelectNote} titulo="Recientes" />
      </div>
    </div>
  );
}

/** B. Revisar fotos: antes de crear la nota, ¿se leen bien? Se acumulan hasta pulsar «Usar». */
function RevisarFotosMovil({
  urls,
  onUsar,
  onRepetir,
  onOtraParte,
  onCancelar,
  procesando,
  error,
}: {
  urls: string[];
  onUsar: () => void;
  onRepetir: () => void;
  onOtraParte: () => void;
  onCancelar: () => void;
  procesando: boolean;
  error: string | null;
}) {
  const n = urls.length;
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-canvas">
      <header className="shrink-0 border-b border-line bg-surface px-4 pb-3 pt-[calc(env(safe-area-inset-top)+0.75rem)]">
        <h1 className="text-title text-ink">¿Se lee bien?</h1>
      </header>
      {error ? (
        <div className="mx-4 mt-3 shrink-0 rounded-tight border border-broken-line bg-broken-bg px-3 py-2 text-small text-broken">
          {error}
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-4">
        {urls.map((url, i) => (
          <img
            key={url}
            src={url}
            alt={`Foto ${i + 1} del tablero`}
            className="w-full rounded-panel border border-line object-contain"
          />
        ))}
      </div>
      <div className="flex shrink-0 flex-col gap-2 border-t border-line bg-surface p-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)]">
        <button
          type="button"
          onClick={onUsar}
          disabled={procesando || n === 0}
          className={`press flex min-h-12 w-full items-center justify-center gap-1.5 rounded-tight bg-ink text-small font-semibold text-surface hover:bg-ink-2 disabled:cursor-not-allowed disabled:opacity-40 ${focoVisible}`}
        >
          <Check size={16} strokeWidth={2} aria-hidden="true" />
          {procesando ? "Creando…" : n === 1 ? "Usar foto" : `Usar ${n} fotos`}
        </button>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onRepetir}
            disabled={procesando}
            className={`press min-h-11 flex-1 rounded-tight border border-line text-small font-semibold text-ink-2 hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40 ${focoVisible}`}
          >
            Repetir
          </button>
          <button
            type="button"
            onClick={onOtraParte}
            disabled={procesando}
            className={`press min-h-11 flex-1 rounded-tight border border-line text-small font-semibold text-ink-2 hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40 ${focoVisible}`}
          >
            + Otra parte
          </button>
        </div>
        <button
          type="button"
          onClick={onCancelar}
          disabled={procesando}
          className={`press min-h-10 text-small font-semibold text-muted hover:text-ink-2 disabled:cursor-not-allowed disabled:opacity-40 ${focoVisible}`}
        >
          Cancelar
        </button>
      </div>
    </div>
  );
}

export default function NotasView() {
  const person = useStore((s) => s.person);
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

  const esCelular = useEsCelular();
  // `onReady` llega tarde (cuando el lienzo terminó de cargar): lee el valor vigente, no el de su cierre.
  const esCelularRef = useRef(esCelular);
  esCelularRef.current = esCelular;

  const [searchParams, setSearchParams] = useSearchParams();
  const urlNote = searchParams.get("nota");

  const handleRef = useRef<LienzoHandle | null>(null);
  const pendingScene = useRef<CanvasScene | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  /** Qué botón está en vuelo: los tres comparten camino, pero cada uno enseña su propio «…ndo». */
  const [accion, setAccion] = useState<"transcribir" | "terminar" | "foto" | null>(null);
  /**
   * Guarda de reentrada real (una ref, no el estado `accion`): la foto
   * encadena «Transcribir» internamente, y si esa comprobación leyera
   * `accion` desde un cierre viejo, un `setAccion` en medio no la vería a
   * tiempo. Con una ref no hay cierre que se quede atrás.
   */
  const enVuelo = useRef(false);
  const fotoCameraRef = useRef<HTMLInputElement | null>(null);
  const fotoGaleriaRef = useRef<HTMLInputElement | null>(null);
  const [menuFotoAbierto, setMenuFotoAbierto] = useState(false);

  // Nota activa "de verdad" en este render: sirve para saber, DESDE `onReady`
  // (que se dispara al montar el lienzo, fuera de un efecto), a qué nota
  // corresponde el handle que acaba de llegar.
  const activeNoteIdRef = useRef<string | null>(null);
  activeNoteIdRef.current = activeNoteId;

  // ── Celular: Inicio / Revisar fotos / nota abierta con pestañas ─────────
  const [pestanaMovil, setPestanaMovil] = useState<"foto" | "texto" | "tareas">("foto");
  // Una foto tomada desde el Inicio fuerza la pestaña "Texto" al abrir la
  // nota nueva (se consume una sola vez, la siguiente nota vuelve a "Foto").
  const pestanaForzadaRef = useRef<"texto" | null>(null);
  useEffect(() => {
    if (pestanaForzadaRef.current) {
      setPestanaMovil(pestanaForzadaRef.current);
      pestanaForzadaRef.current = null;
    } else {
      setPestanaMovil("foto");
    }
  }, [activeNoteId]);

  const [fotosRevisar, setFotosRevisar] = useState<File[]>([]);
  const [creandoTablero, setCreandoTablero] = useState(false);
  const fotoInicioCameraRef = useRef<HTMLInputElement | null>(null);
  const fotoInicioGaleriaRef = useRef<HTMLInputElement | null>(null);
  /** Fotos ya reducidas esperando a que el lienzo de la nota NUEVA esté listo (`onReady`). */
  const pendingFotosRef = useRef<{ noteId: string; fotos: FotoReducida[] } | null>(null);

  // Las URLs de las miniaturas nacen y mueren en el mismo efecto: crearlas en un
  // useMemo y revocarlas en otro efecto las dejaba rotas (StrictMode desmonta y
  // remonta, y la limpieza revocaba las URLs que la vista seguía mostrando).
  const [urlsRevisar, setUrlsRevisar] = useState<string[]>([]);
  useEffect(() => {
    const urls = fotosRevisar.map((f) => URL.createObjectURL(f));
    setUrlsRevisar(urls);
    return () => {
      for (const url of urls) URL.revokeObjectURL(url);
    };
  }, [fotosRevisar]);

  // Lienzo a pantalla completa: el shell deja de pintar menú y cabecera
  // mientras dure, y se apaga sin falta al salir de la vista (navegar con el
  // modo puesto no puede dejar la app sin menú). Sólo existe en escritorio.
  const [pantallaCompleta, setPantallaCompleta] = useState(false);
  const setInmersivo = useShell((s) => s.setInmersivo);
  useEffect(() => {
    setInmersivo(pantallaCompleta && !esCelular);
  }, [pantallaCompleta, esCelular, setInmersivo]);
  useEffect(() => () => setInmersivo(false), [setInmersivo]);
  useEffect(() => {
    if (!pantallaCompleta || esCelular) return;
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
  }, [pantallaCompleta, esCelular]);

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
  // reciente (la lista ya viene ordenada por la API) — EN ESCRITORIO. En
  // celular manda el Inicio: no se abre ni se crea nada sin que el humano
  // toque algo.
  useEffect(() => {
    if (urlNote && urlNote !== activeNoteId) {
      openNote(urlNote);
      return;
    }
    if (esCelular) return;
    if (!urlNote && !activeNoteId && notes.length > 0) openNote(notes[0]!.id);
  }, [urlNote, activeNoteId, notes, openNote, esCelular]);

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

  const volverAInicio = useCallback(() => {
    setSearchParams((params) => {
      const next = new URLSearchParams(params);
      next.delete("nota");
      return next;
    });
  }, [setSearchParams]);

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
      if (!handle || !activeNoteId || enVuelo.current) return;
      setExportError(null);
      if (handle.estaVacio()) {
        setExportError("El lienzo está vacío: escribe algo antes de transcribir.");
        return;
      }
      enVuelo.current = true;
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
        enVuelo.current = false;
      }
    },
    [activeNoteId, captureNote, flush, transcribeNote],
  );

  // «Transcribir» sobre una nota ya terminada la rehace en modo final: no hay
  // borrador al que volver, y `converted` no admite intermedias.
  const modoTranscribir: NoteTranscribeMode = activeNote?.status === "draft" ? "interim" : "final";
  const transcribir = useCallback(() => leerLienzo(modoTranscribir), [leerLienzo, modoTranscribir]);
  const terminar = useCallback(() => leerLienzo("final"), [leerLienzo]);

  /**
   * «Foto»: reduce el archivo, lo pega en el lienzo y encadena EXACTAMENTE el
   * camino de «Transcribir» (captura + lectura): nada de repetir esa lógica
   * aquí. `enVuelo` se libera antes de llamar a `transcribir()` para que su
   * propio guardia no la vea ocupada.
   */
  const procesarFoto = useCallback(
    async (file: File) => {
      const handle = handleRef.current;
      if (!handle || !activeNoteId || enVuelo.current) return;
      enVuelo.current = true;
      setExportError(null);
      setAccion("foto");
      try {
        const foto = await reducirFoto(file);
        handle.insertarFoto(foto);
        await flush();
      } catch (err) {
        setExportError(err instanceof Error ? err.message : "No se pudo procesar la foto");
        return;
      } finally {
        setAccion(null);
        enVuelo.current = false;
      }
      await transcribir();
    },
    [activeNoteId, flush, transcribir],
  );

  /**
   * Igual que `procesarFoto`, pero para N fotos YA reducidas (Inicio del
   * celular, que las reduce todas antes de crear la nota): las pega una a
   * una —`insertarFoto` las va poniendo a la derecha de lo anterior— y
   * encadena el MISMO `transcribir()`, una sola vez para todas.
   */
  const insertarFotosYTranscribir = useCallback(
    async (fotos: readonly FotoReducida[]) => {
      const handle = handleRef.current;
      if (!handle) return;
      enVuelo.current = true;
      setExportError(null);
      setAccion("foto");
      try {
        for (const foto of fotos) handle.insertarFoto(foto);
        await flush();
      } catch (err) {
        setExportError(err instanceof Error ? err.message : "No se pudo procesar la foto");
        return;
      } finally {
        setAccion(null);
        enVuelo.current = false;
      }
      await transcribir();
    },
    [flush, transcribir],
  );

  const onReady = useCallback(
    (handle: LienzoHandle) => {
      handleRef.current = handle;
      // En el celular el zoom guardado suele venir del computador: al abrir, encuadrar todo.
      if (esCelularRef.current) handle.refrescar();
      const pending = pendingFotosRef.current;
      if (pending && pending.noteId === activeNoteIdRef.current) {
        pendingFotosRef.current = null;
        void insertarFotosYTranscribir(pending.fotos);
      }
    },
    [insertarFotosYTranscribir],
  );

  // Al volver a ver la pestaña «Foto» del celular, el lienzo llevaba oculto
  // (`hidden`, nunca desmontado): Excalidraw midió el contenedor al montar,
  // así que hay que decirle que se vuelva a medir.
  useEffect(() => {
    if (esCelular && pestanaMovil === "foto") handleRef.current?.refrescar();
  }, [esCelular, pestanaMovil, activeNoteId]);

  const elegirFoto = useCallback((origen: "camara" | "galeria") => {
    setMenuFotoAbierto(false);
    (origen === "camara" ? fotoCameraRef.current : fotoGaleriaRef.current)?.click();
  }, []);

  const onFotoElegida = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0] ?? null;
      e.target.value = "";
      if (file) void procesarFoto(file);
    },
    [procesarFoto],
  );

  // El menú «Foto» se cierra al tocar fuera de él o con Esc.
  useEffect(() => {
    if (!menuFotoAbierto) return;
    const cerrarFuera = (e: PointerEvent) => {
      if (!(e.target instanceof Element) || !e.target.closest("[data-menu-foto]")) setMenuFotoAbierto(false);
    };
    const cerrarEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuFotoAbierto(false);
    };
    document.addEventListener("pointerdown", cerrarFuera);
    document.addEventListener("keydown", cerrarEsc);
    return () => {
      document.removeEventListener("pointerdown", cerrarFuera);
      document.removeEventListener("keydown", cerrarEsc);
    };
  }, [menuFotoAbierto]);

  // ── Inicio del celular: fotografiar/subir → Revisar fotos ───────────────

  const fotografiarTablero = useCallback(() => fotoInicioCameraRef.current?.click(), []);
  const subirImagenInicio = useCallback(() => fotoInicioGaleriaRef.current?.click(), []);

  const onFotoInicioCamara = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null;
    e.target.value = "";
    if (file) setFotosRevisar((prev) => [...prev, file]);
  }, []);

  const onFotoInicioGaleria = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (files.length > 0) setFotosRevisar((prev) => [...prev, ...files]);
  }, []);

  const repetirFoto = useCallback(() => {
    setFotosRevisar((prev) => prev.slice(0, -1));
    fotoInicioCameraRef.current?.click();
  }, []);

  const otraParteFoto = useCallback(() => fotoInicioCameraRef.current?.click(), []);

  const cancelarRevision = useCallback(() => {
    setFotosRevisar([]);
    setExportError(null);
  }, []);

  /**
   * «Usar N fotos»: reduce todas, crea la nota (título `Tablero <fecha>`), la
   * abre y deja las fotos ya reducidas en `pendingFotosRef` — `onReady` las
   * inserta y transcribe en cuanto el lienzo de esa nota esté listo.
   */
  const usarFotos = useCallback(async () => {
    if (fotosRevisar.length === 0 || creandoTablero) return;
    setCreandoTablero(true);
    setExportError(null);
    try {
      const reducciones = await Promise.all(fotosRevisar.map((f) => reducirFoto(f)));
      await flush();
      // Antes de crear la nota: `createNote` ya deja `activeNoteId` puesto
      // (dispara el efecto que decide la pestaña) desde DENTRO de la propia
      // llamada, así que la marca tiene que estar lista antes, no después.
      pestanaForzadaRef.current = "texto";
      const note = await createNote({ title: tituloTablero(new Date()) });
      if (!note) {
        pestanaForzadaRef.current = null;
        return;
      }
      pendingFotosRef.current = { noteId: note.id, fotos: reducciones };
      setFotosRevisar([]);
      selectNote(note.id);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : "No se pudo procesar la foto");
    } finally {
      setCreandoTablero(false);
    }
  }, [fotosRevisar, creandoTablero, flush, createNote, selectNote]);

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

  /**
   * «Foto»: pizarra, tablero o cuaderno fotografiado con el celular. Abre un
   * menú con «Tomar foto» (cámara trasera, `capture="environment"`) y «Subir
   * imagen» (galería/archivos, sin `capture`); las mismas condiciones de
   * deshabilitado que Transcribir. Igual que `botonesLectura`, se reutiliza
   * tal cual en la cabecera normal, la barra mínima y la pestaña «Foto» del
   * celular (añade fotos a la nota YA abierta).
   */
  const botonFoto = (
    <div className="relative" data-menu-foto>
      <button
        type="button"
        onClick={() => setMenuFotoAbierto((abierto) => !abierto)}
        disabled={!activeNote || ocupado}
        aria-haspopup="true"
        aria-expanded={menuFotoAbierto}
        aria-label="Añadir foto de una pizarra o un tablero"
        className={`press inline-flex min-h-10 items-center gap-1.5 rounded-tight border border-line bg-surface px-3 text-small font-semibold text-ink-2 hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40 ${focoVisible}`}
      >
        <Camera size={15} strokeWidth={1.75} aria-hidden="true" />
        {accion === "foto" ? "Procesando foto…" : "Foto"}
      </button>
      {menuFotoAbierto ? (
        <div
          role="menu"
          aria-label="Añadir foto"
          className="absolute right-0 top-full z-10 mt-1 flex w-44 flex-col gap-0.5 rounded-tight border border-line bg-surface p-1 shadow-lg"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => elegirFoto("camara")}
            className={`press flex min-h-10 items-center rounded-tight px-2.5 text-small text-ink-2 hover:bg-surface-2 ${focoVisible}`}
          >
            Tomar foto
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => elegirFoto("galeria")}
            className={`press flex min-h-10 items-center rounded-tight px-2.5 text-small text-ink-2 hover:bg-surface-2 ${focoVisible}`}
          >
            Subir imagen
          </button>
        </div>
      ) : null}
      {/* Cámara trasera en celular; nunca se muestran, sólo abren el selector nativo. */}
      <input
        ref={fotoCameraRef}
        data-testid="foto-input-camara"
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        tabIndex={-1}
        aria-hidden="true"
        onChange={onFotoElegida}
      />
      <input
        ref={fotoGaleriaRef}
        data-testid="foto-input-galeria"
        type="file"
        accept="image/*"
        hidden
        tabIndex={-1}
        aria-hidden="true"
        onChange={onFotoElegida}
      />
    </div>
  );

  // El lienzo (o su spinner/estado vacío): el MISMO nodo se usa en el layout
  // de escritorio y en la pestaña «Foto» del celular — nunca los dos a la
  // vez, así que nunca hay dos instancias montadas.
  const lienzoElemento =
    notesLoading && notes.length === 0 ? (
      <div className="flex h-full items-center justify-center">
        <Spinner label="Cargando las notas…" />
      </div>
    ) : notesError ? (
      <div className="p-6">
        <ErrorBox message={notesError} onRetry={() => void loadNotes()} />
      </div>
    ) : !activeNote ? (
      <div className="flex h-full items-center justify-center p-6">
        <EmptyState title="Todavía no hay notas" hint="Crea una y empieza a escribir con la tableta." />
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
    );

  const bannerError = exportError ? (
    <div className="border-b border-broken-line bg-broken-bg px-4 py-2 text-small text-broken">{exportError}</div>
  ) : null;

  // Inputs ocultos del Inicio del celular: separados de los de `botonFoto`
  // porque disparan un flujo distinto (Revisar fotos, sin nota todavía) y la
  // galería aquí admite varias fotos de una vez (tablero ancho).
  const inputsInicioMovil = (
    <>
      <input
        ref={fotoInicioCameraRef}
        data-testid="foto-inicio-input-camara"
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        tabIndex={-1}
        aria-hidden="true"
        onChange={onFotoInicioCamara}
      />
      <input
        ref={fotoInicioGaleriaRef}
        data-testid="foto-inicio-input-galeria"
        type="file"
        accept="image/*"
        multiple
        hidden
        tabIndex={-1}
        aria-hidden="true"
        onChange={onFotoInicioGaleria}
      />
    </>
  );

  if (esCelular) {
    if (!urlNote) {
      return (
        <div className="flex h-full min-h-0 flex-col overflow-hidden" data-testid="notas-vista">
          {inputsInicioMovil}
          {fotosRevisar.length > 0 ? (
            <RevisarFotosMovil
              urls={urlsRevisar}
              onUsar={() => void usarFotos()}
              onRepetir={repetirFoto}
              onOtraParte={otraParteFoto}
              onCancelar={cancelarRevision}
              procesando={creandoTablero}
              error={exportError}
            />
          ) : (
            <InicioMovil
              personName={person?.full_name ?? null}
              notes={notes}
              activeNoteId={activeNoteId}
              onSelectNote={selectNote}
              onFotografiar={fotografiarTablero}
              onSubirImagen={subirImagenInicio}
              onNotaAMano={() => void nuevaNota()}
              creandoNota={false}
            />
          )}
        </div>
      );
    }

    // D. Nota abierta: cabecera compacta + pestañas Foto/Texto/Tareas.
    return (
      <div className="flex h-full min-h-0 flex-col overflow-hidden" data-testid="notas-vista">
        {inputsInicioMovil}
        <header className="flex shrink-0 items-center gap-2 border-b border-line bg-surface px-2 pb-2 pt-[calc(env(safe-area-inset-top)+0.5rem)]">
          <button
            type="button"
            onClick={volverAInicio}
            aria-label="Volver"
            className={`press inline-flex min-h-11 min-w-11 items-center justify-center rounded-tight text-ink-2 hover:bg-surface-2 ${focoVisible}`}
          >
            <ArrowLeft size={20} strokeWidth={1.75} aria-hidden="true" />
          </button>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-small font-semibold text-ink">{activeNote?.title ?? "Notas a mano"}</h1>
            <span
              aria-live="polite"
              data-testid="indicador-guardado"
              className="block truncate text-label text-muted"
            >
              {savedLabel}
            </span>
          </div>
          {activeNote ? (
            <span
              className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-label ${STATUS_CLASSES[activeNote.status]}`}
            >
              {STATUS_LABELS[activeNote.status]}
            </span>
          ) : null}
        </header>

        <div role="tablist" aria-label="Secciones de la nota" className="flex shrink-0 gap-1 border-b border-line bg-surface px-2 py-1.5">
          {(
            [
              ["foto", "Foto"],
              ["texto", "Texto"],
              ["tareas", "Tareas"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={pestanaMovil === id}
              onClick={() => setPestanaMovil(id)}
              className={`press min-h-11 flex-1 rounded-tight text-small font-semibold ${focoVisible} ${
                pestanaMovil === id
                  ? "bg-ink text-surface"
                  : "border border-line text-ink-2 hover:bg-surface-2"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {bannerError}

        <div className="min-h-0 flex-1 overflow-hidden">
          {/* El lienzo NO se desmonta al cambiar de pestaña: sólo se oculta. */}
          <div className={`flex h-full min-h-0 flex-col ${pestanaMovil === "foto" ? "" : "hidden"}`}>
            <div className="min-h-0 flex-1 overflow-hidden bg-surface">{lienzoElemento}</div>
            <div className="flex shrink-0 items-center gap-2 border-t border-line bg-surface px-3 py-2 pb-[calc(env(safe-area-inset-bottom)+0.5rem)]">
              {botonFoto}
              <button
                type="button"
                onClick={() => void transcribir()}
                disabled={!activeNote || ocupado}
                className={`press inline-flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-tight border border-line bg-surface text-small font-semibold text-ink-2 hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40 ${focoVisible}`}
              >
                <Wand2 size={15} strokeWidth={1.75} aria-hidden="true" />
                {accion === "transcribir" ? "Transcribiendo…" : "Transcribir"}
              </button>
            </div>
          </div>

          {pestanaMovil === "texto" ? (
            <div className="h-full overflow-auto p-3">
              <TranscripcionSeccion
                activeNote={activeNote}
                borrador={borrador}
                onBorradorChange={setBorrador}
                onGuardar={() => void guardarTranscripcion()}
                noteTranscribing={noteTranscribing}
                noteTranscribeError={noteTranscribeError}
                noteDudas={noteDudas}
                terminar={{
                  onClick: () => void terminar(),
                  disabled: !activeNote || ocupado,
                  label: accion === "terminar" ? "Terminando…" : "Terminar nota",
                }}
              />
            </div>
          ) : null}

          {pestanaMovil === "tareas" ? (
            <div className="h-full overflow-auto p-3">
              {activeNote ? <PropuestasPanel key={activeNote.id} note={activeNote} /> : null}
            </div>
          ) : null}
        </div>
      </div>
    );
  }

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
          {botonFoto}
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
              {botonFoto}
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

      {bannerError}

      <div className="flex min-h-0 flex-1">
        {/* El lienzo nunca baja del 60 % del ancho en escritorio: el panel
            (w-80, max 40 %) cede antes. `min-h-0` + `overflow-hidden` para que
            Excalidraw reciba una altura definida y no empuje la página. */}
        <section className="min-h-0 min-w-0 flex-1 overflow-hidden bg-surface lg:min-w-[60%]">
          {lienzoElemento}
        </section>

        {pantallaCompleta ? null : (
        <aside
          data-testid="panel-lateral-notas"
          className="hidden w-80 max-w-[40%] shrink-0 flex-col gap-3 overflow-auto border-l border-line bg-canvas p-3 lg:flex"
        >
          <TranscripcionSeccion
            activeNote={activeNote}
            borrador={borrador}
            onBorradorChange={setBorrador}
            onGuardar={() => void guardarTranscripcion()}
            noteTranscribing={noteTranscribing}
            noteTranscribeError={noteTranscribeError}
            noteDudas={noteDudas}
          />

          {activeNote ? <PropuestasPanel key={activeNote.id} note={activeNote} /> : null}

          <NotasRecientesLista notes={notes} activeNoteId={activeNoteId} onSelect={selectNote} />
        </aside>
        )}
      </div>
    </div>
  );
}
