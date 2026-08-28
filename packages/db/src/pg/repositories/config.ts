/** Espejo Postgres de src/repositories/config.ts — misma superficie, asíncrona (§NFR-9). */
import { eq } from "drizzle-orm";
import { nowMs } from "@agentos/shared";
import type { AgentosPgDb } from "../client-pg.js";
import { appConfig } from "../schema-pg.js";
import type { AppConfigRow } from "../types-pg.js";

/** Claves conocidas de app_config (kill switch, presupuestos — ARCHITECTURE §5). */
export const ConfigKeys = {
  KILL_SWITCH: "kill_switch",
  BUDGET_MAX_COST_PER_RUN_USD: "budget_max_cost_per_run_usd",
  BUDGET_MAX_COST_PER_DAY_USD: "budget_max_cost_per_day_usd",
} as const;

export async function getConfig<T = unknown>(db: AgentosPgDb, key: string): Promise<T | undefined> {
  const [row] = await db.select().from(appConfig).where(eq(appConfig.key, key)).limit(1);
  return row?.value as T | undefined;
}

export async function setConfig(db: AgentosPgDb, key: string, value: unknown): Promise<void> {
  const now = nowMs();
  await db
    .insert(appConfig)
    .values({ key, value, updatedAt: now })
    .onConflictDoUpdate({ target: appConfig.key, set: { value, updatedAt: now } });
}

export async function listConfig(db: AgentosPgDb): Promise<AppConfigRow[]> {
  return await db.select().from(appConfig);
}
