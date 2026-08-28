/** Espejo Postgres de src/repositories/providers.ts — misma superficie, asíncrona (§NFR-9). */
import { eq } from "drizzle-orm";
import { newId, nowMs } from "@agentos/shared";
import type { AgentosPgDb } from "../client-pg.js";
import { providerProfiles } from "../schema-pg.js";
import type { NewProviderProfile, ProviderProfile } from "../types-pg.js";

export async function upsertProviderProfile(
  db: AgentosPgDb,
  input: Omit<NewProviderProfile, "id" | "createdAt" | "updatedAt"> & { id?: string },
): Promise<ProviderProfile> {
  const now = nowMs();
  const existing = await getProviderProfileBySlug(db, input.slug);
  if (existing) {
    await db
      .update(providerProfiles)
      .set({ ...input, id: existing.id, updatedAt: now })
      .where(eq(providerProfiles.id, existing.id));
    return (await getProviderProfile(db, existing.id))!;
  }
  const row: NewProviderProfile = {
    ...input,
    id: input.id ?? newId(),
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(providerProfiles).values(row);
  return (await getProviderProfile(db, row.id!))!;
}

export async function getProviderProfile(
  db: AgentosPgDb,
  id: string,
): Promise<ProviderProfile | undefined> {
  const [row] = await db.select().from(providerProfiles).where(eq(providerProfiles.id, id)).limit(1);
  return row;
}

export async function getProviderProfileBySlug(
  db: AgentosPgDb,
  slug: string,
): Promise<ProviderProfile | undefined> {
  const [row] = await db
    .select()
    .from(providerProfiles)
    .where(eq(providerProfiles.slug, slug))
    .limit(1);
  return row;
}

export async function listProviderProfiles(db: AgentosPgDb): Promise<ProviderProfile[]> {
  return await db.select().from(providerProfiles);
}

export async function getDefaultProviderProfile(db: AgentosPgDb): Promise<ProviderProfile | undefined> {
  const [row] = await db
    .select()
    .from(providerProfiles)
    .where(eq(providerProfiles.isDefault, true))
    .limit(1);
  return row;
}

/**
 * ¿Tiene credencial configurada este perfil? (Regla del fallback de arranque,
 * ARCHITECTURE §3.) `claude_subscription` no usa API key: cuenta como configurado.
 */
export function isProviderConfigured(
  profile: Pick<ProviderProfile, "kind" | "apiKeyEnv">,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (profile.kind === "claude_subscription") return true;
  if (!profile.apiKeyEnv) return false;
  const value = env[profile.apiKeyEnv];
  return typeof value === "string" && value.trim().length > 0;
}
