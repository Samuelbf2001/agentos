/**
 * Piezas pequeñas compartidas: avatares, pills de estado, vacíos, errores y
 * toasts. Todas hablan la gramática de color única del sistema (ámbar trabajo,
 * violeta decisión humana, rojo roto o vencido, verde cerrado, azul enlace):
 * no existe color por categoría ni por agente.
 */
import { useStore } from "../state/store";
import { Chip, type Tone } from "./system";
import { taskDueState, taskDueTimestamp, type Task, type TaskPriority, type TaskStatus } from "../lib/types";

// ── Avatares: iniciales sobre neutro. La identidad la da el nombre. ─────────

function initialsOf(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

const AVATAR_SIZES: Record<5 | 6 | 8, string> = {
  5: "h-5 w-5 text-[0.625rem]",
  6: "h-6 w-6 text-label",
  8: "h-8 w-8 text-small",
};

/** Agente: neutro con anillo, para distinguirlo de una persona sin usar color. */
export function AgentAvatar({ name, slug, size = 6 }: { name: string; slug: string; size?: 5 | 6 | 8 }) {
  return (
    <span
      title={name}
      data-agent={slug}
      className={`inline-flex shrink-0 items-center justify-center rounded-full bg-ink-2 font-semibold text-surface ring-2 ring-line ${AVATAR_SIZES[size]}`}
    >
      {initialsOf(name)}
    </span>
  );
}

/** Avatar humano deliberadamente neutro: no expone correo en tarjetas ni listas. */
export function PersonAvatar({ name, size = 6 }: { name: string; size?: 5 | 6 | 8 }) {
  return (
    <span
      title={name}
      aria-hidden="true"
      className={`inline-flex shrink-0 items-center justify-center rounded-full border border-line bg-canvas-deep font-semibold text-ink-2 ${AVATAR_SIZES[size]}`}
    >
      {initialsOf(name) || "?"}
    </span>
  );
}

// ── Pills de estado ─────────────────────────────────────────────────────────

/** Un estado, un tono. REVIEW es el único violeta: espera decisión humana. */
export const STATUS_TONES: Record<TaskStatus, Tone> = {
  BACKLOG: "quiet",
  READY: "quiet",
  IN_PROGRESS: "work",
  REVIEW: "decide",
  BLOCKED: "broken",
  DONE: "done",
  CANCELLED: "quiet",
};

export const STATUS_LABELS: Record<TaskStatus, string> = {
  BACKLOG: "Backlog",
  READY: "Lista",
  IN_PROGRESS: "En curso",
  REVIEW: "En revisión",
  BLOCKED: "Bloqueada",
  DONE: "Terminada",
  CANCELLED: "Cancelada",
};

export function StatusPill({ status }: { status: TaskStatus }) {
  return (
    <span data-status={status} aria-label={STATUS_LABELS[status]}>
      <Chip tone={STATUS_TONES[status]} className={status === "CANCELLED" ? "line-through" : ""}>
        {STATUS_LABELS[status]}
      </Chip>
    </span>
  );
}

export const DUE_TONES: Record<ReturnType<typeof taskDueState>, string> = {
  none: "text-faint",
  overdue: "text-broken",
  today: "text-work",
  upcoming: "text-work",
  later: "text-muted",
  complete: "text-done",
};

export function dueLabel(task: Pick<Task, "status" | "dueAt" | "due_at">, now = Date.now()): string {
  const state = taskDueState(task, now);
  const dueAt = taskDueTimestamp(task);
  if (state === "none") return "Sin vencimiento";
  if (state === "complete") return dueAt ? `Venció ${new Date(dueAt).toLocaleDateString("es")}` : "Sin vencimiento";
  if (state === "overdue") {
    const days = Math.max(1, Math.floor((now - (dueAt ?? now)) / 86_400_000));
    return days === 1 ? "Vencida hace 1 día" : `Vencida hace ${days} días`;
  }
  if (state === "today") return "Vence hoy";
  if (state === "upcoming") {
    const days = Math.max(1, Math.ceil(((dueAt ?? now) - now) / 86_400_000));
    return `Vence en ${days} d`;
  }
  return dueAt ? `Vence ${new Date(dueAt).toLocaleDateString("es")}` : "Sin vencimiento";
}

export function DuePill({ task, now = Date.now() }: { task: Pick<Task, "status" | "dueAt" | "due_at">; now?: number }) {
  const state = taskDueState(task, now);
  return (
    <span className={`inline-flex items-center gap-1 text-label font-medium ${DUE_TONES[state]}`}>
      {dueLabel(task, now)}
    </span>
  );
}

export const PRIORITY_TONES: Record<TaskPriority, string> = {
  low: "text-faint",
  normal: "text-muted",
  high: "text-work",
  urgent: "text-broken",
};

const PRIORITY_WORDS: Record<TaskPriority, string> = {
  low: "baja",
  normal: "normal",
  high: "alta",
  urgent: "urgente",
};

export function PriorityDot({ priority }: { priority: TaskPriority }) {
  return (
    <span title={`Prioridad ${PRIORITY_WORDS[priority]}`} className={`text-label font-bold ${PRIORITY_TONES[priority]}`}>
      {priority === "urgent" ? "!!" : priority === "high" ? "!" : "·"}
    </span>
  );
}

export const RUN_STATUS_TONES: Record<string, Tone> = {
  succeeded: "done",
  running: "work",
  queued: "quiet",
  failed: "broken",
  cancelled: "quiet",
  interrupted: "broken",
};

export const RUN_STATUS_LABELS: Record<string, string> = {
  succeeded: "Terminado",
  running: "En curso",
  queued: "En cola",
  failed: "Falló",
  cancelled: "Cancelado",
  interrupted: "Interrumpido",
};

export function RunStatusPill({ status }: { status: string }) {
  return (
    <span data-run-status={status}>
      <Chip tone={RUN_STATUS_TONES[status] ?? "quiet"}>{RUN_STATUS_LABELS[status] ?? status}</Chip>
    </span>
  );
}

// ── Vacíos y errores escritos para quien los lee, no para quien programa ────

export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-panel border border-dashed border-line bg-surface/60 p-10 text-center">
      <p className="text-body font-semibold text-ink-2">{title}</p>
      {hint ? <p className="max-w-prose text-small text-muted">{hint}</p> : null}
      {action}
    </div>
  );
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="rounded-panel border border-broken-line bg-broken-bg p-4 text-small text-broken">
      <p className="font-semibold">Algo falló</p>
      <p className="mt-1">{message}</p>
      {onRetry ? (
        <button
          onClick={onRetry}
          className="press mt-2 rounded-tight border border-broken-line bg-surface px-2.5 py-1 text-small font-semibold text-broken"
        >
          Reintentar
        </button>
      ) : null}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 p-4 text-small text-muted">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-line border-t-muted" />
      {label ?? "Cargando…"}
    </div>
  );
}

