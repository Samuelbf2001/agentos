/**
 * Estado desde la ficha, sin modo edición. Va por la máquina de estados
 * (`moveTaskOptimistic` → `POST /api/tasks/:id/move` con `expected_version`),
 * nunca por PATCH: las invariantes del tablero no se relajan desde la UI.
 */
import { PopoverOption } from "../../components/ui/InlinePopover";
import { StatusPill, STATUS_LABELS } from "../../components/ui";
import { TASK_STATUSES, type Task } from "../../lib/types";
import { useStore } from "../../state/store";
import { PropertyRow, useInlineCommit } from "./PropertyRow";

export function StatusPicker({ task }: { task: Task }) {
  const moveTaskOptimistic = useStore((state) => state.moveTaskOptimistic);
  const { open, setOpen, notice, commit } = useInlineCommit(task.id);

  function choose(status: Task["status"]): void {
    setOpen(false);
    if (status === task.status) return;
    void commit(
      () => moveTaskOptimistic(task.id, status),
      () => STATUS_LABELS[useStore.getState().taskDetail?.task.status ?? task.status],
    );
  }

  return (
    <PropertyRow
      icon="◔"
      label="Estado"
      testId="prop-status"
      open={open}
      onOpenChange={setOpen}
      notice={notice}
      editor={
        <div role="listbox" aria-label="Estado de la tarea" className="flex flex-col gap-0.5">
          {TASK_STATUSES.map((status) => (
            <PopoverOption
              key={status}
              selected={status === task.status}
              onSelect={() => choose(status)}
              testId={`status-option-${status}`}
            >
              <StatusPill status={status} />
            </PopoverOption>
          ))}
        </div>
      }
    >
      <StatusPill status={task.status} />
    </PropertyRow>
  );
}
