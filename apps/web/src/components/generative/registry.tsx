/**
 * Generative UI nativa (handoff §4, Trabajo A): registro `toolName → tarjeta`.
 * Sin CopilotKit: el reducer ya acumula TOOL_CALL_START/ARGS/RESULT en chips y
 * aquí se decide si un chip merece una tarjeta interactiva o el chip genérico.
 *
 * Reglas:
 * - Los args llegan por deltas: mientras el JSON no cierre, o no haya resultado,
 *   se cae al chip genérico (nunca se rompe el stream).
 * - Las tarjetas no reimplementan acciones: usan decideApproval,
 *   approveTaskReview, rejectTaskReview y openTask del store.
 * - El estado vivo se deriva del store (approvals, board.tasks, reviewTasks); el
 *   resultado de la tool es solo el punto de partida.
 */
import { useState, type ReactNode } from "react";
import { useStore } from "../../state/store";
import type { ToolCallChip } from "../../state/reducer";
import type { Task, TaskStatus } from "../../lib/types";
import { StatusPill } from "../ui";
import { ToolChip } from "./ToolChip";

// ── Utilidades ──────────────────────────────────────────────────────────────

/** JSON.parse tolerante: null si el texto está vacío, incompleto o no es JSON. */
export function safeJson(text: string | null | undefined): unknown | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

const STATUSES: readonly TaskStatus[] = [
  "BACKLOG",
  "READY",
  "IN_PROGRESS",
  "REVIEW",
  "BLOCKED",
  "DONE",
  "CANCELLED",
];

function asStatus(v: unknown): TaskStatus | null {
  return typeof v === "string" && (STATUSES as readonly string[]).includes(v) ? (v as TaskStatus) : null;
}

/** Tarea mínima extraída del resultado de una tool (Task del engine, camelCase). */
interface ResultTask {
  id: string;
  title: string | null;
  status: TaskStatus | null;
  assigneeAgentId: string | null;
}

function resultTask(chip: ToolCallChip): ResultTask | null {
  if (!chip.done || chip.isError) return null;
  const r = safeJson(chip.result);
  if (!isRecord(r)) return null;
  const id = str(r.id);
  if (!id) return null;
  return {
    id,
    title: str(r.title),
    status: asStatus(r.status),
    assigneeAgentId: str(r.assigneeAgentId),
  };
}

/** Estado vivo de una tarea: tablero → bandeja de revisión → nada. */
function useLiveTask(taskId: string | null): Task | null {
  return useStore((s) => {
    if (!taskId) return null;
    return s.board.tasks[taskId] ?? s.reviewTasks.find((r) => r.task.id === taskId)?.task ?? null;
  });
}

// ── Piezas compartidas (vocabulario de TaskDrawer/ChatView) ─────────────────

const BTN_APPROVE =
  "min-h-10 rounded-tight bg-done px-3 py-2 text-small font-semibold text-surface hover:bg-done focus:outline-none focus:ring-2 focus:ring-done disabled:cursor-not-allowed disabled:opacity-40";
const BTN_REJECT =
  "min-h-10 rounded-tight border border-broken bg-surface px-3 py-2 text-small font-semibold text-broken hover:bg-broken-bg focus:outline-none focus:ring-2 focus:ring-broken disabled:cursor-not-allowed disabled:opacity-40";
const BTN_CONFIRM_REJECT =
  "mt-2 min-h-10 rounded-tight bg-broken px-3 py-2 text-small font-semibold text-surface focus:outline-none focus:ring-2 focus:ring-broken disabled:cursor-not-allowed disabled:opacity-40";
const BTN_OPEN =
  "inline-flex min-h-10 items-center gap-1 rounded-tight border border-link bg-link-bg px-2 py-1 text-small text-link hover:bg-link-bg focus:outline-none focus:ring-2 focus:ring-link";

function OpenTaskButton({ taskId, label = "Abrir tarjeta" }: { taskId: string; label?: string }) {
  const openTask = useStore((s) => s.openTask);
  return (
    <button type="button" onClick={() => void openTask(taskId)} className={BTN_OPEN}>
      {label}
    </button>
  );
}

/**
 * Aprobar / Rechazar con nota. `noteRequired` fuerza la nota en el rechazo
 * (REVIEW → agente necesita input); las aprobaciones de ask_human la admiten
 * opcional. Deshabilita todo mientras la decisión está en vuelo.
 */
