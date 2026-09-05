/** Espejo Postgres de src/repositories/processes.ts — misma superficie, asíncrona (§NFR-9). */
import { and, asc, eq, sql } from "drizzle-orm";
import { errors, newId, nowMs, type ProcessVariant } from "@agentos/shared";
import type { AgentosPgDb } from "../client-pg.js";
import { processes } from "../schema-pg.js";
import type { NewProcess, Process } from "../types-pg.js";

/**
 * Un proceso mapeado es una ENTIDAD de primera clase, no un párrafo
 * (ARCHITECTURE §8b): la unidad sobre la que se hace mejora, ISO 9001 y transformación.
 */
export async function createProcess(
  db: AgentosPgDb,
  input: Omit<NewProcess, "id" | "createdAt" | "updatedAt"> & { id?: string },
): Promise<Process> {
  const now = nowMs();
  const row: NewProcess = { ...input, id: input.id ?? newId(), createdAt: now, updatedAt: now };
  await db.insert(processes).values(row);
  return (await getProcess(db, row.id!))!;
}

export async function upsertProcess(
  db: AgentosPgDb,
  input: Omit<NewProcess, "id" | "createdAt" | "updatedAt"> & { id?: string },
): Promise<Process> {
  if (input.id && (await getProcess(db, input.id))) {
    await db
      .update(processes)
      .set({ ...input, updatedAt: nowMs() })
      .where(eq(processes.id, input.id));
    return (await getProcess(db, input.id))!;
  }
  return await createProcess(db, input);
}

export async function getProcess(db: AgentosPgDb, id: string): Promise<Process | undefined> {
  const [row] = await db.select().from(processes).where(eq(processes.id, id)).limit(1);
  return row;
}

export async function listProcesses(db: AgentosPgDb, orgId?: string): Promise<Process[]> {
  const base = db.select().from(processes);
  const q = orgId ? base.where(eq(processes.orgId, orgId)) : base;
  return await q.orderBy(asc(processes.name));
}

/** Enlaza una fuente (knowledge_doc) que sustenta el proceso — provenance obligatoria. */
export async function linkSource(db: AgentosPgDb, processId: string, docId: string): Promise<Process> {
  const proc = await getProcess(db, processId);
  if (!proc) throw errors.notFound("process", processId);
  const current = proc.sourceDocIds ?? [];
  if (!current.includes(docId)) {
    await db
      .update(processes)
      .set({ sourceDocIds: [...current, docId], updatedAt: nowMs() })
      .where(eq(processes.id, processId));
  }
  return (await getProcess(db, processId))!;
}

/** Conteo de procesos (cierre de fase — CA-M3.1: `as_is` mapeados de la org). */
export async function countProcesses(
  db: AgentosPgDb,
  filter: { orgId?: string; variant?: ProcessVariant } = {},
): Promise<number> {
  const conds = [];
  if (filter.orgId) conds.push(eq(processes.orgId, filter.orgId));
  if (filter.variant) conds.push(eq(processes.variant, filter.variant));
  const base = db.select({ n: sql<number>`count(*)::int` }).from(processes);
  const [row] = await (conds.length > 0 ? base.where(and(...conds)) : base);
  return Number(row?.n ?? 0);
}
