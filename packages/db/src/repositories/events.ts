import { and, asc, eq, gt } from "drizzle-orm";
import { newId, nowMs } from "@agentos/shared";
import type { AgentosDb } from "../client.js";
import { events } from "../schema.js";
import type { NewPersistedEvent, PersistedEvent } from "../types.js";

/**
 * Persistencia del stream AG-UI (ARCHITECTURE §2): seq monotónico por topic.
 * El WS es optimización; ESTA tabla es la fuente de verdad para resume por `since_seq`.
 * El seq se asigna dentro de una transacción (mono-escritor SQLite → sin huecos ni duplicados;
 * el unique(topic, seq) lo garantiza incluso ante errores de lógica).
 */
export function appendEvent(
  db: AgentosDb,
  input: Omit<NewPersistedEvent, "id" | "createdAt" | "seq"> & { id?: string },
): PersistedEvent {
  const insert = db.$client.prepare(
    `INSERT INTO events (id, topic, seq, type, payload, run_id, created_at)
     VALUES (@id, @topic,
             (SELECT coalesce(max(seq), 0) + 1 FROM events WHERE topic = @topic),
             @type, @payload, @runId, @createdAt)`,
  );
  const id = input.id ?? newId();
  const tx = db.$client.transaction(() => {
    insert.run({
      id,
      topic: input.topic,
      type: input.type,
      payload: input.payload === undefined || input.payload === null ? null : JSON.stringify(input.payload),
      runId: input.runId ?? null,
      createdAt: nowMs(),
    });
  });
  tx.immediate();
  return db.select().from(events).where(eq(events.id, id)).get()!;
}

/** Relleno de huecos al reconectar: eventos de un topic con seq > sinceSeq. */
export function listEventsSince(
  db: AgentosDb,
  topic: string,
  sinceSeq = 0,
  limit = 500,
): PersistedEvent[] {
  return db
    .select()
    .from(events)
    .where(and(eq(events.topic, topic), gt(events.seq, sinceSeq)))
    .orderBy(asc(events.seq))
    .limit(limit)
    .all();
}

export function lastSeq(db: AgentosDb, topic: string): number {
  const row = db.$client
    .prepare(`SELECT coalesce(max(seq), 0) AS s FROM events WHERE topic = ?`)
    .get(topic) as { s: number };
  return row.s;
}
