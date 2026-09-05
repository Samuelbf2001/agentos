/**
 * Resumen por proyecto para Hoy y para la lista de Proyectos.
 *
 * Se arma SOLO con lo que la API ya devuelve: tareas del proyecto, estado de
 * cierre de fase y los runs en curso. Cuando una pieza falla, el campo queda
 * marcado como desconocido en vez de inventar un cero.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { taskDueState, type PhaseClosureStatus, type Project, type Task } from "../lib/types";
import { nextStage } from "../lib/decisions";
import { STAGE_LABELS } from "../components/system";

export interface ProjectSummary {
  project: Project;
  /** null = la API no dio las tareas todavía. */
  tasks: Task[] | null;
  closure: PhaseClosureStatus | null;
  overdue: number;
  open: number;
  /** Ids de agentes con un run vivo en este proyecto. */
  workingAgentIds: string[];
  nextMilestone: string;
  missing: string;
  /** true cuando el gate de la fase actual se puede aprobar ya. */
  gateReady: boolean;
}

export function summarize(
  project: Project,
  tasks: Task[] | null,
  closure: PhaseClosureStatus | null,
  workingAgentIds: string[],
  now = Date.now(),
): ProjectSummary {
  const live = tasks ?? [];
  const overdue = live.filter((t) => taskDueState(t, now) === "overdue").length;
  const open = live.filter((t) => t.status !== "DONE" && t.status !== "CANCELLED").length;

  const items = closure?.items ?? [];
  const covered = items.filter((i) => i.missing === null).length;
  const complete = closure?.complete ?? false;
  const gateReady = complete && project.gateState !== "approved";

  let missing: string;
  if (!closure || closure.reason === "no_launch") missing = "Sin módulo lanzado";
  else if (items.length === 0) missing = "El módulo no declaró entregables";
  else if (complete) missing = "Nada: el gate ya se puede aprobar";
  else missing = `${covered} de ${items.length} entregables`;

  const next = nextStage(project.stage);
  let nextMilestone: string;
  if (project.gateState === "approved" && next) nextMilestone = `Abrir ${STAGE_LABELS[next]}`;
  else if (gateReady) nextMilestone = `Aprobar el gate de ${STAGE_LABELS[project.stage]}`;
  else nextMilestone = `Cerrar ${STAGE_LABELS[project.stage]}`;

  return { project, tasks, closure, overdue, open, workingAgentIds, nextMilestone, missing, gateReady };
}

export function useProjectSummaries(projects: Project[]): {
  summaries: ProjectSummary[];
  loading: boolean;
  reload: () => void;
} {
  const [tasksByProject, setTasksByProject] = useState<Record<string, Task[]>>({});
  const [closureByProject, setClosureByProject] = useState<Record<string, PhaseClosureStatus>>({});
  const [workingByProject, setWorkingByProject] = useState<Record<string, string[]>>({});
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  const ids = projects.map((p) => p.id).join(",");

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (projects.length === 0) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    (async () => {
      const results = await Promise.allSettled([
        ...projects.map((p) => api.tasks({ project_id: p.id })),
        ...projects.map((p) => api.phaseStatus(p.id)),
        api.runs({ status: "running", limit: 100 }),
      ]);
      if (cancelled) return;
      const nextTasks: Record<string, Task[]> = {};
      const nextClosure: Record<string, PhaseClosureStatus> = {};
      projects.forEach((p, i) => {
        const t = results[i];
        if (t && t.status === "fulfilled") nextTasks[p.id] = (t.value as { tasks: Task[] }).tasks;
        const c = results[projects.length + i];
        if (c && c.status === "fulfilled") {
          nextClosure[p.id] = (c.value as { status: PhaseClosureStatus }).status;
        }
      });
      const runsResult = results[results.length - 1];
      const working: Record<string, string[]> = {};
      if (runsResult && runsResult.status === "fulfilled") {
        for (const run of (runsResult.value as { runs: { projectId: string | null; agentId: string | null }[] }).runs) {
          if (!run.projectId || !run.agentId) continue;
          const list = working[run.projectId] ?? [];
          if (!list.includes(run.agentId)) list.push(run.agentId);
          working[run.projectId] = list;
        }
      }
      setTasksByProject(nextTasks);
      setClosureByProject(nextClosure);
      setWorkingByProject(working);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids, nonce]);

  const summaries = useMemo(
    () =>
      projects.map((p) =>
        summarize(p, tasksByProject[p.id] ?? null, closureByProject[p.id] ?? null, workingByProject[p.id] ?? []),
      ),
    [projects, tasksByProject, closureByProject, workingByProject],
  );

  return { summaries, loading, reload };
}
