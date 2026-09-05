import { useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../lib/api";
import type {
  BrainAgent,
  BrainAgentHealth,
  BrainModule,
  BrainOverview,
  BrainPerson,
  BrainSource,
} from "../lib/types";
import { AgentAvatar, ErrorBox, PersonAvatar, Spinner } from "../components/ui";

const SOURCE_ORDER: BrainSource["id"][] = ["agentos", "whatsapphub", "llm_wiki", "notion"];

const SOURCE_META: Record<BrainSource["id"], { label: string; short: string }> = {
  agentos: { label: "AgentOS", short: "núcleo" },
  whatsapphub: { label: "2brain · VPS / WhatsAppHub", short: "vps" },
  llm_wiki: { label: "LLM Wiki", short: "conocimiento" },
  notion: { label: "Notion · Projects & Tasks (1)", short: "operación" },
};

const COUNT_LABELS: Array<{ key: string; label: string; detail: string }> = [
  { key: "projects", label: "Proyectos", detail: "tablero operativo" },
  { key: "tasks", label: "Tareas", detail: "historial preservado" },
  { key: "people", label: "Personas", detail: "roster visible" },
  { key: "agents", label: "Agentes", detail: "jerarquía LLM" },
  { key: "knowledge_docs", label: "Documentos", detail: "contexto indexado" },
  { key: "project_sources", label: "Fuentes ligadas", detail: "trazabilidad" },
];

const LAYER_LABELS: Record<string, string> = {
  consultoria: "Consultoría",
  implementacion: "Implementación",
  operacion: "Operación",
  meta: "Meta",
};

const STATUS_LABELS: Record<BrainSource["status"], string> = {
  connected: "conectada",
  degraded: "degradada",
  not_configured: "no configurada",
  offline: "offline",
};

const MODULE_STATUS_LABELS: Record<BrainModule["status"], string> = {
  available: "disponible",
  partial: "parcial",
  offline: "offline",
};

const LENSES = [
  {
    id: "processes-lens",
    number: "01",
    label: "Procesos y tareas",
    description: "Dónde avanza el trabajo",
    connection: "proyectos + tareas → equipo",
    tone: "border-emerald-200 bg-emerald-50/80 hover:border-emerald-300",
    marker: "bg-emerald-500",
  },
  {
    id: "team-lens",
    number: "02",
    label: "Equipo y roles",
    description: "Quién responde por el sistema",
    connection: "personas + agentes → coordinación",
    tone: "border-sky-200 bg-sky-50/80 hover:border-sky-300",
    marker: "bg-sky-500",
  },
  {
    id: "tools-lens",
    number: "03",
    label: "Herramientas y módulos",
    description: "Qué capacidades sostienen la operación",
    connection: "módulos → fuentes de origen",
    tone: "border-violet-200 bg-violet-50/80 hover:border-violet-300",
    marker: "bg-violet-500",
  },
  {
    id: "knowledge-lens",
    number: "04",
    label: "Datos y conocimiento",
    description: "Qué evidencia alimenta el blueprint",
    connection: "fuentes → contexto trazable",
    tone: "border-amber-200 bg-amber-50/80 hover:border-amber-300",
    marker: "bg-amber-500",
  },
] as const;

function formatCount(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString("es-CO") : "—";
}

function formatTimestamp(value: string | null | undefined): string {
  if (!value) return "sin reporte";
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) return value;
  return timestamp.toLocaleString("es-CO", {
    dateStyle: "short",
    timeStyle: "short",
  });
}

function freshnessLabel(value: string | null | undefined): string {
  return value ? formatTimestamp(value) : "sin lectura fechada";
}

function errorMessage(error: unknown): string {
  return error instanceof ApiError ? `${error.code}: ${error.message}` : "No se pudo leer el inventario del cerebro.";
}

function sourceStatusClass(status: BrainSource["status"] | "unknown"): string {
  if (status === "connected") return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (status === "degraded") return "border-amber-200 bg-amber-50 text-amber-800";
  if (status === "offline") return "border-rose-200 bg-rose-50 text-rose-800";
  if (status === "not_configured") return "border-slate-200 bg-slate-100 text-slate-600";
  return "border-slate-200 bg-white text-slate-500";
}

