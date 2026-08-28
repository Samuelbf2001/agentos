import { asc, eq } from "drizzle-orm";
import { errors, newId, nowMs } from "@agentos/shared";
import type { AgentosDb } from "../client.js";
import { messages, threads } from "../schema.js";
import type { Message, NewMessage, NewThread, Thread } from "../types.js";

// ── Threads ─────────────────────────────────────────────────────────────────

/** `session_key = channel:chat_id:thread_id` (ARCHITECTURE §5). */
export function buildSessionKey(channel: string, chatId: string, threadId?: string): string {
  return `${channel}:${chatId}:${threadId ?? "main"}`;
}

export function getThreadBySessionKey(db: AgentosDb, sessionKey: string): Thread | undefined {
  return db.select().from(threads).where(eq(threads.sessionKey, sessionKey)).get();
}

export function getThread(db: AgentosDb, id: string): Thread | undefined {
  return db.select().from(threads).where(eq(threads.id, id)).get();
}

/** Idempotente por session_key único: la carrera la resuelve el índice, no el código. */
export function getOrCreateThread(
  db: AgentosDb,
  input: Omit<NewThread, "id" | "createdAt" | "updatedAt"> & { id?: string },
): Thread {
  const existing = getThreadBySessionKey(db, input.sessionKey);
  if (existing) return existing;
  const now = nowMs();
  const row: NewThread = { ...input, id: input.id ?? newId(), createdAt: now, updatedAt: now };
  try {
    db.insert(threads).values(row).run();
  } catch (err) {
    const raced = getThreadBySessionKey(db, input.sessionKey);
    if (raced) return raced;
    throw err;
  }
  return getThread(db, row.id!)!;
}

/**
 * M2 (fuentes del launch — §13.3): asociar un hilo existente al proyecto
 * disparado. El launch resuelve la session_key → thread y fija su projectId.
 */
export function setThreadProject(db: AgentosDb, threadId: string, projectId: string | null): Thread {
  const existing = getThread(db, threadId);
  if (!existing) throw errors.notFound("thread", threadId);
  db.update(threads).set({ projectId, updatedAt: nowMs() }).where(eq(threads.id, threadId)).run();
  return getThread(db, threadId)!;
}

export function listThreads(db: AgentosDb, channel?: string): Thread[] {
  const base = db.select().from(threads);
  const q = channel ? base.where(eq(threads.channel, channel)) : base;
  return q.orderBy(asc(threads.createdAt)).all();
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
export function appendMessage(
  db: AgentosDb,
  input: Omit<NewMessage, "id" | "createdAt"> & { id?: string },
): AppendMessageResult {
  if (input.idempotencyKey) {
    const existing = db.$client
      .prepare(`SELECT id FROM messages WHERE thread_id = ? AND idempotency_key = ?`)
      .get(input.threadId, input.idempotencyKey) as { id: string } | undefined;
    if (existing) return { message: getMessage(db, existing.id)!, inserted: false };
  }
  const row: NewMessage = { ...input, id: input.id ?? newId(), createdAt: nowMs() };
  try {
    db.insert(messages).values(row).run();
  } catch (err) {
    // Carrera sobre la misma clave: el índice único manda; devolvemos el original.
    if (input.idempotencyKey) {
      const raced = db.$client
        .prepare(`SELECT id FROM messages WHERE thread_id = ? AND idempotency_key = ?`)
        .get(input.threadId, input.idempotencyKey) as { id: string } | undefined;
      if (raced) return { message: getMessage(db, raced.id)!, inserted: false };
    }
    throw err;
  }
  db.update(threads).set({ updatedAt: nowMs() }).where(eq(threads.id, input.threadId)).run();
  return { message: getMessage(db, row.id!)!, inserted: true };
}

/**
 * B4 (lectura nueva): dedup del gateway de canales por unique(channel, message_id)
 * (ARCHITECTURE §9) — ¿existe ya un mensaje con esta idempotency_key en
 * cualquier thread del canal?
 */
export function findChannelMessage(
  db: AgentosDb,
  channel: string,
  idempotencyKey: string,
): Message | undefined {
  const row = db.$client
    .prepare(
      `SELECT m.id FROM messages m
       JOIN threads t ON t.id = m.thread_id
       WHERE t.channel = ? AND m.idempotency_key = ?
       LIMIT 1`,
    )
    .get(channel, idempotencyKey) as { id: string } | undefined;
  return row ? getMessage(db, row.id) : undefined;
}

export function getMessage(db: AgentosDb, id: string): Message | undefined {
  return db.select().from(messages).where(eq(messages.id, id)).get();
}

/** Usa el índice messages(thread_id, created_at). */
export function listMessages(db: AgentosDb, threadId: string, limit = 200): Message[] {
  return db
    .select()
    .from(messages)
    .where(eq(messages.threadId, threadId))
    .orderBy(asc(messages.createdAt))
    .limit(limit)
    .all();
}
