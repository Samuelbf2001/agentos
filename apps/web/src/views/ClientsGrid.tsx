/**
 * Rejilla de clientes: sustituye a la tabla de proyectos. Un cliente puede
 * tener más de un proyecto (assessment, transform, ops…); cada proyecto es un
 * bloque clicable dentro de la tarjeta de su cliente.
 */
import { Link } from "react-router-dom";
import { Card, Chip, PhaseChip, WorkingDot } from "../components/system";
import { EmptyState } from "../components/ui";
import { paths } from "../lib/paths";
import { clienteLabel } from "../lib/tareas";
import { useStore } from "../state/store";
import type { ProjectSummary } from "../state/useProjectSummaries";

interface ClientGroup {
  orgId: string;
  clientName: string;
  summaries: ProjectSummary[];
  overdueTotal: number;
  gateReady: boolean;
}

function groupByClient(summaries: ProjectSummary[]): ClientGroup[] {
  const byOrg = new Map<string, ProjectSummary[]>();
  for (const summary of summaries) {
    const own = byOrg.get(summary.project.orgId) ?? [];
    own.push(summary);
    byOrg.set(summary.project.orgId, own);
  }
  const projects = summaries.map((s) => s.project);
  const groups: ClientGroup[] = [...byOrg.entries()].map(([orgId, own]) => ({
    orgId,
    clientName: own[0]!.project.orgName ?? clienteLabel(orgId, { projects }),
    summaries: [...own].sort((a, b) => a.project.name.localeCompare(b.project.name, "es")),
    overdueTotal: own.reduce((acc, s) => acc + s.overdue, 0),
    gateReady: own.some((s) => s.gateReady),
  }));
  return groups.sort((a, b) => {
    if ((a.overdueTotal > 0) !== (b.overdueTotal > 0)) return a.overdueTotal > 0 ? -1 : 1;
    if (a.gateReady !== b.gateReady) return a.gateReady ? -1 : 1;
    return a.clientName.localeCompare(b.clientName, "es");
  });
}

export function ClientsGrid({ summaries }: { summaries: ProjectSummary[] }) {
  const agents = useStore((s) => s.agents);

  if (summaries.length === 0) {
    return (
      <EmptyState
        title="Todavía no hay clientes"
        hint="Un cliente nace cuando lanzas un módulo de fase para su primer proyecto."
        action={
          <Link to={paths.nuevoProyecto()} className="press mt-1 text-small font-semibold text-link underline">
            Crear el primero
          </Link>
        }
      />
    );
  }

  const groups = groupByClient(summaries);

  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {groups.map((group) => (
        <Card key={group.orgId} as="article" className="p-5" data-testid={`client-card-${group.orgId}`}>
          <div className="flex items-start justify-between gap-2">
            <h3 className="text-title text-ink">{group.clientName}</h3>
            {group.overdueTotal > 0 ? (
              <Chip tone="broken">{group.overdueTotal === 1 ? "1 vencida" : `${group.overdueTotal} vencidas`}</Chip>
            ) : group.gateReady ? (
              <Chip tone="work">Gate listo</Chip>
            ) : null}
          </div>
          <div className="mt-3 flex flex-col gap-1">
            {group.summaries.map(({ project, nextMilestone, missing, workingAgentIds }) => {
              const names = workingAgentIds
                .map((id) => agents.find((a) => a.id === id)?.name)
                .filter((n): n is string => Boolean(n));
              return (
                <Link
                  key={project.id}
                  to={paths.proyecto(project.id, "ruta")}
                  data-testid={`client-project-${project.id}`}
                  className="block rounded-soft -mx-2 px-2 py-2 hover:bg-canvas-deep/60"
                >
                  <p className="text-body font-medium text-ink">{project.name}</p>
                  <PhaseChip stage={project.stage} className="mt-1" />
                  <p className="mt-1 text-small text-muted">Siguiente: {nextMilestone}</p>
                  {missing ? <p className="text-small text-muted">Falta: {missing}</p> : null}
                  {names.length > 0 ? (
                    <WorkingDot label={`${names.length === 1 ? "1 agente" : `${names.length} agentes`} trabajando`} />
                  ) : null}
                </Link>
              );
            })}
          </div>
        </Card>
      ))}
      <Card
        as="article"
        className="flex items-center justify-center border-2 border-dashed border-line bg-transparent p-5 text-muted shadow-none"
      >
        <Link to={paths.nuevoProyecto()} className="press text-small font-semibold hover:text-ink">
          + Nuevo cliente
        </Link>
      </Card>
    </div>
  );
}

export default ClientsGrid;