function sourceMarkerClass(status: BrainSource["status"] | "unknown"): string {
  if (status === "connected") return "bg-emerald-500 ring-emerald-100";
  if (status === "degraded") return "bg-amber-500 ring-amber-100";
  if (status === "offline") return "bg-rose-500 ring-rose-100";
  return "bg-slate-300 ring-slate-100";
}

function moduleStatusClass(status: BrainModule["status"]): string {
  if (status === "available") return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (status === "partial") return "border-amber-200 bg-amber-50 text-amber-800";
  return "border-rose-200 bg-rose-50 text-rose-800";
}

function agentStatusClass(status: string): string {
  if (status === "active") return "bg-emerald-100 text-emerald-800";
  if (status === "paused") return "bg-amber-100 text-amber-800";
  return "bg-slate-200 text-slate-600";
}

function reportTarget(agent: BrainAgent, health: BrainAgentHealth | undefined): string | null {
  return agent.reports_to ?? agent.reportsTo ?? health?.reports_to ?? null;
}

function agentLabel(agentId: string | null, agents: BrainAgent[]): string {
  if (!agentId) return "raíz del sistema";
  const agent = agents.find((item) => item.id === agentId || item.slug === agentId);
  return agent ? agent.name : agentId;
}

function StatusBadge({ status }: { status: BrainSource["status"] }) {
  return (
    <span className={`inline-flex min-h-6 items-center rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${sourceStatusClass(status)}`}>
      <span aria-hidden="true" className="mr-1.5 h-1.5 w-1.5 rounded-full bg-current" />
      {STATUS_LABELS[status]}
    </span>
  );
}

