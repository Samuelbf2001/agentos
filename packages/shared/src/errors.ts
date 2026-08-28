/**
 * Errores de dominio de AgentOS.
 * Códigos estables usados por API, tools y MCP (los nombres salen de PRD/ARCHITECTURE:
 * `gate_not_passed`, `missing_artifact`, `human_approval_required`, `pending_approval`, ...).
 */

export const ErrorCodes = {
  // Genéricos
  NOT_FOUND: "not_found",
  VALIDATION_ERROR: "validation_error",
  CONFLICT: "conflict",
  // Concurrencia / integridad
  VERSION_CONFLICT: "version_conflict",
  CLAIM_LOST: "claim_lost",
  IDEMPOTENCY_CONFLICT: "idempotency_conflict",
  // Máquina de estados / gates
  INVALID_TRANSITION: "invalid_transition",
  GATE_NOT_PASSED: "gate_not_passed",
  MISSING_ARTIFACT: "missing_artifact",
  HUMAN_APPROVAL_REQUIRED: "human_approval_required",
  PENDING_APPROVAL: "pending_approval",
  APPROVAL_INVALIDATED: "approval_invalidated",
  // Política / gobierno
  POLICY_DENIED: "policy_denied",
  KILL_SWITCH_ACTIVE: "kill_switch_active",
  BUDGET_EXCEEDED: "budget_exceeded",
  DELEGATION_LIMIT: "delegation_limit",
  /** Cadena de mando rota (Fase 2): ancestro terminado, manager faltante o ciclo. */
  AGENT_NOT_ASSIGNABLE: "agent_not_assignable",
  /** Módulos de fase (§13): mismo (slug,version) con contenido distinto exige subir versión. */
  MODULE_VERSION_IMMUTABLE: "module_version_immutable",
  /** Módulos de fase (§13.5): solo un módulo `active` puede dispararse (NM-4). */
  MODULE_NOT_ACTIVE: "module_not_active",
  // Proveedores / runtime
  PROVIDER_ERROR: "provider_error",
  PROVIDER_NOT_CONFIGURED: "provider_not_configured",
  RUNNER_UNAVAILABLE: "runner_unavailable",
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

/** Error de dominio con código estable. Fail-closed: sin código conocido no hay flujo especial. */
export class AgentosError extends Error {
  readonly code: ErrorCode;
  readonly details: unknown;

  constructor(code: ErrorCode, message?: string, details?: unknown) {
    super(message ?? code);
    this.name = "AgentosError";
    this.code = code;
    this.details = details;
  }
}

export function isAgentosError(err: unknown, code?: ErrorCode): err is AgentosError {
  if (!(err instanceof AgentosError)) return false;
  return code === undefined || err.code === code;
}

/** Azúcar para los errores más comunes. */
export const errors = {
  notFound: (entity: string, id: string) =>
    new AgentosError(ErrorCodes.NOT_FOUND, `${entity} no encontrado: ${id}`, { entity, id }),
  versionConflict: (entity: string, id: string, expected: number) =>
    new AgentosError(
      ErrorCodes.VERSION_CONFLICT,
      `Conflicto de versión en ${entity} ${id} (expected_version=${expected}); relee y reintenta`,
      { entity, id, expected },
    ),
  validation: (message: string, details?: unknown) =>
    new AgentosError(ErrorCodes.VALIDATION_ERROR, message, details),
  /** Cadena de mando rota: la razón (`terminated_ancestor` | `missing_manager` | `cycle`) viaja en details. */
  notAssignable: (agent: string, reason: string, details?: Record<string, unknown>) =>
    new AgentosError(
      ErrorCodes.AGENT_NOT_ASSIGNABLE,
      `El agente ${agent} no es asignable: cadena de mando rota (${reason})`,
      { agent, reason, ...details },
    ),
};
