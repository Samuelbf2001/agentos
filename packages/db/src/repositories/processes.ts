import { asc, eq } from "drizzle-orm";
import { errors, newId, nowMs } from "@agentos/shared";
import type { AgentosDb } from "../client.js";
import { processes } from "../schema.js";
import type { NewProcess, Process } from "../types.js";

/**
 * Un proceso mapeado es una ENTIDAD de primera clase, no un párrafo
 * (ARCHITECTURE §8b): la unidad sobre la que se hace mejora, ISO 9001 y transformación.
 */
export function createProcess(
  db: AgentosDb,
  input: Omit<NewProcess, "id" | "createdAt" | "updatedAt"> & { id?: string },
): Process {
  const now = nowMs();
  const row: NewProcess = { ...input, id: input.id ?? newId(), createdAt: now, updatedAt: now };
  db.insert(processes).values(row).run();
  return getProcess(db, row.id!)!;
}

export function upsertProcess(
  db: AgentosDb,
  input: Omit<NewProcess, "id" | "createdAt" | "updatedAt"> & { id?: string },
): Process {
  if (input.id && getProcess(db, input.id)) {
    db.update(processes)
      .set({ ...input, updatedAt: nowMs() })
      .where(eq(processes.id, input.id))
      .run();
    return getProcess(db, input.id)!;
  }
  return createProcess(db, input);
}

export function getProcess(db: AgentosDb, id: string): Process | undefined {
  return db.select().from(processes).where(eq(processes.id, id)).get();
}

export function listProcesses(db: AgentosDb, orgId?: string): Process[] {
  const base = db.select().from(processes);
  const q = orgId ? base.where(eq(processes.orgId, orgId)) : base;
  return q.orderBy(asc(processes.name)).all();
}

/** Enlaza una fuente (knowledge_doc) que sustenta el proceso — provenance obligatoria. */
export function linkSource(db: AgentosDb, processId: string, docId: string): Process {
  const proc = getProcess(db, processId);
  if (!proc) throw errors.notFound("process", processId);
  const current = proc.sourceDocIds ?? [];
  if (!current.includes(docId)) {
    db.update(processes)
      .set({ sourceDocIds: [...current, docId], updatedAt: nowMs() })
      .where(eq(processes.id, processId))
      .run();
  }
  return getProcess(db, processId)!;
}
