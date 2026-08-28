import { eq } from "drizzle-orm";
import { nowMs } from "@agentos/shared";
import type { AgentosDb } from "../client.js";
import { appConfig } from "../schema.js";
import type { AppConfigRow } from "../types.js";

/** Claves conocidas de app_config (kill switch, presupuestos — ARCHITECTURE §5). */
export const ConfigKeys = {
  KILL_SWITCH: "kill_switch",
  BUDGET_MAX_COST_PER_RUN_USD: "budget_max_cost_per_run_usd",
  BUDGET_MAX_COST_PER_DAY_USD: "budget_max_cost_per_day_usd",
} as const;

export function getConfig<T = unknown>(db: AgentosDb, key: string): T | undefined {
  const row = db.select().from(appConfig).where(eq(appConfig.key, key)).get();
  return row?.value as T | undefined;
}

export function setConfig(db: AgentosDb, key: string, value: unknown): void {
  const now = nowMs();
  db.insert(appConfig)
    .values({ key, value, updatedAt: now })
    .onConflictDoUpdate({ target: appConfig.key, set: { value, updatedAt: now } })
    .run();
}

export function listConfig(db: AgentosDb): AppConfigRow[] {
  return db.select().from(appConfig).all();
}
