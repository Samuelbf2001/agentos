/**
 * Etiquetas: chips con búsqueda sobre el catálogo del proyecto. Enter o coma
 * añaden; el aspa quita. Guarda al cerrar el popover (`PUT /labels`, sin
 * `expected_version` a propósito: las etiquetas no participan en la
 * reconciliación por versión).
 */
import { useMemo, useState } from "react";
import { PopoverOption } from "../../components/ui/InlinePopover";
import { normalizar } from "../../lib/tareas";
import { getTaskLabels, type LabelUsage, type Task } from "../../lib/types";
import { useStore } from "../../state/store";
import { PropertyRow, useInlineCommit } from "./PropertyRow";

/** Fila de la ficha: abre el editor y guarda al cerrar si cambió. */
export function LabelsPicker({ task }: { task: Task }) {
  const setTaskLabels = useStore((state) => state.setTaskLabels);
  const catalog = useStore((state) => state.labelCatalog);
  const { open, setOpen, notice, commit } = useInlineCommit(task.id);
  const labels = getTaskLabels(task);
  const [draft, setDraft] = useState<string[]>(labels);

  function handleOpenChange(value: boolean): void {
    if (value) {
      setDraft(labels);
      setOpen(true);
      return;
    }
    setOpen(false);
    if (draft.join("|") === labels.join("|")) return;
    void commit(
      () => setTaskLabels(task.id, draft),
      () => getTaskLabels(useStore.getState().taskDetail?.task ?? task).join(", ") || "sin etiquetas",
    );
  }

  return (
    <PropertyRow
      icon="#"
      label="Etiquetas"
      testId="prop-labels"
      open={open}
      onOpenChange={handleOpenChange}
      notice={notice}
      empty={labels.length === 0}
      editor={<LabelsEditor value={draft} onChange={setDraft} catalog={catalog} />}
    >
      <span className="flex flex-wrap gap-1">
        {labels.map((label) => (
          <span key={label} className="rounded-full bg-line-soft px-2 py-0.5 text-label font-medium text-ink-2">{label}</span>
        ))}
      </span>
    </PropertyRow>
  );
}

export function normalizeLabel(raw: string): string {
  return raw.trim().replace(/\s+/g, " ").toLocaleLowerCase("es");
}

/** Editor aislado (sin store) para poder probarlo y reutilizarlo. */
export function LabelsEditor({
  value,
  onChange,
  catalog,
  /** En el popover el foco va al campo; en un formulario largo, no: lo tiene el título. */
  autoFocus = true,
}: {
  value: string[];
  onChange(labels: string[]): void;
  catalog: LabelUsage[];
  autoFocus?: boolean;
}) {
  const [input, setInput] = useState("");
  const suggestions = useMemo(() => {
    const needle = normalizar(input);
    return catalog
      .filter((usage) => !value.includes(usage.label))
      .filter((usage) => !needle || normalizar(usage.label).includes(needle))
      .slice(0, 8);
  }, [catalog, input, value]);

  function add(raw: string): void {
    const label = normalizeLabel(raw);
    setInput("");
    if (!label || value.includes(label)) return;
    onChange([...value, label]);
  }

  return (
    <div>
      <div className="flex flex-wrap gap-1.5" data-testid="task-labels">
        {value.length === 0 ? <span className="px-1 text-small text-faint">Sin etiquetas.</span> : null}
        {value.map((label) => (
          <span key={label} className="inline-flex items-center gap-1 rounded-full bg-line-soft px-2 py-0.5 text-label font-medium text-ink-2">
            {label}
            <button
              type="button"
              aria-label={`Quitar etiqueta ${label}`}
              onClick={() => onChange(value.filter((item) => item !== label))}
              className="min-h-5 min-w-5 rounded-full text-faint hover:text-broken focus:outline-none focus:ring-2 focus:ring-link"
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <label htmlFor="task-label-input" className="sr-only">Nueva etiqueta</label>
      <input
        id="task-label-input"
        data-testid="task-label-input"
        autoFocus={autoFocus}
        value={input}
        onChange={(event) => setInput(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === ",") {
            event.preventDefault();
            add(input);
          } else if (event.key === "Backspace" && !input && value.length > 0) {
            onChange(value.slice(0, -1));
          }
        }}
        placeholder="Escribe y pulsa Enter…"
        className="mt-2 min-h-10 w-full rounded-soft border border-line px-2.5 py-2 text-small focus:border-link focus:outline-none focus:ring-2 focus:ring-link"
      />
      {suggestions.length > 0 ? (
        <div role="listbox" aria-label="Etiquetas del catálogo" className="mt-1 flex flex-col gap-0.5">
          {suggestions.map((usage) => (
            <PopoverOption key={usage.label} onSelect={() => add(usage.label)} testId={`label-option-${usage.label}`}>
              <span className="min-w-0 flex-1 truncate">{usage.label}</span>
              <span className="text-label text-faint">{usage.count}</span>
            </PopoverOption>
          ))}
        </div>
      ) : null}
    </div>
  );
}
