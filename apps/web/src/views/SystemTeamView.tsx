/**
 * Sistema › Equipo. Personas y agentes, que antes vivían en el Cerebro.
 * Las personas se distinguen por si son de Sixteam o del cliente; los agentes,
 * por su capa y por a quién reportan. Ningún identificador crudo a la vista.
 */
import { useBrainOverview } from "../state/useBrainOverview";
import { useStore } from "../state/store";
import { Card, SectionHead } from "../components/system";
import { ErrorBox, PersonAvatar, Spinner } from "../components/ui";
import { AgentsSection } from "./AgentsSection";

export default function SystemTeamView() {
  const { overview, error, reload } = useBrainOverview();
  const agentsCount = useStore((s) => s.agents.length);

  return (
    <div className="density-explorar">
      <p className="max-w-[62ch] text-body text-muted">
        Quién puede recibir una tarea: las personas del roster y los agentes con su capa, su modelo y a
        quién reportan.
      </p>

      {error ? (
        <ErrorBox message={error} onRetry={reload} />
      ) : !overview ? (
        <Spinner label="Leyendo el equipo…" />
      ) : (
        <>
          <SectionHead label="Personas" count={overview.core.people.length} />
          <div className="grid gap-2.5 lg:grid-cols-2">
            {[
              { title: "Sixteam", list: overview.core.people.filter((p) => p.is_internal) },
              { title: "Del cliente", list: overview.core.people.filter((p) => !p.is_internal) },
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
        </>
      )}

      <SectionHead label="Agentes" count={agentsCount} />
      <AgentsSection />
    </div>
  );
}
