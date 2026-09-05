/**
 * Mesa de control operativa: tablero canónico stage × status con filtros
 * humanos. El riel de pulso de cada tarjeta resume estado, vencimiento y
 * responsables sin abrir el drawer.
 */
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { useEffect, useMemo, useState } from "react";
import { useStore } from "../state/store";
import type { BoardFilter, Person, Stage, Task, TaskAssigneePerson, TaskStatus } from "../lib/types";
import {
  getTaskAssignees,
  STAGES,
  TASK_STATUSES,
  taskAssigneeIsPrimary,
  taskAssigneePersonId,
  taskDueState,
} from "../lib/types";
import {
  AgentAvatar,
  DuePill,
  EmptyState,
  ErrorBox,
  PersonAvatar,
  PriorityDot,
  Spinner,
  STATUS_LABELS,
  StatusPill,
  timeAgo,
} from "../components/ui";
import { ProjectPhaseHeader } from "./PhasePanel";

export const STAGE_LABEL: Record<Stage, string> = {
  ENTENDER: "Entender",
  CONSTRUIR: "Construir",
  OPERAR: "Operar",
};

export const BOARD_FILTER_LABELS: Record<BoardFilter, string> = {
  all: "Todas",
  mine: "Mis tareas",
  unassigned: "Sin responsable",
  due: "Vencidas y próximas",
};

const PULSE_STATUS: Record<TaskStatus, string> = {
  BACKLOG: "bg-slate-400",
  READY: "bg-sky-500",
  IN_PROGRESS: "bg-amber-500",
  REVIEW: "bg-violet-500",
  BLOCKED: "bg-rose-600",
  DONE: "bg-emerald-500",
  CANCELLED: "bg-slate-300",
};

const PULSE_DUE: Record<ReturnType<typeof taskDueState>, string> = {
  none: "bg-transparent",
  overdue: "bg-rose-700",
  today: "bg-orange-600",
  upcoming: "bg-amber-500",
  later: "bg-slate-500",
  complete: "bg-emerald-700",
};

/** Exportado para el reducer/UI test sin depender de Date.now global. */
export function taskMatchesBoardFilter(
  task: Task,
  filter: BoardFilter,
  personId: string | null,
  now = Date.now(),
): boolean {
  if (filter === "all") return true;
  const assignees = getTaskAssignees(task);
  if (filter === "unassigned") return assignees.length === 0;
  if (filter === "mine") {
    return Boolean(personId) && assignees.some((assignee) => taskAssigneePersonId(assignee) === personId);
  }
  const due = taskDueState(task, now);
  return due === "overdue" || due === "today" || due === "upcoming";
}

export function filterBoardTasks(
  tasks: Task[],
  filter: BoardFilter,
  personId: string | null,
  now = Date.now(),
): Task[] {
  return tasks.filter((task) => taskMatchesBoardFilter(task, filter, personId, now));
}

function personLabel(person: (Person | TaskAssigneePerson) | null | undefined, fallbackId: string | null): string {
  if (person) return person.full_name || person.fullName || (fallbackId ? `Persona ${fallbackId.slice(0, 8)}` : "Persona");
  return fallbackId ? `Persona ${fallbackId.slice(0, 8)}` : "Sin responsable";
}

