/**
 * "Mis tareas": todo lo asignado a la persona de la sesión, en TODOS los
 * proyectos, agrupado por vencimiento.
 *
 * El tablero sólo sabe del proyecto activo, así que quien lleva tres cuentas a
 * la vez no tenía forma de ver su día. La agrupación usa los mismos cortes que
 * la píldora de vencimiento de la tarjeta (`dueBucket`), para que un "vencida"
 * aquí sea el mismo "vencida" de allí.
 */
import { useEffect, useMemo, useState } from "react";
import { useStore } from "../state/store";
import {
  DuePill,
  EmptyState,
  ErrorBox,
  PriorityDot,
  Spinner,
  StatusPill,
  timeAgo,
} from "../components/ui";
import {
  DUE_BUCKETS,
  DUE_BUCKET_LABELS,
  TASK_STATUSES,
  dueBucket,
  getTaskLabels,
  type DueBucket,
  type Task,
  type TaskStatus,
} from "../lib/types";
import TaskSearchBox from "./TaskSearchBox";
import { STAGE_LABELS } from "../components/system";

/** Estados que no aportan a "lo que tengo que hacer" y se ocultan por defecto. */
const CLOSED_STATUSES: TaskStatus[] = ["DONE", "CANCELLED"];

export function groupByDue(tasks: Task[], now = Date.now()): Map<DueBucket, Task[]> {
  const groups = new Map<DueBucket, Task[]>();
  for (const bucket of DUE_BUCKETS) groups.set(bucket, []);
  for (const task of tasks) groups.get(dueBucket(task, now))!.push(task);
  for (const list of groups.values()) {
    list.sort((a, b) => {
      const dueA = a.dueAt ?? a.due_at ?? Number.POSITIVE_INFINITY;
      const dueB = b.dueAt ?? b.due_at ?? Number.POSITIVE_INFINITY;
      if (dueA !== dueB) return dueA - dueB;
      return a.title.localeCompare(b.title, "es");
    });
  }
  return groups;
}

function MyTaskRow({ task, projectName }: { task: Task; projectName: string | null }) {
  const openTask = useStore((state) => state.openTask);
  const labels = getTaskLabels(task);
  return (
    <li>
      <button
        type="button"
        data-testid={`my-task-${task.id}`}
        onClick={() => void openTask(task.id)}
        className="flex w-full flex-col gap-1.5 rounded-soft border border-line bg-surface px-3 py-2.5 text-left shadow-rest transition-colors hover:border-line hover:bg-surface-2 focus:outline-none focus:ring-2 focus:ring-link"
      >
        <span className="flex items-start gap-2">
          <PriorityDot priority={task.priority} />
          <span className="min-w-0 flex-1 text-small font-semibold leading-snug text-ink">{task.title}</span>
          <StatusPill status={task.status} />
        </span>
        <span className="flex flex-wrap items-center gap-1.5 text-label text-muted">
          {projectName ? <span className="max-w-[14rem] truncate font-medium">{projectName}</span> : null}
          <span className="rounded bg-line-soft px-1 py-0.5">{STAGE_LABELS[task.stage]}</span>
          <DuePill task={task} />
          {labels.map((label) => (
            <span key={label} className="rounded-full bg-link-bg px-1.5 py-0.5 text-link">
              {label}
            </span>
          ))}
          <span className="ml-auto">{timeAgo(task.updatedAt)}</span>
        </span>
      </button>
    </li>
  );
}

