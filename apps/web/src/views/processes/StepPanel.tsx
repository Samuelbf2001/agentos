/**
 * Panel lateral del paso seleccionado: texto, responsable, sistema, entrada
 * y salida, más las acciones de reordenar. Mismo patrón visual que RolePanel.
 * En readOnly todo es lectura, sin botones de acción.
 */
import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { ActionButton } from "../../components/system";
import type { ProcessStep } from "../../lib/types";

export interface StepPanelProps {
  step: ProcessStep;
  index: number;
  total: number;
  readOnly: boolean;
  roleNames: string[];
  onClose(): void;
  onCommit(patch: Partial<ProcessStep>): void;
  onInsertAfter(): void;
  onMoveBefore(): void;
  onMoveAfter(): void;
  onDelete(): void;
}

export default function StepPanel({
  step,
  index,
  total,
  readOnly,
  roleNames,
  onClose,
  onCommit,
  onInsertAfter,
  onMoveBefore,
  onMoveAfter,
  onDelete,
}: StepPanelProps) {
  const [textDraft, setTextDraft] = useState(step.step);
  const [systemDraft, setSystemDraft] = useState(step.system ?? "");
  const [inputDraft, setInputDraft] = useState(step.input ?? "");
  const [outputDraft, setOutputDraft] = useState(step.output ?? "");

  useEffect(() => setTextDraft(step.step), [index, step.step]);
  useEffect(() => setSystemDraft(step.system ?? ""), [index, step.system]);
  useEffect(() => setInputDraft(step.input ?? ""), [index, step.input]);
  useEffect(() => setOutputDraft(step.output ?? ""), [index, step.output]);

  function commitText() {
    if (textDraft === step.step) return;
    onCommit({ step: textDraft });
  }
  function commitSystem() {
    const trimmed = systemDraft.trim();
    if (trimmed === (step.system ?? "")) return;
    onCommit({ system: trimmed || undefined });
  }
  function commitInput() {
    const trimmed = inputDraft.trim();
    if (trimmed === (step.input ?? "")) return;
    onCommit({ input: trimmed || undefined });
  }
  function commitOutput() {
    const trimmed = outputDraft.trim();
    if (trimmed === (step.output ?? "")) return;
    onCommit({ output: trimmed || undefined });
  }

  return (
    <aside
      data-testid="step-panel"
      className="w-full shrink-0 overflow-y-auto rounded-panel bg-surface p-5 shadow-raise md:w-[340px]"
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-label text-faint">
          Paso {index + 1} de {total}
        </p>
        <button
          type="button"
          onClick={onClose}
          aria-label="Cerrar panel"
          className="press shrink-0 rounded-full p-1 text-faint hover:bg-canvas-deep hover:text-ink-2"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <label className="mt-3 block">
        <span className="mb-1 block text-label text-faint">Paso</span>
        <textarea
          value={textDraft}
          disabled={readOnly}
          rows={3}
          onChange={(e) => setTextDraft(e.target.value)}
          onBlur={commitText}
          className="w-full resize-none rounded-tight border border-line bg-surface px-2 py-1.5 text-small text-ink disabled:opacity-70"
        />
      </label>

      <label className="mt-3 block">
        <span className="mb-1 block text-label text-faint">Responsable</span>
        <select
          value={step.responsible ?? ""}
          disabled={readOnly}
          onChange={(e) => onCommit({ responsible: e.target.value || undefined })}
          className="w-full rounded-tight border border-line bg-surface px-2 py-1.5 text-small text-ink disabled:opacity-70"
        >
          <option value="">Sin responsable</option>
          {roleNames.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>

      <label className="mt-3 block">
        <span className="mb-1 block text-label text-faint">Sistema</span>
        <input
          value={systemDraft}
          disabled={readOnly}
          onChange={(e) => setSystemDraft(e.target.value)}
          onBlur={commitSystem}
          className="w-full rounded-tight border border-line bg-surface px-2 py-1.5 text-small text-ink disabled:opacity-70"
        />
      </label>

      <label className="mt-3 block">
        <span className="mb-1 block text-label text-faint">Entrada</span>
        <input
          value={inputDraft}
          disabled={readOnly}
          onChange={(e) => setInputDraft(e.target.value)}
          onBlur={commitInput}
          className="w-full rounded-tight border border-line bg-surface px-2 py-1.5 text-small text-ink disabled:opacity-70"
        />
      </label>

      <label className="mt-3 block">
        <span className="mb-1 block text-label text-faint">Salida</span>
        <input
          value={outputDraft}
          disabled={readOnly}
          onChange={(e) => setOutputDraft(e.target.value)}
          onBlur={commitOutput}
          className="w-full rounded-tight border border-line bg-surface px-2 py-1.5 text-small text-ink disabled:opacity-70"
        />
      </label>

      {!readOnly ? (
        <div className="mt-6 flex flex-col gap-1.5 border-t border-line-soft pt-4">
          <ActionButton variant="quiet" onClick={onInsertAfter}>
            Insertar paso después
          </ActionButton>
          <ActionButton variant="quiet" disabled={index === 0} onClick={onMoveBefore}>
            Mover antes
          </ActionButton>
          <ActionButton variant="quiet" disabled={index === total - 1} onClick={onMoveAfter}>
            Mover después
          </ActionButton>
          <ActionButton variant="danger" onClick={onDelete}>
            Eliminar paso
          </ActionButton>
        </div>
      ) : null}
    </aside>
  );
}
