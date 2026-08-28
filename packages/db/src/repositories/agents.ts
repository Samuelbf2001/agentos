import { desc, eq, sql } from "drizzle-orm";
import { errors, newId, nowMs } from "@agentos/shared";
import type { AgentosDb } from "../client.js";
import { agents, promptVersions } from "../schema.js";
import type { Agent, NewAgent, NewPromptVersion, PromptVersion } from "../types.js";

// ── Agentes ─────────────────────────────────────────────────────────────────

export function createAgent(
  db: AgentosDb,
  input: Omit<NewAgent, "id" | "createdAt" | "updatedAt" | "version"> & { id?: string },
): Agent {
  const now = nowMs();
  const row: NewAgent = { ...input, id: input.id ?? newId(), createdAt: now, updatedAt: now };
  db.insert(agents).values(row).run();
  return getAgent(db, row.id!)!;
}

export function getAgent(db: AgentosDb, id: string): Agent | undefined {
  return db.select().from(agents).where(eq(agents.id, id)).get();
}

export function getAgentBySlug(db: AgentosDb, slug: string): Agent | undefined {
  return db.select().from(agents).where(eq(agents.slug, slug)).get();
}

export function listAgents(db: AgentosDb): Agent[] {
  return db.select().from(agents).all();
}

/** Actualización con optimistic locking (columna `version` de ARCHITECTURE §5). */
export function updateAgent(
  db: AgentosDb,
  id: string,
  patch: Partial<Omit<Agent, "id" | "createdAt" | "version">>,
  expectedVersion: number,
): Agent {
  const res = db
    .update(agents)
    .set({ ...patch, updatedAt: nowMs(), version: sql`${agents.version} + 1` })
    .where(sql`${agents.id} = ${id} AND ${agents.version} = ${expectedVersion}`)
    .run();
  if (res.changes === 0) {
    if (!getAgent(db, id)) throw errors.notFound("agent", id);
    throw errors.versionConflict("agent", id, expectedVersion);
  }
  return getAgent(db, id)!;
}

/**
 * Upsert por slug desde los seeds `agents/*.md`. La DB es la fuente de verdad en
 * ejecución; `seed_hash` delata divergencia (ARCHITECTURE §8). Si el hash del seed
 * no cambió, no toca la fila (respeta ediciones en caliente).
 */
export function upsertAgentFromSeed(
  db: AgentosDb,
  input: Omit<NewAgent, "id" | "createdAt" | "updatedAt" | "version">,
): { agent: Agent; created: boolean; seedChanged: boolean } {
  const existing = getAgentBySlug(db, input.slug);
  if (!existing) {
    return { agent: createAgent(db, input), created: true, seedChanged: false };
  }
  if (existing.seedHash === input.seedHash) {
    return { agent: existing, created: false, seedChanged: false };
  }
  const agent = updateAgent(db, existing.id, { ...input }, existing.version);
  return { agent, created: false, seedChanged: true };
}

// ── Versiones de prompt (editar crea versión, nunca sobrescribe) ────────────

export function createPromptVersion(
  db: AgentosDb,
  input: Omit<NewPromptVersion, "id" | "createdAt" | "version"> & {
    id?: string;
    activate?: boolean;
  },
): PromptVersion {
  const { activate, ...rest } = input;
  const agent = getAgent(db, input.agentId);
  if (!agent) throw errors.notFound("agent", input.agentId);

  const last = db
    .select({ v: sql<number>`coalesce(max(${promptVersions.version}), 0)` })
    .from(promptVersions)
    .where(eq(promptVersions.agentId, input.agentId))
    .get();
  const row: NewPromptVersion = {
    ...rest,
    id: input.id ?? newId(),
    version: (last?.v ?? 0) + 1,
    createdAt: nowMs(),
  };
  db.insert(promptVersions).values(row).run();
  if (activate !== false) {
    updateAgent(db, agent.id, { activePromptVersionId: row.id! }, agent.version);
  }
  return getPromptVersion(db, row.id!)!;
}

export function getPromptVersion(db: AgentosDb, id: string): PromptVersion | undefined {
  return db.select().from(promptVersions).where(eq(promptVersions.id, id)).get();
}

export function getActivePrompt(db: AgentosDb, agentId: string): PromptVersion | undefined {
  const agent = getAgent(db, agentId);
  if (!agent?.activePromptVersionId) return undefined;
  return getPromptVersion(db, agent.activePromptVersionId);
}

export function listPromptVersions(db: AgentosDb, agentId: string): PromptVersion[] {
  return db
    .select()
    .from(promptVersions)
    .where(eq(promptVersions.agentId, agentId))
    .orderBy(desc(promptVersions.version))
    .all();
}

/** Rollback = activar una versión anterior (jamás se borra ni sobrescribe). */
export function activatePromptVersion(db: AgentosDb, agentId: string, versionId: string): Agent {
  const agent = getAgent(db, agentId);
  if (!agent) throw errors.notFound("agent", agentId);
  const pv = getPromptVersion(db, versionId);
  if (!pv || pv.agentId !== agentId) throw errors.notFound("prompt_version", versionId);
  return updateAgent(db, agentId, { activePromptVersionId: versionId }, agent.version);
}
