/**
 * Componentes de estado del sistema (PLAN-v1.5 §Sistema visual).
 *
 * "Cada estado tiene un componente y se reutiliza en todas partes": la fase
 * siempre en el mismo punto, el gate como candado (cerrado con su lista,
 * abierto que ES un botón, o aprobado con quién y cuándo), el agente trabajando
 * como punto que late, y el atraso con un solo patrón en todo el producto.
 */
import type { ReactNode } from "react";
import { STAGES, type Stage } from "../lib/types";

// ── Piezas base ─────────────────────────────────────────────────────────────

export type Tone = "work" | "decide" | "broken" | "done" | "quiet" | "link";

const CHIP_TONES: Record<Tone, string> = {
  work: "bg-work-bg text-work border-work-line",
  decide: "bg-decide-bg text-decide border-decide-line",
  broken: "bg-broken-bg text-broken border-broken-line",
  done: "bg-done-bg text-done border-done-line",
  quiet: "bg-transparent text-muted border-line",
  link: "bg-link-bg text-link border-transparent",
};

export function Chip({
  tone = "quiet",
  children,
  title,
  className = "",
}: {
  tone?: Tone;
  children: ReactNode;
  title?: string;
  className?: string;
}) {
  return (
    <span
      title={title}
      data-tone={tone}
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-[6px] border px-2 py-0.5 text-label font-semibold uppercase ${CHIP_TONES[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

export function Card({
  children,
  className = "",
  as: As = "div",
  "data-testid": testId,
}: {
  children: ReactNode;
  className?: string;
  as?: "div" | "section" | "article";
  "data-testid"?: string;
}) {
  return (
    <As
      data-testid={testId}
      className={`rounded-panel border border-line-soft bg-surface shadow-rest ${className}`}
    >
      {children}
    </As>
  );
}

export function SectionHead({ label, count, hint }: { label: string; count?: number; hint?: string }) {
  return (
    <div className="mb-3 mt-7 flex items-baseline gap-2.5 first:mt-0">
      <h2 className="text-label uppercase text-muted">{label}</h2>
      {count !== undefined ? (
        <span className="rounded-full bg-canvas-deep px-1.5 py-px text-label font-semibold tabular-nums text-muted">
          {count}
        </span>
      ) : null}
      {hint ? <span className="text-small text-faint">{hint}</span> : null}
    </div>
  );
}

export function Stat({ value, label, tone }: { value: ReactNode; label: string; tone?: Tone }) {
  const color = tone === "broken" ? "text-broken" : tone === "work" ? "text-work" : "text-ink";
  return (
    <Card className="px-4 py-3">
      <p className={`text-display tabular-nums ${color}`}>{value}</p>
      <p className="mt-0.5 text-small text-muted">{label}</p>
    </Card>
  );
}

/** Botón con la respuesta al pulsar (scale .97 en 100 ms), no al soltar. */
export function ActionButton({
  children,
  onClick,
  variant = "quiet",
  disabled,
  type = "button",
  title,
  className = "",
  "data-testid": testId,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "quiet" | "primary" | "gate" | "danger";
  disabled?: boolean;
  type?: "button" | "submit";
  title?: string;
  className?: string;
  "data-testid"?: string;
}) {
  const variants: Record<string, string> = {
    quiet: "border-line bg-surface text-ink hover:bg-surface-2 shadow-rest",
    primary: "border-transparent bg-ink text-canvas hover:opacity-90 shadow-rest",
    gate: "border-work-line bg-work-bg text-work hover:bg-work-bg shadow-rest",
    danger: "border-broken-line bg-surface text-broken hover:bg-broken-bg shadow-rest",
  };
  return (
    <button
      type={type}
      title={title}
      disabled={disabled}
      data-testid={testId}
      onClick={onClick}
      className={`press inline-flex min-h-9 items-center justify-center gap-1.5 rounded-[9px] border px-3.5 py-1.5 text-small font-semibold disabled:cursor-not-allowed disabled:opacity-45 disabled:shadow-none ${variants[variant]} ${className}`}
    >
      {children}
    </button>
  );
}

// ── Agente trabajando: late el punto, nunca el contenedor ───────────────────

export function WorkingDot({ label, title }: { label?: string; title?: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-small text-muted" title={title}>
      <span className="pip" aria-hidden="true" />
      {label ? <span>{label}</span> : <span className="sr-only">trabajando ahora</span>}
    </span>
  );
}

// ── Atraso: un solo patrón (barra roja a la izquierda + días) ───────────────

/** Días completos de atraso; 0 cuando aún no vence. */
export function overdueDays(dueAt: number | null | undefined, now = Date.now()): number {
  if (!dueAt || dueAt >= now) return 0;
  return Math.max(1, Math.floor((now - dueAt) / 86_400_000));
}

export function lateLabel(days: number): string {
  if (days <= 0) return "";
  return days === 1 ? "1 día" : `${days} días`;
}

/** Marca de atraso. Se usa SIEMPRE junto a la clase `late` del contenedor. */
export function LateChip({ days }: { days: number }) {
  if (days <= 0) return null;
  return (
    <Chip tone="broken" title={`Vencida hace ${lateLabel(days)}`}>
      {lateLabel(days)}
    </Chip>
  );
}

// ── Fase del proyecto: siempre el mismo punto ───────────────────────────────

export const STAGE_LABELS: Record<Stage, string> = {
  ENTENDER: "Entender",
  CONSTRUIR: "Construir",
  OPERAR: "Operar",
};

export function PhaseChip({ stage, className = "" }: { stage: Stage; className?: string }) {
  const index = STAGES.indexOf(stage);
  return (
    <span
      className={`inline-flex items-center gap-2 ${className}`}
      title={`Fase ${STAGE_LABELS[stage]}`}
      data-stage={stage}
    >
      <span className="inline-flex items-center gap-[3px]" aria-hidden="true">
        {STAGES.map((_, i) => (
          <i
            key={i}
            className={`block h-1 w-4 rounded-[2px] ${
              i < index ? "bg-ink-2" : i === index ? "bg-work" : "bg-line"
            }`}
          />
        ))}
      </span>
      <span className="text-small font-semibold text-ink-2">{STAGE_LABELS[stage]}</span>
    </span>
  );
}

// ── El gate: el motor del avance ────────────────────────────────────────────

export type GateState = "locked" | "ready" | "passed";

function LockIcon({ state }: { state: GateState }) {
  const stroke =
    state === "passed" ? "var(--color-done)" : state === "ready" ? "var(--color-work)" : "var(--color-faint)";
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true">
      {state === "locked" ? (
        <path d="M7.4 9.5V6.8a3.6 3.6 0 1 1 7.2 0v2.7" stroke={stroke} strokeWidth="1.6" strokeLinecap="round" />
      ) : (
        <path d="M7 9.5V6.8a4 4 0 0 1 7.7-1.5" stroke={stroke} strokeWidth="1.6" strokeLinecap="round" />
      )}
      <rect x="5" y="9.5" width="12" height="8.5" rx="2.4" stroke={stroke} strokeWidth="1.6" />
    </svg>
  );
}

export interface GateMissing {
  key: string;
  text: string;
  onClick?: () => void;
  hint?: string;
}

/**
 * Tres estados legibles y nada más: cerrado con la lista de qué falta, listo
 * para aprobar como ACCIÓN (el candado es el botón), y aprobado con quién y
 * cuándo.
 */
export function GateLock({
  code,
  state,
  caption,
  missing = [],
  onApprove,
  busy = false,
  approveLabel = "Aprobar",
}: {
  code: string;
  state: GateState;
  caption?: string;
  missing?: GateMissing[];
  onApprove?: () => void;
  busy?: boolean;
  approveLabel?: string;
}) {
  const tone = state === "passed" ? "text-done" : state === "ready" ? "text-work" : "text-muted";
  const frame =
    state === "passed"
      ? "border-solid border-done-line bg-done-bg"
      : state === "ready"
        ? "border-solid border-work-line bg-work-bg shadow-raise"
        : "border-dashed border-line bg-surface";
  return (
    <div
      data-testid={`gate-${code}`}
      data-gate-state={state}
      className={`flex w-full flex-col items-center gap-2 rounded-soft border px-3 py-3 text-center ${frame}`}
    >
      <LockIcon state={state} />
      <span className={`text-label uppercase ${tone}`}>{code}</span>
      {state === "ready" && onApprove ? (
        <button
          type="button"
          disabled={busy}
          onClick={onApprove}
          data-testid={`gate-approve-${code}`}
          className="press rounded-[7px] bg-work px-3 py-1.5 text-label font-semibold uppercase text-surface disabled:opacity-50"
        >
          {busy ? "Aprobando…" : approveLabel}
        </button>
      ) : null}
      {caption ? <span className={`text-small leading-snug ${tone}`}>{caption}</span> : null}
      {state === "locked" && missing.length > 0 ? (
        <ul className="mt-1 w-full space-y-1.5 text-left">
          {missing.map((item) =>
            item.onClick ? (
              <li key={item.key}>
                <button
                  type="button"
                  onClick={item.onClick}
                  data-testid={`gate-missing-${item.key}`}
                  className="press flex w-full items-center gap-2 rounded-tight border border-line-soft bg-surface px-2.5 py-1.5 text-left text-small text-ink-2 hover:border-line"
                >
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-broken" aria-hidden="true" />
                  <span className="min-w-0 flex-1">{item.text}</span>
                </button>
              </li>
            ) : (
              <li
                key={item.key}
                className="flex items-center gap-2 rounded-tight border border-line-soft bg-surface px-2.5 py-1.5 text-small text-ink-2"
              >
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-broken" aria-hidden="true" />
                <span className="min-w-0 flex-1">{item.text}</span>
              </li>
            ),
          )}
        </ul>
      ) : null}
    </div>
  );
}
