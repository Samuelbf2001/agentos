/**
 * Los dos botones que acompañan a un campo de texto de la tarea.
 *
 * "Pon un icono de IA y que la IA consulte el contexto del cliente y complete
 * la solicitud, mejorando su detalle, pasos, etc.; al lado otro botón para
 * copiar el prompt de ejecución y pegarlo en Claude Code."
 *
 * ✦ redacta: pide `mode:"enrich"` con el borrador ENTERO (aunque la tarea aún
 * no exista) y enseña la propuesta antes de tocar nada — aplicar es del humano.
 * ⧉ copia: pide `mode:"execution_prompt"` y lo deja en el portapapeles; si el
 * navegador no lo permite, el texto se abre en una ventana para copiarlo a
 * mano, porque un botón que falla en silencio es peor que no tenerlo.
 *
 * Mientras trabaja late el punto de 7 px (`.pip`), nunca el botón: el
 * contenedor quieto es la regla 9 de la dirección visual.
 */
import { useRef, useState } from "react";
import { api, ApiError } from "../../lib/api";
import { Markdown } from "../../components/Markdown";
import { InlinePopover } from "../../components/ui/InlinePopover";
import { Modal } from "../../components/ui/Modal";
import { useStore } from "../../state/store";
import type { TaskAssistContext, TaskAssistDraft, TaskAssistField } from "../../lib/types";

const FIELD_LABELS: Record<TaskAssistField, string> = {
  title: "el título",
  description: "la descripción",
  definition_of_done: "la definición de terminado",
};

const ICON_BUTTON =
  "press inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-tight text-small text-faint hover:bg-surface-2 hover:text-link focus:outline-none focus:ring-2 focus:ring-link disabled:cursor-not-allowed disabled:opacity-45";

export function contextoLegible(context: TaskAssistContext | null): string {
  if (!context) return "";
  const parts = [`Consultó ${context.docs} ${context.docs === 1 ? "documento" : "documentos"} de ${context.org_name}`];
  if (context.images > 0) parts.push(`${context.images} ${context.images === 1 ? "imagen" : "imágenes"}`);
  if (context.sibling_tasks > 0) {
    parts.push(`${context.sibling_tasks} ${context.sibling_tasks === 1 ? "tarea" : "tareas"} del proyecto`);
  }
  return parts.join(" · ");
}

/**
 * "Copiar prompt de ejecución": el mismo botón con dos pieles —icono junto a
 * un campo, texto en la cabecera de la ficha— y una sola implementación.
 */
export function ExecutionPromptButton({
  draft,
  taskId,
  variant = "icon",
  className = "",
}: {
  draft: () => TaskAssistDraft;
  taskId?: string;
  variant?: "icon" | "text";
  className?: string;
}) {
  const pushToast = useStore((state) => state.pushToast);
  const [copying, setCopying] = useState(false);
  const [fallback, setFallback] = useState<string | null>(null);
  const fallbackRef = useRef<HTMLTextAreaElement>(null);

  async function copiar(): Promise<void> {
    if (copying) return;
    setCopying(true);
    try {
      const result = await api.taskAssist({
        mode: "execution_prompt",
        ...(taskId ? { task_id: taskId } : {}),
        draft: draft(),
      });
      try {
        await navigator.clipboard.writeText(result.text);
        pushToast("ok", "Prompt copiado, pégalo en Claude Code");
      } catch {
        // Sin permiso de portapapeles (o sin HTTPS): se enseña el texto.
        setFallback(result.text);
      }
    } catch (err) {
      if (err instanceof ApiError && err.code === "provider_unavailable") {
        pushToast("error", "El asistente no está disponible");
      } else {
        pushToast("error", err instanceof Error ? err.message : "No se pudo generar el prompt");
      }
    } finally {
      setCopying(false);
    }
  }

  return (
    <>
      <button
        type="button"
        data-testid={variant === "text" ? "copiar-prompt-ejecucion" : "field-assist-prompt"}
        aria-label="Copiar prompt de ejecución"
        title="Copiar prompt de ejecución para pegarlo en Claude Code"
        aria-busy={copying}
        disabled={copying}
        onClick={() => void copiar()}
        className={
          variant === "text"
            ? `press inline-flex min-h-10 items-center gap-1.5 rounded-tight px-2 text-small font-semibold text-muted hover:text-link focus:outline-none focus:ring-2 focus:ring-link disabled:opacity-45 ${className}`
            : `${ICON_BUTTON} ${className}`
        }
      >
        {copying ? <span className="pip" aria-hidden="true" /> : <span aria-hidden="true">⧉</span>}
        {variant === "text" ? <span>Copiar prompt de ejecución</span> : null}
      </button>

      <Modal
        open={fallback !== null}
        onOpenChange={(value) => !value && setFallback(null)}
        title="Prompt de ejecución"
        description="Tu navegador no dejó copiar automáticamente. Selecciónalo y cópialo."
        testId="prompt-fallback"
        closeLabel="Cerrar el prompt"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          requestAnimationFrame(() => {
            fallbackRef.current?.focus();
            fallbackRef.current?.select();
          });
        }}
      >
        <label htmlFor="prompt-fallback-text" className="sr-only">
          Prompt de ejecución
        </label>
        <textarea
          ref={fallbackRef}
          id="prompt-fallback-text"
          data-testid="prompt-fallback-text"
          readOnly
          value={fallback ?? ""}
          rows={16}
          className="w-full resize-y rounded-soft border border-line bg-surface-2 p-3 font-mono text-small focus:outline-none focus:ring-2 focus:ring-link"
        />
      </Modal>
    </>
  );
}

