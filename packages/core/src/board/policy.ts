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

/**
 * FUENTE ÚNICA de los entregables que Quinn audita (US-10) y que, por tanto,
 * exigen gate humano: no pueden ir directo a DONE por un agente (fix Q1).
 *
 * Esta constante se usa en DOS sitios que antes estaban desincronizados:
 *  1. `computeRequiresApproval` (abajo) → fuerza `requires_approval` ⇒ el agente
 *     debe pasar por REVIEW y el cierre lo hace un humano.
 *  2. la auto-crítica de Quinn del despachador (`DEFAULT_QUINN_ACTIVITY_TYPES`
 *     en apps/api) → Quinn se dispara al entrar a REVIEW.
 *
 * Regla: todo entregable que Quinn revisa exige REVIEW + aprobación. Cambiar la
 * lista en un solo lugar mantiene ambos caminos alineados por construcción.
 * Incluye los entregables de consultoría (org_profile, process_map,
 * leak_analysis, iso_gap, report, roadmap) y el trabajo técnico que Quinn
 * critica (code, build, bug, integration, deploy, dev, technical).
 */
export const QUINN_REVIEWED_ACTIVITY_TYPES: readonly string[] = [
  // Trabajo técnico (crítica adversaria de Quinn)
  "code",
  "build",
  "bug",
  "integration",
  "deploy",
  "dev",
  "technical",
  // Entregables de consultoría (el caso principal de US-10)
  "report",
  "process_map",
  "roadmap",
  "iso_gap",
  "org_profile",
  "leak_analysis",
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
  return (
    PHASE_DELIVERABLE_ACTIVITY_TYPES.includes(at) ||
    SENSITIVE_ACTIVITY_TYPES.includes(at) ||
    QUINN_REVIEWED_ACTIVITY_TYPES.includes(at)
  );
}
