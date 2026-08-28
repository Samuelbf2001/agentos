/**
 * Salud de la cadena de mando — NÚCLEO PURO (ARCHITECTURE §13.3, mismo patrón
 * que `computeRequiresApproval`): extraído de packages/core/src/org.ts para que
 * el motor de launch de @agentos/db pueda decidir asignabilidad sin crear el
 * ciclo db → core → db. Core conserva el wrapper con acceso a DB
 * (`computeOrgChainHealth`) y RE-exporta estos tipos — su API no cambia.
 *
 * La regla (Fase 2, docs/nota-jerarquia-agentes.md): un agente cuyo camino
 * ascendente al tope tiene un ancestro terminado (paused/disabled), un manager
 * faltante o un ciclo NO puede recibir ni ejecutar trabajo, aunque él mismo
 * esté `active`. Sin reloj, sin DB: la resolución de filas entra por parámetro.
 */

/** Tope anti-ciclo: ninguna cadena legítima del roster se acerca a esto. */
export const MAX_CHAIN_DEPTH = 64;

export type OrgHealthStatus = "healthy" | "terminated_ancestor" | "missing_manager" | "cycle";

export interface OrgChainHealth {
  status: OrgHealthStatus;
  /**
   * Nodo que rompe la cadena: id del ancestro terminado, del manager faltante
   * (id que nadie satisface) o del agente donde se cierra el ciclo. `undefined`
   * cuando `status === "healthy"`.
   */
  offendingAgentId?: string;
}

/** Mínimo de una fila de `agents` que la salud de cadena necesita. */
export interface ChainAgentRow {
  id: string;
  status: string;
  reportsTo: string | null;
}

/**
 * Diagnóstico PURO de la cadena de un agente. Considera SOLO a sus ancestros —
 * el estado propio del agente es un asunto aparte (lo cubren `assertAgentCanRun`
 * en core y la resolución de asignaciones del launch, cada uno con su mensaje).
 * Prioridad de fallo al subir: ciclo → manager faltante → ancestro terminado;
 * el primero que aparece manda.
 */
export function computeChainHealthFrom(
  start: ChainAgentRow,
  getById: (id: string) => ChainAgentRow | undefined,
): OrgChainHealth {
  const seen = new Set<string>([start.id]);
  let current = start.reportsTo;
  let depth = 0;
  while (current) {
    if (seen.has(current) || ++depth > MAX_CHAIN_DEPTH) {
      return { status: "cycle", offendingAgentId: current };
    }
    const mgr = getById(current);
    if (!mgr) return { status: "missing_manager", offendingAgentId: current };
    if (mgr.status !== "active") return { status: "terminated_ancestor", offendingAgentId: mgr.id };
    seen.add(mgr.id);
    current = mgr.reportsTo;
  }
  return { status: "healthy" };
}
