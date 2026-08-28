/** Piezas pequeñas compartidas: avatar de agente, pills, vacíos, errores, toasts. */
import { useStore } from "../state/store";
import type { TaskPriority, TaskStatus } from "../lib/types";

// ── Avatar de agente: iniciales + color determinista por slug ───────────────

const AVATAR_COLORS = [
  "bg-rose-500",
  "bg-orange-500",
  "bg-amber-500",
  "bg-emerald-500",
  "bg-teal-500",
  "bg-sky-500",
  "bg-indigo-500",
  "bg-violet-500",
  "bg-fuchsia-500",
];

export function agentColor(slug: string): string {
  let h = 0;
  for (let i = 0; i < slug.length; i++) h = (h * 31 + slug.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length]!;
}

export function AgentAvatar({ name, slug, size = 6 }: { name: string; slug: string; size?: 5 | 6 | 8 }) {
  const initials = name
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  const sizeCls = size === 8 ? "h-8 w-8 text-sm" : size === 5 ? "h-5 w-5 text-[10px]" : "h-6 w-6 text-xs";
  return (
    <span
      title={name}
      className={`inline-flex items-center justify-center rounded-full font-semibold text-white ${sizeCls} ${agentColor(slug)}`}
    >
      {initials}
    </span>
  );
}

// ── Pills de estado ─────────────────────────────────────────────────────────

export const STATUS_STYLES: Record<TaskStatus, string> = {
  BACKLOG: "bg-slate-200 text-slate-700",
  READY: "bg-sky-100 text-sky-800",
  IN_PROGRESS: "bg-amber-100 text-amber-800",
  BLOCKED: "bg-rose-100 text-rose-800",
  REVIEW: "bg-violet-100 text-violet-800",
  DONE: "bg-emerald-100 text-emerald-800",
  CANCELLED: "bg-slate-100 text-slate-400 line-through",
};

export function StatusPill({ status }: { status: TaskStatus }) {
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${STATUS_STYLES[status]}`}>
      {status}
    </span>
  );
}

export const PRIORITY_STYLES: Record<TaskPriority, string> = {
  low: "text-slate-400",
  normal: "text-slate-500",
  high: "text-orange-600",
  urgent: "text-rose-600",
};

export function PriorityDot({ priority }: { priority: TaskPriority }) {
  const label: Record<TaskPriority, string> = {
    low: "baja",
    normal: "normal",
    high: "alta",
    urgent: "urgente",
  };
  return (
    <span title={`Prioridad ${label[priority]}`} className={`text-[10px] font-bold ${PRIORITY_STYLES[priority]}`}>
      {priority === "urgent" ? "!!" : priority === "high" ? "!" : "·"}
    </span>
  );
}

export function RunStatusPill({ status }: { status: string }) {
  const cls =
    status === "succeeded"
      ? "bg-emerald-100 text-emerald-800"
      : status === "running"
        ? "bg-amber-100 text-amber-800"
        : status === "failed"
          ? "bg-rose-100 text-rose-800"
          : status === "queued"
            ? "bg-sky-100 text-sky-800"
            : "bg-slate-200 text-slate-600";
  return <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${cls}`}>{status}</span>;
}

// ── Vacíos y errores legibles ───────────────────────────────────────────────

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-slate-300 bg-white/60 p-8 text-center">
      <p className="text-sm font-medium text-slate-600">{title}</p>
      {hint ? <p className="text-xs text-slate-400">{hint}</p> : null}
    </div>
  );
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
      <p className="font-medium">Algo falló</p>
      <p className="mt-1 text-xs">{message}</p>
      {onRetry ? (
        <button
          onClick={onRetry}
          className="mt-2 rounded bg-rose-600 px-2 py-1 text-xs font-medium text-white hover:bg-rose-700"
        >
          Reintentar
        </button>
      ) : null}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 p-4 text-sm text-slate-500">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-slate-600" />
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
          className={`flex items-start justify-between gap-2 rounded-lg border p-3 text-sm shadow-lg ${
            t.kind === "error"
              ? "border-rose-200 bg-rose-50 text-rose-800"
              : t.kind === "ok"
                ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                : "border-sky-200 bg-sky-50 text-sky-800"
          }`}
        >
          <span className="break-words">{t.text}</span>
          <button onClick={() => dismiss(t.id)} className="text-xs opacity-60 hover:opacity-100">
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
  return new Date(ts).toLocaleString("es", { dateStyle: "short", timeStyle: "medium" });
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
