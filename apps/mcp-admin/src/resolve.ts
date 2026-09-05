/** Resolución id-o-slug compartida por las tools admin. */
import {
  getAgent,
  getAgentBySlug,
  getProviderProfile,
  getProviderProfileBySlug,
  type Agent,
  type AgentosDb,
  type ProviderProfile,
} from "@agentos/db";
import { errors } from "@agentos/shared";

export async function resolveAgentRef(db: AgentosDb, ref: string): Promise<Agent> {
  const agent = (await getAgent(db, ref)) ?? (await getAgentBySlug(db, ref));
  if (!agent) throw errors.notFound("agent", ref);
  return agent;
}

export async function resolveProviderRef(db: AgentosDb, ref: string): Promise<ProviderProfile> {
  const profile = (await getProviderProfile(db, ref)) ?? (await getProviderProfileBySlug(db, ref));
  if (!profile) throw errors.notFound("provider_profile", ref);
  return profile;
}
