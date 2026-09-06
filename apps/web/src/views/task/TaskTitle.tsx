/**
 * Título como H1 contenteditable (Notion): clic → cursor. Guarda en blur y
 * con Enter; Esc revierte. Un título vacío no se envía: se restaura el
 * anterior en vez de dejar la tarea sin nombre.
 */
import { useEffect, useRef } from "react";

export function TaskTitle({
  value,
  onSave,
}: {
  value: string;
  onSave: (title: string) => Promise<boolean>;
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

  return (
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
      className="min-h-10 break-words rounded-tight px-1 text-[1.5rem] font-semibold leading-tight tracking-tight text-ink outline-none empty:before:text-faint empty:before:content-['Sin_título'] hover:bg-surface-2 focus:bg-surface focus:ring-2 focus:ring-link"
    />
  );
}
