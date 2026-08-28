/** Espejo Postgres de src/repositories/agents.ts — misma superficie, asíncrona (§NFR-9). */
import { desc, eq, sql } from "drizzle-orm";
import { errors, newId, nowMs } from "@agentos/shared";
import type { AgentosPgDb } from "../client-pg.js";
import { agents, promptVersions } from "../schema-pg.js";
import type { Agent, NewAgent, NewPromptVersion, PromptVersion } from "../types-pg.js";

// ── Agentes ─────────────────────────────────────────────────────────────────

export async function createAgent(
  db: AgentosPgDb,
  input: Omit<NewAgent, "id" | "createdAt" | "updatedAt" | "version"> & { id?: string },
): Promise<Agent> {
  const now = nowMs();
  const row: NewAgent = { ...input, id: input.id ?? newId(), createdAt: now, updatedAt: now };
  await db.insert(agents).values(row);
  return (await getAgent(db, row.id!))!;
}

export async function getAgent(db: AgentosPgDb, id: string): Promise<Agent | undefined> {
  const [row] = await db.select().from(agents).where(eq(agents.id, id)).limit(1);
  return row;
}

export async function getAgentBySlug(db: AgentosPgDb, slug: string): Promise<Agent | undefined> {
  const [row] = await db.select().from(agents).where(eq(agents.slug, slug)).limit(1);
  return row;
}

export async function listAgents(db: AgentosPgDb): Promise<Agent[]> {
  return await db.select().from(agents);
}

/** Actualización con optimistic locking (columna `version` de ARCHITECTURE §5). */
export async function updateAgent(
  db: AgentosPgDb,
  id: string,
  patch: Partial<Omit<Agent, "id" | "createdAt" | "version">>,
  expectedVersion: number,
): Promise<Agent> {
  const rows = await db
    .update(agents)
    .set({ ...patch, updatedAt: nowMs(), version: sql`${agents.version} + 1` })
    .where(sql`${agents.id} = ${id} AND ${agents.version} = ${expectedVersion}`)
    .returning({ id: agents.id });
  if (rows.length === 0) {
    if (!(await getAgent(db, id))) throw errors.notFound("agent", id);
    throw errors.versionConflict("agent", id, expectedVersion);
  }
  return (await getAgent(db, id))!;
}

/**
 * Upsert por slug desde los seeds `agents/*.md`. La DB es la fuente de verdad en
 * ejecución; `seed_hash` delata divergencia (ARCHITECTURE §8). Si el hash del seed
 * no cambió, no toca la fila (respeta ediciones en caliente).
 */
export async function upsertAgentFromSeed(
  db: AgentosPgDb,
  input: Omit<NewAgent, "id" | "createdAt" | "updatedAt" | "version">,
): Promise<{ agent: Agent; created: boolean; seedChanged: boolean }> {
  const existing = await getAgentBySlug(db, input.slug);
  if (!existing) {
    return { agent: await createAgent(db, input), created: true, seedChanged: false };
  }
  if (existing.seedHash === input.seedHash) {
    return { agent: existing, created: false, seedChanged: false };
  }
  const agent = await updateAgent(db, existing.id, { ...input }, existing.version);
  return { agent, created: false, seedChanged: true };
}

// ── Versiones de prompt (editar crea versión, nunca sobrescribe) ────────────

export async function createPromptVersion(
  db: AgentosPgDb,
  input: Omit<NewPromptVersion, "id" | "createdAt" | "version"> & {
    id?: string;
    activate?: boolean;
  },
): Promise<PromptVersion> {
  const { activate, ...rest } = input;
  const agent = await getAgent(db, input.agentId);
  if (!agent) throw errors.notFound("agent", input.agentId);

  const [last] = await db
    .select({ v: sql<number>`coalesce(max(${promptVersions.version}), 0)` })
    .from(promptVersions)
    .where(eq(promptVersions.agentId, input.agentId))
    .limit(1);
  const row: NewPromptVersion = {
    ...rest,
    id: input.id ?? newId(),
    version: (last?.v ?? 0) + 1,
    createdAt: nowMs(),
  };
  await db.insert(promptVersions).values(row);
  if (activate !== false) {
    await updateAgent(db, agent.id, { activePromptVersionId: row.id! }, agent.version);
  }
  return (await getPromptVersion(db, row.id!))!;
}

export async function getPromptVersion(db: AgentosPgDb, id: string): Promise<PromptVersion | undefined> {
  const [row] = await db.select().from(promptVersions).where(eq(promptVersions.id, id)).limit(1);
  return row;
}

export async function getActivePrompt(
  db: AgentosPgDb,
  agentId: string,
): Promise<PromptVersion | undefined> {
  const agent = await getAgent(db, agentId);
  if (!agent?.activePromptVersionId) return undefined;
  return await getPromptVersion(db, agent.activePromptVersionId);
}

export async function listPromptVersions(db: AgentosPgDb, agentId: string): Promise<PromptVersion[]> {
  return await db
    .select()
    .from(promptVersions)
    .where(eq(promptVersions.agentId, agentId))
    .orderBy(desc(promptVersions.version));
}

/** Rollback = activar una versión anterior (jamás se borra ni sobrescribe). */
export async function activatePromptVersion(
  db: AgentosPgDb,
  agentId: string,
  versionId: string,
): Promise<Agent> {
  const agent = await getAgent(db, agentId);
  if (!agent) throw errors.notFound("agent", agentId);
  const pv = await getPromptVersion(db, versionId);
  if (!pv || pv.agentId !== agentId) throw errors.notFound("prompt_version", versionId);
  return await updateAgent(db, agentId, { activePromptVersionId: versionId }, agent.version);
}
