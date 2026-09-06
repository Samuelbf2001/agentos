/**
 * Actividad: la lista de ejecuciones. Vive dos veces —global en Sistema y
 * filtrada dentro del proyecto— porque es el mismo dato con distinto alcance.
 *
 * Gana las columnas Tarea y Proyecto (PLAN-v1.5 §Los caminos que hay que
 * abrir, 7): la API ya aceptaba esos filtros y la tabla no los pintaba, así
 * que desde un run no se podía volver a su trabajo.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import type { Run, Task } from "../lib/types";
import { useStore } from "../state/store";
import { paths } from "../lib/paths";
import { ActionButton, Chip } from "../components/system";
import {
  AgentAvatar,
  EmptyState,
  ErrorBox,
  fmtCost,
  fmtTokens,
  RunStatusPill,
  Spinner,
  timeAgo,
} from "../components/ui";

const RUN_STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "Todos los estados" },
  { value: "running", label: "En curso" },
  { value: "queued", label: "En cola" },
  { value: "succeeded", label: "Terminados" },
  { value: "failed", label: "Fallidos" },
  { value: "cancelled", label: "Cancelados" },
  { value: "interrupted", label: "Interrumpidos" },
];

const selectCls =
  "min-h-9 rounded-tight border border-line bg-surface px-2.5 py-1.5 text-small text-ink-2";

/**
 * Caché en memoria de título por tarea (I2): esta vista vive dos veces
 * (global en Sistema y filtrada dentro de cada proyecto) y sondea cada 10s,
 * así que compartir la caché entre montajes evita pedir de nuevo lo ya sabido.
 */
const taskTitleCache = new Map<string, string>();

