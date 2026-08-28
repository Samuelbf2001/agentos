/**
 * Detalle de run (US-7): árbol de spans (LLM/tool/subrun, duración, estado),
 * tokens in/out/cache y coste (null = "no reportado"), navegación padre/hijos,
 * y botón Reproducir: repinta desde los eventos persistidos del topic
 * run:<id> — sin volver a llamar al LLM (CA-7.3).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import type { Run, Span, TopicEvent } from "../lib/types";
import { useStore } from "../state/store";
import { Markdown } from "../components/Markdown";
import {
  AgentAvatar,
  ErrorBox,
  fmtCost,
  fmtDate,
  fmtTokens,
  RunStatusPill,
  Spinner,
} from "../components/ui";

function SpanNode({ span, all, depth }: { span: Span; all: Span[]; depth: number }) {
  const children = all.filter((s) => s.parentSpanId === span.id);
  const duration = span.endedAt ? `${((span.endedAt - span.startedAt) / 1000).toFixed(2)} s` : "en curso";
  const kindIcon = span.kind === "llm" ? "🧠" : span.kind === "tool" ? "🔧" : span.kind === "subrun" ? "🪆" : "·";
  return (
    <div style={{ marginLeft: depth * 16 }}>
      <div className="flex items-center gap-2 rounded px-2 py-1 text-xs hover:bg-slate-50">
        <span aria-hidden>{kindIcon}</span>
        <span className="font-mono font-medium">{span.name}</span>
        <span className="text-slate-400">{span.kind}</span>
        <span className="text-slate-400">{duration}</span>
        {span.status ? (
          <span
            className={`rounded px-1 py-0.5 text-[9px] font-semibold ${
              span.status === "ok" || span.status === "succeeded"
                ? "bg-emerald-100 text-emerald-700"
                : "bg-rose-100 text-rose-700"
            }`}
          >
            {span.status}
          </span>
        ) : null}
      </div>
      {children.map((c) => (
        <SpanNode key={c.id} span={c} all={all} depth={depth + 1} />
      ))}
    </div>
  );
}

/** Reproductor: repinta la sesión evento a evento desde el stream persistido. */
function Replay({ runId }: { runId: string }) {
  const fetchRunHistory = useStore((s) => s.fetchRunHistory);
  const [events, setEvents] = useState<TopicEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const [playing, setPlaying] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    fetchRunHistory(runId)
      .then((evs) => {
        setEvents(evs);
        setCursor(0);
        setPlaying(true);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "No se pudo leer la historia"));
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [runId, fetchRunHistory]);

  useEffect(() => {
    if (!playing || !events) return;
    timer.current = setInterval(() => {
      setCursor((c) => {
        if (c >= events.length) {
          setPlaying(false);
          return c;
        }
        return c + 1;
      });
    }, 120);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [playing, events]);

  const painted = useMemo(() => {
    if (!events) return { text: "", tools: [] as { name: string; done: boolean; isError: boolean }[], lines: [] as string[] };
    let text = "";
    const tools: { id: string; name: string; done: boolean; isError: boolean }[] = [];
    const lines: string[] = [];
    for (const ev of events.slice(0, cursor)) {
      const p = ev.payload;
      switch (ev.type) {
        case "RUN_STARTED":
          lines.push("▶ run arrancó");
          break;
        case "TEXT_MESSAGE_CONTENT":
          text += String(p.delta ?? "");
          break;
        case "TOOL_CALL_START":
          tools.push({ id: String(p.toolCallId), name: String(p.toolCallName ?? "tool"), done: false, isError: false });
          break;
        case "TOOL_CALL_RESULT": {
          const t = tools.find((x) => x.id === String(p.toolCallId));
          if (t) {
            t.done = true;
            t.isError = p.isError === true;
          }
          break;
        }
        case "RUN_FINISHED":
          lines.push("■ run terminó");
          break;
        case "RUN_ERROR":
          lines.push(`✖ error: ${String(p.message ?? "")}`);
          break;
        case "RUN_CANCELLED":
          lines.push("⏹ cancelado");
          break;
        default:
          break;
      }
    }
    return { text, tools, lines };
  }, [events, cursor]);

  if (error) return <ErrorBox message={error} />;
  if (!events) return <Spinner label="Leyendo eventos persistidos…" />;

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3">
      <div className="flex items-center gap-2 text-xs">
        <button
          onClick={() => setPlaying((v) => !v)}
          className="rounded bg-slate-900 px-2 py-1 font-medium text-white"
        >
          {playing ? "⏸ Pausa" : "▶ Reproducir"}
        </button>
        <button
          onClick={() => {
            setCursor(0);
            setPlaying(true);
          }}
          className="rounded border border-slate-300 px-2 py-1"
        >
          ⟲ Desde el inicio
        </button>
        <input
          type="range"
          min={0}
          max={events.length}
          value={cursor}
          onChange={(e) => setCursor(Number(e.target.value))}
          className="flex-1"
        />
        <span className="w-20 text-right text-slate-400">
          {cursor}/{events.length}
        </span>
      </div>
      <div className="mt-3 space-y-2 text-sm">
        {painted.lines.map((l, i) => (
          <p key={i} className="text-xs text-slate-400">
            {l}
          </p>
        ))}
        {painted.tools.map((t, i) => (
          <span
            key={i}
            className={`mr-1 inline-block rounded border px-1.5 py-0.5 font-mono text-[10px] ${
              !t.done
                ? "border-amber-300 bg-amber-50"
                : t.isError
                  ? "border-rose-300 bg-rose-50"
                  : "border-emerald-300 bg-emerald-50"
            }`}
          >
            🔧 {t.name}
          </span>
        ))}
        {painted.text ? (
          <div className="rounded-md border border-slate-100 bg-slate-50 p-2">
            <Markdown>{painted.text}</Markdown>
          </div>
        ) : null}
        {events.length === 0 ? (
          <p className="text-xs text-slate-400">Este run no dejó eventos en su topic.</p>
        ) : null}
      </div>
    </div>
  );
}

