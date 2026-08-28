/** Espejo Postgres de src/repositories/events.ts — misma superficie, asíncrona (§NFR-9). */
import { and, asc, eq, gt, sql } from "drizzle-orm";
import { newId, nowMs } from "@agentos/shared";
import type { AgentosPgDb } from "../client-pg.js";
import { events } from "../schema-pg.js";
import type { NewPersistedEvent, PersistedEvent } from "../types-pg.js";

/**
 * Persistencia del stream AG-UI (ARCHITECTURE §2): seq monotónico por topic.
 * El WS es optimización; ESTA tabla es la fuente de verdad para resume por `since_seq`.
 *
 * En SQLite el mono-escritor + la transacción bastaban para que la asignación
 * de seq (`SELECT coalesce(max(seq),0)+1 ... WHERE topic=@topic`) fuera segura.
 * En Postgres NO basta: bajo READ COMMITTED, dos transacciones concurrentes
 * pueden leer el mismo `max(seq)` antes de que ninguna haga commit y generar el
 * mismo seq para el mismo topic. Por eso tomamos un lock de asesoramiento
 * (`pg_advisory_xact_lock(hashtext(topic))`) al entrar a la transacción: serializa
 * la asignación de seq entre procesos concurrentes para el MISMO topic (topics
 * distintos no se bloquean entre sí) y se libera solo al hacer commit/rollback.
 * El unique(topic, seq) sigue siendo la red de seguridad si algo se escapara del lock.
 */
export async function appendEvent(
  db: AgentosPgDb,
  input: Omit<NewPersistedEvent, "id" | "createdAt" | "seq"> & { id?: string },
): Promise<PersistedEvent> {
  const id = input.id ?? newId();
  const createdAt = nowMs();
  await db.transaction(async (tx) => {
    // Lock de asesoramiento por topic: serializa la asignación de seq entre
    // procesos concurrentes (en SQLite lo garantizaba el mono-escritor).
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${input.topic}))`);
    await tx.insert(events).values({
      id,
      topic: input.topic,
      seq: sql`(SELECT coalesce(max(seq), 0) + 1 FROM events WHERE topic = ${input.topic})`,
      type: input.type,
      // payload es jsonb: se pasa como objeto JS tal cual — NUNCA con
      // JSON.stringify (eso solo era necesario contra SQL crudo en SQLite).
      payload: input.payload === undefined ? null : input.payload,
      runId: input.runId ?? null,
      createdAt,
    });
  });
  const [row] = await db.select().from(events).where(eq(events.id, id)).limit(1);
  return row!;
}

/** Relleno de huecos al reconectar: eventos de un topic con seq > sinceSeq. */
export async function listEventsSince(
  db: AgentosPgDb,
  topic: string,
  sinceSeq = 0,
  limit = 500,
): Promise<PersistedEvent[]> {
  return await db
    .select()
    .from(events)
    .where(and(eq(events.topic, topic), gt(events.seq, sinceSeq)))
    .orderBy(asc(events.seq))
    .limit(limit);
}

export async function lastSeq(db: AgentosPgDb, topic: string): Promise<number> {
  const [row] = await db
    .select({ s: sql<number>`coalesce(max(${events.seq}), 0)` })
    .from(events)
    .where(eq(events.topic, topic));
  return row?.s ?? 0;
}
