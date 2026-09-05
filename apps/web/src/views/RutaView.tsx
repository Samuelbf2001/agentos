/**
 * Ruta del proyecto (PLAN-v1.5 §Cómo se representa el avance).
 *
 * El panel de fase, que vivía enterrado bajo los filtros del tablero, se
 * convierte en el cuerpo de esta pantalla: mapa del ciclo en rejilla CSS con
 * tres columnas —Entender, Construir y Operar—, hitos en vertical y gates
 * intercalados como candados.
 *
 * El gate es el motor del avance y aquí sí tiene botón: el candado abierto
 * llama a `POST /api/projects/:id/gate`, que existía en el cliente de la API y
 * ninguna vista llamaba. Los dos relojes se cruzan: el del proyecto en el mapa
 * y el de los agentes en la tira de "trabajando ahora".
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import { useStore } from "../state/store";
import type { LaunchReceipt, PhaseClosureStatus, Project, Run, Task } from "../lib/types";
import {
  ActionButton,
  Card,
  Chip,
  GateLock,
  SectionHead,
  STAGE_LABELS,
  WorkingDot,
  type GateMissing,
} from "../components/system";
import { AgentAvatar, ErrorBox, fmtDate, Spinner } from "../components/ui";
import { buildCycle, CLOSURE_SOURCE_LABELS, humanizeKind, missingDeliverables } from "../lib/route-map";
import { nextStage } from "../lib/decisions";
import { paths } from "../lib/paths";

function fmtInputValue(v: unknown): string {
  if (Array.isArray(v)) return v.map((x) => String(x)).join(", ");
  if (typeof v === "boolean") return v ? "sí" : "no";
  if (v === null || v === undefined) return "—";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** Recibo del lanzamiento, expandido: qué módulo creó este proyecto y con qué. */
function LaunchReceiptPanel({ launch }: { launch: LaunchReceipt }) {
  const toggles = Object.entries(launch.toggles ?? {});
  return (
    <Card className="mt-4 p-4" data-testid="launch-receipt">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-small text-muted">
        <span className="text-body font-semibold text-ink">
          {launch.module_name} v{launch.module_version}
        </span>
        <span>
          Lanzado por <span className="font-semibold text-ink-2">{launch.actor_name ?? launch.actor}</span>
        </span>
        <span>{fmtDate(launch.created_at)}</span>
        <span>
          <span className="font-semibold text-ink-2">{launch.task_count}</span> tareas creadas
        </span>
        <span>
          Presupuesto ${launch.budget_phase_usd} por fase · ${launch.budget_per_run_usd} por ejecución
        </span>
      </div>
      <div className="mt-3 border-t border-line-soft pt-3">
        <p className="mb-1.5 text-label uppercase text-muted">Con qué se disparó</p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-small">
          {Object.entries(launch.inputs).map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted">{humanizeKind(k)}</dt>
              <dd className="min-w-0 break-words text-ink-2">{fmtInputValue(v)}</dd>
            </div>
          ))}
        </dl>
        {toggles.length > 0 ? (
          <p className="mt-2 text-small text-muted">
            Opciones: {toggles.map(([k, v]) => `${humanizeKind(k)}: ${v ? "sí" : "no"}`).join(" · ")}
          </p>
        ) : null}
      </div>
    </Card>
  );
}

function MilestoneRow({
  label,
  done,
  total,
  state,
}: {
  label: string;
  done: number;
  total: number;
  state: "done" | "now" | "open";
}) {
  return (
    <li
      className={`flex items-start gap-2.5 rounded-tight border bg-surface px-2.5 py-2 text-small ${
        state === "now" ? "border-work-line" : "border-line-soft"
      }`}
    >
      <span
        aria-hidden="true"
        className={`mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full border ${
          state === "done"
            ? "border-done bg-done text-surface"
            : state === "now"
              ? "border-dashed border-work"
              : "border-line"
        }`}
      >
        {state === "done" ? (
          <svg width="9" height="9" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M1.5 5.2 4 7.6 8.5 2.6" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" />
          </svg>
        ) : null}
      </span>
      <span className="min-w-0 flex-1 text-ink-2">{label}</span>
      <span className="shrink-0 tabular-nums text-muted">
        {done}/{total}
      </span>
    </li>
  );
}

