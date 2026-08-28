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

export function resolveAgentRef(db: AgentosDb, ref: string): Agent {
  const agent = getAgent(db, ref) ?? getAgentBySlug(db, ref);
  if (!agent) throw errors.notFound("agent", ref);
  return agent;
}

export function resolveProviderRef(db: AgentosDb, ref: string): ProviderProfile {
  const profile = getProviderProfile(db, ref) ?? getProviderProfileBySlug(db, ref);
  if (!profile) throw errors.notFound("provider_profile", ref);
  return profile;
}
