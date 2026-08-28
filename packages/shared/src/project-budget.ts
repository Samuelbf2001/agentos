/**
 * Presupuesto de fase por proyecto (§13.4): el launch lo declara en
 * `app_config['budget:project:<projectId>']` y lo consumen el despachador
 * (tope efectivo por run + corte de fase), el MCP admin (config.set con shape
 * validado, system.health) y la UI. Piezas puras — sin DB.
 */

export const PROJECT_BUDGET_KEY_PREFIX = "budget:project:";

export function projectBudgetKey(projectId: string): string {
  return `${PROJECT_BUDGET_KEY_PREFIX}${projectId}`;
}

/** `budget:project:<id>` → `<id>`, o null si la clave no tiene esa forma. */
export function projectIdFromBudgetKey(key: string): string | null {
  if (!key.startsWith(PROJECT_BUDGET_KEY_PREFIX)) return null;
  const id = key.slice(PROJECT_BUDGET_KEY_PREFIX.length);
  return id.trim() === "" ? null : id;
}

export const DEFAULT_BUDGET_WARNING_THRESHOLDS_PCT = [70, 90, 100];

export interface ProjectBudget {
  /** Tope de gasto de la FASE (suma de cost_usd de los runs del proyecto). */
  phaseUsd?: number;
  /** Tope por run del proyecto (se combina con agents.limits por `min`). */
  perRunUsd?: number;
  warningThresholdsPct: number[];
  launchId: string | null;
}

function positiveNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
}

/**
 * Parse TOLERANTE del valor guardado (el humano puede editarlo por MCP):
 * null si no es un objeto; los campos inválidos se descartan campo a campo —
 * un tope corrupto jamás se aplica como número mágico.
 */
export function parseProjectBudget(value: unknown): ProjectBudget | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const thresholds = Array.isArray(raw["warning_thresholds_pct"])
    ? (raw["warning_thresholds_pct"] as unknown[]).filter(
        (t): t is number => typeof t === "number" && Number.isFinite(t) && t > 0 && t <= 100,
      )
    : undefined;
  const budget: ProjectBudget = {
    warningThresholdsPct:
      thresholds && thresholds.length > 0 ? thresholds : [...DEFAULT_BUDGET_WARNING_THRESHOLDS_PCT],
    launchId: typeof raw["launch_id"] === "string" ? (raw["launch_id"] as string) : null,
  };
  const phaseUsd = positiveNumber(raw["phase_usd"]);
  const perRunUsd = positiveNumber(raw["per_run_usd"]);
  if (phaseUsd !== undefined) budget.phaseUsd = phaseUsd;
  if (perRunUsd !== undefined) budget.perRunUsd = perRunUsd;
  return budget;
}