export default function RutaView({ project }: { project: Project }) {
  const boardTasks = useStore((s) => s.board.tasks);
  const boardProjectId = useStore((s) => s.board.projectId);
  const agents = useStore((s) => s.agents);
  const openTask = useStore((s) => s.openTask);
  const loadProjects = useStore((s) => s.loadProjects);
  const pushToast = useStore((s) => s.pushToast);
  const person = useStore((s) => s.person);
  const navigate = useNavigate();

  const [launch, setLaunch] = useState<LaunchReceipt | null>(null);
  const [closure, setClosure] = useState<PhaseClosureStatus | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [gateBusy, setGateBusy] = useState(false);
  const [approvedNow, setApprovedNow] = useState<{ by: string; at: number } | null>(null);

  const tasks: Task[] = useMemo(
    () => (boardProjectId === project.id ? Object.values(boardTasks) : []),
    [boardTasks, boardProjectId, project.id],
  );

  const load = useCallback(async () => {
    setError(null);
    const [launchesRes, statusRes, runsRes] = await Promise.allSettled([
      api.projectLaunches(project.id),
      api.phaseStatus(project.id),
      api.runs({ project_id: project.id, status: "running", limit: 20 }),
    ]);
    if (launchesRes.status === "fulfilled") {
      const sorted = [...launchesRes.value.launches].sort((a, b) => b.created_at - a.created_at);
      setLaunch(sorted[0] ?? null);
    }
    if (statusRes.status === "fulfilled") {
      setClosure(statusRes.value.status.reason === "no_launch" ? null : statusRes.value.status);
    } else if (launchesRes.status === "rejected") {
      setError(
        statusRes.reason instanceof ApiError
          ? statusRes.reason.message
          : "No se pudo leer el estado de la fase",
      );
    }
    if (runsRes.status === "fulfilled") setRuns(runsRes.value.runs);
    setLoading(false);
  }, [project.id]);

  useEffect(() => {
    setLoading(true);
    setApprovedNow(null);
    void load();
    const t = setInterval(() => void load(), 20_000);
    return () => clearInterval(t);
  }, [load]);

  const columns = useMemo(() => buildCycle(project, tasks, closure), [project, tasks, closure]);
  const missing = useMemo(() => missingDeliverables(closure, tasks), [closure, tasks]);
  const covered = (closure?.items.length ?? 0) - missing.length;
  const next = nextStage(project.stage);

  async function approveGate() {
    setGateBusy(true);
    try {
      await api.gate(project.id, "approve");
      setApprovedNow({ by: person?.full_name ?? "ti", at: Date.now() });
      pushToast("ok", `Gate de ${STAGE_LABELS[project.stage]} aprobado`);
      await loadProjects();
      await load();
    } catch (err) {
      pushToast("error", err instanceof ApiError ? err.message : "No se pudo aprobar el gate");
    } finally {
      setGateBusy(false);
    }
  }

  const gateMissing: GateMissing[] = missing.map((m) => ({
    key: m.key,
    text: m.label,
    ...(m.task ? { onClick: () => void openTask(m.task!.id) } : {}),
  }));

  const workers = runs
    .map((run) => ({
      run,
      agent: run.agentId ? agents.find((a) => a.id === run.agentId) : undefined,
      task: run.taskId ? tasks.find((t) => t.id === run.taskId) : undefined,
    }))
    .filter((w) => w.agent);

  if (loading && !closure && !launch) {
    return (
      <div className="mx-auto max-w-[1180px] px-4 py-6 sm:px-5">
        <Spinner label="Leyendo la ruta del proyecto…" />
      </div>
    );
  }

  return (
    <div className="density-explorar mx-auto max-w-[1180px] px-4 pb-20 pt-6 sm:px-5">
      <p className="max-w-[62ch] text-body text-muted">
        {closure
          ? closure.complete
            ? project.gateState === "approved"
              ? `${STAGE_LABELS[project.stage]} está cerrada y aprobada.${next ? ` Puedes lanzar ${STAGE_LABELS[next]}.` : ""}`
              : `Los entregables de ${STAGE_LABELS[project.stage]} están completos: el gate se puede aprobar.`
            : `El cierre de ${STAGE_LABELS[project.stage]} espera ${missing.length} ${missing.length === 1 ? "entregable" : "entregables"}.`
          : "Este proyecto no nació de un módulo de fase, así que no tiene entregables de cierre declarados."}
      </p>

      {error ? (
        <div className="mt-4">
          <ErrorBox message={error} onRetry={() => void load()} />
        </div>
      ) : null}

      {launch ? <LaunchReceiptPanel launch={launch} /> : null}

      <SectionHead label="Mapa del ciclo" hint="Los candados abren la fase siguiente" />
      <div className="grid gap-3 lg:grid-cols-3" data-testid="cycle-map">
        {columns.map((column) => {
          const isCurrent = column.status === "active";
          const gateState =
            isCurrent && approvedNow ? "passed" : (column.gate?.state ?? "locked");
          return (
            <div key={column.stage} className="flex flex-col gap-3">
              <Card
                className={`p-3.5 ${isCurrent ? "border-work-line bg-work-bg" : column.status === "closed" ? "opacity-80" : ""}`}
                data-testid={`cycle-column-${column.stage}`}
              >
                <div className="flex items-center gap-2">
                  <h3 className={`text-label uppercase ${isCurrent ? "text-work" : "text-muted"}`}>
                    {STAGE_LABELS[column.stage]}
                  </h3>
                  <span className="ml-auto">
                    {column.status === "closed" ? (
                      <Chip tone="done">Cerrada</Chip>
                    ) : isCurrent ? (
                      <Chip tone="work">Aquí</Chip>
                    ) : (
                      <Chip tone="quiet">Sin abrir</Chip>
                    )}
                  </span>
                </div>
                {column.milestones.length === 0 ? (
                  <p className="mt-3 text-small text-muted">
                    {column.status === "blocked"
                      ? "Se poblará cuando se lance el módulo de esta fase."
                      : "Esta fase no tiene tareas todavía."}
                  </p>
                ) : (
                  <ul className="mt-3 grid gap-1.5">
                    {column.milestones.map((m) => (
                      <MilestoneRow
                        key={m.key}
                        label={m.label}
                        done={m.done}
                        total={m.total}
                        state={m.state}
                      />
                    ))}
                  </ul>
                )}
              </Card>

              {column.gate ? (
                <GateLock
                  code={column.gate.code}
                  state={gateState}
                  caption={
                    gateState === "passed" && isCurrent && approvedNow
                      ? `Aprobado por ${approvedNow.by} · ${fmtDate(approvedNow.at)}`
                      : gateState === "passed" && column.status === "closed"
                        ? "Aprobado"
                        : column.gate.caption
                  }
                  missing={isCurrent ? gateMissing : []}
                  busy={gateBusy}
                  {...(isCurrent && gateState === "ready" ? { onApprove: () => void approveGate() } : {})}
                />
              ) : null}
            </div>
          );
        })}
      </div>

      {project.gateState === "approved" && next ? (
        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-soft border border-done-line bg-done-bg px-4 py-3">
          <p className="text-small text-done">
            {STAGE_LABELS[project.stage]} quedó cerrada. El siguiente paso es lanzar el módulo de{" "}
            {STAGE_LABELS[next]}.
          </p>
          <ActionButton
            variant="primary"
            className="ml-auto"
            data-testid="next-phase"
            onClick={() => navigate(paths.nuevoProyecto({ projectId: project.id, phase: next }))}
          >
            Lanzar {STAGE_LABELS[next]}
          </ActionButton>
        </div>
      ) : null}

      <SectionHead label="Hito activo" />
      <div className="grid gap-3 lg:grid-cols-[1.35fr_0.95fr]">
        <Card className="p-4" data-testid="phase-closure">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-title text-ink">Cerrar {STAGE_LABELS[project.stage]}</h3>
            {closure ? (
              closure.complete ? (
                <Chip tone="done">Entregables completos</Chip>
              ) : (
                <Chip tone="work">
                  {covered} de {closure.items.length}
                </Chip>
              )
            ) : null}
          </div>

          {!closure ? (
            <p className="mt-3 text-small text-muted">
              Sin módulo lanzado no hay lista de entregables. Lanza uno desde Proyectos para que la ruta
              tenga hitos que cerrar.
            </p>
          ) : closure.items.length === 0 ? (
            <p className="mt-3 text-small text-muted">El módulo no declaró entregables de cierre.</p>
          ) : (
            <>
              <p className="mt-2 text-small text-muted">
                {closure.complete
                  ? "Todo lo que pedía el módulo está en su sitio: el candado de la fase ya se puede abrir."
                  : "El gate no se puede aprobar mientras falte un entregable. Cada uno enlaza a la tarea que lo produce."}
              </p>
              <ul className="mt-3 grid gap-1.5">
                {closure.items.map((item) => {
                  const miss = missing.find((m) => m.key === `${item.kind}:${item.source}`);
                  const label = humanizeKind(item.kind);
                  const source = CLOSURE_SOURCE_LABELS[item.source] ?? item.source;
                  return (
                    <li key={`${item.kind}:${item.source}`}>
                      {miss?.task ? (
                        <button
                          onClick={() => void openTask(miss.task!.id)}
                          data-testid={`missing-${item.kind}`}
                          className="press flex w-full items-center gap-2.5 rounded-tight border border-line-soft bg-surface px-3 py-2 text-left text-small hover:border-line"
                        >
                          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-broken" aria-hidden="true" />
                          <span className="min-w-0 flex-1 text-ink-2">{label}</span>
                          <span className="shrink-0 text-muted">{miss.task.title}</span>
                        </button>
                      ) : (
                        <div
                          data-testid={`missing-${item.kind}`}
                          className="flex items-center gap-2.5 rounded-tight border border-line-soft bg-surface px-3 py-2 text-small"
                        >
                          <span
                            aria-hidden="true"
                            className={`h-1.5 w-1.5 shrink-0 rounded-full ${item.missing === null ? "bg-done" : "bg-broken"}`}
                          />
                          <span className="min-w-0 flex-1 text-ink-2">{label}</span>
                          <span className="shrink-0 text-muted">
                            {item.missing === null
                              ? `${source} · ${item.found}/${item.required}`
                              : "sin tarea que lo produzca"}
                          </span>
                        </div>
                      )}
                      {miss ? <p className="ml-3 mt-1 text-small text-broken">{miss.text}</p> : null}
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </Card>

        <Card className="overflow-hidden">
          <div className="flex items-center gap-2 border-b border-line-soft px-4 py-3">
            <h3 className="text-label uppercase text-muted">Trabajando ahora</h3>
          </div>
          {workers.length === 0 ? (
            <p className="px-4 py-4 text-small text-muted">
              Ningún agente tiene una ejecución viva en este proyecto ahora mismo.
            </p>
          ) : (
            workers.map(({ run, agent, task }) => (
              <div key={run.id} className="flex items-center gap-2.5 border-b border-line-soft px-4 py-3 last:border-b-0">
                <AgentAvatar name={agent!.name} slug={agent!.slug} size={6} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-small font-semibold text-ink-2">{agent!.name}</p>
                  <p className="truncate text-small text-muted">
                    {task ? task.title : `ejecución ${run.id.slice(0, 8)}`}
                  </p>
                </div>
                <Link to={paths.run(run.id)} className="press shrink-0" aria-label={`Ver la ejecución de ${agent!.name}`}>
                  <WorkingDot />
                </Link>
              </div>
            ))
          )}
          <div className="p-3">
            <ActionButton
              className="w-full"
              onClick={() => navigate(paths.proyecto(project.id, "actividad"))}
            >
              Ver toda la actividad
            </ActionButton>
          </div>
        </Card>
      </div>
    </div>
  );
}
