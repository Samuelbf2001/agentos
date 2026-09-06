/**
 * Bloque de propiedades bajo el título (tabla icono+nombre | valor). Núcleo
 * visible según el llenado real de Notion (§0): Estado, Vencimiento,
 * Proyecto, Asignado, Prioridad. El resto va plegado tras "N más
 * propiedades", con el estado del pliegue en localStorage.
 */
import { useState } from "react";
import { PopoverOption } from "../../components/ui/InlinePopover";
import { PriorityDot } from "../../components/ui";
import { STAGE_LABELS } from "../../components/system";
import { guardarMasPropiedades, leerMasPropiedades } from "../../lib/tareas";
import type { Agent, Project, Task, TaskPriority } from "../../lib/types";
import { useStore } from "../../state/store";
import { DatePicker } from "./DatePicker";
import { LabelsPicker } from "./LabelsPicker";
import { PeoplePicker } from "./PeoplePicker";
import { ClientRow, ProjectPicker } from "./ProjectPicker";
import { PropertyRow, useInlineCommit } from "./PropertyRow";
import { StatusPicker } from "./StatusPicker";

export const PRIORITY_LABELS: Record<TaskPriority, string> = {
  low: "Baja",
  normal: "Normal",
  high: "Alta",
  urgent: "Urgente",
};

const PRIORITIES: TaskPriority[] = ["low", "normal", "high", "urgent"];

export function PriorityPicker({ task }: { task: Task }) {
  const updateTask = useStore((state) => state.updateTask);
  const { open, setOpen, notice, commit } = useInlineCommit(task.id);

  function choose(priority: TaskPriority): void {
    setOpen(false);
    if (priority === task.priority) return;
    void commit(
      () => updateTask(task.id, { priority }),
      () => PRIORITY_LABELS[useStore.getState().taskDetail?.task.priority ?? task.priority],
    );
  }

  return (
    <PropertyRow
      icon="!"
      label="Prioridad"
      testId="prop-priority"
      open={open}
      onOpenChange={setOpen}
      notice={notice}
      editor={
        <div role="listbox" aria-label="Prioridad de la tarea" className="flex flex-col gap-0.5">
          {PRIORITIES.map((priority) => (
            <PopoverOption key={priority} selected={priority === task.priority} onSelect={() => choose(priority)} testId={`priority-option-${priority}`}>
              <PriorityDot priority={priority} />
              <span>{PRIORITY_LABELS[priority]}</span>
            </PopoverOption>
          ))}
        </div>
      }
    >
      <PriorityDot priority={task.priority} />
      <span>{PRIORITY_LABELS[task.priority]}</span>
    </PropertyRow>
  );
}

export function TaskProperties({
  task,
  project,
  agent,
  onNavigate,
}: {
  task: Task;
  project: Project | null;
  agent: Agent | null;
  onNavigate?: () => void;
}) {
  const [more, setMore] = useState(() => leerMasPropiedades());

  function toggleMore(): void {
    setMore((value) => {
      guardarMasPropiedades(!value);
      return !value;
    });
  }

  // Filas plegables: Cliente, Etapa, Etiquetas, Agente. Vacías → ocultas
  // mientras está plegado; desplegadas se ven como "Vacío" para poder rellenar.
  const rest = [
    { key: "client", node: <ClientRow project={project} /> },
    {
      key: "stage",
      node: (
        <PropertyRow icon="≡" label="Etapa" testId="prop-stage">
          <span className="rounded-full border border-line bg-surface px-2 py-0.5 text-label text-muted">{STAGE_LABELS[task.stage]}</span>
        </PropertyRow>
      ),
    },
    { key: "labels", node: <LabelsPicker task={task} /> },
    {
      key: "agent",
      node: (
        <PropertyRow icon="◈" label="Agente" testId="prop-agent" empty={!agent}>
          {agent ? (
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-ink text-[0.625rem] font-bold text-surface">{agent.name.slice(0, 2).toUpperCase()}</span>
              <span className="text-small font-medium text-ink-2">{agent.name}</span>
            </span>
          ) : null}
        </PropertyRow>
      ),
    },
  ];

  return (
    <section className="mt-3 border-b border-line-soft pb-2" aria-label="Propiedades" data-testid="task-properties">
      <div className="flex flex-col gap-0.5">
        <StatusPicker task={task} />
        <DatePicker task={task} />
        <ProjectPicker task={task} project={project} onNavigate={onNavigate} />
        <PeoplePicker task={task} />
        <PriorityPicker task={task} />
        {more ? rest.map((row) => <div key={row.key}>{row.node}</div>) : null}
      </div>
      <button
        type="button"
        aria-expanded={more}
        data-testid="task-more-properties"
        onClick={toggleMore}
        className="mt-1 flex min-h-10 items-center gap-1.5 rounded-tight px-2 text-small font-medium text-muted hover:bg-surface-2 hover:text-ink-2 focus:outline-none focus:ring-2 focus:ring-link"
      >
        <span aria-hidden="true">{more ? "▾" : "▸"}</span>
        {more ? "Menos propiedades" : `${rest.length} más propiedades`}
      </button>
    </section>
  );
}
