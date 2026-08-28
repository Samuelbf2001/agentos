/**
 * Tablero kanban (US-2, spec B5 §4): carriles por stage × columnas por status,
 * tarjetas con avatar de agente, prioridad y badges de gate/bloqueo. dnd-kit
 * para arrastre humano → POST move optimista con reconciliación por evento.
 */
import { DndContext, PointerSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { useMemo } from "react";
import { useStore } from "../state/store";
import type { Stage, Task, TaskStatus } from "../lib/types";
import { STAGES, TASK_STATUSES } from "../lib/types";
import { AgentAvatar, EmptyState, ErrorBox, PriorityDot, Spinner, timeAgo } from "../components/ui";

const STAGE_LABEL: Record<Stage, string> = {
  ENTENDER: "Entender",
  CONSTRUIR: "Construir",
  OPERAR: "Operar",
};

function TaskCard({ task }: { task: Task }) {
  const agents = useStore((s) => s.agents);
  const openTask = useStore((s) => s.openTask);
  const agent = task.assigneeAgentId ? agents.find((a) => a.id === task.assigneeAgentId) : null;
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: task.id,
    data: { task },
  });

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      onClick={() => {
        if (!isDragging) void openTask(task.id);
      }}
      style={
        transform
          ? { transform: `translate(${transform.x}px, ${transform.y}px)`, zIndex: 30 }
          : undefined
      }
      className={`cursor-grab rounded-lg border border-slate-200 bg-white p-2 shadow-sm transition-shadow hover:shadow ${
        isDragging ? "opacity-70 shadow-lg" : ""
      }`}
      data-testid={`task-card-${task.id}`}
    >
      <div className="flex items-start gap-1.5">
        <PriorityDot priority={task.priority} />
        <p className="min-w-0 flex-1 text-xs font-medium leading-snug">{task.title}</p>
        {agent ? <AgentAvatar name={agent.name} slug={agent.slug} size={5} /> : null}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        {task.requiresApproval ? (
          <span className="rounded bg-violet-100 px-1 py-0.5 text-[9px] font-semibold text-violet-700">
            gate
          </span>
        ) : null}
        {task.externalEffect ? (
          <span className="rounded bg-orange-100 px-1 py-0.5 text-[9px] font-semibold text-orange-700">
            efecto externo
          </span>
        ) : null}
        {task.blockedReason ? (
          <span className="rounded bg-rose-100 px-1 py-0.5 text-[9px] font-semibold text-rose-700">
            {task.blockedReason === "approval" ? "esperando aprobación" : task.blockedReason}
          </span>
        ) : null}
        <span className="ml-auto text-[9px] text-slate-400">{timeAgo(task.updatedAt)}</span>
      </div>
    </div>
  );
}

function Cell({ stage, status, tasks }: { stage: Stage; status: TaskStatus; tasks: Task[] }) {
  const { setNodeRef, isOver } = useDroppable({ id: `${stage}|${status}`, data: { stage, status } });
  return (
    <div
      ref={setNodeRef}
      className={`min-h-16 space-y-1.5 rounded-md p-1 ${isOver ? "bg-sky-50 ring-1 ring-sky-300" : ""}`}
    >
      {tasks.map((t) => (
        <TaskCard key={t.id} task={t} />
      ))}
    </div>
  );
}

export default function BoardView() {
  const board = useStore((s) => s.board);
  const boardLoading = useStore((s) => s.boardLoading);
  const boardError = useStore((s) => s.boardError);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const setActiveProject = useStore((s) => s.setActiveProject);
  const moveTaskOptimistic = useStore((s) => s.moveTaskOptimistic);
  const pushToast = useStore((s) => s.pushToast);
  const projects = useStore((s) => s.projects);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const project = projects.find((p) => p.id === board.projectId);

  const byCell = useMemo(() => {
    const cells = new Map<string, Task[]>();
    for (const t of Object.values(board.tasks)) {
      const key = `${t.stage}|${t.status}`;
      const list = cells.get(key) ?? [];
      list.push(t);
      cells.set(key, list);
    }
    for (const list of cells.values()) {
      list.sort((a, b) => (a.orderKey < b.orderKey ? -1 : a.orderKey > b.orderKey ? 1 : 0));
    }
    return cells;
  }, [board.tasks]);

  function onDragEnd(ev: DragEndEvent) {
    const task = ev.active.data.current?.task as Task | undefined;
    const target = ev.over?.data.current as { stage: Stage; status: TaskStatus } | undefined;
    if (!task || !target) return;
    if (target.stage !== task.stage) {
      pushToast("error", "El carril (etapa) no se cambia arrastrando: es la metodología del proyecto");
      return;
    }
    if (target.status === task.status) return;
    void moveTaskOptimistic(task.id, target.status);
  }

  if (!activeProjectId) {
    return (
      <div className="p-6">
        <EmptyState
          title="Sin proyecto activo"
          hint="Elige un proyecto en el selector del header, o pide a Alex que arranque un engagement desde el chat."
        />
      </div>
    );
  }
  if (boardLoading) return <Spinner label="Cargando tablero…" />;
  if (boardError) {
    return (
      <div className="p-6">
        <ErrorBox message={boardError} onRetry={() => void setActiveProject(activeProjectId)} />
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto p-4">
      {project ? (
        <div className="mb-3 flex items-center gap-3 text-xs text-slate-500">
          <span className="font-semibold text-slate-700">{project.name}</span>
          <span>etapa {project.stage}</span>
          <span
            className={`rounded px-1.5 py-0.5 font-semibold ${
              project.gateState === "approved"
                ? "bg-emerald-100 text-emerald-700"
                : project.gateState === "rejected"
                  ? "bg-rose-100 text-rose-700"
                  : "bg-amber-100 text-amber-700"
            }`}
          >
            Gate 1: {project.gateState === "approved" ? "aprobado" : project.gateState === "rejected" ? "rechazado" : "pendiente"}
          </span>
          <span className="ml-auto">{Object.keys(board.tasks).length} tarjetas</span>
        </div>
      ) : null}

      {Object.keys(board.tasks).length === 0 ? (
        <EmptyState
          title="Tablero vacío"
          hint="Pide a Alex un assessment por el chat y verás el backlog poblarse solo."
        />
      ) : (
        <DndContext sensors={sensors} onDragEnd={onDragEnd}>
          <div className="min-w-[1100px]">
            {/* cabecera de columnas */}
            <div className="grid grid-cols-[90px_repeat(7,1fr)] gap-2">
              <div />
              {TASK_STATUSES.map((s) => (
                <p key={s} className="px-1 text-[10px] font-bold uppercase tracking-wide text-slate-400">
                  {s}
                </p>
              ))}
            </div>
            {STAGES.map((stage) => (
              <div
                key={stage}
                className="mt-2 grid grid-cols-[90px_repeat(7,1fr)] gap-2 rounded-lg border border-slate-200 bg-white/50 p-2"
              >
                <div className="flex items-start pt-1">
                  <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] font-bold uppercase text-white">
                    {STAGE_LABEL[stage]}
                  </span>
                </div>
                {TASK_STATUSES.map((status) => (
                  <Cell
                    key={status}
                    stage={stage}
                    status={status}
                    tasks={byCell.get(`${stage}|${status}`) ?? []}
                  />
                ))}
              </div>
            ))}
          </div>
        </DndContext>
      )}
    </div>
  );
}
