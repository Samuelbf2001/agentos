/**
 * Espejo operativo del pipeline histórico de reuniones de 2brain.
 *
 * No abre transcripciones, no ejecuta extracción y no crea tareas: muestra el
 * estado que WhatsAppHub ya calculó y dirige la asociación explícita al Context
 * Hub de AgentOS. La aprobación humana y cualquier escritura siguen en el
 * sistema heredado hasta que haya una migración contractual y reversible.
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import type { MeetingProcessingFilter, MeetingProcessingItem, MeetingProcessingOverview } from "../lib/types";
import { EmptyState, ErrorBox, Spinner } from "../components/ui";

const FILTERS: Array<{ id: MeetingProcessingFilter; label: string }> = [
  { id: "all", label: "Todas" },
  { id: "pending", label: "Pendientes" },
  { id: "error", label: "Con error" },
  { id: "ok", label: "Completas" },
];

function readableDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : new Intl.DateTimeFormat("es-CO", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function stageClass(done: boolean, problem = false): string {
  if (problem) return "border-rose-200 bg-rose-50 text-rose-800";
  return done ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-slate-200 bg-slate-50 text-slate-500";
}

function associationLabel(status: string): string {
  const labels: Record<string, string> = {
    awaiting_confirmation: "requiere revisión",
    needs_clarification: "requiere aclaración",
    confirmed: "asociación confirmada",
  };
  return labels[status] ?? status.replaceAll("_", " ");
}

function taskLabel(status: string): string {
  const labels: Record<string, string> = {
    candidates_pending_confirmation: "tareas candidatas",
    confirmed_candidates: "candidatas confirmadas",
    created: "tareas creadas",
    rejected: "tareas descartadas",
  };
  return labels[status] ?? status.replaceAll("_", " ");
}

function ProcessRail({ item }: { item: MeetingProcessingItem }) {
  const hasError = Boolean(item.processing_error);
  const extracted = Boolean(item.extracted_at);
  const reviewed = item.association_status === "confirmed";
  const carriedForward = Boolean(item.wiki_exported || item.notion_synced_at);
  const stages = [
    { label: "Capturada", done: Boolean(item.created_at || item.meeting_date) },
    { label: "Extraída", done: extracted },
    { label: "Revisión humana", done: reviewed },
    { label: "Evidencia", done: carriedForward },
  ];
  return (
    <ol className="grid grid-cols-2 gap-1.5 sm:grid-cols-4" aria-label={`Etapas de ${item.title}`}>
      {stages.map((stage, index) => (
        <li key={stage.label} className={`rounded-lg border px-2 py-1.5 text-[10px] font-semibold ${stageClass(stage.done, hasError && index === 1)}`}>
          <span className="mr-1" aria-hidden>{stage.done ? "✓" : index + 1}</span>
          {stage.label}
        </li>
      ))}
    </ol>
  );
}

function QueueCard({ label, value, tone }: { label: string; value: number | null; tone: "amber" | "rose" | "emerald" }) {
  const tones = {
    amber: "border-amber-200 bg-amber-50 text-amber-900",
    rose: "border-rose-200 bg-rose-50 text-rose-900",
    emerald: "border-emerald-200 bg-emerald-50 text-emerald-900",
  };
  return (
    <div className={`rounded-xl border p-3 ${tones[tone]}`}>
      <p className="text-xl font-bold tabular-nums">{value ?? "—"}</p>
      <p className="mt-0.5 text-[10px] font-bold uppercase tracking-[0.12em] opacity-75">{label}</p>
    </div>
  );
}

function MeetingRow({ item }: { item: MeetingProcessingItem }) {
  return (
    <article className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm sm:p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="break-words text-sm font-bold text-slate-900">{item.title}</h2>
          <p className="mt-1 text-[11px] text-slate-500">
            {item.source ?? "Fuente no reportada"} · {readableDate(item.meeting_date ?? item.created_at)}
          </p>
        </div>
        <div className="flex flex-wrap gap-1">
          <span className={`rounded-full px-2 py-1 text-[10px] font-bold ${item.processing_error ? "bg-rose-100 text-rose-800" : "bg-sky-100 text-sky-800"}`}>
            {item.processing_error ? "requiere atención" : associationLabel(item.association_status)}
          </span>
          <span className="rounded-full bg-slate-100 px-2 py-1 text-[10px] font-semibold text-slate-600">{taskLabel(item.task_status)}</span>
        </div>
      </div>
      <div className="mt-3"><ProcessRail item={item} /></div>
      <div className="mt-3 grid gap-2 text-[11px] text-slate-600 sm:grid-cols-3">
        <p><span className="font-semibold text-slate-800">Extracción:</span> {item.extracted_at ? readableDate(item.extracted_at) : `${item.extract_attempts ?? 0} intentos`}</p>
        <p><span className="font-semibold text-slate-800">Notion histórico:</span> {item.notion_synced_at ? "sincronizado" : "sin escritura"}</p>
        <p><span className="font-semibold text-slate-800">Wiki:</span> {item.wiki_exported ? "exportada" : "pendiente"}</p>
      </div>
      {item.processing_error ? <p role="alert" className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs leading-relaxed text-rose-800">{item.processing_error}</p> : null}
    </article>
  );
}

export default function MeetingProcessingView() {
  const [data, setData] = useState<MeetingProcessingOverview | null>(null);
  const [filter, setFilter] = useState<MeetingProcessingFilter>("all");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function load(nextFilter = filter) {
    setLoading(true);
    setError(null);
    try {
      setData(await api.meetingProcessing(nextFilter));
    } catch (cause) {
      setData(null);
      setError(cause instanceof ApiError ? cause.message : "No se pudo consultar el procesamiento de reuniones.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(filter); }, [filter]);

  return (
    <div className="min-h-full bg-slate-100 p-3 sm:p-5 lg:p-6">
      <div className="mx-auto max-w-6xl space-y-5">
        <header className="overflow-hidden rounded-2xl bg-slate-950 px-4 py-5 text-white shadow-sm sm:px-6">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div className="max-w-2xl">
              <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-cyan-300">2brain / WhatsAppHub · lectura operativa</p>
              <h1 className="mt-2 text-2xl font-bold tracking-tight sm:text-3xl">Procesamiento de reuniones</h1>
              <p className="mt-2 text-sm leading-relaxed text-slate-300">La cola real de captura, extracción, revisión humana y evidencia. Esta vista no ejecuta procesamiento ni crea tareas: protege el historial y la compuerta de confirmación del 2brain original.</p>
            </div>
            <button onClick={() => void load()} disabled={loading} className="min-h-11 rounded-lg border border-white/20 bg-white/10 px-4 text-xs font-bold text-white hover:bg-white/20 disabled:opacity-60">
              {loading ? "Actualizando…" : "Actualizar lectura"}
            </button>
          </div>
        </header>

        <section className="grid gap-3 sm:grid-cols-3" aria-label="Resumen de cola">
          <QueueCard label="Pendientes" value={data?.queue.pending ?? null} tone="amber" />
          <QueueCard label="Con error" value={data?.queue.errors ?? null} tone="rose" />
          <QueueCard label="Completas" value={data?.queue.complete ?? null} tone="emerald" />
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-400">Puente hacia AgentOS</p>
              <h2 className="mt-1 text-base font-bold text-slate-900">Historial intacto, contexto explícito</h2>
              <p className="mt-1 text-xs text-slate-500">{data ? `${data.agentos_context.linked} reuniones enlazadas · ${data.agentos_context.ingested} ingeridas como evidencia` : "Se cargará cuando WhatsAppHub responda."}</p>
            </div>
            <Link to="/context" className="inline-flex min-h-10 items-center rounded-lg border border-sky-200 bg-sky-50 px-3 text-xs font-bold text-sky-800 hover:border-sky-400 hover:bg-sky-100">Asociar al contexto de un proyecto</Link>
          </div>
          <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900">Las tareas candidatas siguen siendo candidatas. Solo el flujo de revisión autorizado en WhatsAppHub puede confirmarlas o crear tareas históricas en Notion.</p>
        </section>

        <section aria-labelledby="meetings-list-heading" className="space-y-3">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-400">Cola de origen</p>
              <h2 id="meetings-list-heading" className="mt-1 text-lg font-bold text-slate-900">Reuniones observadas {data?.total !== null && data?.total !== undefined ? `· ${data.total}` : ""}</h2>
            </div>
            <div className="flex flex-wrap gap-1" role="group" aria-label="Filtrar reuniones por estado">
              {FILTERS.map((option) => <button key={option.id} onClick={() => setFilter(option.id)} className={`min-h-9 rounded-lg px-3 text-xs font-bold ${filter === option.id ? "bg-slate-900 text-white" : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"}`}>{option.label}</button>)}
            </div>
          </div>
          {loading && !data ? <div className="rounded-xl border border-slate-200 bg-white p-5"><Spinner label="Leyendo la cola de WhatsAppHub…" /></div> : null}
          {error ? <ErrorBox message={error} onRetry={() => void load()} /> : null}
          {!loading && data?.meetings.length === 0 ? <EmptyState title="No hay reuniones para este filtro" hint="La lectura es directa del audit de 2brain; cambia el filtro o actualiza." /> : null}
          <div className="space-y-3">{data?.meetings.map((item) => <MeetingRow key={item.id} item={item} />)}</div>
        </section>
      </div>
    </div>
  );
}
