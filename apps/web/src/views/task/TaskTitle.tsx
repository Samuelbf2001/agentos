/**
 * Título como H1 contenteditable (Notion): clic → cursor. Guarda en blur y
 * con Enter; Esc revierte. Un título vacío no se envía: se restaura el
 * anterior en vez de dejar la tarea sin nombre.
 *
 * Lleva el icono de IA (sólo ese: un "prompt de ejecución" de una línea no
 * sirve de nada), y lo que la IA proponga se guarda como cualquier edición.
 */
import { useEffect, useRef } from "react";
import type { TaskAssistDraft } from "../../lib/types";
import { FieldAssist } from "./FieldAssist";

export function TaskTitle({
  value,
  onSave,
  assist,
}: {
  value: string;
  onSave: (title: string) => Promise<boolean>;
  assist?: { draft: () => TaskAssistDraft; taskId?: string };
}) {
  const ref = useRef<HTMLHeadingElement>(null);
  const lastValue = useRef(value);

  // El H1 es no controlado (contenteditable): se sincroniza sólo cuando el
  // valor cambia por fuera y el usuario no está escribiendo en él.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (document.activeElement === el && el.textContent !== value && lastValue.current === value) return;
    if (el.textContent !== value) el.textContent = value;
    lastValue.current = value;
  }, [value]);

  function commit(): void {
    const el = ref.current;
    if (!el) return;
    const next = (el.textContent ?? "").replace(/\s+/g, " ").trim();
    if (!next) {
      el.textContent = value;
      return;
    }
    if (next === value) {
      el.textContent = value;
      return;
    }
    el.textContent = next;
    void onSave(next).then((ok) => {
      if (!ok && ref.current && document.activeElement !== ref.current) ref.current.textContent = value;
    });
  }

  function aplicar(text: string): void {
    const next = text.replace(/\s+/g, " ").trim();
    if (!next || next === value) return;
    if (ref.current) ref.current.textContent = next;
    void onSave(next).then((ok) => {
      if (!ok && ref.current) ref.current.textContent = value;
    });
  }

  return (
    <div className="flex items-start gap-1">
    <h1
      ref={ref}
      contentEditable
      suppressContentEditableWarning
      role="textbox"
      aria-label="Título de la tarea"
      aria-multiline={false}
      data-testid="task-title"
      spellCheck={false}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          ref.current?.blur();
        } else if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          if (ref.current) ref.current.textContent = value;
          ref.current?.blur();
        }
      }}
      className="min-h-10 min-w-0 flex-1 break-words rounded-tight px-1 text-[1.5rem] font-semibold leading-tight tracking-tight text-ink outline-none empty:before:text-faint empty:before:content-['Sin_título'] hover:bg-surface-2 focus:bg-surface focus:ring-2 focus:ring-link"
    />
      {assist ? (
        <span className="mt-2 shrink-0">
          <FieldAssist
            field="title"
            draft={assist.draft}
            {...(assist.taskId ? { taskId: assist.taskId } : {})}
            showPrompt={false}
            onApply={aplicar}
          />
        </span>
      ) : null}
    </div>
  );
}