export interface FieldAssistProps {
  field: TaskAssistField;
  /** Se lee en el momento de pulsar: el borrador cambia mientras se escribe. */
  draft: () => TaskAssistDraft;
  taskId?: string;
  onApply(text: string): void;
  /** El título no ofrece "copiar prompt": un prompt de una línea no sirve. */
  showPrompt?: boolean;
  className?: string;
}

export function FieldAssist({
  field,
  draft,
  taskId,
  onApply,
  showPrompt = true,
  className = "",
}: FieldAssistProps) {
  const pushToast = useStore((state) => state.pushToast);
  const [enriching, setEnriching] = useState(false);
  const [open, setOpen] = useState(false);
  const [proposal, setProposal] = useState("");
  const [context, setContext] = useState<TaskAssistContext | null>(null);

  function reportar(err: unknown, fallback: string): void {
    if (err instanceof ApiError && err.code === "provider_unavailable") {
      pushToast("error", "El asistente no está disponible");
      return;
    }
    pushToast("error", err instanceof Error ? err.message : fallback);
  }

  async function mejorar(): Promise<void> {
    if (enriching) return;
    setEnriching(true);
    try {
      const result = await api.taskAssist({
        mode: "enrich",
        field,
        ...(taskId ? { task_id: taskId } : {}),
        draft: draft(),
      });
      setProposal(result.text);
      setContext(result.context);
      setOpen(true);
    } catch (err) {
      reportar(err, "No se pudo consultar al asistente");
    } finally {
      setEnriching(false);
    }
  }

  const trigger = (
    <button
      type="button"
      data-testid={`field-assist-ai-${field}`}
      aria-label={`Mejorar ${FIELD_LABELS[field]} con IA`}
      title="Mejorar con IA: consulta el contexto del cliente"
      aria-busy={enriching}
      disabled={enriching}
      onClick={(event) => {
        // Es el disparador del popover, pero el panel NO se abre al pulsar:
        // se abre cuando hay propuesta. `preventDefault` es lo que Radix mira
        // para no ejecutar su propio toggle.
        event.preventDefault();
        void mejorar();
      }}
      className={ICON_BUTTON}
    >
      {enriching ? <span className="pip" aria-hidden="true" /> : <span aria-hidden="true">✦</span>}
      <span className="sr-only">{enriching ? "Consultando al asistente…" : ""}</span>
    </button>
  );

  return (
    <span className={`inline-flex items-center gap-0.5 ${className}`}>
      <InlinePopover
        open={open}
        onOpenChange={setOpen}
        align="end"
        label="Propuesta del asistente"
        className="w-[min(94vw,30rem)]"
        testId={`field-assist-panel-${field}`}
        trigger={trigger}
      >
        <div data-testid="field-assist-panel">
          <p className="px-1 text-label font-bold text-faint" data-testid="field-assist-context">
            {contextoLegible(context)}
          </p>
          <div className="mt-1 max-h-64 overflow-y-auto rounded-tight bg-surface-2 p-2 text-small text-ink-2">
            <Markdown>{proposal}</Markdown>
          </div>
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              data-testid="field-assist-apply"
              onClick={() => {
                onApply(proposal);
                setOpen(false);
              }}
              className="press min-h-10 rounded-soft bg-ink px-3 py-1.5 text-small font-semibold text-surface hover:bg-ink-2 focus:outline-none focus:ring-2 focus:ring-link"
            >
              Aplicar
            </button>
            <button
              type="button"
              data-testid="field-assist-discard"
              onClick={() => setOpen(false)}
              className="press min-h-10 rounded-soft px-3 py-1.5 text-small font-semibold text-muted hover:bg-line-soft focus:outline-none focus:ring-2 focus:ring-link"
            >
              Descartar
            </button>
          </div>
        </div>
      </InlinePopover>

      {showPrompt ? (
        <ExecutionPromptButton draft={draft} {...(taskId ? { taskId } : {})} />
      ) : null}
    </span>
  );
}

export default FieldAssist;