export default function RunsView({ projectId }: { projectId?: string } = {}) {
  const agents = useStore((s) => s.agents);
  const projects = useStore((s) => s.projects);
  const openTask = useStore((s) => s.openTask);
  const boardTasks = useStore((s) => s.board.tasks);
  const [params, setParams] = useSearchParams();
  const taskFilter = params.get("de_tarea");

  const [runs, setRuns] = useState<Run[] | null>(null);
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [agentId, setAgentId] = useState("");
  const [costFilter, setCostFilter] = useState<"" | "with_cost" | "no_cost">("");

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api.runs({
        limit: 100,
        ...(status ? { status } : {}),
        ...(agentId ? { agent_id: agentId } : {}),
        ...(projectId ? { project_id: projectId } : {}),
        ...(taskFilter ? { task_id: taskFilter } : {}),
      });
      setRuns(res.runs);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo leer la actividad");
    }
  }, [status, agentId, projectId, taskFilter]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 10_000);
    return () => clearInterval(t);
  }, [load]);

  // Títulos de tarea para que la columna diga el trabajo y no un identificador.
  // No se baja la base entera (I2): sólo se piden, en paralelo, los ids
  // distintos que aparecen en la página de runs visible y que aún no estén en
  // la caché en memoria.
  useEffect(() => {
    const ids = Array.from(
      new Set((runs ?? []).map((r) => r.taskId).filter((id): id is string => Boolean(id))),
    ).filter((id) => !taskTitleCache.has(id));
    if (ids.length === 0) return;
    let cancelled = false;
    void (async () => {
      await Promise.all(
        ids.map(async (id) => {
          try {
            const detail = await api.task(id);
            taskTitleCache.set(id, detail.task.title);
          } catch {
            /* la columna cae a un enlace genérico, nunca a un id crudo */
          }
        }),
      );
      if (!cancelled) setTitles((prev) => ({ ...prev, ...Object.fromEntries(taskTitleCache) }));
    })();
    return () => {
      cancelled = true;
    };
  }, [runs]);

  const titleOf = useCallback(
    (taskId: string): string | null => {
      const fromBoard = (boardTasks as Record<string, Task>)[taskId]?.title;
      return titles[taskId] ?? fromBoard ?? null;
    },
    [titles, boardTasks],
  );

  const filtered = useMemo(() => {
    if (!runs) return null;
    if (costFilter === "with_cost") return runs.filter((r) => r.costUsd !== null && r.costUsd > 0);
    if (costFilter === "no_cost") return runs.filter((r) => r.costUsd === null);
    return runs;
  }, [runs, costFilter]);

  const agentById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  const projectById = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);
  const filteredTaskTitle = taskFilter ? titleOf(taskFilter) : null;

  return (
    <div className="density-operar">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <select
          value={agentId}
          onChange={(e) => setAgentId(e.target.value)}
          aria-label="Filtrar por agente"
          className={selectCls}
        >
          <option value="">Todos los agentes</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          aria-label="Filtrar por estado"
          className={selectCls}
        >
          {RUN_STATUS_OPTIONS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        <select
          value={costFilter}
          onChange={(e) => setCostFilter(e.target.value as typeof costFilter)}
          aria-label="Filtrar por coste"
          className={selectCls}
        >
          <option value="">Con y sin coste</option>
          <option value="with_cost">Con coste reportado</option>
          <option value="no_cost">Coste no reportado</option>
        </select>
        {taskFilter ? (
          <span className="flex items-center gap-2">
            <Chip tone="link">Sólo {filteredTaskTitle ?? "una tarea"}</Chip>
            <button
              onClick={() => {
                params.delete("de_tarea");
                setParams(params, { replace: true });
              }}
              className="press text-small text-link hover:underline"
            >
              Quitar el filtro
            </button>
          </span>
        ) : null}
        <ActionButton className="ml-auto" onClick={() => void load()}>
          Actualizar
        </ActionButton>
      </div>

      {error ? <ErrorBox message={error} onRetry={() => void load()} /> : null}
      {!filtered && !error ? <Spinner label="Cargando la actividad…" /> : null}
      {filtered && filtered.length === 0 ? (
        <EmptyState
          title="Todavía no hay ejecuciones"
          hint="Cada vez que un agente trabaje, aquí quedará el registro con su tarea, su coste y lo que hizo."
        />
      ) : null}

      {filtered && filtered.length > 0 ? (
        <div className="overflow-x-auto rounded-panel bg-surface shadow-rest">
          <table className="w-full min-w-[58rem] border-collapse text-left">
            <thead>
              <tr>
                {["Ejecución", "Tarea", "Proyecto", "Agente", "Estado", "Tokens", "Coste", "Cuándo"].map(
                  (h) => (
                    <th key={h} scope="col" className="border-b border-line px-3 py-2.5 text-label text-muted">
                      {h}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => {
                const agent = r.agentId ? agentById.get(r.agentId) : null;
                const project = r.projectId ? projectById.get(r.projectId) : null;
                const taskTitle = r.taskId ? titleOf(r.taskId) : null;
                return (
                  <tr key={r.id} className="hover:bg-surface-2" data-testid={`run-row-${r.id}`}>
                    <td className="border-b border-line-soft px-3 py-2.5 text-small">
                      <Link to={paths.run(r.id)} className="press font-mono font-semibold text-link hover:underline">
                        {r.id.slice(0, 8)}
                      </Link>
                      {r.parentRunId ? <span className="ml-1 text-faint">hijo</span> : null}
                    </td>
                    <td className="border-b border-line-soft px-3 py-2.5 text-small">
                      {r.taskId ? (
                        <button
                          onClick={() => void openTask(r.taskId!)}
                          className="press max-w-56 truncate text-left font-medium text-link hover:underline"
                          title={taskTitle ?? "Abrir la tarjeta"}
                        >
                          {taskTitle ?? "Abrir la tarjeta"}
                        </button>
                      ) : (
                        <span className="text-faint">Sin tarea</span>
                      )}
                    </td>
                    <td className="border-b border-line-soft px-3 py-2.5 text-small">
                      {r.projectId ? (
                        <Link
                          to={paths.proyecto(r.projectId, "ruta")}
                          className="press max-w-44 truncate font-medium text-link hover:underline"
                        >
                          {project?.name ?? "Ver el proyecto"}
                        </Link>
                      ) : (
                        <span className="text-faint">Sin proyecto</span>
                      )}
                    </td>
                    <td className="border-b border-line-soft px-3 py-2.5 text-small">
                      {agent ? (
                        <span className="flex items-center gap-1.5">
                          <AgentAvatar name={agent.name} slug={agent.slug} size={5} />
                          {agent.name}
                        </span>
                      ) : (
                        <span className="text-faint">—</span>
                      )}
                    </td>
                    <td className="border-b border-line-soft px-3 py-2.5">
                      <RunStatusPill status={r.status} />
                    </td>
                    <td className="border-b border-line-soft px-3 py-2.5 text-small tabular-nums text-muted">
                      {fmtTokens(r.tokensIn)} / {fmtTokens(r.tokensOut)}
                    </td>
                    <td className="border-b border-line-soft px-3 py-2.5 text-small tabular-nums text-muted">
                      {fmtCost(r.costUsd)}
                    </td>
                    <td className="border-b border-line-soft px-3 py-2.5 text-small text-faint">
                      {timeAgo(r.createdAt)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