// ── Toasts ──────────────────────────────────────────────────────────────────

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  if (toasts.length === 0) return null;
  return (
    <div className="fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2" role="status">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`enter-rise flex items-start justify-between gap-2 rounded-soft border p-3 text-small shadow-float ${
            t.kind === "error"
              ? "border-broken-line bg-broken-bg text-broken"
              : t.kind === "ok"
                ? "border-done-line bg-done-bg text-done"
                : "border-line bg-surface text-ink-2"
          }`}
        >
          <span className="break-words">{t.text}</span>
          <button onClick={() => dismiss(t.id)} className="press text-label opacity-60 hover:opacity-100">
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}

// ── Utilidades de formato ───────────────────────────────────────────────────

export function timeAgo(ts: number | null | undefined): string {
  if (!ts) return "—";
  const diff = Date.now() - ts;
  if (diff < 60_000) return "hace segundos";
  if (diff < 3_600_000) return `hace ${Math.floor(diff / 60_000)} min`;
  if (diff < 86_400_000) return `hace ${Math.floor(diff / 3_600_000)} h`;
  return `hace ${Math.floor(diff / 86_400_000)} d`;
}

export function fmtDate(ts: number | null | undefined): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleString("es", { dateStyle: "short", timeStyle: "short" });
}

export function fmtDay(ts: number | null | undefined): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleDateString("es", { day: "numeric", month: "short" });
}

/** null = "no reportado", nunca cero inferido (PRD CA-7.2). */
export function fmtTokens(n: number | null | undefined): string {
  return n === null || n === undefined ? "no reportado" : n.toLocaleString("es");
}

export function fmtCost(n: number | null | undefined): string {
  return n === null || n === undefined ? "no reportado" : `$${n.toFixed(4)}`;
}

export function actorLabel(actor: string | null | undefined): string {
  if (!actor) return "—";
  const [kind, ...rest] = actor.split(":");
  const ref = rest.join(":");
  if (kind === "agent") return `agente ${ref}`;
  if (kind === "person") return `persona ${ref.slice(0, 8)}`;
  return `sistema ${ref}`;
}
