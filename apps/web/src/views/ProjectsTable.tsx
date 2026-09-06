/**
 * Tabla de proyectos: la misma en Hoy y en Proyectos, porque es el mismo dato.
 * Cada fila lleva a la Ruta del proyecto, que es donde se decide algo.
 */
import { useNavigate } from "react-router-dom";
import { PhaseChip, WorkingDot } from "../components/system";
import { EmptyState } from "../components/ui";
import { paths } from "../lib/paths";
import type { ProjectSummary } from "../state/useProjectSummaries";
import { useStore } from "../state/store";

export function ProjectsTable({ summaries }: { summaries: ProjectSummary[] }) {
  const navigate = useNavigate();
  const agents = useStore((s) => s.agents);

  if (summaries.length === 0) {
    return (
      <EmptyState
        title="Todavía no hay proyectos"
        hint="Un proyecto nace cuando lanzas un módulo de fase para un cliente."
      />
    );
  }

  return (
    <div className="overflow-x-auto rounded-panel border border-line-soft bg-surface shadow-rest">
      <table className="w-full min-w-[46rem] border-collapse text-left">
        <thead>
          <tr>
            {["Cliente", "Ciclo", "Siguiente hito", "Qué falta", "Vencidas", "Trabajando"].map((h) => (
              <th
                key={h}
                className="border-b border-line px-3.5 py-2.5 text-label uppercase text-muted"
                scope="col"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {summaries.map(({ project, overdue, nextMilestone, missing, workingAgentIds, tasks }) => {
            const names = workingAgentIds
              .map((id) => agents.find((a) => a.id === id)?.name)
              .filter((n): n is string => Boolean(n));
            return (
              <tr
                key={project.id}
                tabIndex={0}
                role="link"
                aria-label={`${project.name}: ${nextMilestone}`}
                data-testid={`project-row-${project.id}`}
                onClick={() => navigate(paths.proyecto(project.id, "ruta"))}
                onKeyDown={(e) => {
                  if (e.key === "Enter") navigate(paths.proyecto(project.id, "ruta"));
                }}
                className={`cursor-pointer transition-colors hover:bg-surface-2 ${overdue > 0 ? "late" : ""}`}
              >
                <td className="border-b border-line-soft px-3.5 py-3 text-body font-semibold text-ink">
                  {project.name}
                </td>
                <td className="border-b border-line-soft px-3.5 py-3">
                  <PhaseChip stage={project.stage} />
                </td>
                <td className="border-b border-line-soft px-3.5 py-3 text-small text-ink-2">{nextMilestone}</td>
                <td className="border-b border-line-soft px-3.5 py-3 text-small text-muted">{missing}</td>
                <td className="border-b border-line-soft px-3.5 py-3 text-small tabular-nums">
                  {tasks === null ? (
                    <span className="text-faint">—</span>
                  ) : overdue > 0 ? (
                    <span className="font-semibold text-broken">{overdue}</span>
                  ) : (
                    <span className="text-muted">0</span>
                  )}
                </td>
                <td className="border-b border-line-soft px-3.5 py-3 text-small">
                  {names.length > 0 ? (
                    <WorkingDot label={names.join(", ")} />
                  ) : (
                    <span className="text-faint">En espera</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default ProjectsTable;
