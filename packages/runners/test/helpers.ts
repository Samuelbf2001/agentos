import { newId } from "@agentos/shared";
import {
  openDb,
  runMigrations,
  upsertProviderProfile,
  type AgentosDb,
  type NewProviderProfile,
  type ProviderProfile,
} from "@agentos/db";
import type { RunTraceContext } from "../src/types.js";

export function makeDb(): AgentosDb {
  const db = openDb(":memory:");
  runMigrations(db);
  return db;
}

export async function makeProfile(
  db: AgentosDb,
  overrides: Partial<Omit<NewProviderProfile, "id" | "createdAt" | "updatedAt">> = {},
): Promise<ProviderProfile> {
  return await upsertProviderProfile(db, {
    slug: "test-openai-compatible",
    name: "Proveedor de prueba",
    kind: "openai_compatible",
    baseUrl: "https://api.test.local/v1",
    apiKeyEnv: "TEST_PROVIDER_KEY",
    costInputPerMtok: 3,
    costOutputPerMtok: 15,
    ...overrides,
  });
}

export function makeCtx(overrides: Partial<RunTraceContext> = {}): RunTraceContext {
  const runId = overrides.runId ?? newId();
  return { runId, rootRunId: overrides.rootRunId ?? runId, ...overrides };
}

export const tick = (ms = 20) => new Promise<void>((resolve) => setTimeout(resolve, ms));
