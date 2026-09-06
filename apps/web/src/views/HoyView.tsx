/**
 * Hoy (PLAN-v1.5 §La pantalla de entrada). Sustituye a "Esperando por ti" y es
 * la puerta después del login: nunca más un chat vacío.
 *
 * Tres bloques en este orden: las decisiones que te esperan —las tres más
 * urgentes arriba, el resto agrupado por proyecto y por gate, ordenado por
 * riesgo y con aprobación en lote para las de riesgo bajo—, y el pulso del
 * día en una columna aparte.
 */
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useStore } from "../state/store";
import { api, ApiError } from "../lib/api";
import { paths } from "../lib/paths";
import {
  batchable,
  buildDecisions,
  daysWaiting,
  groupDecisions,
  KIND_LABELS,
  sortByRisk,
  summarizePayload,
  type Decision,
} from "../lib/decisions";
import { ActionButton, Card, Chip, LateChip, SectionHead, Stat } from "../components/system";
import { EmptyState, fmtCost } from "../components/ui";

const LATE_AFTER_DAYS = 2;

/** Campos que ya tienen su propio sitio en la tarjeta: no se repiten en el detalle técnico. */
const FEATURED_PAYLOAD_KEYS = new Set(["type", "title", "body", "task_id"]);

function payloadText(payload: Record<string, unknown> | undefined, key: string): string | null {
  if (!payload) return null;
  const value = payload[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function waitingLabel(days: number): string {
  return days === 1 ? "Hace 1 día" : `Hace ${days} días`;
}

function DecisionCard({
  decision,
  clientName,
  selectable,
  selected,
  onToggle,
}: {
  decision: Decision;
  clientName: string;
  selectable: boolean;
  selected: boolean;
  onToggle: (id: string) => void;
}) {
  const decideApproval = useStore((s) => s.decideApproval);
  const approveTaskReview = useStore((s) => s.approveTaskReview);
  const rejectTaskReview = useStore((s) => s.rejectTaskReview);
  const openTask = useStore((s) => s.openTask);
  const [bodyExpanded, setBodyExpanded] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const days = daysWaiting(decision);
  const late = days >= LATE_AFTER_DAYS ? days : 0;
  const payload = decision.approval?.payload;
  const question = payloadText(payload, "title") ?? decision.title;
  const body = payloadText(payload, "body");
  const technicalLines = payload ? summarizePayload(payload).filter((l) => !FEATURED_PAYLOAD_KEYS.has(l.label)) : [];

  async function decide(action: "approve" | "reject") {
    setBusy(true);
    try {
      if (decision.approval) {
        await decideApproval(
          decision.approval.id,
          action === "approve" ? "approved" : "rejected",
          note.trim() || undefined,
        );
      } else if (decision.taskId) {
        if (action === "approve") await approveTaskReview(decision.taskId, note.trim() || undefined);
        else await rejectTaskReview(decision.taskId, note.trim());
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card as="article" className={`p-5 ${late ? "late overflow-hidden" : ""}`} data-testid={`decision-${decision.id}`}>
      <div className="flex flex-wrap items-center gap-2 text-small text-muted">
        {selectable ? (
          <input
            type="checkbox"
            checked={selected}
            onChange={() => onToggle(decision.id)}
            aria-label={`Seleccionar «${decision.title}» para aprobar en lote`}
            data-testid={`decision-select-${decision.id}`}
            className="h-4 w-4 accent-[var(--color-link)]"
          />
        ) : null}
        <span>{clientName}</span>
        <span>·</span>
        <span>{KIND_LABELS[decision.kind]}</span>
        <span className="ml-auto">
          {late ? <LateChip days={late} /> : <Chip tone="quiet">{waitingLabel(days)}</Chip>}
        </span>
      </div>

      <h3 className="mt-2 text-title text-ink">{question}</h3>
      <p className="mt-1 text-body text-muted">{decision.unlocks}</p>

      {decision.kind === "review" ? (
        <div className="mt-3">
          <p className="text-label text-muted">Evidencia entregada</p>
          {decision.artifacts.length > 0 ? (
            <ul className="mt-1 space-y-0.5">
              {decision.artifacts.map((artifact) => (
                <li key={artifact.id} className="text-body text-ink-2">
                  {artifact.title} <span className="text-muted">· {artifact.kind}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-body text-muted">Sin evidencia adjunta</p>
          )}
        </div>
      ) : body ? (
        <div className="mt-3">
          <p className={`whitespace-pre-line text-body text-ink-2 ${bodyExpanded ? "" : "line-clamp-4"}`}>{body}</p>
          <button
            onClick={() => setBodyExpanded((v) => !v)}
            className="press mt-1 text-small font-semibold text-link hover:underline"
          >
            {bodyExpanded ? "Leer menos" : "Leer completo"}
          </button>
        </div>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <ActionButton
          variant="primary"
          disabled={busy}
          onClick={() => void decide("approve")}
          data-testid={`decision-approve-${decision.id}`}
        >
          Aprobar
        </ActionButton>
        {!rejecting ? (
          <ActionButton variant="quiet" disabled={busy} onClick={() => setRejecting(true)}>
            Rechazar
          </ActionButton>
        ) : null}
        <div className="ml-auto flex flex-wrap gap-3 text-small">
          {decision.projectId ? (
            <Link to={paths.proyecto(decision.projectId, "ruta")} className="press font-semibold text-link hover:underline">
              Ver la ruta
            </Link>
          ) : null}
          {decision.task ? (
            <button
              onClick={() => void openTask(decision.taskId!)}
              className="press font-semibold text-link hover:underline"
            >
              Abrir la tarjeta
            </button>
          ) : null}
          {decision.runId ? (
            <Link to={paths.run(decision.runId)} className="press font-semibold text-link hover:underline">
              Ver la ejecución
            </Link>
          ) : null}
        </div>
      </div>

      {rejecting ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Motivo del rechazo"
            aria-label="Motivo del rechazo"
            className="min-h-9 min-w-40 flex-1 rounded-tight border border-line bg-surface px-2.5 py-1.5 text-small"
          />
          <ActionButton
            variant="danger"
            disabled={busy || (!decision.approval && !note.trim())}
            onClick={() => void decide("reject")}
          >
            Confirmar rechazo
          </ActionButton>
          <button
            onClick={() => {
              setRejecting(false);
              setNote("");
            }}
            className="press text-small text-muted hover:text-ink-2"
          >
            Cancelar
          </button>
        </div>
      ) : null}

      {payload ? (
        <details className="mt-4">
          <summary className="press cursor-pointer text-label text-faint">Detalle técnico</summary>
          {technicalLines.length > 0 ? (
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-small">
              {technicalLines.map((line) => (
                <div key={line.label} className="contents">
                  <dt className="text-muted">{line.label}</dt>
                  <dd className="min-w-0 break-words text-ink-2">{line.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          <pre className="text-label">{JSON.stringify(payload, null, 2)}</pre>
        </details>
      ) : null}
    </Card>
  );
}

interface Pulse {
  working: number;
  failed: number;
  spentToday: number | null;
}

function usePulse(): Pulse | null {
  const failedRuns = useStore((s) => s.failedRunsCount);
  const [pulse, setPulse] = useState<Pulse | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const { runs } = await api.runs({ limit: 200 });
        if (cancelled) return;
        const startOfDay = new Date();
        startOfDay.setHours(0, 0, 0, 0);
        const today = runs.filter((r) => r.createdAt >= startOfDay.getTime());
        const reported = today.filter((r) => r.costUsd !== null);
        setPulse({
          working: runs.filter((r) => r.status === "running").length,
          failed: failedRuns,
          spentToday: reported.length === 0 ? null : reported.reduce((acc, r) => acc + (r.costUsd ?? 0), 0),
        });
      } catch {
        if (!cancelled) setPulse(null);
      }
    }
    void load();
    const t = setInterval(() => void load(), 20_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [failedRuns]);

  return pulse;
}

export default function HoyView() {
  const approvals = useStore((s) => s.approvals);
  const reviewTasks = useStore((s) => s.reviewTasks);
  const projects = useStore((s) => s.projects);
  const loadApprovals = useStore((s) => s.loadApprovals);
  const pushToast = useStore((s) => s.pushToast);
  const [params, setParams] = useSearchParams();
  const projectFilter = params.get("proyecto");
  const [selected, setSelected] = useState<string[]>([]);
  const [batching, setBatching] = useState(false);
  const pulse = usePulse();

  useEffect(() => {
    void loadApprovals();
  }, [loadApprovals]);

  const all = useMemo(
    () => sortByRisk(buildDecisions(approvals, reviewTasks, projects)),
    [approvals, reviewTasks, projects],
  );
  const decisions = useMemo(
    () => (projectFilter ? all.filter((d) => d.projectId === projectFilter) : all),
    [all, projectFilter],
  );
  const top = decisions.slice(0, 3);
  const rest = decisions.slice(3);
  const groups = useMemo(() => groupDecisions(rest, projects), [rest, projects]);
  const batchCandidates = useMemo(() => batchable(decisions), [decisions]);
  const projectsById = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);
  const filteredProject = projectFilter ? projects.find((p) => p.id === projectFilter) : undefined;

  function clientNameFor(projectId: string | null): string {
    if (!projectId) return "Sin proyecto";
    const project = projectsById.get(projectId);
    return project?.orgName ?? project?.name ?? "Proyecto";
  }

  function nameOf(decision: Decision): string {
    return clientNameFor(decision.projectId);
  }

  function toggle(id: string) {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  /**
   * Aprobación en lote: llamadas secuenciales a la API que ya existe, una por
   * decisión, para no romper el `expected_version` de la siguiente. Cada
   * llamada va directo a `api.approveTask` (no a la acción del store) porque
   * necesitamos que un fallo real se propague: el conteo tiene que reflejar
   * lo que de verdad pasó, no lo que el store se tragó en su try/catch.
   */
  async function approveSelected() {
    const chosen = batchCandidates.filter((d) => selected.includes(d.id) && d.taskId && d.task);
    if (chosen.length === 0) return;
    setBatching(true);
    let ok = 0;
    let stopped = false;
    try {
      for (const decision of chosen) {
        try {
          await api.approveTask(decision.taskId!, decision.task!.version);
          ok += 1;
          pushToast("ok", `Aprobada: ${decision.title}`);
        } catch (err) {
          const reason =
            err instanceof ApiError
              ? `${err.code}: ${err.message}`
              : err instanceof Error
                ? err.message
                : "error desconocido";
          pushToast("error", `No se pudo aprobar «${decision.title}»: ${reason}`);
          stopped = true;
          break;
        }
      }
    } finally {
      setBatching(false);
      setSelected([]);
      if (stopped) pushToast("error", `Lote detenido: ${ok} de ${chosen.length} aprobadas.`);
      void loadApprovals();
    }
  }

  const total = decisions.length;
  const highest = decisions[0];

  return (
    <div className="density-operar mx-auto max-w-[1180px] px-4 pb-20 pt-6 sm:px-5">
      <h1 className="text-display text-ink">
        {total === 0
          ? "Nada espera tu decisión"
          : total === 1
            ? "Te espera 1 decisión"
            : `Te esperan ${total} decisiones`}
      </h1>
      <p className="mt-1.5 max-w-[62ch] text-body text-muted">
        {total === 0
          ? "Los agentes siguen trabajando. Cuando algo necesite tu criterio, aparecerá aquí antes que en ningún otro sitio."
          : highest
            ? `Lo primero: ${highest.title.toLowerCase()} en ${nameOf(highest)}.`
            : ""}
      </p>

      {filteredProject ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Chip tone="link">Sólo {filteredProject.name}</Chip>
          <button
            onClick={() => {
              params.delete("proyecto");
              setParams(params, { replace: true });
            }}
            className="press text-small text-link hover:underline"
          >
            Ver todos los proyectos
          </button>
        </div>
      ) : null}

      <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_280px] lg:gap-8">
        <div className="min-w-0">
          <SectionHead label="Decisiones" count={total} />

          {total === 0 ? (
            <EmptyState
              title="Nada espera tu decisión"
              hint="Los agentes siguen trabajando; te avisaremos aquí cuando necesiten algo de ti."
            />
          ) : (
            <>
              <div className="grid gap-2.5">
                {top.map((decision) => (
                  <DecisionCard
                    key={decision.id}
                    decision={decision}
                    clientName={nameOf(decision)}
                    selectable={decision.risk === "bajo"}
                    selected={selected.includes(decision.id)}
                    onToggle={toggle}
                  />
                ))}
              </div>

              {batchCandidates.length > 1 ? (
                <div
                  className="mt-3 flex flex-wrap items-center gap-3 rounded-soft border border-line-soft bg-surface-2 px-3.5 py-2.5"
                  data-testid="batch-bar"
                >
                  <p className="text-small text-muted">
                    {batchCandidates.length} decisiones de riesgo bajo se pueden aprobar juntas.
                  </p>
                  <button
                    onClick={() =>
                      setSelected(
                        selected.length === batchCandidates.length ? [] : batchCandidates.map((d) => d.id),
                      )
                    }
                    className="press text-small font-semibold text-link hover:underline"
                  >
                    {selected.length === batchCandidates.length ? "Quitar la selección" : "Seleccionarlas todas"}
                  </button>
                  <ActionButton
                    variant="primary"
                    disabled={selected.length === 0 || batching}
                    onClick={() => void approveSelected()}
                    data-testid="batch-approve"
                  >
                    {batching
                      ? "Aprobando…"
                      : selected.length === 0
                        ? "Aprobar en lote"
                        : `Aprobar ${selected.length} en lote`}
                  </ActionButton>
                </div>
              ) : null}

              {groups.map((group) => (
                <section key={group.key} data-testid={`decision-group-${group.key}`}>
                  <SectionHead
                    label={clientNameFor(group.projectId)}
                    count={group.decisions.length}
                    hint={KIND_LABELS[group.kind]}
                  />
                  <div className="grid gap-2.5">
                    {group.decisions.map((decision) => (
                      <DecisionCard
                        key={decision.id}
                        decision={decision}
                        clientName={clientNameFor(group.projectId)}
                        selectable={decision.risk === "bajo"}
                        selected={selected.includes(decision.id)}
                        onToggle={toggle}
                      />
                    ))}
                  </div>
                </section>
              ))}
            </>
          )}
        </div>

        <aside className="mt-8 lg:mt-0">
          <SectionHead label="Pulso" />
          <div className="grid gap-3">
            <Stat
              value={pulse ? pulse.working : "—"}
              label="Agentes trabajando"
              {...(pulse && pulse.working > 0 ? { tone: "work" as const } : {})}
            />
            <Stat
              value={pulse ? pulse.failed : "—"}
              label={pulse?.failed === 1 ? "Ejecución fallida" : "Ejecuciones fallidas"}
              tone={pulse && pulse.failed > 0 ? "broken" : undefined}
            />
            <Stat
              value={pulse ? (pulse.spentToday === null ? "no reportado" : fmtCost(pulse.spentToday)) : "—"}
              label="Gasto de hoy"
            />
          </div>

          <SectionHead label="Atajos" />
          <div className="flex flex-col items-start gap-2">
            <Link to={paths.misTareas()} className="press text-small font-semibold text-link hover:underline">
              Mis tareas
            </Link>
            <Link to={paths.tareas()} className="press text-small font-semibold text-link hover:underline">
              Todas las tareas
            </Link>
          </div>
        </aside>
      </div>
    </div>
  );
}