export default function RunDetailView() {
  const { runId } = useParams<{ runId: string }>();
  const agents = useStore((s) => s.agents);
  const [data, setData] = useState<{ run: Run; spans: Span[]; tree: Run[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showReplay, setShowReplay] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const pushToast = useStore((s) => s.pushToast);

  async function load() {
    if (!runId) return;
    setError(null);
    try {
      const res = await api.run(runId);
      setData(res);
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : "Error cargando el run");
    }
  }

  useEffect(() => {
    setData(null);
    setShowReplay(false);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  if (error) {
    return (
      <div className="p-4">
        <ErrorBox message={error} onRetry={() => void load()} />
      </div>
    );
  }
  if (!data) return <Spinner label="Cargando run…" />;

  const { run, spans, tree } = data;
  const agent = run.agentId ? agents.find((a) => a.id === run.agentId) : null;
  const roots = spans.filter((s) => !s.parentSpanId);
  const children = tree.filter((r) => r.parentRunId === run.id);
  const parent = run.parentRunId ? tree.find((r) => r.id === run.parentRunId) : null;

  return (
    <div className="space-y-4 p-4">
      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-mono text-sm font-bold">run {run.id.slice(0, 8)}</h1>
          <RunStatusPill status={run.status} />
          {agent ? (
            <span className="flex items-center gap-1.5 text-xs">
              <AgentAvatar name={agent.name} slug={agent.slug} size={5} /> {agent.name}
            </span>
          ) : null}
          <span className="text-xs text-slate-400">
            trigger {run.trigger} · runtime {run.runtime} · modelo {run.model ?? "no reportado"}
          </span>
          <div className="ml-auto flex gap-2">
            {run.status === "running" || run.status === "queued" ? (
              <button
                disabled={cancelling}
                onClick={async () => {
                  setCancelling(true);
                  try {
                    await api.cancelRun(run.id);
                    pushToast("ok", "Run cancelado");
                    await load();
                  } catch (err) {
                    pushToast("error", err instanceof ApiError ? err.message : "No se pudo cancelar");
                  } finally {
                    setCancelling(false);
                  }
                }}
                className="rounded-md border border-rose-300 px-2.5 py-1 text-xs font-medium text-rose-700 hover:bg-rose-50"
              >
                Cancelar run
              </button>
            ) : null}
            <button
              onClick={() => setShowReplay((v) => !v)}
              className="rounded-md bg-slate-900 px-2.5 py-1 text-xs font-medium text-white hover:bg-slate-700"
            >
              {showReplay ? "Ocultar reproducción" : "▶ Reproducir"}
            </button>
          </div>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
          <div className="rounded bg-slate-50 p-2">
            <p className="text-slate-400">Tokens in / out</p>
            <p className="font-medium">
              {fmtTokens(run.tokensIn)} / {fmtTokens(run.tokensOut)}
            </p>
          </div>
          <div className="rounded bg-slate-50 p-2">
            <p className="text-slate-400">Cache read / write</p>
            <p className="font-medium">
              {fmtTokens(run.tokensCacheRead)} / {fmtTokens(run.tokensCacheWrite)}
            </p>
          </div>
          <div className="rounded bg-slate-50 p-2">
            <p className="text-slate-400">Coste USD</p>
            <p className="font-medium">{fmtCost(run.costUsd)}</p>
          </div>
          <div className="rounded bg-slate-50 p-2">
            <p className="text-slate-400">Inicio / fin</p>
            <p className="font-medium">
              {fmtDate(run.startedAt)} → {fmtDate(run.finishedAt)}
            </p>
          </div>
        </div>
        {run.error ? (
          <p className="mt-2 rounded bg-rose-50 p-2 text-xs text-rose-700">{run.error}</p>
        ) : null}
        <div className="mt-2 flex flex-wrap gap-3 text-xs">
          {parent ? (
            <Link to={`/runs/${parent.id}`} className="text-sky-700 underline">
              ↑ padre {parent.id.slice(0, 8)}
            </Link>
          ) : null}
          {run.resumeOfRunId ? (
            <Link to={`/runs/${run.resumeOfRunId}`} className="text-sky-700 underline">
              ⟳ reanuda a {run.resumeOfRunId.slice(0, 8)}
            </Link>
          ) : null}
          {children.map((c) => (
            <Link key={c.id} to={`/runs/${c.id}`} className="text-sky-700 underline">
              ↓ hijo {c.id.slice(0, 8)} ({c.status})
            </Link>
          ))}
          {run.taskId ? <span className="text-slate-400">tarea {run.taskId.slice(0, 8)}</span> : null}
        </div>
      </div>

      {showReplay && runId ? <Replay runId={runId} /> : null}

      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <h2 className="text-xs font-bold uppercase tracking-wide text-slate-400">
          Árbol de spans ({spans.length})
        </h2>
        <div className="mt-2">
          {roots.length === 0 ? (
            <p className="text-xs text-slate-400">Este run no registró spans.</p>
          ) : (
            roots.map((s) => <SpanNode key={s.id} span={s} all={spans} depth={0} />)
          )}
        </div>
      </div>
    </div>
  );
}
