/**
 * Política determinista de `requires_approval` (ARCHITECTURE §6, PRD constitución 2):
 * se calcula AL CREAR la tarea y un agente no puede rebajarla — solo subirla.
 *
 * `requires_approval = true` si:
 *  1. la tarea tiene efecto externo (`external_effect`),
 *  2. es entregable de fase (informe de assessment, roadmap, propuesta), o
 *  3. su `activity_type` está en la lista de actividades sensibles.
 */

/** Entregables de fase: siempre pasan por gate humano (Gate 1 / revisión). */
export const PHASE_DELIVERABLE_ACTIVITY_TYPES: readonly string[] = [
  "assessment_report",
  "informe_assessment",
  "roadmap",
  "proposal",
  "propuesta",
  "phase_deliverable",
  "entregable_fase",
];

/** Actividades sensibles: aunque no salgan de la máquina, las revisa un humano. */
export const SENSITIVE_ACTIVITY_TYPES: readonly string[] = [
  "deploy",
  "payment",
  "pago",
  "credentials",
  "credenciales",
  "data_deletion",
  "borrado_datos",
  "external_communication",
  "comunicacion_externa",
  "email_send",
  "contract",
  "contrato",
];

export interface RequiresApprovalInput {
  externalEffect?: boolean | null;
  activityType?: string | null;
}

/** Política pura y determinista. Misma entrada → misma salida, sin reloj ni DB. */
export function computeRequiresApproval(task: RequiresApprovalInput): boolean {
  if (task.externalEffect === true) return true;
  const at = task.activityType?.trim().toLowerCase();
  if (!at) return false;
  return PHASE_DELIVERABLE_ACTIVITY_TYPES.includes(at) || SENSITIVE_ACTIVITY_TYPES.includes(at);
}