function DecideButtons({
  onApprove,
  onReject,
  noteRequired,
  disabled,
  idPrefix,
}: {
  onApprove: () => Promise<void>;
  onReject: (note: string) => Promise<void>;
  noteRequired: boolean;
  disabled?: boolean;
  idPrefix: string;
}) {
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState("");
  const off = busy || disabled === true;

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2">
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={off} onClick={() => void run(onApprove)} className={BTN_APPROVE}>
          ✓ Aprobar
        </button>
        <button
          type="button"
          disabled={off}
          aria-expanded={rejecting}
          onClick={() => setRejecting((v) => !v)}
          className={BTN_REJECT}
        >
          ✕ Rechazar
        </button>
      </div>
      {rejecting ? (
        <div className="mt-2">
          <label htmlFor={`${idPrefix}-reject-note`} className="sr-only">
            Nota de rechazo
          </label>
          <textarea
            id={`${idPrefix}-reject-note`}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            disabled={off}
            placeholder={
              noteRequired
                ? "Nota de rechazo (obligatoria): el agente la recibe como input"
                : "Nota de rechazo (opcional)"
            }
            className="w-full rounded-tight border border-line p-2 text-small focus:border-broken focus:outline-none focus:ring-2 focus:ring-broken"
            rows={3}
          />
          <button
            type="button"
            disabled={off || (noteRequired && !note.trim())}
            onClick={() =>
              void run(async () => {
                await onReject(note.trim());
                setRejecting(false);
                setNote("");
              })
            }
            className={BTN_CONFIRM_REJECT}
          >
            Confirmar rechazo
          </button>
        </div>
      ) : null}
      {busy ? <p className="mt-1 text-label text-faint">Enviando decisión…</p> : null}
    </div>
  );
}

function Card({
  tone,
  title,
  children,
  toolName,
}: {
  tone: "decide" | "quiet" | "done";
  title: ReactNode;
  children?: ReactNode;
  toolName: string;
}) {
  const skin =
    tone === "decide"
      ? "border-decide-line bg-decide-bg"
      : tone === "done"
        ? "border-done-line bg-done-bg"
        : "border-line bg-surface-2";
  return (
    <section className={`my-1 rounded-tight border p-2 text-small ${skin}`} data-generative={toolName}>
      <p className={`font-semibold ${tone === "decide" ? "text-decide" : "text-muted"}`}>{title}</p>
      {children}
    </section>
  );
}

// ── Tarjetas ────────────────────────────────────────────────────────────────

/** ask_human: {kind,title,body} → approval; decide inline mientras esté pendiente. */
function AskHumanCard({ chip }: { chip: ToolCallChip; runId: string }) {
  const args = safeJson(chip.args);
  const res = safeJson(chip.result);
  const approvalId = isRecord(res) ? str(res.approval_id) : null;
  const pending = useStore((s) => (approvalId ? s.approvals.find((a) => a.id === approvalId) ?? null : null));
  const decideApproval = useStore((s) => s.decideApproval);

  if (!chip.done || chip.isError || !approvalId || !isRecord(args)) return <ToolChip chip={chip} />;

  const kind = str(args.kind) === "deliverable" ? "Entregable" : "Pregunta";
  const title = str(args.title) ?? "Necesita tu decisión";
  const body = str(args.body);
  const taskId = str(args.task_id);
  const resolved = pending === null;

  return (
    <Card tone={resolved ? "done" : "decide"} toolName="ask_human" title={`${kind} para ti: ${title}`}>
      {body ? <p className="mt-1 whitespace-pre-wrap text-ink">{body}</p> : null}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {resolved ? (
          <span className="rounded-tight border border-done-line bg-surface px-2 py-1 font-medium text-done">
            Resuelta
          </span>
        ) : null}
        {taskId ? <OpenTaskButton taskId={taskId} /> : null}
      </div>
      {!resolved ? (
        <DecideButtons
          idPrefix={`ask-${chip.id}`}
          noteRequired={false}
          onApprove={() => decideApproval(approvalId, "approved")}
          onReject={(note) => decideApproval(approvalId, "rejected", note || undefined)}
        />
      ) : null}
    </Card>
  );
}