export default function MyTasksView() {
  const person = useStore((state) => state.person);
  const myTasks = useStore((state) => state.myTasks);
  const loading = useStore((state) => state.myTasksLoading);
  const error = useStore((state) => state.myTasksError);
  const loadMyTasks = useStore((state) => state.loadMyTasks);
  const labelCatalog = useStore((state) => state.labelCatalog);
  const loadLabels = useStore((state) => state.loadLabels);
  const projects = useStore((state) => state.projects);

  const [label, setLabel] = useState<string>("");
  const [status, setStatus] = useState<TaskStatus | "">("");
  const [showClosed, setShowClosed] = useState(false);

  useEffect(() => {
    void loadMyTasks({ ...(label ? { label } : {}), ...(status ? { status } : {}) });
  }, [label, status, loadMyTasks]);

  useEffect(() => {
    // El catálogo global (sin proyecto) es el correcto aquí: la vista cruza proyectos.
    void loadLabels(undefined);
  }, [loadLabels]);

  const projectNames = useMemo(
    () => new Map(projects.map((project) => [project.id, project.name])),
    [projects],
  );

  const visible = useMemo(
    () => (showClosed ? myTasks : myTasks.filter((task) => !CLOSED_STATUSES.includes(task.status))),
    [myTasks, showClosed],
  );
  const groups = useMemo(() => groupByDue(visible), [visible]);
  const overdueCount = groups.get("overdue")?.length ?? 0;
  const todayCount = groups.get("today")?.length ?? 0;

  return (
    <div className="density-operar min-h-full p-3 sm:p-4">
      <div className="mx-auto max-w-3xl">
        <div className="rounded-panel border border-line-soft bg-surface shadow-rest">
          <div className="border-b border-line-soft px-3 py-3 sm:px-4 sm:py-4">
            <div className="flex flex-wrap items-start gap-3">
              <div className="min-w-0 flex-1">
                <h1 className="text-display text-ink">
                  Mis tareas{person ? ` · ${person.full_name}` : ""}
                </h1>
                <p className="mt-1 text-small text-muted">
                  Todo lo asignado a ti en todos los proyectos, agrupado por vencimiento.
                </p>
              </div>
              <div className="grid grid-cols-3 gap-1.5 text-right sm:gap-3">
                <div className="rounded-soft bg-surface-2 px-2 py-1.5 sm:px-3">
                  <p className="text-label uppercase text-faint">Abiertas</p>
                  <p className="text-body font-semibold tabular-nums text-ink">{visible.length}</p>
                </div>
                <div className="rounded-soft bg-broken-bg px-2 py-1.5 sm:px-3">
                  <p className="text-label uppercase text-broken">Vencidas</p>
                  <p className="text-body font-semibold tabular-nums text-broken">{overdueCount}</p>
                </div>
                <div className="rounded-soft bg-work-bg px-2 py-1.5 sm:px-3">
                  <p className="text-label uppercase text-work">Hoy</p>
                  <p className="text-body font-semibold tabular-nums text-work">{todayCount}</p>
                </div>
              </div>
            </div>

            <div className="mt-3">
              <TaskSearchBox mine placeholder="Buscar entre mis tareas…" />
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <label htmlFor="my-tasks-label" className="text-label font-semibold text-muted">
                Etiqueta
              </label>
              <select
                id="my-tasks-label"
                data-testid="my-tasks-label"
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                className="min-h-9 rounded-soft border border-line bg-surface px-2 py-1.5 text-small focus:border-link focus:outline-none focus:ring-2 focus:ring-link"
              >
                <option value="">Todas</option>
                {labelCatalog.map((usage) => (
                  <option key={usage.label} value={usage.label}>
                    {usage.label} ({usage.count})
                  </option>
                ))}
              </select>

              <label htmlFor="my-tasks-status" className="text-label font-semibold text-muted">
                Estado
              </label>
              <select
                id="my-tasks-status"
                data-testid="my-tasks-status"
                value={status}
                onChange={(event) => setStatus(event.target.value as TaskStatus | "")}
                className="min-h-9 rounded-soft border border-line bg-surface px-2 py-1.5 text-small focus:border-link focus:outline-none focus:ring-2 focus:ring-link"
              >
                <option value="">Todos</option>
                {TASK_STATUSES.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>

              <label className="ml-auto inline-flex min-h-9 cursor-pointer items-center gap-1.5 text-label text-muted">
                <input
                  type="checkbox"
                  data-testid="my-tasks-show-closed"
                  checked={showClosed}
                  onChange={(event) => setShowClosed(event.target.checked)}
                  className="h-4 w-4 rounded border-line text-ink focus:ring-link"
                />
                Incluir cerradas
              </label>
            </div>
          </div>

          <div className="p-3 sm:p-4">
            {loading ? <Spinner label="Cargando tus tareas…" /> : null}
            {!loading && error ? <ErrorBox message={error} onRetry={() => void loadMyTasks()} /> : null}
            {!loading && !error && visible.length === 0 ? (
              <EmptyState
                title="Nada asignado a ti"
                hint="Cuando alguien te asigne una tarea aparecerá aquí, en cualquier proyecto."
              />
            ) : null}
            {!loading && !error && visible.length > 0
              ? DUE_BUCKETS.map((bucket) => {
                  const tasks = groups.get(bucket) ?? [];
                  if (tasks.length === 0) return null;
                  return (
                    <section key={bucket} className="mb-4" data-testid={`bucket-${bucket}`}>
                      <h2 className="mb-1.5 flex items-center gap-2 text-label font-bold uppercase text-muted">
                        {DUE_BUCKET_LABELS[bucket]}
                        <span className="rounded-full bg-line-soft px-1.5 py-0.5 text-label tabular-nums text-muted">
                          {tasks.length}
                        </span>
                      </h2>
                      <ul className="space-y-1.5">
                        {tasks.map((task) => (
                          <MyTaskRow
                            key={task.id}
                            task={task}
                            projectName={projectNames.get(task.projectId) ?? null}
                          />
                        ))}
                      </ul>
                    </section>
                  );
                })
              : null}
          </div>
        </div>
      </div>
    </div>
  );
}
