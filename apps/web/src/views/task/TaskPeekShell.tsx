/**
 * Contenedor de la ficha al estilo Notion (§4.1): side peek redimensionable
 * (tirador accesible, ancho persistido), center peek y página completa, con
 * conmutador en la cabecera. Radix Dialog con `modal={false}`: sin overlay
 * opaco, el tablero sigue operable detrás. Esc cierra; el clic fuera sólo
 * cierra en modo center (en side/full arrastrar sobre el tablero no cierra).
 *
 * Coexistencia con el copiloto (decisión §3.1): en ≥1280px el peek empuja el
 * contenido (`--task-peek-inset` → `padding-right` del <main>) y convive con
 * el panel; por debajo, abrir el peek cierra el copiloto. <768px: ancho
 * completo, sin tirador.
 */
import * as Dialog from "@radix-ui/react-dialog";
import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "../../state/store";
import {
  acotarAnchoPeek,
  anchoDesdePuntero,
  anchoMaximoPeek,
  guardarAnchoPeek,
  guardarModoPeek,
  leerAnchoPeek,
  leerModoPeek,
  PEEK_KEY_STEP,
  PEEK_MIN_WIDTH,
  PEEK_MODES,
  type PeekMode,
} from "../../lib/tareas";
import { TaskBody } from "./TaskBody";

export const PEEK_INSET_VAR = "--task-peek-inset";
const MOBILE_MAX = 768;
const COEXIST_MIN = 1280;

const MODE_LABELS: Record<PeekMode, string> = {
  side: "Panel lateral",
  center: "Centrado",
  full: "Página completa",
};

const MODE_ICONS: Record<PeekMode, string> = {
  side: "◨",
  center: "▣",
  full: "⛶",
};

function useViewportWidth(): number {
  const [width, setWidth] = useState(() => (typeof window !== "undefined" ? window.innerWidth : 1280));
  useEffect(() => {
    const update = () => setWidth(window.innerWidth);
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return width;
}

/** Tirador del borde izquierdo: puntero (con captura) y teclado. */
function ResizeHandle({
  width,
  viewport,
  onResize,
  onCommit,
}: {
  width: number;
  viewport: number;
  onResize(width: number): void;
  onCommit(width: number): void;
}) {
  const dragging = useRef(false);
  const latest = useRef(width);
  latest.current = width;

  useEffect(() => {
    function onMove(event: PointerEvent) {
      if (!dragging.current) return;
      event.preventDefault();
      onResize(anchoDesdePuntero(event.clientX, window.innerWidth));
    }
    function onUp() {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      onCommit(latest.current);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [onResize, onCommit]);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Ancho de la ficha"
      aria-valuenow={Math.round(width)}
      aria-valuemin={PEEK_MIN_WIDTH}
      aria-valuemax={anchoMaximoPeek(viewport)}
      tabIndex={0}
      data-testid="peek-resize"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        dragging.current = true;
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          // jsdom y algunos navegadores antiguos no implementan la captura.
        }
      }}
      onKeyDown={(event) => {
        let next: number | null = null;
        if (event.key === "ArrowLeft") next = width + PEEK_KEY_STEP;
        else if (event.key === "ArrowRight") next = width - PEEK_KEY_STEP;
        else if (event.key === "Home") next = anchoMaximoPeek(viewport);
        else if (event.key === "End") next = PEEK_MIN_WIDTH;
        if (next === null) return;
        event.preventDefault();
        const clamped = acotarAnchoPeek(next, viewport);
        onResize(clamped);
        onCommit(clamped);
      }}
      className="group absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize touch-none select-none hover:bg-link/40 focus:outline-none focus-visible:bg-link"
    >
      <span className="sr-only">Arrastra o usa las flechas para cambiar el ancho</span>
    </div>
  );
}

