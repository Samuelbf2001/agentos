/**
 * Salud de la cadena de mando (Fase 2 — inspirado en Paperclip §modelo de empresa).
 *
 * El organigrama vive en `agents.reports_to` (self-FK nullable). Lo load-bearing
 * NO es dibujar el árbol, sino que **la salud de la cadena jerárquica gobierna la
 * asignabilidad**: un agente cuyo camino ascendente al tope tiene un ancestro
 * terminado (paused/disabled), un manager faltante o un ciclo NO puede recibir
 * ni ejecutar trabajo, aunque él mismo esté `active`. Terminar/pausar a un manager
 * invalida por CÁLCULO todo su subárbol; reactivarlo lo restaura sin tocar filas
 * (no cascada persistida — ver docs/nota-jerarquia-agentes.md).
 *
 * Módulo PURO respecto al reloj y sin efectos: solo lee agentes. La decisión de
 * bloquear se toma en el motor del tablero (`assertAgentCanRun`) y el despachador.
 *
 * §13.3: el DIAGNÓSTICO de salud (`computeChainHealthFrom`) se extrajo a
 * @agentos/shared (mismo patrón que `computeRequiresApproval`) porque el motor
 * de launch de @agentos/db lo necesita sin crear el ciclo db → core → db. Aquí
 * queda el wrapper con acceso a DB y el RE-export de tipos: la API no cambia.
 */
import { MAX_CHAIN_DEPTH, computeChainHealthFrom, errors } from "@agentos/shared";
import { getAgent, getAgentBySlug, listAgents, type Agent, type AgentosDb } from "@agentos/db";

export {
  MAX_CHAIN_DEPTH,
  computeChainHealthFrom,
  type ChainAgentRow,
  type OrgChainHealth,
  type OrgHealthStatus,
} from "@agentos/shared";
import type { OrgChainHealth } from "@agentos/shared";

export interface OrgNode {
  agent: Agent;
  reports: OrgNode[];
}

async function resolve(db: AgentosDb, ref: string): Promise<Agent> {
  const agent = (await getAgent(db, ref)) ?? (await getAgentBySlug(db, ref));
  if (!agent) throw errors.notFound("agent", ref);
  return agent;
}

/**
 * Cadena de mando ASCENDENTE: el agente en la posición 0, luego su manager, el
 * manager de su manager, … hasta la raíz. Se corta con seguridad ante un ciclo,
 * un manager faltante o el tope `MAX_CHAIN_DEPTH` (nunca lanza por esos casos:
 * devuelve lo recorrido; el diagnóstico fino lo da `computeOrgChainHealth`).
 */
export async function getChainOfCommand(db: AgentosDb, agentIdOrSlug: string): Promise<Agent[]> {
  const start = await resolve(db, agentIdOrSlug);
  const chain: Agent[] = [start];
  const seen = new Set<string>([start.id]);
  let current = start.reportsTo;
  while (current) {
    if (seen.has(current) || chain.length >= MAX_CHAIN_DEPTH) break;
    const mgr = await getAgent(db, current);
    if (!mgr) break;
    chain.push(mgr);
    seen.add(mgr.id);
    current = mgr.reportsTo;
  }
  return chain;
}

/**
 * Diagnóstico de la cadena de un agente. Considera SOLO a sus ancestros — el
 * estado propio del agente es un asunto aparte (lo cubre `assertAgentCanRun` con
 * su propio mensaje). Prioridad de fallo al subir: ciclo → manager faltante →
 * ancestro terminado; el primero que aparece manda.
 */
export async function computeOrgChainHealth(db: AgentosDb, agentIdOrSlug: string): Promise<OrgChainHealth> {
  const start = await resolve(db, agentIdOrSlug);
  // El núcleo puro vive en @agentos/shared (§13.3) y su getById es SÍNCRONO:
  // materializamos el mapa de agentes antes de invocarlo.
  const all = await listAgents(db);
  const byId = new Map(all.map((a) => [a.id, a] as const));
  return computeChainHealthFrom(start, (id) => byId.get(id));
}

/**
 * ¿Asignar `newManager` como manager de `agent` cerraría un ciclo? Sube desde el
 * manager propuesto hasta la raíz; si reaparece el agente (o el manager es el
 * propio agente), habría ciclo. `null` = hacerse raíz, jamás crea ciclo.
 */
export async function wouldCreateCycle(
  db: AgentosDb,
  agentIdOrSlug: string,
  newManagerIdOrSlug: string | null,
): Promise<boolean> {
  if (newManagerIdOrSlug == null) return false;
  const agent = await resolve(db, agentIdOrSlug);
  const manager = await resolve(db, newManagerIdOrSlug);
  if (manager.id === agent.id) return true;
  const seen = new Set<string>();
  let current: string | null = manager.id;
  while (current) {
    if (current === agent.id || seen.has(current)) return true;
    seen.add(current);
    current = (await getAgent(db, current))?.reportsTo ?? null;
  }
  return false;
}

/** Igual que `wouldCreateCycle` pero lanza `agent_not_assignable` (reason=cycle). */
export async function assertNoCycle(
  db: AgentosDb,
  agentIdOrSlug: string,
  newManagerIdOrSlug: string | null,
): Promise<void> {
  if (await wouldCreateCycle(db, agentIdOrSlug, newManagerIdOrSlug)) {
    const agent = await resolve(db, agentIdOrSlug);
    throw errors.notAssignable(agent.slug, "cycle", {
      agentId: agent.id,
      proposedManager: newManagerIdOrSlug,
    });
  }
}

/**
 * Organigrama de la "empresa" como bosque agrupado por manager: un `OrgNode` por
 * raíz (reports_to null o manager faltante), con sus reports anidados y ordenados
 * por slug. A prueba de ciclos: cada agente aparece exactamente una vez; un agente
 * atrapado solo en un ciclo (sin raíz alcanzable) se emite como raíz de rescate.
 */
export async function orgForCompany(db: AgentosDb): Promise<OrgNode[]> {
  const all = await listAgents(db);
  const byId = new Map(all.map((a) => [a.id, a] as const));
  const childrenOf = new Map<string, Agent[]>();
  const roots: Agent[] = [];
  for (const a of all) {
    const mgrId = a.reportsTo;
    if (mgrId && byId.has(mgrId)) {
      const arr = childrenOf.get(mgrId) ?? [];
      arr.push(a);
      childrenOf.set(mgrId, arr);
    } else {
      roots.push(a); // raíz legítima o huérfano (manager inexistente)
    }
  }
  const bySlug = (a: Agent, b: Agent): number => a.slug.localeCompare(b.slug);
  const seen = new Set<string>();
  const build = (agent: Agent): OrgNode => {
    seen.add(agent.id);
    const reports = (childrenOf.get(agent.id) ?? [])
      .filter((k) => !seen.has(k.id))
      .sort(bySlug)
      .map(build);
    return { agent, reports };
  };
  const nodes = roots.sort(bySlug).map(build);
  // Rescate: agentes solo alcanzables dentro de un ciclo se emiten como raíces.
  for (const a of all.sort(bySlug)) {
    if (!seen.has(a.id)) nodes.push(build(a));
  }
  return nodes;
}
