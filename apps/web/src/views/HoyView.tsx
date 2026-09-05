/**
 * Hoy (PLAN-v1.5 §La pantalla de entrada). Sustituye a "Esperando por ti" y es
 * la puerta después del login: nunca más un chat vacío.
 *
 * Tres bloques en este orden: las decisiones que te esperan —las tres más
 * urgentes arriba, el resto agrupado por proyecto y por gate, ordenado por
 * riesgo y con aprobación en lote para las de riesgo bajo—, tus proyectos con
 * su posición en el ciclo, y el pulso del día.
 */
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useStore } from "../state/store";
import { api } from "../lib/api";
import { paths } from "../lib/paths";
import {
  batchable,
  buildDecisions,
  daysWaiting,
  groupDecisions,
  KIND_LABELS,
  RISK_LABELS,
  sortByRisk,
  summarizePayload,
  type Decision,
} from "../lib/decisions";
import { useProjectSummaries } from "../state/useProjectSummaries";
import { ActionButton, Card, Chip, LateChip, SectionHead, Stat } from "../components/system";
import { EmptyState, fmtCost, Spinner, timeAgo } from "../components/ui";
import { ArtifactBlock } from "./TaskDrawer";
import ProjectsTable from "./ProjectsTable";

const LATE_AFTER_DAYS = 2;

function riskTone(decision: Decision): "broken" | "decide" | "quiet" {
  if (decision.risk === "alto") return "broken";
  if (decision.risk === "medio") return "decide";
  return "quiet";
}

