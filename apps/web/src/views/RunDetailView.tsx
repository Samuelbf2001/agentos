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
import { paths } from "../lib/paths";
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
      <div className="flex items-center gap-2 rounded px-2 py-1 text-small hover:bg-surface-2">
        <span aria-hidden>{kindIcon}</span>
        <span className="font-mono font-medium">{span.name}</span>
        <span className="text-faint">{span.kind}</span>
        <span className="text-faint">{duration}</span>
        {span.status ? (
          <span
            className={`rounded px-1 py-0.5 text-label font-semibold ${
              span.status === "ok" || span.status === "succeeded"
                ? "bg-done-bg text-done"
                : "bg-broken-bg text-broken"
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
    <div className="rounded-soft border border-line bg-surface p-3">
      <div className="flex items-center gap-2 text-small">
        <button
          onClick={() => setPlaying((v) => !v)}
          className="rounded bg-ink px-2 py-1 font-medium text-surface"
        >
          {playing ? "⏸ Pausa" : "▶ Reproducir"}
        </button>
        <button
          onClick={() => {
            setCursor(0);
            setPlaying(true);
          }}
          className="rounded border border-line px-2 py-1"
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
        <span className="w-20 text-right text-faint">
          {cursor}/{events.length}
        </span>
      </div>
      <div className="mt-3 space-y-2 text-body">
        {painted.lines.map((l, i) => (
          <p key={i} className="text-small text-faint">
            {l}
          </p>
        ))}
        {painted.tools.map((t, i) => (
          <span
            key={i}
            className={`mr-1 inline-block rounded border px-1.5 py-0.5 font-mono text-label ${
              !t.done
                ? "border-work bg-work-bg"
                : t.isError
                  ? "border-broken bg-broken-bg"
                  : "border-done bg-done-bg"
            }`}
          >
            🔧 {t.name}
          </span>
        ))}
        {painted.text ? (
          <div className="rounded-tight border border-line-soft bg-surface-2 p-2">
            <Markdown>{painted.text}</Markdown>
          </div>
        ) : null}
        {events.length === 0 ? (
          <p className="text-small text-faint">Este run no dejó eventos en su topic.</p>
        ) : null}
      </div>
    </div>
  );
}

export default function RunDetailView() {
  const { runId } = useParams<{ runId: string }>();
  const agents = useStore((s) => s.agents);
  const projects = useStore((s) => s.projects);
  const boardTasks = useStore((s) => s.board.tasks);
  const openTask = useStore((s) => s.openTask);
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
  const project = run.projectId ? projects.find((p) => p.id === run.projectId) : null;
  const taskTitle = run.taskId ? (boardTasks[run.taskId]?.title ?? null) : null;

  return (
    <div className="mx-auto max-w-[1180px] space-y-4 px-4 pb-20 pt-5 sm:px-5">
      {/* Miga de pan: desde una ejecución siempre se vuelve a su trabajo. */}
      <nav aria-label="Dónde estás" className="flex flex-wrap items-center gap-2 text-small text-muted">
        <Link to={paths.sistema("actividad")} className="press hover:text-ink-2">
          Actividad
        </Link>
        {run.projectId ? (
          <>
            <span aria-hidden="true" className="text-faint">
              ›
            </span>
            <Link to={paths.proyecto(run.projectId, "ruta")} className="press text-link hover:underline">
              {project?.name ?? "Proyecto"}
            </Link>
          </>
        ) : null}
        {run.taskId ? (
          <>
            <span aria-hidden="true" className="text-faint">
              ›
            </span>
            <button
              onClick={() => void openTask(run.taskId!)}
              className="press text-link hover:underline"
              data-testid="run-breadcrumb-task"
            >
              {taskTitle ?? "Su tarjeta"}
            </button>
          </>
        ) : null}
        <span aria-hidden="true" className="text-faint">
          ›
        </span>
        <span className="font-mono text-ink-2">{run.id.slice(0, 8)}</span>
      </nav>

      <div className="rounded-panel border border-line-soft bg-surface p-4 shadow-rest">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-title text-ink">
            Ejecución <span className="font-mono text-body">{run.id.slice(0, 8)}</span>
          </h1>
          <RunStatusPill status={run.status} />
          {agent ? (
            <span className="flex items-center gap-1.5 text-small">
              <AgentAvatar name={agent.name} slug={agent.slug} size={5} /> {agent.name}
            </span>
          ) : null}
          <span className="text-small text-faint">
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
                className="rounded-tight border border-broken px-2.5 py-1 text-small font-medium text-broken hover:bg-broken-bg"
              >
                Cancelar run
              </button>
            ) : null}
            <button
              onClick={() => setShowReplay((v) => !v)}
              className="rounded-tight bg-ink px-2.5 py-1 text-small font-medium text-surface hover:bg-ink-2"
            >
              {showReplay ? "Ocultar reproducción" : "▶ Reproducir"}
            </button>
          </div>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2 text-small sm:grid-cols-4">
          <div className="rounded bg-surface-2 p-2">
            <p className="text-faint">Tokens in / out</p>
            <p className="font-medium">
              {fmtTokens(run.tokensIn)} / {fmtTokens(run.tokensOut)}
            </p>
          </div>
          <div className="rounded bg-surface-2 p-2">
            <p className="text-faint">Cache read / write</p>
            <p className="font-medium">
              {fmtTokens(run.tokensCacheRead)} / {fmtTokens(run.tokensCacheWrite)}
            </p>
          </div>
          <div className="rounded bg-surface-2 p-2">
            <p className="text-faint">Coste USD</p>
            <p className="font-medium">{fmtCost(run.costUsd)}</p>
          </div>
          <div className="rounded bg-surface-2 p-2">
            <p className="text-faint">Inicio / fin</p>
            <p className="font-medium">
              {fmtDate(run.startedAt)} → {fmtDate(run.finishedAt)}
            </p>
          </div>
        </div>
        {run.error ? (
          <p className="mt-2 rounded bg-broken-bg p-2 text-small text-broken">{run.error}</p>
        ) : null}
        <div className="mt-2 flex flex-wrap gap-3 text-small">
          {parent ? (
            <Link to={paths.run(parent.id)} className="press text-link hover:underline">
              Ejecución que la lanzó
            </Link>
          ) : null}
          {run.resumeOfRunId ? (
            <Link to={paths.run(run.resumeOfRunId)} className="press text-link hover:underline">
              Reanuda una anterior
            </Link>
          ) : null}
          {children.map((c) => (
            <Link key={c.id} to={paths.run(c.id)} className="press text-link hover:underline">
              Ejecución hija ({c.status})
            </Link>
          ))}
          {run.taskId ? (
            <button
              onClick={() => void openTask(run.taskId!)}
              className="press text-link hover:underline"
            >
              Abrir la tarjeta que trabajó
            </button>
          ) : null}
        </div>
      </div>

      {showReplay && runId ? <Replay runId={runId} /> : null}

      <div className="rounded-soft border border-line bg-surface p-4">
        <h2 className="text-small font-bold uppercase text-faint">
          Árbol de spans ({spans.length})
        </h2>
        <div className="mt-2">
          {roots.length === 0 ? (
            <p className="text-small text-faint">Este run no registró spans.</p>
          ) : (
            roots.map((s) => <SpanNode key={s.id} span={s} all={spans} depth={0} />)
          )}
        </div>
      </div>
    </div>
  );
}
