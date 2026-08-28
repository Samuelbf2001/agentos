/**
 * Esperando por ti (US-4/5, spec B5 §7): bandeja de TODO lo que espera a un
 * humano — aprobaciones pendientes (payload literal del tool_call o pregunta,
 * riesgo, quién lo pidió, hace cuánto) Y entregables en REVIEW con su artefacto
 * renderizado (CA-4.2, fix H10). Aprobar/Rechazar con nota; la lista y el
 * tablero se actualizan en vivo (topic approvals + board).
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useStore, type ReviewEntry } from "../state/store";
import type { Approval } from "../lib/types";
import { actorLabel, EmptyState, StatusPill, timeAgo } from "../components/ui";
import { ArtifactBlock } from "./TaskDrawer";

const KIND_LABEL: Record<Approval["kind"], { label: string; risk: string; cls: string }> = {
  tool_call: {
    label: "Tool de efecto externo",
    risk: "Alto: al aprobar, la plataforma EJECUTA el efecto",
    cls: "bg-orange-100 text-orange-800",
  },
  deliverable: {
    label: "Entregable",
    risk: "Medio: cierra una fase de trabajo",
    cls: "bg-violet-100 text-violet-800",
  },
  gate: {
    label: "Gate de proyecto",
    risk: "Alto: habilita la siguiente etapa",
    cls: "bg-rose-100 text-rose-800",
  },
};

function ApprovalCard({ approval }: { approval: Approval }) {
  const decideApproval = useStore((s) => s.decideApproval);
  const openTask = useStore((s) => s.openTask);
  const [note, setNote] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const meta = KIND_LABEL[approval.kind];
  const payload = approval.payload as { tool?: string; args?: unknown };

  async function decide(decision: "approved" | "rejected") {
    setBusy(true);
    try {
      await decideApproval(approval.id, decision, note.trim() || undefined);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${meta.cls}`}>{meta.label}</span>
        {payload.tool ? <span className="font-mono text-xs font-medium">{payload.tool}</span> : null}
        <span className="text-xs text-slate-400">
          pedida por {actorLabel(approval.requestedBy)} · {timeAgo(approval.createdAt)}
        </span>
      </div>
      <p className="mt-1 text-[11px] text-rose-600">⚠ {meta.risk}</p>

      <div className="mt-2">
        <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400">
          Payload literal (el digest liga la aprobación a EXACTAMENTE esto)
        </p>
        <pre className="mt-1 max-h-52 overflow-auto rounded-md bg-slate-900 p-3 text-[11px] leading-relaxed text-slate-100">
          {JSON.stringify(approval.payload, null, 2)}
        </pre>
      </div>

      <div className="mt-2 flex flex-wrap gap-3 text-xs">
        {approval.taskId ? (
          <button onClick={() => void openTask(approval.taskId!)} className="text-sky-700 underline">
            Ver tarjeta
          </button>
        ) : null}
        {approval.runId ? (
          <Link to={`/runs/${approval.runId}`} className="text-sky-700 underline">
            Ver run
          </Link>
        ) : null}
      </div>

      <div className="mt-3 flex items-start gap-2">
        <button
          disabled={busy}
          onClick={() => void decide("approved")}
          className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-40"
        >
          ✓ Aprobar
        </button>
        {!rejecting ? (
          <button
            disabled={busy}
            onClick={() => setRejecting(true)}
            className="rounded-md border border-rose-300 px-3 py-1.5 text-xs font-medium text-rose-700 hover:bg-rose-50"
          >
            ✕ Rechazar…
          </button>
        ) : null}
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={rejecting ? "Nota de rechazo (recomendada)" : "Nota opcional"}
          className="flex-1 rounded-md border border-slate-300 px-2 py-1.5 text-xs"
        />
        {rejecting ? (
          <button
            disabled={busy}
            onClick={() => void decide("rejected")}
            className="rounded-md bg-rose-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-rose-700 disabled:opacity-40"
          >
            Confirmar
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** Entregable en REVIEW: artefacto renderizado + Aprobar/Rechazar (CA-4.2, H10). */
function ReviewCard({ entry }: { entry: ReviewEntry }) {
  const approveTaskReview = useStore((s) => s.approveTaskReview);
  const rejectTaskReview = useStore((s) => s.rejectTaskReview);
  const openTask = useStore((s) => s.openTask);
  const agents = useStore((s) => s.agents);
  const [note, setNote] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const { task, artifacts } = entry;
  const agent = task.assigneeAgentId ? agents.find((a) => a.id === task.assigneeAgentId) : null;

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-violet-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded bg-violet-100 px-1.5 py-0.5 text-[10px] font-semibold text-violet-800">
          Entregable en REVIEW
        </span>
        {task.requiresApproval ? (
          <span className="rounded bg-rose-100 px-1.5 py-0.5 text-[10px] font-semibold text-rose-800">
            requiere aprobación
          </span>
        ) : null}
        <StatusPill status={task.status} />
        <span className="text-xs text-slate-400">
          {agent ? `producido por ${agent.name}` : ""} · {timeAgo(task.updatedAt)}
        </span>
      </div>
      <p className="mt-1 text-sm font-medium">{task.title}</p>
      <p className="mt-0.5 text-[11px] text-violet-700">REVIEW → DONE solo lo decides tú.</p>

      <div className="mt-2 space-y-2">
        {artifacts.length === 0 ? (
          <p className="text-xs text-rose-600">
            ⚠ Sin artefactos (no debería: nada llega a REVIEW sin evidencia)
          </p>
        ) : (
          artifacts.map((a) => <ArtifactBlock key={a.id} artifact={a} />)
        )}
      </div>

      <div className="mt-2 flex flex-wrap gap-3 text-xs">
        <button onClick={() => void openTask(task.id)} className="text-sky-700 underline">
          Ver tarjeta completa
        </button>
      </div>

      <div className="mt-3 flex items-start gap-2">
        <button
          disabled={busy}
          onClick={() => void run(() => approveTaskReview(task.id, note.trim() || undefined))}
          className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-40"
        >
          ✓ Aprobar → DONE
        </button>
        {!rejecting ? (
          <button
            disabled={busy}
            onClick={() => setRejecting(true)}
            className="rounded-md border border-rose-300 px-3 py-1.5 text-xs font-medium text-rose-700 hover:bg-rose-50"
          >
            ✕ Rechazar…
          </button>
        ) : null}
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={rejecting ? "Nota de rechazo (obligatoria): el agente la recibe" : "Nota opcional"}
          className="flex-1 rounded-md border border-slate-300 px-2 py-1.5 text-xs"
        />
        {rejecting ? (
          <button
            disabled={busy || !note.trim()}
            onClick={() => void run(() => rejectTaskReview(task.id, note.trim()))}
            className="rounded-md bg-rose-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-rose-700 disabled:opacity-40"
          >
            Confirmar
          </button>
        ) : null}
      </div>
    </div>
  );
}

export default function WaitingView() {
  const approvals = useStore((s) => s.approvals);
  const reviewTasks = useStore((s) => s.reviewTasks);
  const loadApprovals = useStore((s) => s.loadApprovals);
  const total = approvals.length + reviewTasks.length;

  useEffect(() => {
    void loadApprovals();
  }, [loadApprovals]);

  return (
    <div className="mx-auto max-w-3xl space-y-3 p-4">
      <h1 className="text-sm font-bold">Esperando por ti ({total})</h1>
      {total === 0 ? (
        <EmptyState
          title="Nada pendiente de tu decisión"
          hint="Aprobaciones de tools/gates y entregables en REVIEW aparecerán aquí."
        />
      ) : (
        <>
          {approvals.map((a) => (
            <ApprovalCard key={a.id} approval={a} />
          ))}
          {reviewTasks.map((r) => (
            <ReviewCard key={r.task.id} entry={r} />
          ))}
        </>
      )}
    </div>
  );
}
