/**
 * Sistema › Equipo. Personas y agentes, que antes vivían en el Cerebro.
 * Las personas se distinguen por si son de Sixteam o del cliente; los agentes,
 * por su capa y por a quién reportan. Ningún identificador crudo a la vista.
 */
import { Link } from "react-router-dom";
import { useBrainOverview } from "../state/useBrainOverview";
import { Card, Chip, SectionHead, type Tone } from "../components/system";
import { AgentAvatar, ErrorBox, PersonAvatar, Spinner } from "../components/ui";
import { paths } from "../lib/paths";
import type { AgentStatus, BrainAgent } from "../lib/types";

const LAYER_LABELS: Record<string, string> = {
  consultoria: "Consultoría",
  implementacion: "Implementación",
  operacion: "Operación",
  meta: "Meta",
};

const AGENT_STATUS: Record<AgentStatus, { label: string; tone: Tone }> = {
  active: { label: "activo", tone: "done" },
  paused: { label: "pausado", tone: "work" },
  disabled: { label: "apagado", tone: "broken" },
};

const AUTONOMY_LABELS: Record<string, string> = {
  manual: "manual",
  supervised: "supervisado",
  auto: "autónomo",
};

function reportsTo(agent: BrainAgent): string | null {
  return agent.reports_to ?? agent.reportsTo ?? null;
}

export default function SystemTeamView() {
  const { overview, error, reload } = useBrainOverview();

  if (error) return <ErrorBox message={error} onRetry={reload} />;
  if (!overview) return <Spinner label="Leyendo el equipo…" />;

  const people = overview.core.people;
  const internal = people.filter((p) => p.is_internal);
  const external = people.filter((p) => !p.is_internal);
  const agents = overview.agents.items;
  const byId = new Map(agents.map((a) => [a.id, a]));

  return (
    <div className="density-explorar">
      <p className="max-w-[62ch] text-body text-muted">
        Quién puede recibir una tarea: las personas del roster y los agentes con su capa, su modelo y a
        quién reportan.
      </p>

      <SectionHead label="Personas" count={people.length} />
      <div className="grid gap-2.5 lg:grid-cols-2">
        {[
          { title: "Sixteam", list: internal },
          { title: "Del cliente", list: external },
        ].map((group) => (
          <Card key={group.title} className="overflow-hidden">
            <div className="border-b border-line-soft px-4 py-3">
              <h3 className="text-label uppercase text-muted">{group.title}</h3>
            </div>
            {group.list.length === 0 ? (
              <p className="px-4 py-4 text-small text-muted">Nadie por aquí todavía.</p>
            ) : (
              group.list.map((p) => (
                <div key={p.id} className="flex items-center gap-2.5 border-b border-line-soft px-4 py-2.5 last:border-b-0">
                  <PersonAvatar name={p.full_name} size={6} />
                  <span className="min-w-0 flex-1 truncate text-small font-medium text-ink-2">
                    {p.full_name}
                  </span>
                  <span className="shrink-0 text-small text-muted">{p.role ?? "sin rol"}</span>
                </div>
              ))
            )}
          </Card>
        ))}
      </div>

      <SectionHead label="Agentes" count={agents.length} />
      <div className="grid gap-2.5 lg:grid-cols-2">
        {agents.map((agent) => {
          const chief = reportsTo(agent);
          const status = AGENT_STATUS[agent.status] ?? { label: agent.status, tone: "quiet" as Tone };
          return (
            <Card key={agent.id} className="p-4" data-testid={`agent-${agent.slug}`}>
              <div className="flex flex-wrap items-center gap-2">
                <AgentAvatar name={agent.name} slug={agent.slug} size={6} />
                <h3 className="text-body font-semibold text-ink">{agent.name}</h3>
                <Chip tone={status.tone}>{status.label}</Chip>
                <span className="ml-auto text-small text-muted">
                  {LAYER_LABELS[agent.layer] ?? agent.layer}
                </span>
              </div>
              <p className="mt-1.5 text-small text-muted">
                Modelo {agent.model ?? "no asignado"} · autonomía{" "}
                {AUTONOMY_LABELS[agent.autonomy] ?? agent.autonomy}
              </p>
              {chief ? (
                <p className="mt-1 text-small text-muted">
                  Reporta a:{" "}
                  <span className="font-medium text-ink-2">{byId.get(chief)?.name ?? "otro agente"}</span>
                </p>
              ) : (
                <p className="mt-1 text-small text-faint">No reporta a nadie: es raíz de su cadena.</p>
              )}
            </Card>
          );
        })}
      </div>
      <p className="mt-4 text-small text-muted">
        Para pausar, apagar o cambiarles el modelo,{" "}
        <Link to={paths.sistema("ajustes")} className="press font-semibold text-link hover:underline">
          entra a Ajustes
        </Link>
        .
      </p>
    </div>
  );
}