/** El payload literal sigue disponible: el digest liga la aprobación a él. */
function PayloadSummary({ decision }: { decision: Decision }) {
  const approval = decision.approval;
  if (!approval) return null;
  const lines = summarizePayload(approval.payload);
  return (
    <div className="mt-3">
      {lines.length > 0 ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-small">
          {lines.map((line) => (
            <div key={line.label} className="contents">
              <dt className="text-muted">{line.label}</dt>
              <dd className="min-w-0 break-words text-ink-2">{line.value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="text-small text-muted">La aprobación no trae parámetros.</p>
      )}
      <details className="mt-2">
        <summary className="press cursor-pointer text-small text-link">Ver el payload literal</summary>
        <pre className="mt-1.5 max-h-52 overflow-auto rounded-tight border border-line-soft bg-canvas-deep p-3 text-label leading-relaxed text-ink-2">
          {JSON.stringify(approval.payload, null, 2)}
        </pre>
      </details>
    </div>
  );
}

function DecisionBody({ decision }: { decision: Decision }) {
  if (decision.approval) return <PayloadSummary decision={decision} />;
  if (decision.artifacts.length === 0) {
    return (
      <p className="mt-3 text-small text-broken">
        Llegó a revisión sin evidencia adjunta. Abre la tarjeta antes de aprobar.
      </p>
    );
  }
  return (
    <div className="mt-3 space-y-2">
      {decision.artifacts.map((a) => (
        <ArtifactBlock key={a.id} artifact={a} />
      ))}
    </div>
  );
}

function DecisionCard({
  decision,
  projectName,
  selectable,
  selected,
  onToggle,
  defaultOpen = false,
}: {
  decision: Decision;
  projectName: string;
  selectable: boolean;
  selected: boolean;
  onToggle: (id: string) => void;
  defaultOpen?: boolean;
}) {
  const decideApproval = useStore((s) => s.decideApproval);
  const approveTaskReview = useStore((s) => s.approveTaskReview);
  const rejectTaskReview = useStore((s) => s.rejectTaskReview);
  const openTask = useStore((s) => s.openTask);
  const [open, setOpen] = useState(defaultOpen);
  const [note, setNote] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const late = daysWaiting(decision) >= LATE_AFTER_DAYS ? daysWaiting(decision) : 0;

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
    <Card
      as="article"
      className={`overflow-hidden ${late ? "late" : ""}`}
      data-testid={`decision-${decision.id}`}
    >
      <div className="flex items-start gap-3 p-4">
        {selectable ? (
          <label className="flex min-h-9 items-center gap-2 pt-0.5 text-small text-muted">
            <input
              type="checkbox"
              checked={selected}
              onChange={() => onToggle(decision.id)}
              aria-label={`Seleccionar «${decision.title}» para aprobar en lote`}
              data-testid={`decision-select-${decision.id}`}
              className="h-4 w-4 accent-[var(--color-link)]"
            />
          </label>
        ) : null}
        <div className="min-w-0 flex-1">
          <h3 className="text-body font-semibold text-ink">{decision.title}</h3>
          <p className="mt-1 text-small text-muted">{decision.unlocks}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-small text-muted">
            <Chip tone="quiet">{projectName}</Chip>
            <Chip tone="quiet">{KIND_LABELS[decision.kind]}</Chip>
            <span>espera desde {timeAgo(decision.waitingSince)}</span>
            <LateChip days={late} />
          </div>
          <div className="mt-2 flex flex-wrap gap-3 text-small">
            {decision.projectId ? (
              <Link
                to={paths.proyecto(decision.projectId, "ruta")}
                className="press font-semibold text-link hover:underline"
              >
                Ver la ruta y el gate
              </Link>
            ) : null}
            {decision.taskId ? (
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
            <button onClick={() => setOpen((v) => !v)} className="press text-muted hover:text-ink-2">
              {open ? "Ocultar el detalle" : "Ver el detalle"}
            </button>
          </div>
          {open ? <DecisionBody decision={decision} /> : null}
        </div>
        <Chip tone={riskTone(decision)} className="mt-0.5 shrink-0">
          {RISK_LABELS[decision.risk]}
        </Chip>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-line-soft bg-surface-2 p-3">
        <ActionButton
          variant="primary"
          disabled={busy}
          onClick={() => void decide("approve")}
          data-testid={`decision-approve-${decision.id}`}
        >
          Aprobar
        </ActionButton>
        {!rejecting ? (
          <ActionButton variant="danger" disabled={busy} onClick={() => setRejecting(true)}>
            Rechazar…
          </ActionButton>
        ) : null}
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={rejecting ? "Nota de rechazo: el agente la recibe" : "Nota opcional"}
          aria-label={rejecting ? "Nota de rechazo" : "Nota opcional"}
          className="min-h-9 min-w-40 flex-1 rounded-tight border border-line bg-surface px-2.5 py-1.5 text-small"
        />
        {rejecting ? (
          <ActionButton
            variant="danger"
            disabled={busy || (!decision.approval && !note.trim())}
            onClick={() => void decide("reject")}
          >
            Confirmar rechazo
          </ActionButton>
        ) : null}
      </div>
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
  const approveTaskReview = useStore((s) => s.approveTaskReview);
  const pushToast = useStore((s) => s.pushToast);
  const [params, setParams] = useSearchParams();
  const projectFilter = params.get("proyecto");
  const [selected, setSelected] = useState<string[]>([]);
  const [batching, setBatching] = useState(false);
  const pulse = usePulse();
  const { summaries, loading: summariesLoading } = useProjectSummaries(projects);

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
  const projectNames = useMemo(() => new Map(projects.map((p) => [p.id, p.name])), [projects]);
  const filteredProject = projectFilter ? projects.find((p) => p.id === projectFilter) : undefined;
  const visibleSummaries = projectFilter ? summaries.filter((s) => s.project.id === projectFilter) : summaries;

  function nameOf(decision: Decision): string {
    return decision.projectId ? (projectNames.get(decision.projectId) ?? "Proyecto") : "Sin proyecto";
  }

  function toggle(id: string) {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  /**
   * Aprobación en lote: llamadas secuenciales a la API que ya existe, una por
   * decisión, para no romper el `expected_version` de la siguiente.
   */
  async function approveSelected() {
    const chosen = batchCandidates.filter((d) => selected.includes(d.id) && d.taskId);
    if (chosen.length === 0) return;
    setBatching(true);
    let ok = 0;
    try {
      for (const decision of chosen) {
        try {
          await approveTaskReview(decision.taskId!);
          ok += 1;
        } catch {
          break;
        }
      }
    } finally {
      setBatching(false);
      setSelected([]);
      if (ok > 0) pushToast("ok", ok === 1 ? "1 decisión aprobada" : `${ok} decisiones aprobadas`);
      if (ok < chosen.length) pushToast("error", "El lote se detuvo: revisa las que quedaron.");
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

      <SectionHead label="Decisiones" count={total} />

      {total === 0 ? (
        <EmptyState
          title="Bandeja limpia"
          hint="Aquí llegan los gates de fase, las acciones que tocan sistemas del cliente y los entregables que los agentes dejan listos para tu visto bueno."
        />
      ) : (
        <>
          <div className="grid gap-2.5">
            {top.map((decision) => (
              <DecisionCard
                key={decision.id}
                decision={decision}
                projectName={nameOf(decision)}
                selectable={decision.risk === "bajo"}
                selected={selected.includes(decision.id)}
                onToggle={toggle}
                defaultOpen
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
            <section key={group.key} className="mt-6" data-testid={`decision-group-${group.key}`}>
              <div className="mb-2 flex flex-wrap items-baseline gap-2">
                <h3 className="text-body font-semibold text-ink-2">{group.projectName}</h3>
                <span className="text-small text-muted">{KIND_LABELS[group.kind]}</span>
                <span className="text-small text-faint">{group.decisions.length}</span>
              </div>
              <div className="grid gap-2.5">
                {group.decisions.map((decision) => (
                  <DecisionCard
                    key={decision.id}
                    decision={decision}
                    projectName={group.projectName}
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

      <SectionHead label="Tus proyectos" count={visibleSummaries.length} />
      {summariesLoading && visibleSummaries.length === 0 ? (
        <Spinner label="Leyendo el estado de cada proyecto…" />
      ) : (
        <ProjectsTable summaries={visibleSummaries} />
      )}

      <SectionHead label="Pulso" />
      <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
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
        <Stat value={total} label={total === 1 ? "Decisión esperando" : "Decisiones esperando"} />
      </div>

      <p className="mt-6 text-small text-muted">
        ¿Buscabas tu propio trabajo?{" "}
        <Link to={paths.misTareas()} className="press font-semibold text-link hover:underline">
          Ver mis tareas
        </Link>
        .
      </p>
    </div>
  );
}
