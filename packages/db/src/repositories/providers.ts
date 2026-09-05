import { eq } from "drizzle-orm";
import { newId, nowMs } from "@agentos/shared";
import type { AgentosSqliteDb } from "../client.js";
import { providerProfiles } from "../schema.js";
import type { NewProviderProfile, ProviderProfile } from "../types.js";

export function upsertProviderProfile(
  db: AgentosSqliteDb,
  input: Omit<NewProviderProfile, "id" | "createdAt" | "updatedAt"> & { id?: string },
): ProviderProfile {
  const now = nowMs();
  const existing = getProviderProfileBySlug(db, input.slug);
  if (existing) {
    db.update(providerProfiles)
      .set({ ...input, id: existing.id, updatedAt: now })
      .where(eq(providerProfiles.id, existing.id))
      .run();
    return getProviderProfile(db, existing.id)!;
  }
  const row: NewProviderProfile = {
    ...input,
    id: input.id ?? newId(),
    createdAt: now,
    updatedAt: now,
  };
  db.insert(providerProfiles).values(row).run();
  return getProviderProfile(db, row.id!)!;
}

export function getProviderProfile(db: AgentosSqliteDb, id: string): ProviderProfile | undefined {
  return db.select().from(providerProfiles).where(eq(providerProfiles.id, id)).get();
}

export function getProviderProfileBySlug(
  db: AgentosSqliteDb,
  slug: string,
): ProviderProfile | undefined {
  return db.select().from(providerProfiles).where(eq(providerProfiles.slug, slug)).get();
}

export function listProviderProfiles(db: AgentosSqliteDb): ProviderProfile[] {
  return db.select().from(providerProfiles).all();
}

export function getDefaultProviderProfile(db: AgentosSqliteDb): ProviderProfile | undefined {
  return db.select().from(providerProfiles).where(eq(providerProfiles.isDefault, true)).get();
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
