/** Espejo Postgres de src/repositories/stats.ts — misma superficie, asíncrona (§NFR-9). */
import { eq, sql } from "drizzle-orm";
import type { AgentosPgDb } from "../client-pg.js";
import {
  agents,
  approvals,
  events,
  messages,
  methodologies,
  organizations,
  people,
  phaseModules,
  projects,
  promptVersions,
  providerProfiles,
  runs,
  tasks,
  threads,
} from "../schema-pg.js";
import type { DomainCounts } from "../../repositories/stats.js";

export type { DomainCounts } from "../../repositories/stats.js";

// `count(*)` es bigint y el driver lo entrega como STRING: el casteo a int lo
// devuelve como number, que es lo que promete el contrato compartido.
const N = sql<number>`count(*)::int`;

const one = (rows: { n: number }[]): number => Number(rows[0]?.n ?? 0);

export async function domainCounts(db: AgentosPgDb): Promise<DomainCounts> {
  return {
    organizations: one(await db.select({ n: N }).from(organizations)),
    people: one(await db.select({ n: N }).from(people)),
    providerProfiles: one(await db.select({ n: N }).from(providerProfiles)),
    agents: one(await db.select({ n: N }).from(agents)),
    promptVersions: one(await db.select({ n: N }).from(promptVersions)),
    methodologies: one(await db.select({ n: N }).from(methodologies)),
    phaseModules: one(await db.select({ n: N }).from(phaseModules)),
    projects: one(await db.select({ n: N }).from(projects)),
    tasks: one(await db.select({ n: N }).from(tasks)),
    threads: one(await db.select({ n: N }).from(threads)),
    messages: one(await db.select({ n: N }).from(messages)),
    runsTotal: one(await db.select({ n: N }).from(runs)),
    runsRunning: one(await db.select({ n: N }).from(runs).where(eq(runs.status, "running"))),
    runsQueued: one(await db.select({ n: N }).from(runs).where(eq(runs.status, "queued"))),
    approvalsPending: one(
      await db.select({ n: N }).from(approvals).where(eq(approvals.status, "pending")),
    ),
    events: one(await db.select({ n: N }).from(events)),
  };
}

/**
 * Tablas de dominio del esquema `public`, excluyendo la de migraciones de
 * drizzle (que en Postgres vive en el esquema `drizzle`, pero se filtra igual
 * por si acaso). Equivalente del recuento sobre `sqlite_master`.
 */
export async function countDomainTables(db: AgentosPgDb): Promise<number> {
  const rows = (await db.execute(
    sql`SELECT count(*)::int AS n FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_type = 'BASE TABLE'
          AND table_name <> '__drizzle_migrations'`,
  )) as unknown as { n: number }[];
  return Number(rows[0]?.n ?? 0);
}