export function TaskPeekShell() {
  const detail = useStore((state) => state.taskDetail);
  const loading = useStore((state) => state.taskDetailLoading);
  const detailError = useStore((state) => state.taskDetailError);
  const closeTask = useStore((state) => state.closeTask);
  const copilotOpen = useStore((state) => state.copilotOpen);
  const setCopilotOpen = useStore((state) => state.setCopilotOpen);
  const open = detail !== null || loading || Boolean(detailError);
  const viewport = useViewportWidth();
  const isMobile = viewport < MOBILE_MAX;
  const [mode, setMode] = useState<PeekMode>(() => leerModoPeek());
  const [width, setWidth] = useState(() => leerAnchoPeek());

  // Si la ventana encoge, el ancho guardado se reacota sin perder el valor.
  const effectiveWidth = acotarAnchoPeek(width, viewport);

  const commitWidth = useCallback((value: number) => {
    setWidth(value);
    guardarAnchoPeek(value);
  }, []);

  function changeMode(next: PeekMode): void {
    setMode(next);
    guardarModoPeek(next);
  }

  // Coexistencia con el copiloto: por debajo de 1280px no caben los dos.
  useEffect(() => {
    if (open && copilotOpen && viewport < COEXIST_MIN) setCopilotOpen(false);
  }, [open, copilotOpen, viewport, setCopilotOpen]);

  // Empujar el contenido en escritorio ancho (modo side).
  useEffect(() => {
    const root = document.documentElement;
    const push = open && mode === "side" && !isMobile && viewport >= COEXIST_MIN;
    root.style.setProperty(PEEK_INSET_VAR, push ? `${effectiveWidth}px` : "0px");
    return () => {
      root.style.setProperty(PEEK_INSET_VAR, "0px");
    };
  }, [open, mode, isMobile, viewport, effectiveWidth]);

  if (!open) return null;

  const title = detail?.task.title ?? "Detalle de tarea";
  const sideStyle = mode === "side" && !isMobile ? { width: effectiveWidth } : undefined;
  const contentClass =
    isMobile || mode === "full"
      ? "fixed inset-0 z-50 flex h-[100dvh] w-full flex-col overflow-hidden bg-surface shadow-float focus:outline-none"
      : mode === "center"
        ? "fixed left-1/2 top-1/2 z-50 flex max-h-[85vh] w-[min(90vw,860px)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-panel border border-line bg-surface shadow-float focus:outline-none"
        : "fixed inset-y-0 right-0 z-50 flex h-full max-w-[100vw] flex-col overflow-hidden border-l border-line bg-surface shadow-float focus:outline-none";

  return (
    <Dialog.Root open={open} modal={false} onOpenChange={(value) => !value && closeTask()}>
      <Dialog.Portal>
        {mode === "center" && !isMobile ? <div className="fixed inset-0 z-40 bg-ink/10" aria-hidden="true" /> : null}
        <Dialog.Content
          role="complementary"
          aria-modal={false}
          aria-describedby="task-peek-description"
          data-testid="task-peek"
          data-mode={isMobile ? "mobile" : mode}
          style={sideStyle}
          className={contentClass}
          onInteractOutside={(event) => {
            // Side/full: arrastrar o hacer clic sobre el tablero no cierra.
            if (mode !== "center" || isMobile) event.preventDefault();
          }}
          onFocusOutside={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => {
            // Dentro de un campo, Esc sale del campo (el título revierte, los
            // textareas guardan al perder el foco); la ficha sólo se cierra
            // con Esc desde fuera de un campo.
            const target = event.target as HTMLElement | null;
            if (target && (target.isContentEditable || target.tagName === "TEXTAREA" || target.tagName === "INPUT")) {
              event.preventDefault();
              if (!target.isContentEditable) target.blur();
            }
          }}
          onOpenAutoFocus={(event) => {
            // Sin overlay, robar el foco al abrir desde la búsqueda o el
            // tablero corta el flujo; el foco va al contenido sólo si se pide.
            event.preventDefault();
          }}
        >
          {mode === "side" && !isMobile ? (
            <ResizeHandle width={effectiveWidth} viewport={viewport} onResize={setWidth} onCommit={commitWidth} />
          ) : null}

          <div className="flex shrink-0 items-center gap-1 border-b border-line bg-surface px-2 py-1.5 sm:px-3">
            <Dialog.Title className="sr-only">Ficha de tarea: {title}</Dialog.Title>
            <Dialog.Description id="task-peek-description" className="sr-only">
              Propiedades, descripción, evidencia y actividad de la tarea. Todo se edita en sitio.
            </Dialog.Description>
            {!isMobile ? (
              <div role="group" aria-label="Modo de la ficha" className="flex items-center gap-0.5 rounded-[11px] bg-canvas-deep p-[3px]">
                {PEEK_MODES.map((candidate) => (
                  <button
                    key={candidate}
                    type="button"
                    aria-pressed={mode === candidate}
                    aria-label={MODE_LABELS[candidate]}
                    title={MODE_LABELS[candidate]}
                    data-testid={`peek-mode-${candidate}`}
                    onClick={() => changeMode(candidate)}
                    className={`press inline-flex min-h-10 min-w-10 items-center justify-center rounded-tight px-2 text-small focus:outline-none focus:ring-2 focus:ring-link ${
                      mode === candidate ? "bg-surface text-ink shadow-rest" : "text-muted hover:text-ink-2"
                    }`}
                  >
                    <span aria-hidden="true">{MODE_ICONS[candidate]}</span>
                  </button>
                ))}
              </div>
            ) : null}
            <span className="ml-2 min-w-0 flex-1 truncate text-label font-bold uppercase text-faint">Ficha de tarea</span>
            <Dialog.Close
              className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-soft text-title text-faint hover:bg-line-soft hover:text-ink-2 focus:outline-none focus:ring-2 focus:ring-link"
              aria-label="Cerrar ficha"
            >
              ×
            </Dialog.Close>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-4 sm:px-6">
            <div className={mode === "full" && !isMobile ? "mx-auto max-w-[760px]" : undefined}>
              <TaskBody />
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
