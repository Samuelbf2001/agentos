/** Espejo Postgres de src/repositories/threads.ts — misma superficie, asíncrona (§NFR-9). */
import { and, asc, eq } from "drizzle-orm";
import { errors, newId, nowMs } from "@agentos/shared";
import type { AgentosPgDb } from "../client-pg.js";
import { messages, threads } from "../schema-pg.js";
import type { Message, NewMessage, NewThread, Thread } from "../types-pg.js";

// ── Threads ─────────────────────────────────────────────────────────────────

/** `session_key = channel:chat_id:thread_id` (ARCHITECTURE §5). */
export function buildSessionKey(channel: string, chatId: string, threadId?: string): string {
  return `${channel}:${chatId}:${threadId ?? "main"}`;
}

export async function getThreadBySessionKey(db: AgentosPgDb, sessionKey: string): Promise<Thread | undefined> {
  const [row] = await db.select().from(threads).where(eq(threads.sessionKey, sessionKey)).limit(1);
  return row;
}

export async function getThread(db: AgentosPgDb, id: string): Promise<Thread | undefined> {
  const [row] = await db.select().from(threads).where(eq(threads.id, id)).limit(1);
  return row;
}

/** Idempotente por session_key único: la carrera la resuelve el índice, no el código. */
export async function getOrCreateThread(
  db: AgentosPgDb,
  input: Omit<NewThread, "id" | "createdAt" | "updatedAt"> & { id?: string },
): Promise<Thread> {
  const existing = await getThreadBySessionKey(db, input.sessionKey);
  if (existing) return existing;
  const now = nowMs();
  const row: NewThread = { ...input, id: input.id ?? newId(), createdAt: now, updatedAt: now };
  try {
    await db.insert(threads).values(row);
  } catch (err) {
    const raced = await getThreadBySessionKey(db, input.sessionKey);
    if (raced) return raced;
    throw err;
  }
  return (await getThread(db, row.id!))!;
}

/**
 * M2 (fuentes del launch — §13.3): asociar un hilo existente al proyecto
 * disparado. El launch resuelve la session_key → thread y fija su projectId.
 */
export async function setThreadProject(
  db: AgentosPgDb,
  threadId: string,
  projectId: string | null,
): Promise<Thread> {
  const existing = await getThread(db, threadId);
  if (!existing) throw errors.notFound("thread", threadId);
  await db.update(threads).set({ projectId, updatedAt: nowMs() }).where(eq(threads.id, threadId));
  return (await getThread(db, threadId))!;
}

export async function listThreads(db: AgentosPgDb, channel?: string): Promise<Thread[]> {
  const base = db.select().from(threads);
  const q = channel ? base.where(eq(threads.channel, channel)) : base;
  return await q.orderBy(asc(threads.createdAt));
}

// ── Messages ────────────────────────────────────────────────────────────────

export interface AppendMessageResult {
  message: Message;
  /** false si la clave de idempotencia ya existía (mensaje reintentado, no duplicado). */
  inserted: boolean;
}

/**
 * Inserta un mensaje con idempotencia (ARCHITECTURE §9): mismo
 * (thread_id, idempotency_key) reintentado devuelve el mensaje original.
 */
export async function appendMessage(
  db: AgentosPgDb,
  input: Omit<NewMessage, "id" | "createdAt"> & { id?: string },
): Promise<AppendMessageResult> {
  if (input.idempotencyKey) {
    const [existing] = await db
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.threadId, input.threadId), eq(messages.idempotencyKey, input.idempotencyKey)))
      .limit(1);
    if (existing) return { message: (await getMessage(db, existing.id))!, inserted: false };
  }
  const row: NewMessage = { ...input, id: input.id ?? newId(), createdAt: nowMs() };
  try {
    await db.insert(messages).values(row);
  } catch (err) {
    // Carrera sobre la misma clave: el índice único manda; devolvemos el original.
    if (input.idempotencyKey) {
      const [raced] = await db
        .select({ id: messages.id })
        .from(messages)
        .where(and(eq(messages.threadId, input.threadId), eq(messages.idempotencyKey, input.idempotencyKey)))
        .limit(1);
      if (raced) return { message: (await getMessage(db, raced.id))!, inserted: false };
    }
    throw err;
  }
  await db.update(threads).set({ updatedAt: nowMs() }).where(eq(threads.id, input.threadId));
  return { message: (await getMessage(db, row.id!))!, inserted: true };
}

/**
 * B4 (lectura nueva): dedup del gateway de canales por unique(channel, message_id)
 * (ARCHITECTURE §9) — ¿existe ya un mensaje con esta idempotency_key en
 * cualquier thread del canal?
 */
export async function findChannelMessage(
  db: AgentosPgDb,
  channel: string,
  idempotencyKey: string,
): Promise<Message | undefined> {
  const [row] = await db
    .select({ id: messages.id })
    .from(messages)
    .innerJoin(threads, eq(threads.id, messages.threadId))
    .where(and(eq(threads.channel, channel), eq(messages.idempotencyKey, idempotencyKey)))
    .limit(1);
  return row ? await getMessage(db, row.id) : undefined;
}

export async function getMessage(db: AgentosPgDb, id: string): Promise<Message | undefined> {
  const [row] = await db.select().from(messages).where(eq(messages.id, id)).limit(1);
  return row;
}

/** Usa el índice messages(thread_id, created_at). */
export async function listMessages(db: AgentosPgDb, threadId: string, limit = 200): Promise<Message[]> {
  return await db
    .select()
    .from(messages)
    .where(eq(messages.threadId, threadId))
    .orderBy(asc(messages.createdAt))
    .limit(limit);
}