/** tasks.move: si deja la tarea en REVIEW, decide inline; si no, chip compacto. */
function TaskMoveCard({ chip }: { chip: ToolCallChip; runId: string }) {
  const rt = resultTask(chip);
  const live = useLiveTask(rt?.id ?? null);
  const approveTaskReview = useStore((s) => s.approveTaskReview);
  const rejectTaskReview = useStore((s) => s.rejectTaskReview);

  if (!rt) return <ToolChip chip={chip} />;

  const status = live?.status ?? rt.status;
  const title = live?.title ?? rt.title ?? `Tarjeta ${rt.id.slice(0, 8)}`;
  if (!status) return <ToolChip chip={chip} />;

  if (status !== "REVIEW") {
    return (
      <Card tone="quiet" toolName="tasks.move" title={
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-normal text-muted">Movida a</span>
          <StatusPill status={status} />
          <span className="text-ink">{title}</span>
        </span>
      }>
        <div className="mt-1">
          <OpenTaskButton taskId={rt.id} />
        </div>
      </Card>
    );
  }

  // REVIEW → DONE solo humano. Los botones exigen la tarea en el store: la
  // acción del store la busca ahí (version para expected_version).
  return (
    <Card tone="decide" toolName="tasks.move" title={`En revisión: ${title}`}>
      <p className="mt-1 text-muted">Decide tú (REVIEW → DONE solo humano).</p>
      <div className="mt-2">
        <OpenTaskButton taskId={rt.id} />
      </div>
      {live ? (
        <DecideButtons
          idPrefix={`move-${chip.id}`}
          noteRequired
          onApprove={() => approveTaskReview(rt.id)}
          onReject={(note) => rejectTaskReview(rt.id, note)}
        />
      ) : (
        <p className="mt-2 text-label text-faint">
          La tarjeta no está cargada en este tablero: ábrela para decidir.
        </p>
      )}
    </Card>
  );
}

/** delegate: tarea hija + agente destino + estado vivo. */
function DelegateCard({ chip }: { chip: ToolCallChip; runId: string }) {
  const args = safeJson(chip.args);
  const rt = resultTask(chip);
  const live = useLiveTask(rt?.id ?? null);
  const agents = useStore((s) => s.agents);

  if (!rt) return <ToolChip chip={chip} />;

  const assigneeSlug = isRecord(args) ? str(args.assignee) : null;
  const agent =
    agents.find((a) => a.id === (live?.assigneeAgentId ?? rt.assigneeAgentId)) ??
    (assigneeSlug ? agents.find((a) => a.slug === assigneeSlug) : undefined);
  const agentLabel = agent?.name ?? assigneeSlug ?? "agente";
  const title = live?.title ?? rt.title ?? (isRecord(args) ? str(args.tarea) : null) ?? `Tarjeta ${rt.id.slice(0, 8)}`;
  const status = live?.status ?? rt.status;

  return (
    <Card tone="quiet" toolName="delegate" title={`Delegada a ${agentLabel}`}>
      <p className="mt-1 text-ink">{title}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {status ? <StatusPill status={status} /> : null}
        <OpenTaskButton taskId={rt.id} />
      </div>
    </Card>
  );
}

/** tasks.create: mini-tarjeta con estado vivo + abrir. */
function TaskCreateCard({ chip }: { chip: ToolCallChip; runId: string }) {
  const rt = resultTask(chip);
  const live = useLiveTask(rt?.id ?? null);
  if (!rt) return <ToolChip chip={chip} />;
  const title = live?.title ?? rt.title ?? `Tarjeta ${rt.id.slice(0, 8)}`;
  const status = live?.status ?? rt.status;
  return (
    <Card tone="quiet" toolName="tasks.create" title="Tarea creada">
      <p className="mt-1 text-ink">{title}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {status ? <StatusPill status={status} /> : null}
        <OpenTaskButton taskId={rt.id} />
      </div>
    </Card>
  );
}

// ── Registro ────────────────────────────────────────────────────────────────

type CardComponent = (props: { chip: ToolCallChip; runId: string }) => ReactNode;

const REGISTRY: Record<string, CardComponent> = {
  ask_human: AskHumanCard,
  "tasks.move": TaskMoveCard,
  delegate: DelegateCard,
  "tasks.create": TaskCreateCard,
};

export function hasGenerativeCard(toolName: string): boolean {
  return Object.prototype.hasOwnProperty.call(REGISTRY, toolName);
}

/** Tarjeta interactiva si el registro la conoce; si no, el chip genérico. */
export function renderToolCall(chip: ToolCallChip, runId: string): ReactNode {
  const Component = REGISTRY[chip.name];
  if (!Component) return <ToolChip key={chip.id} chip={chip} />;
  return <Component key={chip.id} chip={chip} runId={runId} />;
}

/**
 * Tareas que el registro ya muestra como tarjeta (tasks.create / delegate con
 * resultado completo): ChatView las omite de sus mini-tarjetas `createdTasks`
 * para no duplicar.
 */
export function tasksShownByRegistry(chips: ToolCallChip[]): Set<string> {
  const ids = new Set<string>();
  for (const chip of chips) {
    if (chip.name !== "tasks.create" && chip.name !== "delegate") continue;
    const rt = resultTask(chip);
    if (rt) ids.add(rt.id);
  }
  return ids;
}