function TaskCard({ task, people, agents }: { task: Task; people: Person[]; agents: ReturnType<typeof useStore.getState>["agents"] }) {
  const openTask = useStore((s) => s.openTask);
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: task.id,
    data: { task },
  });
  const assignees = getTaskAssignees(task);
  const primary = assignees.find(taskAssigneeIsPrimary) ?? assignees[0];
  const primaryId = primary ? taskAssigneePersonId(primary) : null;
  const primaryPerson = primary?.person ?? people.find((person) => person.id === primaryId);
  const agent = task.assigneeAgentId ? agents.find((candidate) => candidate.id === task.assigneeAgentId) : null;
  const dueState = taskDueState(task);
  const label = [
    task.title,
    STATUS_LABELS[task.status],
    dueState === "overdue" ? "vencida" : dueState === "upcoming" || dueState === "today" ? "próxima" : "",
    primaryPerson ? `responsable ${primaryPerson.full_name}` : "sin responsable",
    agent ? `agente ${agent.name}` : "",
  ]
    .filter(Boolean)
    .join(". ");

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      role="button"
      tabIndex={0}
      aria-label={label}
      onClick={() => {
        if (!isDragging) void openTask(task.id);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          void openTask(task.id);
        }
      }}
      style={
        transform
          ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`, zIndex: 30 }
          : undefined
      }
      className={`group relative min-w-0 cursor-grab overflow-hidden rounded-lg border border-slate-200 bg-white p-3 pl-4 shadow-sm transition-all hover:-translate-y-px hover:border-slate-300 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-sky-500 focus:ring-offset-1 ${
        isDragging ? "opacity-70 shadow-lg" : ""
      }`}
      data-testid={`task-card-${task.id}`}
      data-status={task.status}
      data-due-state={dueState}
    >
      <span className={`absolute inset-y-0 left-0 w-1.5 ${PULSE_STATUS[task.status]}`} aria-hidden="true">
        <span className={`absolute inset-x-0 bottom-0 h-1/3 ${PULSE_DUE[dueState]}`} />
      </span>
      <div className="flex items-start gap-2">
        <PriorityDot priority={task.priority} />
        <p className="min-w-0 flex-1 text-xs font-semibold leading-snug text-slate-800">{task.title}</p>
        <span className="sr-only">Estado canónico: {task.status}</span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
        <StatusPill status={task.status} />
        <DuePill task={task} />
      </div>
      <div className="mt-2 flex min-w-0 items-center gap-1.5 border-t border-slate-100 pt-2">
        {primary ? (
          <span className="inline-flex min-w-0 items-center gap-1" title={`Responsable: ${personLabel(primaryPerson, primaryId)}`}>
            <PersonAvatar name={personLabel(primaryPerson, primaryId)} size={5} />
            <span className="max-w-[9rem] truncate text-[10px] text-slate-600">
              {personLabel(primaryPerson, primaryId)}
            </span>
          </span>
        ) : (
          <span className="text-[10px] font-medium text-slate-400">Sin responsable</span>
        )}
        {assignees.length > 1 ? (
          <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[9px] font-semibold text-slate-500">
            +{assignees.length - 1}
          </span>
        ) : null}
        {agent ? (
          <span className="ml-auto inline-flex items-center gap-1" title={`Agente: ${agent.name}`}>
            <AgentAvatar name={agent.name} slug={agent.slug} size={5} />
            <span className="max-w-[6rem] truncate text-[10px] text-slate-500">{agent.name}</span>
          </span>
        ) : null}
      </div>
      <div className="mt-1 flex items-center gap-1 text-[9px] text-slate-400">
        {task.requiresApproval ? <span className="rounded bg-violet-50 px-1 py-0.5 text-violet-700">gate</span> : null}
        {task.externalEffect ? <span className="rounded bg-orange-50 px-1 py-0.5 text-orange-700">efecto externo</span> : null}
        {task.blockedReason ? (
          <span className="rounded bg-rose-50 px-1 py-0.5 text-rose-700">
            {task.blockedReason === "approval" ? "esperando aprobación" : task.blockedReason}
          </span>
        ) : null}
        <span className="ml-auto">{timeAgo(task.updatedAt)}</span>
      </div>
    </div>
  );
}

function Cell({
  stage,
  status,
  tasks,
  people,
  agents,
  compact = false,
}: {
  stage: Stage;
  status: TaskStatus;
  tasks: Task[];
  people: Person[];
  agents: ReturnType<typeof useStore.getState>["agents"];
  compact?: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `${stage}|${status}`, data: { stage, status } });
  return (
    <div
      ref={setNodeRef}
      className={`min-h-16 space-y-2 rounded-md p-1.5 transition-colors ${
        isOver ? "bg-sky-50 ring-1 ring-sky-300" : ""
      } ${compact ? "bg-slate-50/70" : ""}`}
      data-testid={`cell-${stage}-${status}`}
    >
      {tasks.map((task) => (
        <TaskCard key={task.id} task={task} people={people} agents={agents} />
      ))}
      {tasks.length === 0 ? <span className="block h-5" aria-hidden="true" /> : null}
    </div>
  );
}

function DesktopBoard({ byCell, people, agents }: { byCell: Map<string, Task[]>; people: Person[]; agents: ReturnType<typeof useStore.getState>["agents"] }) {
  return (
    <div className="min-w-[1120px] pb-3">
      <div className="grid grid-cols-[96px_repeat(7,minmax(120px,1fr))] gap-2 px-2">
        <div />
        {TASK_STATUSES.map((status) => (
          <p key={status} className="px-1 text-[10px] font-bold uppercase tracking-[0.14em] text-slate-400">
            {status}
          </p>
        ))}
      </div>
      <div className="space-y-2">
        {STAGES.map((stage) => (
          <section key={stage} className="grid grid-cols-[96px_repeat(7,minmax(120px,1fr))] gap-2 rounded-xl border border-slate-200 bg-white/70 p-2 shadow-sm">
            <div className="flex items-start pt-1">
              <span className="rounded bg-slate-800 px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-white">
                {STAGE_LABEL[stage]}
              </span>
            </div>
            {TASK_STATUSES.map((status) => (
              <Cell
                key={status}
                stage={stage}
                status={status}
                tasks={byCell.get(`${stage}|${status}`) ?? []}
                people={people}
                agents={agents}
              />
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}

function MobileBoard({ byCell, people, agents }: { byCell: Map<string, Task[]>; people: Person[]; agents: ReturnType<typeof useStore.getState>["agents"] }) {
  return (
    <div className="space-y-4">
      {STAGES.map((stage) => (
        <section key={stage} className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="flex items-center justify-between border-b border-slate-200 bg-slate-800 px-3 py-2">
            <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-white">{STAGE_LABEL[stage]}</span>
            <span className="text-[10px] text-slate-300">carril operativo</span>
          </div>
          <div className="divide-y divide-slate-100">
            {TASK_STATUSES.map((status) => {
              const tasks = byCell.get(`${stage}|${status}`) ?? [];
              return (
                <div key={status} className="p-2">
                  <div className="flex items-center justify-between px-1">
                    <span className="text-[10px] font-bold uppercase tracking-wide text-slate-500">{status}</span>
                    <span className="text-[10px] tabular-nums text-slate-400">{tasks.length}</span>
                  </div>
                  <Cell stage={stage} status={status} tasks={tasks} people={people} agents={agents} compact />
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

function useIsMobileBoard() {
  const [mobile, setMobile] = useState(() => typeof window !== "undefined" && window.innerWidth < 768);
  useEffect(() => {
    const update = () => setMobile(window.innerWidth < 768);
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return mobile;
}

export default function BoardView() {
  const board = useStore((state) => state.board);
  const boardLoading = useStore((state) => state.boardLoading);
  const boardError = useStore((state) => state.boardError);
  const activeProjectId = useStore((state) => state.activeProjectId);
  const setActiveProject = useStore((state) => state.setActiveProject);
  const moveTaskOptimistic = useStore((state) => state.moveTaskOptimistic);
  const pushToast = useStore((state) => state.pushToast);
  const projects = useStore((state) => state.projects);
  const people = useStore((state) => state.people);
  const currentPerson = useStore((state) => state.person);
  const agents = useStore((state) => state.agents);
  const boardFilter = useStore((state) => state.boardFilter);
  const setBoardFilter = useStore((state) => state.setBoardFilter);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor),
  );
  const isMobile = useIsMobileBoard();
  const project = projects.find((candidate) => candidate.id === board.projectId);
  const allTasks = useMemo(() => Object.values(board.tasks), [board.tasks]);
  const visibleTasks = useMemo(
    () => filterBoardTasks(allTasks, boardFilter, currentPerson?.id ?? null),
    [allTasks, boardFilter, currentPerson?.id],
  );
  const byCell = useMemo(() => {
    const cells = new Map<string, Task[]>();
    for (const task of visibleTasks) {
      const key = `${task.stage}|${task.status}`;
      const list = cells.get(key) ?? [];
      list.push(task);
      cells.set(key, list);
    }
    for (const list of cells.values()) {
      list.sort((a, b) => (a.orderKey < b.orderKey ? -1 : a.orderKey > b.orderKey ? 1 : 0));
    }
    return cells;
  }, [visibleTasks]);

  function onDragEnd(event: DragEndEvent) {
    const task = event.active.data.current?.task as Task | undefined;
    const target = event.over?.data.current as { stage: Stage; status: TaskStatus } | undefined;
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
      <div className="p-4 sm:p-6">
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
      <div className="p-4 sm:p-6">
        <ErrorBox message={boardError} onRetry={() => void setActiveProject(activeProjectId)} />
      </div>
    );
  }

  const counts = {
    total: allTasks.length,
    visible: visibleTasks.length,
    due: filterBoardTasks(allTasks, "due", currentPerson?.id ?? null).length,
    unassigned: filterBoardTasks(allTasks, "unassigned", currentPerson?.id ?? null).length,
  };

  return (
    <div className="min-h-full overflow-x-hidden bg-slate-50 p-3 sm:p-4 lg:overflow-auto">
      <div className="mx-auto max-w-[1680px]">
        <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-200 px-3 py-3 sm:px-4 sm:py-4">
            <div className="flex flex-wrap items-start gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-slate-400">Mesa de control / tablero</p>
                <h1 className="mt-1 truncate text-base font-semibold tracking-tight text-slate-900 sm:text-lg">
                  {project?.name ?? "Proyecto activo"}
                </h1>
                <p className="mt-1 text-xs text-slate-500">
                  {project ? `${STAGE_LABEL[project.stage]} · Gate 1 ${project.gateState === "approved" ? "aprobado" : project.gateState === "rejected" ? "rechazado" : "pendiente"}` : "Estado del proyecto no disponible"}
                </p>
              </div>
              <div className="grid grid-cols-3 gap-1.5 text-right sm:gap-3">
                <div className="rounded-lg bg-slate-50 px-2 py-1.5 sm:px-3">
                  <p className="text-[9px] uppercase tracking-wide text-slate-400">Visibles</p>
                  <p className="text-sm font-semibold tabular-nums text-slate-800">{counts.visible}<span className="text-[10px] font-normal text-slate-400">/{counts.total}</span></p>
                </div>
                <div className="rounded-lg bg-rose-50 px-2 py-1.5 sm:px-3">
                  <p className="text-[9px] uppercase tracking-wide text-rose-500">Vencidas</p>
                  <p className="text-sm font-semibold tabular-nums text-rose-700">{counts.due}</p>
                </div>
                <div className="rounded-lg bg-amber-50 px-2 py-1.5 sm:px-3">
                  <p className="text-[9px] uppercase tracking-wide text-amber-600">Sin resp.</p>
                  <p className="text-sm font-semibold tabular-nums text-amber-700">{counts.unassigned}</p>
                </div>
              </div>
            </div>
            <fieldset className="mt-4">
              <legend className="sr-only">Filtros de tareas</legend>
              <div className="flex flex-wrap gap-1.5" role="toolbar" aria-label="Filtros de tareas">
                {(Object.keys(BOARD_FILTER_LABELS) as BoardFilter[]).map((filter) => {
                  const count = filterBoardTasks(allTasks, filter, currentPerson?.id ?? null).length;
                  const active = boardFilter === filter;
                  return (
                    <button
                      key={filter}
                      type="button"
                      aria-pressed={active}
                      data-testid={`board-filter-${filter}`}
                      onClick={() => setBoardFilter(filter)}
                      className={`inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-sky-500 focus:ring-offset-1 ${
                        active
                          ? "border-slate-900 bg-slate-900 text-white"
                          : "border-slate-200 bg-white text-slate-600 hover:border-slate-400 hover:bg-slate-50"
                      }`}
                    >
                      {BOARD_FILTER_LABELS[filter]}
                      <span className={`rounded-full px-1.5 py-0.5 text-[10px] tabular-nums ${active ? "bg-white/15 text-white" : "bg-slate-100 text-slate-500"}`}>
                        {count}
                      </span>
                    </button>
                  );
                })}
              </div>
            </fieldset>
          </div>
          <ProjectPhaseHeader projectId={activeProjectId} />
          <div className="p-2 sm:p-3">
            {allTasks.length === 0 ? (
              <EmptyState
                title="Tablero vacío"
                hint="Pide a Alex un assessment por el chat y verás el backlog poblarse solo."
              />
            ) : visibleTasks.length === 0 ? (
              <EmptyState
                title={`Sin tareas en «${BOARD_FILTER_LABELS[boardFilter]}»`}
                hint="Cambia el filtro para volver a ver las tareas del proyecto."
              />
            ) : (
              <DndContext sensors={sensors} onDragEnd={onDragEnd}>
                {isMobile ? (
                  <MobileBoard byCell={byCell} people={people.length > 0 ? people : currentPerson ? [currentPerson] : []} agents={agents} />
                ) : (
                  <div className="overflow-x-auto">
                    <DesktopBoard byCell={byCell} people={people.length > 0 ? people : currentPerson ? [currentPerson] : []} agents={agents} />
                  </div>
                )}
              </DndContext>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
