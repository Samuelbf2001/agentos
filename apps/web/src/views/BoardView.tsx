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
import CreateTaskDialog from "./CreateTaskDialog";
import BoardCopilotPanel from "../components/chat/BoardCopilotPanel";
import type { BoardFilter, Person, Stage, Task, TaskAssigneePerson, TaskStatus } from "../lib/types";
import {
  getTaskAssignees,
  getTaskLabels,
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
import { ActionButton, STAGE_LABELS } from "../components/system";

/** La etiqueta de etapa vive en un solo sitio; se reexporta por compatibilidad. */
export const STAGE_LABEL: Record<Stage, string> = STAGE_LABELS;

export const BOARD_FILTER_LABELS: Record<BoardFilter, string> = {
  all: "Todas",
  mine: "Mis tareas",
  unassigned: "Sin responsable",
  due: "Vencidas y próximas",
};

const PULSE_STATUS: Record<TaskStatus, string> = {
  BACKLOG: "bg-faint",
  READY: "bg-link",
  IN_PROGRESS: "bg-work",
  REVIEW: "bg-decide",
  BLOCKED: "bg-broken",
  DONE: "bg-done",
  CANCELLED: "bg-line",
};

const PULSE_DUE: Record<ReturnType<typeof taskDueState>, string> = {
  none: "bg-transparent",
  overdue: "bg-broken",
  today: "bg-work",
  upcoming: "bg-work",
  later: "bg-muted",
  complete: "bg-done",
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
  label: string | null = null,
): Task[] {
  return tasks.filter(
    (task) =>
      taskMatchesBoardFilter(task, filter, personId, now) &&
      (!label || getTaskLabels(task).includes(label)),
  );
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
    // El snapshot del tablero no pasa por normalizeTask, así que la persona
    // embebida puede venir en camelCase: personLabel cubre ambas formas.
    primary ? `responsable ${personLabel(primaryPerson, primaryId)}` : "sin responsable",
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
      className={`group relative min-w-0 cursor-grab overflow-hidden rounded-soft bg-surface p-3 pl-4 shadow-rest transition-all hover:-translate-y-px hover:shadow-raise focus:outline-none focus:ring-2 focus:ring-link focus:ring-offset-1 ${
        isDragging ? "opacity-70 shadow-float" : ""
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
        <p className="min-w-0 flex-1 text-small font-semibold leading-snug text-ink">{task.title}</p>
        <span className="sr-only">Estado canónico: {task.status}</span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
        <StatusPill status={task.status} />
        <DuePill task={task} />
      </div>
      <div className="mt-2 flex min-w-0 items-center gap-1.5 border-t border-line-soft pt-2">
        {primary ? (
          <span className="inline-flex min-w-0 items-center gap-1" title={`Responsable: ${personLabel(primaryPerson, primaryId)}`}>
            <PersonAvatar name={personLabel(primaryPerson, primaryId)} size={5} />
            <span className="max-w-[9rem] truncate text-label text-muted">
              {personLabel(primaryPerson, primaryId)}
            </span>
          </span>
        ) : (
          <span className="text-label font-medium text-faint">Sin responsable</span>
        )}
        {assignees.length > 1 ? (
          <span className="rounded-full bg-line-soft px-1.5 py-0.5 text-label font-semibold text-muted">
            +{assignees.length - 1}
          </span>
        ) : null}
        {agent ? (
          <span className="ml-auto inline-flex items-center gap-1" title={`Agente: ${agent.name}`}>
            <AgentAvatar name={agent.name} slug={agent.slug} size={5} />
            <span className="max-w-[6rem] truncate text-label text-muted">{agent.name}</span>
          </span>
        ) : null}
      </div>
      {getTaskLabels(task).length > 0 ? (
        <div className="mt-1.5 flex flex-wrap gap-1" data-testid={`card-labels-${task.id}`}>
          {getTaskLabels(task).map((label) => (
            <span key={label} className="rounded-full bg-link-bg px-1.5 py-0.5 text-label font-medium text-link">
              {label}
            </span>
          ))}
        </div>
      ) : null}
      <div className="mt-1 flex items-center gap-1 text-label text-faint">
        {task.requiresApproval ? <span className="rounded-full bg-decide-bg px-1 py-0.5 text-decide">gate</span> : null}
        {task.externalEffect ? <span className="rounded-full bg-work-bg px-1 py-0.5 text-work">efecto externo</span> : null}
        {task.blockedReason ? (
          <span className="rounded-full bg-broken-bg px-1 py-0.5 text-broken">
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
      className={`min-h-16 space-y-2 rounded-soft p-1.5 transition-colors ${
        isOver ? "bg-link-bg ring-1 ring-link" : compact ? "bg-surface-2/70" : "bg-canvas-deep/50"
      }`}
      data-testid={`cell-${stage}-${status}`}
    >
      {tasks.map((task) => (
        <TaskCard key={task.id} task={task} people={people} agents={agents} />
      ))}
      {tasks.length === 0 ? <span className="block h-5" aria-hidden="true" /> : null}
    </div>
  );
}

/**
 * Un carril por etapa (Entender/Construir/Operar). El de la etapa actual del
 * proyecto se pinta abierto; los otros dos nacen plegados en una sola fila
 * (estado local: no es una preferencia que valga la pena recordar entre
 * sesiones) con el nombre, el número de tarjetas y "Mostrar"/"Ocultar".
 */
function StageLane({
  stage,
  isActive,
  byCell,
  cardCount,
  people,
  agents,
}: {
  stage: Stage;
  isActive: boolean;
  byCell: Map<string, Task[]>;
  cardCount: number;
  people: Person[];
  agents: ReturnType<typeof useStore.getState>["agents"];
}) {
  const [open, setOpen] = useState(false);
  const expanded = isActive || open;

  if (!expanded) {
    return (
      <div
        className="flex items-center gap-3 rounded-soft bg-canvas-deep/40 px-4 py-2"
        data-testid={`lane-${stage}-plegado`}
      >
        <span className="text-small font-semibold text-ink-2">{STAGE_LABEL[stage]}</span>
        {cardCount === 0 ? (
          <span className="text-small text-faint">Sin tarjetas todavía</span>
        ) : (
          <>
            <span className="text-small text-faint">
              {cardCount} {cardCount === 1 ? "tarjeta" : "tarjetas"}
            </span>
            <button
              type="button"
              data-testid={`lane-${stage}-mostrar`}
              onClick={() => setOpen(true)}
              className="press ml-auto text-small font-semibold text-link hover:underline"
            >
              Mostrar
            </button>
          </>
        )}
      </div>
    );
  }

  return (
    <section
      className="rounded-panel border border-line-soft bg-surface/70 p-2 shadow-rest"
      data-testid={`lane-${stage}`}
    >
      <div className="flex items-center justify-between px-1 pb-1.5">
        <span className="rounded-tight border border-line bg-canvas-deep px-2 py-1 text-label text-ink-2">
          {STAGE_LABEL[stage]}
        </span>
        {!isActive ? (
          <button
            type="button"
            data-testid={`lane-${stage}-ocultar`}
            onClick={() => setOpen(false)}
            className="press text-small font-semibold text-muted hover:text-ink-2"
          >
            Ocultar
          </button>
        ) : null}
      </div>
      <div className="grid grid-cols-[repeat(7,minmax(120px,1fr))] gap-2 px-1">
        {TASK_STATUSES.map((status) => (
          <p key={status} className="flex items-baseline gap-1.5 px-1">
            <span className="text-small font-semibold text-ink-2">{STATUS_LABELS[status]}</span>
            <span className="text-label tabular-nums text-faint">
              {(byCell.get(`${stage}|${status}`) ?? []).length}
            </span>
          </p>
        ))}
      </div>
      <div className="grid grid-cols-[repeat(7,minmax(120px,1fr))] gap-2 px-1 pt-1">
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
      </div>
    </section>
  );
}

function DesktopBoard({
  byCell,
  people,
  agents,
  projectStage,
}: {
  byCell: Map<string, Task[]>;
  people: Person[];
  agents: ReturnType<typeof useStore.getState>["agents"];
  projectStage: Stage;
}) {
  return (
    <div className="min-w-[1120px] space-y-2 pb-3">
      {STAGES.map((stage) => {
        const cardCount = TASK_STATUSES.reduce(
          (total, status) => total + (byCell.get(`${stage}|${status}`)?.length ?? 0),
          0,
        );
        return (
          <StageLane
            key={stage}
            stage={stage}
            isActive={stage === projectStage}
            byCell={byCell}
            cardCount={cardCount}
            people={people}
            agents={agents}
          />
        );
      })}
    </div>
  );
}

function MobileBoard({ byCell, people, agents }: { byCell: Map<string, Task[]>; people: Person[]; agents: ReturnType<typeof useStore.getState>["agents"] }) {
  return (
    <div className="space-y-4">
      {STAGES.map((stage) => (
        <section key={stage} className="overflow-hidden rounded-panel bg-surface shadow-rest">
          <div className="flex items-center justify-between border-b border-line-soft bg-canvas-deep px-3 py-2">
            <span className="text-label text-ink-2">{STAGE_LABEL[stage]}</span>
          </div>
          <div className="divide-y divide-line-soft">
            {TASK_STATUSES.map((status) => {
              const tasks = byCell.get(`${stage}|${status}`) ?? [];
              return (
                <div key={status} className="p-2">
                  <div className="flex items-center justify-between px-1">
                    <span className="text-label text-muted">{STATUS_LABELS[status]}</span>
                    <span className="text-label tabular-nums text-faint">{tasks.length}</span>
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

export default function BoardView({ projectId }: { projectId: string }) {
  const board = useStore((state) => state.board);
  const boardLoading = useStore((state) => state.boardLoading);
  const boardError = useStore((state) => state.boardError);
  const setActiveProject = useStore((state) => state.setActiveProject);
  const moveTaskOptimistic = useStore((state) => state.moveTaskOptimistic);
  const pushToast = useStore((state) => state.pushToast);
  const projects = useStore((state) => state.projects);
  const people = useStore((state) => state.people);
  const currentPerson = useStore((state) => state.person);
  const agents = useStore((state) => state.agents);
  const boardFilter = useStore((state) => state.boardFilter);
  const setBoardFilter = useStore((state) => state.setBoardFilter);
  const boardLabelFilter = useStore((state) => state.boardLabelFilter);
  const setBoardLabelFilter = useStore((state) => state.setBoardLabelFilter);
  const labelCatalog = useStore((state) => state.labelCatalog);
  const [creating, setCreating] = useState(false);
  // Copiloto: panel lateral con el hilo `board:<projectId>`; al cambiar de
  // proyecto el panel mismo salta al hilo del nuevo (nunca mezcla hilos).
  // El estado vive en el store para que la ficha de tarea pueda cerrarlo
  // cuando no caben los dos (<1280px); al salir del tablero se cierra.
  const copilotOpen = useStore((state) => state.copilotOpen);
  const setCopilotOpen = useStore((state) => state.setCopilotOpen);
  useEffect(() => () => setCopilotOpen(false), [setCopilotOpen]);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor),
  );
  const isMobile = useIsMobileBoard();
  const project = projects.find((candidate) => candidate.id === board.projectId);
  const allTasks = useMemo(() => Object.values(board.tasks), [board.tasks]);
  const visibleTasks = useMemo(
    () => filterBoardTasks(allTasks, boardFilter, currentPerson?.id ?? null, Date.now(), boardLabelFilter),
    [allTasks, boardFilter, currentPerson?.id, boardLabelFilter],
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

  if (boardLoading) return <Spinner label="Cargando tablero…" />;
  if (boardError) {
    return (
      <div className="p-4 sm:p-6">
        <ErrorBox message={boardError} onRetry={() => void setActiveProject(projectId)} />
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
    <div className="min-h-full overflow-x-hidden bg-surface-2 p-3 sm:p-4 lg:overflow-auto">
      <div className="mx-auto flex max-w-[1680px] flex-col gap-3 lg:flex-row lg:items-start">
        <div className="min-w-0 flex-1 rounded-panel bg-surface shadow-rest">
          <div className="border-b border-line px-3 py-3 sm:px-4 sm:py-4">
            {/* Sin cabecera duplicada: el nombre del cliente y la fase viven
                arriba, en la barra del proyecto. Aquí sólo lo operativo. */}
            <div className="flex flex-wrap items-center gap-3">
              <ActionButton variant="primary" data-testid="board-new-task" onClick={() => setCreating(true)}>
                Nueva tarea
              </ActionButton>
              <button
                type="button"
                data-testid="board-copilot-toggle"
                aria-pressed={copilotOpen}
                aria-expanded={copilotOpen}
                aria-controls="board-copilot"
                onClick={() => setCopilotOpen(!copilotOpen)}
                className={`press inline-flex min-h-10 items-center justify-center gap-1.5 rounded-tight border px-3 py-1.5 text-small font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-link focus:ring-offset-1 ${
                  copilotOpen
                    ? "border-ink bg-ink text-surface"
                    : "border-line bg-surface text-ink hover:bg-surface-2"
                }`}
              >
                Copiloto
              </button>
              <span className="ml-auto text-small text-muted">
                <span className="font-semibold tabular-nums text-ink-2">{counts.visible}</span> de{" "}
                {counts.total} visibles ·{" "}
                <span className="font-semibold tabular-nums text-ink-2">{counts.due}</span> vencidas ·{" "}
                <span className="font-semibold tabular-nums text-ink-2">{counts.unassigned}</span> sin
                responsable
              </span>
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
                      className={`inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 py-1.5 text-small font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-link focus:ring-offset-1 ${
                        active
                          ? "border-ink bg-ink text-surface"
                          : "border-line bg-surface text-muted hover:border-faint hover:bg-surface-2"
                      }`}
                    >
                      {BOARD_FILTER_LABELS[filter]}
                      <span className={`rounded-full px-1.5 py-0.5 text-label tabular-nums ${active ? "bg-surface/15 text-surface" : "bg-line-soft text-muted"}`}>
                        {count}
                      </span>
                    </button>
                  );
                })}
              </div>
            </fieldset>
            {labelCatalog.length > 0 ? (
              <fieldset className="mt-2">
                <legend className="sr-only">Filtro por etiqueta</legend>
                <div className="flex flex-wrap items-center gap-1.5" role="toolbar" aria-label="Filtro por etiqueta">
                  <span className="text-label font-semibold text-faint">Etiquetas</span>
                  <button
                    type="button"
                    aria-pressed={boardLabelFilter === null}
                    data-testid="board-label-all"
                    onClick={() => setBoardLabelFilter(null)}
                    className={`inline-flex min-h-8 items-center rounded-full border px-2.5 py-1 text-label font-medium ${
                      boardLabelFilter === null
                        ? "border-link bg-link text-surface"
                        : "border-line bg-surface text-muted hover:border-faint"
                    }`}
                  >
                    Todas
                  </button>
                  {labelCatalog.map((usage) => {
                    const active = boardLabelFilter === usage.label;
                    return (
                      <button
                        key={usage.label}
                        type="button"
                        aria-pressed={active}
                        data-testid={`board-label-${usage.label}`}
                        onClick={() => setBoardLabelFilter(active ? null : usage.label)}
                        className={`inline-flex min-h-8 items-center gap-1 rounded-full border px-2.5 py-1 text-label font-medium ${
                          active
                            ? "border-link bg-link text-surface"
                            : "border-line bg-surface text-muted hover:border-faint"
                        }`}
                      >
                        {usage.label}
                        <span className={`tabular-nums ${active ? "text-surface/70" : "text-faint"}`}>
                          {usage.count}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </fieldset>
            ) : null}
          </div>
          <div className="p-2 sm:p-3">
            {allTasks.length === 0 ? (
              <EmptyState
                title="Tablero vacío"
                hint="Crea la primera tarea con «＋ Nueva tarea», o pide a Alex un assessment por el chat."
              />
            ) : visibleTasks.length === 0 ? (
              <EmptyState
                title={`Sin tareas en «${BOARD_FILTER_LABELS[boardFilter]}»${boardLabelFilter ? ` · ${boardLabelFilter}` : ""}`}
                hint="Cambia el filtro o la etiqueta para volver a ver las tareas del proyecto."
              />
            ) : (
              <DndContext sensors={sensors} onDragEnd={onDragEnd}>
                {isMobile ? (
                  <MobileBoard byCell={byCell} people={people.length > 0 ? people : currentPerson ? [currentPerson] : []} agents={agents} />
                ) : (
                  <div className="overflow-x-auto">
                    <DesktopBoard
                      byCell={byCell}
                      people={people.length > 0 ? people : currentPerson ? [currentPerson] : []}
                      agents={agents}
                      projectStage={project?.stage ?? "ENTENDER"}
                    />
                  </div>
                )}
              </DndContext>
            )}
          </div>
        </div>
        {copilotOpen ? (
          <BoardCopilotPanel
            projectId={projectId}
            projectName={project?.name}
            onClose={() => setCopilotOpen(false)}
          />
        ) : null}
      </div>
      <CreateTaskDialog
        open={creating}
        onOpenChange={setCreating}
        projectId={projectId}
        defaultStage={project?.stage ?? "ENTENDER"}
      />
    </div>
  );
}
