/**
 * Sistema › Salud. Aquí aterrizaron los contadores y las fuentes que vivían en
 * el Cerebro: qué hay en la plataforma y de qué integraciones se puede fiar.
 *
 * El estado de una fuente usa la gramática de color única: verde conectada,
 * ámbar degradada, rojo caída, neutro sin configurar. Nunca color por
 * categoría, y ninguna enumeración cruda a la vista.
 */
import { Link } from "react-router-dom";
import { useBrainOverview } from "../state/useBrainOverview";
import { useStore } from "../state/store";
import { Card, Chip, SectionHead, Stat, type Tone } from "../components/system";
import { ErrorBox, Spinner } from "../components/ui";
import { paths } from "../lib/paths";
import type { BrainSource } from "../lib/types";

const COUNTERS: { key: string; label: string }[] = [
  { key: "projects", label: "Proyectos" },
  { key: "tasks", label: "Tareas" },
  { key: "people", label: "Personas" },
  { key: "agents", label: "Agentes" },
  { key: "knowledge_docs", label: "Documentos de contexto" },
  { key: "project_sources", label: "Fuentes ligadas" },
];

const SOURCE_STATUS: Record<BrainSource["status"], { label: string; tone: Tone }> = {
  connected: { label: "conectada", tone: "done" },
  degraded: { label: "degradada", tone: "work" },
  not_configured: { label: "no configurada", tone: "quiet" },
  offline: { label: "offline", tone: "broken" },
};

function fmtMoment(value: string | null | undefined): string {
  if (!value) return "sin lectura";
  const ts = Date.parse(value);
  if (Number.isNaN(ts)) return "sin lectura";
  return new Date(ts).toLocaleString("es", { dateStyle: "short", timeStyle: "short" });
}

function StageChips({ title, stages }: { title: string; stages: string[] | undefined }) {
  if (!stages || stages.length === 0) return null;
  return (
    <div className="mt-2">
      <p className="text-label uppercase text-muted">{title}</p>
      <div className="mt-1 flex flex-wrap gap-1.5">
        {stages.map((stage) => (
          <Chip key={stage} tone="quiet">
            {stage}
          </Chip>
        ))}
      </div>
    </div>
  );
}

export default function SystemHealthView() {
  const { overview, error, reload } = useBrainOverview();
  const projects = useStore((s) => s.projects);

  if (error) return <ErrorBox message={error} onRetry={reload} />;
  if (!overview) return <Spinner label="Leyendo el inventario del sistema…" />;

  const counts = overview.core.counts;
  const degraded = overview.sources.filter((s) => s.status !== "connected");

  return (
    <div className="density-explorar">
      <p className="max-w-[62ch] text-body text-muted">
        Qué hay guardado y de qué integraciones se puede fiar ahora mismo. Lectura del{" "}
        {fmtMoment(overview.generated_at)}.
      </p>

      <SectionHead label="Qué hay en la plataforma" />
      <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
        {COUNTERS.map((c) => (
          <Stat key={c.key} value={counts[c.key] ?? "—"} label={c.label} />
        ))}
      </div>

      <SectionHead label="Fuentes" count={overview.sources.length} />
      {degraded.length > 0 ? (
        <p className="mb-3 text-small text-muted">
          {degraded.length === 1 ? "Una fuente no está" : `${degraded.length} fuentes no están`} al 100 %.
          Los proyectos que dependen de ellas pueden quedarse sin contexto fresco:{" "}
          <Link to={paths.proyectos()} className="press font-semibold text-link hover:underline">
            revisa los {projects.length} proyectos abiertos
          </Link>
          .
        </p>
      ) : null}
      <div className="grid gap-2.5 lg:grid-cols-2">
        {overview.sources.map((source) => {
          const status = SOURCE_STATUS[source.status];
          return (
            <Card key={source.id} className="p-4" data-testid={`source-${source.id}`}>
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-body font-semibold text-ink">{source.label}</h3>
                <Chip tone={status.tone}>{status.label}</Chip>
                <span className="ml-auto text-small text-faint">{source.mode.replace(/_/g, " ")}</span>
              </div>
              <p className="mt-1.5 text-small text-muted">{source.detail}</p>
              <p className="mt-1.5 text-small text-faint">
                Última lectura: {fmtMoment(source.last_checked_at)}
                {source.last_snapshot_at ? ` · Captura: ${fmtMoment(source.last_snapshot_at)}` : ""}
              </p>
              {Object.keys(source.counts ?? {}).length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-small text-ink-2">
                  {Object.entries(source.counts).map(([k, v]) => (
                    <span key={k} className="tabular-nums">
                      <span className="font-semibold">{String(v)}</span>{" "}
                      <span className="text-muted">{k.replace(/_/g, " ")}</span>
                    </span>
                  ))}
                </div>
              ) : null}
              <StageChips title="Etapas de tareas" stages={source.stages?.tasks} />
              <StageChips title="Etapas de proyectos" stages={source.stages?.projects} />
            </Card>
          );
        })}
      </div>
    </div>
  );
}
