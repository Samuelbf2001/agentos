/**
 * Política determinista de `requires_approval` — MUDADA a @agentos/shared
 * (ARCHITECTURE §13.3): es pura (cero imports) y el motor de launch de
 * @agentos/db la necesita sin crear el ciclo db → core → db.
 *
 * Este archivo queda como re-export para que el barrel de core no cambie su
 * API: `apps/api` y los tests siguen importando desde @agentos/core.
 */
export {
  PHASE_DELIVERABLE_ACTIVITY_TYPES,
  SENSITIVE_ACTIVITY_TYPES,
  QUINN_REVIEWED_ACTIVITY_TYPES,
  computeRequiresApproval,
  type RequiresApprovalInput,
} from "@agentos/shared";