function CountStrip({ source }: { source: BrainSource | undefined }) {
  if (!source || Object.keys(source.counts).length === 0) {
    return <p className="mt-3 text-[11px] text-slate-400">Volumen: sin reporte.</p>;
  }
  const entries = Object.entries(source.counts).filter(([, value]) => typeof value === "number");
  if (entries.length === 0) return <p className="mt-3 text-[11px] text-slate-400">Volumen: sin reporte.</p>;
  return (
    <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 border-t border-slate-100 pt-3 sm:grid-cols-3">
      {entries.slice(0, 6).map(([key, value]) => (
        <div key={key} className="min-w-0">
          <dt className="truncate text-[10px] uppercase tracking-wide text-slate-400">{key.replaceAll("_", " ")}</dt>
          <dd className="mt-0.5 text-sm font-semibold tabular-nums text-slate-800">{formatCount(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

function BlueprintLenses({ overview }: { overview: BrainOverview }) {
  const connectedSources = overview.sources.filter((source) => source.status === "connected").length;
  const values: Record<(typeof LENSES)[number]["id"], string> = {
    "processes-lens": `${formatCount(overview.core.counts.projects)} proyectos · ${formatCount(overview.core.counts.tasks)} tareas`,
    "team-lens": `${formatCount(overview.core.counts.internal_people)} personas internas · ${formatCount(overview.core.counts.agents)} agentes`,
    "tools-lens": `${formatCount(overview.modules.length)} módulos con origen visible`,
    "knowledge-lens": `${formatCount(connectedSources)}/${formatCount(overview.sources.length)} fuentes conectadas`,
  };

  return (
    <section aria-labelledby="blueprint-heading" className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="max-w-2xl">
          <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-slate-400">Una lectura, cuatro lentes</p>
          <h2 id="blueprint-heading" className="mt-1 text-xl font-bold tracking-tight text-slate-950">Blueprint operativo unificado</h2>
          <p className="mt-2 text-sm leading-relaxed text-slate-600">No es un tablero de widgets: cada lente abre evidencia del mismo sistema y deja visible qué se conecta con qué.</p>
        </div>
        <p className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5 text-[11px] font-medium text-slate-600">Corte de lectura: <time dateTime={overview.generated_at}>{formatTimestamp(overview.generated_at)}</time></p>
      </div>

      <nav aria-label="Cuatro lentes del blueprint operativo" className="mt-4 grid gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
        {LENSES.map((lens) => (
          <a
            key={lens.id}
            href={`#${lens.id}`}
            className={`brain-interaction group relative flex min-h-28 flex-col justify-between overflow-hidden rounded-xl border p-3.5 text-left shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:ring-offset-2 active:scale-[0.98] ${lens.tone}`}
          >
            <span aria-hidden="true" className={`absolute right-3 top-3 h-2 w-2 rounded-full ${lens.marker}`} />
            <div>
              <span className="text-[10px] font-bold tracking-[0.16em] text-slate-400">{lens.number}</span>
              <h3 className="mt-1 text-sm font-bold text-slate-900">{lens.label}</h3>
              <p className="mt-1 text-[11px] leading-relaxed text-slate-600">{lens.description}</p>
            </div>
            <div className="mt-3 border-t border-slate-900/10 pt-2">
              <p className="text-[11px] font-semibold tabular-nums text-slate-800">{values[lens.id]}</p>
              <p className="mt-0.5 text-[10px] text-slate-500">{lens.connection}</p>
            </div>
          </a>
        ))}
      </nav>
    </section>
  );
}

function SourceSpine({ sources }: { sources: BrainSource[] }) {
  const byId = useMemo(() => new Map(sources.map((source) => [source.id, source])), [sources]);
  return (
    <section id="knowledge-lens" aria-labelledby="sources-heading" className="scroll-mt-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
      <div className="flex flex-wrap items-end justify-between gap-2 border-b border-slate-100 pb-4">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-slate-400">Datos y conocimiento · lente 04</p>
          <h2 id="sources-heading" className="mt-1 text-lg font-bold tracking-tight text-slate-900">Fuentes, origen y frescura</h2>
        </div>
        <p className="max-w-xs text-right text-[11px] leading-relaxed text-slate-400">Estado y volumen vienen del API; el panel no inventa sincronizaciones.</p>
      </div>
      <ol className="relative mt-5 space-y-4 before:absolute before:bottom-7 before:left-[0.55rem] before:top-7 before:w-px before:bg-slate-200">
        {SOURCE_ORDER.map((id) => {
          const source = byId.get(id);
          const status = source?.status ?? "unknown";
          const meta = SOURCE_META[id];
          return (
            <li key={id} className="relative pl-8">
              <span aria-hidden="true" className={`absolute left-0 top-4 h-[1.15rem] w-[1.15rem] rounded-full ring-4 ${sourceMarkerClass(status)}`} />
              <article className="rounded-xl border border-slate-200 bg-slate-50/70 p-3.5 sm:p-4">
                <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-sm font-bold text-slate-900">{source?.label ?? meta.label}</h3>
                      <span className="rounded bg-slate-200 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide text-slate-500">{meta.short}</span>
                    </div>
                    <p className="mt-1 text-[11px] leading-relaxed text-slate-500">{source?.detail ?? "El API todavía no reporta esta fuente."}</p>
                  </div>
                  {source ? <StatusBadge status={source.status} /> : <span className="inline-flex min-h-6 items-center rounded-full border border-slate-200 bg-white px-2 text-[10px] font-bold uppercase tracking-wide text-slate-500">sin reporte</span>}
                </div>
                <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-[10px] text-slate-500">
                  <span><span className="font-semibold text-slate-700">Modo:</span> {source?.mode ?? "sin reporte"}</span>
                  <span><span className="font-semibold text-slate-700">Comprobación:</span> {freshnessLabel(source?.last_checked_at)}</span>
                  {id === "notion" ? (
                    <span><span className="font-semibold text-slate-700">Captura:</span> {freshnessLabel(source?.last_snapshot_at)}</span>
                  ) : null}
                </div>
                <CountStrip source={source} />
              </article>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function StageChips({ title, stages }: { title: string; stages: string[] | undefined }) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400">{title}</p>
      {stages && stages.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {stages.map((stage) => <span key={stage} className="rounded-md border border-violet-200 bg-violet-50 px-2 py-1 text-[10px] font-medium text-violet-800">{stage}</span>)}
        </div>
      ) : <p className="mt-1 text-[11px] text-slate-400">Sin etapas reportadas.</p>}
    </div>
  );
}

function NotionStages({ source }: { source: BrainSource | undefined }) {
  if (!source?.stages) return null;
  return (
    <div className="mt-4 grid gap-3 border-t border-slate-200 pt-3 sm:grid-cols-2">
      <StageChips title="Etapas de tareas" stages={source.stages.tasks} />
      <StageChips title="Etapas de proyectos" stages={source.stages.projects} />
    </div>
  );
}

function Summary({ overview }: { overview: BrainOverview }) {
  const internalPeople = overview.core.counts.internal_people;
  return (
    <section id="processes-lens" aria-labelledby="summary-heading" className="scroll-mt-4">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-slate-400">Procesos y tareas · lente 01</p>
          <h2 id="summary-heading" className="mt-1 text-lg font-bold tracking-tight text-slate-900">Trabajo que AgentOS ya puede sostener</h2>
        </div>
        <p className="text-[11px] text-slate-500">Corte: <time dateTime={overview.generated_at}>{formatTimestamp(overview.generated_at)}</time></p>
      </div>
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
        {COUNT_LABELS.map((item) => (
          <article key={item.key} className="min-w-0 rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
            <p className="truncate text-[10px] font-bold uppercase tracking-wide text-slate-400">{item.label}</p>
            <p className="mt-2 text-2xl font-semibold tabular-nums tracking-tight text-slate-900">{formatCount(overview.core.counts[item.key])}</p>
            <p className="mt-1 truncate text-[10px] text-slate-400">{item.detail}</p>
          </article>
        ))}
      </div>
      <p className="mt-2 text-[11px] text-slate-500">Equipo interno reportado: <span className="font-semibold text-slate-800">{formatCount(internalPeople)}</span>. Los guiones significan que el origen no lo reportó.</p>
    </section>
  );
}

function PeopleTable({ people }: { people: BrainPerson[] }) {
  const internalPeople = people.filter((person) => person.is_internal);
  return (
    <section id="team-lens" aria-labelledby="people-heading" className="scroll-mt-4 min-w-0 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
      <div className="flex items-end justify-between gap-2 border-b border-slate-100 pb-3">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-slate-400">Equipo y roles · lente 02</p>
          <h2 id="people-heading" className="mt-1 text-lg font-bold tracking-tight text-slate-900">Personas internas</h2>
        </div>
        <span className="rounded-full bg-slate-100 px-2 py-1 text-[10px] font-bold text-slate-600">{internalPeople.length} visibles</span>
      </div>
      {internalPeople.length === 0 ? (
        <p className="mt-4 rounded-lg border border-dashed border-slate-300 bg-slate-50 p-4 text-xs text-slate-500">No hay usuarios internos reportados por el API.</p>
      ) : (
        <div className="mt-3 overflow-hidden rounded-lg border border-slate-100">
          <table className="w-full table-fixed text-left text-xs">
            <caption className="sr-only">Usuarios internos disponibles en AgentOS</caption>
            <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-400">
              <tr>
                <th className="w-[52%] px-3 py-2 font-semibold">Persona</th>
                <th className="w-[30%] px-3 py-2 font-semibold">Rol</th>
                <th className="w-[18%] px-3 py-2 text-right font-semibold">Acceso</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {internalPeople.map((person) => (
                <tr key={person.id} className="align-middle hover:bg-slate-50">
                  <td className="max-w-0 px-3 py-2.5">
                    <div className="flex min-w-0 items-center gap-2">
                      <PersonAvatar name={person.full_name} size={6} />
                      <div className="min-w-0">
                        <p className="truncate font-medium text-slate-800">{person.full_name}</p>
                      </div>
                    </div>
                  </td>
                  <td className="max-w-0 truncate px-3 py-2.5 text-slate-600">{person.role ?? "sin rol"}</td>
                  <td className="px-3 py-2.5 text-right"><span className="rounded bg-emerald-50 px-1.5 py-1 text-[10px] font-semibold text-emerald-700">interno</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function AgentCoordinationChain({ agents }: { agents: BrainOverview["agents"] }) {
  const relationships = agents.items.flatMap((agent) => {
    const health = agents.health.find((item) => item.id === agent.id || item.slug === agent.slug);
    const parent = reportTarget(agent, health);
    return parent ? [{ agent, parent: agentLabel(parent, agents.items) }] : [];
  });
  const roots = agents.items.filter((agent) => {
    const health = agents.health.find((item) => item.id === agent.id || item.slug === agent.slug);
    return !reportTarget(agent, health);
  });

  return (
    <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50/80 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-slate-400">Wayfinding de coordinación</p>
          <h3 className="mt-0.5 text-sm font-bold text-slate-900">Cadena agente → subagente</h3>
        </div>
        <span className="rounded-full border border-slate-200 bg-white px-2 py-1 text-[10px] font-semibold text-slate-600">{relationships.length} relación{relationships.length === 1 ? "" : "es"}</span>
      </div>
      {relationships.length > 0 ? (
        <ol className="mt-3 space-y-2" aria-label="Relaciones de reporte entre agentes">
          {relationships.map(({ agent, parent }) => (
            <li key={agent.id} className="flex min-w-0 items-center gap-2 text-xs text-slate-700">
              <span className="inline-flex min-h-7 shrink-0 items-center rounded-md bg-slate-200 px-2 font-medium text-slate-700">{parent}</span>
              <span aria-hidden="true" className="text-slate-400">→</span>
              <span className="inline-flex min-h-7 min-w-0 items-center rounded-md border border-sky-200 bg-sky-50 px-2 font-semibold text-sky-900">{agent.name}</span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="mt-3 text-[11px] leading-relaxed text-slate-500">No hay relaciones de reporte para dibujar; los agentes se muestran como raíces del sistema.</p>
      )}
      {roots.length > 0 ? <p className="mt-3 text-[10px] text-slate-500">{roots.length === 1 ? "Raíz" : "Raíces"}: {roots.map((agent) => agent.name).join(" · ")}</p> : null}
      <p className="mt-2 text-[10px] leading-relaxed text-slate-400">La API entrega relaciones de reporte; esta vista no las presenta como eventos de handoff de tareas.</p>
    </div>
  );
}

function AgentRoster({ agents }: { agents: BrainOverview["agents"] }) {
  const health = useMemo(() => new Map(agents.health.map((item) => [item.id, item])), [agents.health]);
  return (
    <section aria-labelledby="agents-heading" className="min-w-0 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
      <div className="flex flex-wrap items-end justify-between gap-2 border-b border-slate-100 pb-3">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-slate-400">Orquestación y roles</p>
          <h2 id="agents-heading" className="mt-1 text-lg font-bold tracking-tight text-slate-900">Agentes y subagentes</h2>
        </div>
        <span className="rounded-full bg-slate-100 px-2 py-1 text-[10px] font-bold text-slate-600">{agents.items.length} registrados</span>
      </div>
      {agents.items.length === 0 ? (
        <p className="mt-4 rounded-lg border border-dashed border-slate-300 bg-slate-50 p-4 text-xs text-slate-500">No hay agentes reportados.</p>
      ) : (
        <>
          <AgentCoordinationChain agents={agents} />
          <div className="mt-3 grid gap-2">
          {agents.items.map((agent) => {
            const itemHealth = health.get(agent.id) ?? health.get(agent.slug);
            const parent = reportTarget(agent, itemHealth);
            const status = itemHealth?.status ?? agent.status;
            return (
              <article key={agent.id} className="min-w-0 rounded-xl border border-slate-100 bg-slate-50/80 p-3">
                <div className="flex min-w-0 items-start gap-3">
                  <AgentAvatar name={agent.name} slug={agent.slug} size={8} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <h3 className="truncate text-sm font-semibold text-slate-900">{agent.name}</h3>
                      <span className="font-mono text-[10px] text-slate-400">{agent.slug}</span>
                    </div>
                    <p className="mt-1 break-words text-[11px] text-slate-500">Reporta a: <span className="font-medium text-slate-700">{agentLabel(parent, agents.items)}</span></p>
                  </div>
                  <span className={`shrink-0 rounded-full px-2 py-1 text-[10px] font-bold ${agentStatusClass(status)}`}>{status === "active" ? "activo" : status === "paused" ? "pausado" : status}</span>
                </div>
                <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 border-t border-slate-200/70 pt-3 text-[10px] sm:grid-cols-4">
                  <div className="min-w-0"><dt className="uppercase tracking-wide text-slate-400">Capa</dt><dd className="mt-0.5 truncate font-medium text-slate-700">{LAYER_LABELS[agent.layer] ?? agent.layer}</dd></div>
                  <div className="min-w-0"><dt className="uppercase tracking-wide text-slate-400">Modelo</dt><dd className="mt-0.5 truncate font-mono text-slate-700">{agent.model ?? "por defecto"}</dd></div>
                  <div className="min-w-0"><dt className="uppercase tracking-wide text-slate-400">Runtime</dt><dd className="mt-0.5 truncate font-mono text-slate-700">{agent.runtime}</dd></div>
                  <div className="min-w-0"><dt className="uppercase tracking-wide text-slate-400">Autonomía</dt><dd className="mt-0.5 truncate font-medium text-slate-700">{agent.autonomy}</dd></div>
                </dl>
              </article>
            );
          })}
          </div>
        </>
      )}
    </section>
  );
}

function ModuleMap({ modules, sources }: { modules: BrainModule[]; sources: BrainSource[] }) {
  const sourcesById = useMemo(() => new Map(sources.map((source) => [source.id, source])), [sources]);
  return (
    <section id="tools-lens" aria-labelledby="modules-heading" className="scroll-mt-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
      <div className="flex flex-wrap items-end justify-between gap-2 border-b border-slate-100 pb-3">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-slate-400">Herramientas y módulos · lente 03</p>
          <h2 id="modules-heading" className="mt-1 text-lg font-bold tracking-tight text-slate-900">Capacidades y sus dependencias</h2>
        </div>
        <span className="text-[11px] text-slate-400">Cada módulo declara la fuente de la que depende</span>
      </div>
      {modules.length === 0 ? (
        <p className="mt-4 rounded-lg border border-dashed border-slate-300 bg-slate-50 p-4 text-xs text-slate-500">No hay módulos reportados por el API.</p>
      ) : (
        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {modules.map((module) => {
            const source = sourcesById.get(module.source_id);
            return (
              <article key={module.id} className="min-w-0 rounded-xl border border-slate-100 bg-slate-50/40 p-3">
                <div className="flex items-start justify-between gap-2">
                  <h3 className="min-w-0 text-sm font-semibold text-slate-900">{module.label}</h3>
                  <span className={`shrink-0 rounded-full border px-2 py-1 text-[10px] font-bold ${moduleStatusClass(module.status)}`}>{MODULE_STATUS_LABELS[module.status]}</span>
                </div>
                <p className="mt-2 min-h-[2.5rem] text-[11px] leading-relaxed text-slate-500">{module.description}</p>
                <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-slate-200/70 pt-2 text-[10px]">
                  <span className="font-semibold text-slate-500">Depende de</span>
                  <span aria-hidden="true" className="text-slate-400">→</span>
                  <span className="rounded bg-white px-1.5 py-1 font-mono text-slate-600">{source?.label ?? SOURCE_META[module.source_id]?.label ?? module.source_id}</span>
                  {source ? <StatusBadge status={source.status} /> : <span className="rounded border border-slate-200 bg-white px-1.5 py-1 text-slate-500">sin reporte</span>}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

export default function BrainView() {
  const [overview, setOverview] = useState<BrainOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setOverview(await api.brainOverview());
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  return (
    <div className="min-h-full bg-slate-100 p-3 sm:p-5 lg:p-6">
      <style>{`
        .brain-material {
          background: rgba(15, 23, 42, 0.66);
          border: 1px solid rgba(255, 255, 255, 0.16);
          -webkit-backdrop-filter: blur(18px) saturate(135%);
          backdrop-filter: blur(18px) saturate(135%);
          box-shadow: 0 14px 32px rgba(2, 6, 23, 0.18);
        }
        .brain-interaction { transition: transform 100ms ease-out, border-color 140ms ease-out, background-color 140ms ease-out; }
        .brain-interaction:active { transform: scale(0.98); }
        @media (prefers-reduced-motion: reduce) {
          .brain-interaction { transition: none !important; transform: none !important; }
          .brain-interaction:active { transform: none !important; }
        }
        @media (prefers-reduced-transparency: reduce) {
          .brain-material { background: rgb(15, 23, 42); -webkit-backdrop-filter: none; backdrop-filter: none; }
        }
        @media (prefers-contrast: more) {
          .brain-material { background: rgb(15, 23, 42); border-color: rgba(255, 255, 255, 0.9); }
          .brain-interaction { border-width: 2px; }
        }
      `}</style>
      <div className="mx-auto max-w-[1440px] space-y-5">
        <header className="relative overflow-hidden rounded-2xl bg-slate-950 px-4 py-5 text-white shadow-sm sm:px-6 sm:py-6">
          <div aria-hidden="true" className="absolute -right-16 -top-24 h-64 w-64 rounded-full border border-white/10" />
          <div aria-hidden="true" className="absolute -right-5 -top-12 h-40 w-40 rounded-full border border-emerald-300/20" />
          <div className="relative flex flex-wrap items-end justify-between gap-4">
            <div className="max-w-2xl">
              <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-emerald-300">2brain / AgentOS · blueprint operativo unificado</p>
              <h1 className="mt-2 text-2xl font-bold tracking-tight sm:text-3xl">El cerebro operativo</h1>
              <p className="mt-2 max-w-xl text-sm leading-relaxed text-slate-300">Procesos, roles, módulos y conocimiento en una misma lectura. Aquí se distingue lo conectado de lo que aún necesita configuración, sin convertir el sistema en un dashboard genérico.</p>
            </div>
            <div className="brain-material flex min-h-11 flex-wrap items-center gap-3 rounded-xl px-3 py-2">
              {overview ? <p className="text-[10px] leading-tight text-slate-200">Frescura<br /><time dateTime={overview.generated_at} className="font-semibold text-white">{formatTimestamp(overview.generated_at)}</time></p> : <p className="text-[10px] text-slate-200">Esperando la lectura del API</p>}
              <button onClick={() => void load()} disabled={loading} className="brain-interaction min-h-11 rounded-lg border border-white/20 bg-white/10 px-4 text-xs font-semibold text-white outline-none hover:bg-white/20 focus-visible:ring-2 focus-visible:ring-emerald-300 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950 active:scale-[0.98] disabled:cursor-wait disabled:opacity-60" aria-label="Actualizar inventario del cerebro">
                {loading ? "Actualizando…" : "Actualizar lectura"}
              </button>
            </div>
          </div>
        </header>

        {loading && !overview ? <div className="rounded-2xl border border-slate-200 bg-white p-5" role="status" aria-live="polite"><Spinner label="Leyendo el inventario real…" /></div> : null}
        {error ? <div role="alert"><ErrorBox message={error} onRetry={() => void load()} /></div> : null}
        {overview ? (
          <>
            <BlueprintLenses overview={overview} />
            <Summary overview={overview} />
            <div className="grid min-w-0 gap-5 xl:grid-cols-[minmax(0,0.78fr)_minmax(0,1.22fr)]">
              <PeopleTable people={overview.core.people} />
              <AgentRoster agents={overview.agents} />
            </div>
            <ModuleMap modules={overview.modules} sources={overview.sources} />
            <div id="notion-stages" className="scroll-mt-4"><NotionStages source={overview.sources.find((source) => source.id === "notion")} /></div>
            <SourceSpine sources={overview.sources} />
          </>
        ) : null}
      </div>
    </div>
  );
}
