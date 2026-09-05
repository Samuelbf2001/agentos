/**
 * Contadores de dominio (salud de la API y resumen del seed). Viven aquí y no
 * en `apps/api` porque son CONSULTAS, y ninguna consulta vive fuera de
 * `repositories/` (ARCHITECTURE §5). El espejo Postgres está en
 * `src/pg/repositories/stats.ts`.
 */
import { eq, sql } from "drizzle-orm";
import type { AgentosSqliteDb } from "../client.js";
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
} from "../schema.js";

/** Conteos que consumen `healthCounts` (apps/api) y el resumen del seed. */
export interface DomainCounts {
  organizations: number;
  people: number;
  providerProfiles: number;
  agents: number;
  promptVersions: number;
  methodologies: number;
  phaseModules: number;
  projects: number;
  tasks: number;
  threads: number;
  messages: number;
  runsTotal: number;
  runsRunning: number;
  runsQueued: number;
  approvalsPending: number;
  events: number;
}

interface CountQuery {
  get(): { n: number } | undefined;
}

const N = sql<number>`count(*)`;

export function domainCounts(db: AgentosSqliteDb): DomainCounts {
  const one = (q: CountQuery): number => q.get()?.n ?? 0;
  return {
    organizations: one(db.select({ n: N }).from(organizations)),
    people: one(db.select({ n: N }).from(people)),
    providerProfiles: one(db.select({ n: N }).from(providerProfiles)),
    agents: one(db.select({ n: N }).from(agents)),
    promptVersions: one(db.select({ n: N }).from(promptVersions)),
    methodologies: one(db.select({ n: N }).from(methodologies)),
    phaseModules: one(db.select({ n: N }).from(phaseModules)),
    projects: one(db.select({ n: N }).from(projects)),
    tasks: one(db.select({ n: N }).from(tasks)),
    threads: one(db.select({ n: N }).from(threads)),
    messages: one(db.select({ n: N }).from(messages)),
    runsTotal: one(db.select({ n: N }).from(runs)),
    runsRunning: one(db.select({ n: N }).from(runs).where(eq(runs.status, "running"))),
    runsQueued: one(db.select({ n: N }).from(runs).where(eq(runs.status, "queued"))),
    approvalsPending: one(
      db.select({ n: N }).from(approvals).where(eq(approvals.status, "pending")),
    ),
    events: one(db.select({ n: N }).from(events)),
  };
}

/**
 * Tablas de dominio: excluye las internas de SQLite, los espejos FTS y la de
 * migraciones. El espejo Postgres cuenta lo mismo sobre `information_schema`.
 */
export function countDomainTables(db: AgentosSqliteDb): number {
  const row = db.$client
    .prepare(
      `SELECT count(*) n FROM sqlite_master
       WHERE type = 'table'
         AND name NOT LIKE 'sqlite_%'
         AND name NOT LIKE '%_fts%'
         AND name != '__drizzle_migrations'`,
    )
    .get() as { n: number };
  return row.n;
}
