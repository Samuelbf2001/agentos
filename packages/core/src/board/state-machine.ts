/**
 * Máquina de estados del tablero — 7 estados (ARCHITECTURE §6) con la matriz
 * EXACTA de permisos por actor de proposal-opus §2.6:
 *
 * | Transición                    | Agente                              | Humano | Sistema |
 * |-------------------------------|-------------------------------------|--------|---------|
 * | BACKLOG → READY               | solo orquestador, con DoD + dueño   | Sí     | No      |
 * | READY → BACKLOG (despriorizar)| No                                  | Sí     | No      |
 * | READY → IN_PROGRESS           | solo vía tasks.claim                | Sí     | Sí (despachador vía claim) |
 * | IN_PROGRESS → BLOCKED         | Sí                                  | Sí     | Sí (reaper 'stuck') |
 * | BLOCKED → READY               | Sí                                  | Sí     | Sí (aprobación resuelta) |
 * | IN_PROGRESS → REVIEW          | Sí, exige ≥1 artefacto              | Sí     | No      |
 * | IN_PROGRESS → DONE            | solo si !requires_approval + artef. | Sí     | No      |
 * | IN_PROGRESS → READY           | No                                  | No     | Sí (reaper / run cancelado) |
 * | REVIEW → DONE                 | NUNCA                               | Sí     | No      |
 * | REVIEW → IN_PROGRESS (rechazo)| No                                  | Sí, nota obligatoria | No |
 * | cualquiera → CANCELLED        | No                                  | Sí     | No      |
 *
 * Fail-closed: lo que no está en la matriz está prohibido.
 */
import { AgentosError, ErrorCodes, type TaskStatus } from "@agentos/shared";

export type ActorKind = "agent" | "human" | "system";

/** `agent:<slug>` → agent, `person:<id>` → human, `system:<comp>` → system. */
export function actorKind(actor: string): ActorKind {
  if (actor.startsWith("agent:")) return "agent";
  if (actor.startsWith("person:")) return "human";
  if (actor.startsWith("system:")) return "system";
  throw new AgentosError(
    ErrorCodes.VALIDATION_ERROR,
    `actor inválido: "${actor}" (esperado agent:|person:|system:<ref>)`,
  );
}

export function actorRef(actor: string): string {
  return actor.slice(actor.indexOf(":") + 1);
}

const TERMINAL: readonly TaskStatus[] = ["DONE", "CANCELLED"];

export function isTerminal(status: TaskStatus): boolean {
  return TERMINAL.includes(status);
}

/** Transiciones permitidas por actor. `CANCELLED` se trata aparte (cualquiera→). */
const MATRIX: Record<ActorKind, readonly `${TaskStatus}>${TaskStatus}`[]> = {
  agent: [
    "BACKLOG>READY", // solo orquestador (guard extra en el motor)
    "READY>IN_PROGRESS", // solo vía tasks.claim (guard extra en el motor)
    "IN_PROGRESS>BLOCKED",
    "BLOCKED>READY",
    "IN_PROGRESS>REVIEW",
    "IN_PROGRESS>DONE", // solo si !requires_approval (guard extra en el motor)
  ],
  human: [
    "BACKLOG>READY",
    "READY>BACKLOG", // despriorizar (CA-2.4, fix H7): solo el humano saca de la cola
    "READY>IN_PROGRESS",
    "IN_PROGRESS>BLOCKED",
    "BLOCKED>READY",
    "IN_PROGRESS>REVIEW",
    "IN_PROGRESS>DONE",
    "REVIEW>DONE",
    "REVIEW>IN_PROGRESS",
  ],
  system: [
    "READY>IN_PROGRESS", // despachador (vía claim)
    "IN_PROGRESS>BLOCKED", // reaper: attempts >= max → 'stuck'
    "IN_PROGRESS>READY", // reaper: lease vencido / run cancelado
    "BLOCKED>READY", // aprobación resuelta → reanudar
  ],
};

/**
 * ¿Puede este tipo de actor hacer from→to?
 * No mira guards de contenido (DoD, artefactos, gates) — eso es del motor.
 */
export function isTransitionAllowed(kind: ActorKind, from: TaskStatus, to: TaskStatus): boolean {
  if (from === to) return false;
  if (isTerminal(from)) return false; // DONE/CANCELLED no se reabren en MVP
  if (to === "CANCELLED") return kind === "human"; // cualquiera→CANCELLED solo humano
  return MATRIX[kind].includes(`${from}>${to}`);
}

export function assertTransitionAllowed(kind: ActorKind, from: TaskStatus, to: TaskStatus): void {
  if (!isTransitionAllowed(kind, from, to)) {
    throw new AgentosError(
      ErrorCodes.INVALID_TRANSITION,
      `Transición ${from}→${to} no permitida para actor de tipo "${kind}"`,
      { from, to, actorKind: kind },
    );
  }
}
