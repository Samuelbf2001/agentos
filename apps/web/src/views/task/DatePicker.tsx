/**
 * Vencimiento: popover con `<input type="datetime-local">` y "Quitar fecha".
 * Guarda al cerrar el popover si cambió (PATCH con `expected_version`).
 */
import { useState } from "react";
import { DuePill } from "../../components/ui";
import { taskDueTimestamp, type Task } from "../../lib/types";
import { useStore } from "../../state/store";
import { PropertyRow, useInlineCommit } from "./PropertyRow";
import { fromDateTimeLocal, toDateTimeLocal } from "./TaskBlocks";

export function DatePicker({ task }: { task: Task }) {
  const updateTask = useStore((state) => state.updateTask);
  const { open, setOpen, notice, commit } = useInlineCommit(task.id);
  const current = toDateTimeLocal(taskDueTimestamp(task));
  const [draft, setDraft] = useState(current);

  function describeCurrent(): string {
    const latest = useStore.getState().taskDetail?.task ?? task;
    const ts = taskDueTimestamp(latest);
    return ts ? new Date(ts).toLocaleString("es", { dateStyle: "medium", timeStyle: "short" }) : "sin fecha";
  }

  function save(next: string): void {
    const nextTs = fromDateTimeLocal(next);
    if (nextTs === taskDueTimestamp(task)) return;
    void commit(() => updateTask(task.id, { due_at: nextTs }), describeCurrent);
  }

  function handleOpenChange(value: boolean): void {
    if (value) {
      setDraft(toDateTimeLocal(taskDueTimestamp(task)));
      setOpen(true);
      return;
    }
    setOpen(false);
    save(draft);
  }

  const hasDate = taskDueTimestamp(task) !== null;

  return (
    <PropertyRow
      icon="▣"
      label="Vencimiento"
      testId="prop-due"
      open={open}
      onOpenChange={handleOpenChange}
      notice={notice}
      empty={!hasDate}
      editor={
        <div className="flex flex-col gap-2">
          <label htmlFor="task-due-at" className="text-label text-muted">Fecha y hora local</label>
          <input
            id="task-due-at"
            data-testid="task-due-at"
            type="datetime-local"
            autoFocus
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                handleOpenChange(false);
              }
            }}
            className="min-h-10 w-full rounded-soft border border-line px-2 py-2 text-body focus:border-link focus:outline-none focus:ring-2 focus:ring-link"
          />
          <button
            type="button"
            disabled={!draft && !hasDate}
            onClick={() => {
              setDraft("");
              setOpen(false);
              save("");
            }}
            className="min-h-10 rounded-soft border border-line px-3 py-1.5 text-small font-semibold text-muted hover:bg-surface-2 focus:outline-none focus:ring-2 focus:ring-link disabled:cursor-not-allowed disabled:opacity-40"
          >
            Quitar fecha
          </button>
        </div>
      }
    >
      <DuePill task={task} />
    </PropertyRow>
  );
}
