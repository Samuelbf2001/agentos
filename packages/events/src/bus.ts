import { EventEmitter } from "node:events";
import type { AgentosDb, PersistedEvent } from "@agentos/db";
import { appendEvent, lastSeq as dbLastSeq, listEventsSince } from "@agentos/db";
import { BusPayload } from "./ag-ui.js";
import { RingBuffer } from "./ring-buffer.js";
import { isValidTopic } from "./topics.js";

/** Tamaño del ring buffer por topic (ARCHITECTURE §2). */
export const DEFAULT_BUFFER_SIZE = 500;

/**
 * Un listener puede ser asíncrono: el bus recoge su promesa y captura el
 * rechazo (nunca lo espera). Así un listener que lanza no puede tumbar el
 * proceso con un `unhandledRejection`.
 */
export type BusListener = (event: PersistedEvent) => void | Promise<void>;

export interface EventBusOptions {
  /** Capacidad del ring buffer por topic (default 500). */
  bufferSize?: number;
  /** Si true (default), valida el payload contra los schemas AG-UI/plataforma. */
  validate?: boolean;
  /** Qué hacer con el error de un listener (default: `console.error`). */
  onListenerError?: (topic: string, error: unknown) => void;
}

/**
 * Bus pub/sub en proceso (ARCHITECTURE §2).
 *
 * Reglas:
 * - La DB es la FUENTE DE VERDAD: todo publish persiste primero en `events`
 *   (seq monotónico por topic asignado por el repositorio) y solo después
 *   emite a los suscriptores y al ring buffer.
 * - El bus/WS es optimización: `getSince` sirve del buffer si puede garantizar
 *   continuidad y cae a la DB si el hueco excede el buffer.
 */
export class EventBus {
  private readonly emitter = new EventEmitter();
  private readonly buffers = new Map<string, RingBuffer<PersistedEvent>>();
  private readonly bufferSize: number;
  private readonly validate: boolean;
  private readonly onListenerError: (topic: string, error: unknown) => void;

  constructor(
    private readonly db: AgentosDb,
    options: EventBusOptions = {},
  ) {
    this.bufferSize = options.bufferSize ?? DEFAULT_BUFFER_SIZE;
    this.validate = options.validate ?? true;
    this.onListenerError =
      options.onListenerError ??
      ((topic, error) => {
        console.error(`[event-bus] listener de '${topic}' falló:`, error);
      });
    // Un proceso con muchos topics vivos es lo normal; sin límite de listeners.
    this.emitter.setMaxListeners(0);
  }

  /**
   * Publica un evento en un topic: persiste (append-only, seq monotónico),
   * alimenta el ring buffer y notifica a los suscriptores del topic y a los
   * suscriptores globales.
   */
  async publish(
    topic: string,
    event: BusPayload,
    opts: { runId?: string } = {},
  ): Promise<PersistedEvent> {
    if (!isValidTopic(topic)) {
      throw new Error(`Topic inválido: ${topic}`);
    }
    const parsed = this.validate ? BusPayload.parse(event) : event;
    const runId =
      opts.runId ?? (typeof (parsed as { runId?: unknown }).runId === "string"
        ? (parsed as { runId: string }).runId
        : undefined);
    const persisted = await appendEvent(this.db, {
      topic,
      type: parsed.type,
      payload: parsed as unknown as Record<string, unknown>,
      runId: runId ?? null,
    });
    this.bufferFor(topic).push(persisted);
    this.emitter.emit(topic, persisted);
    this.emitter.emit("*", persisted);
    return persisted;
  }

  /** Suscripción a un topic. Devuelve la función de baja. */
  subscribe(topic: string, listener: BusListener): () => void {
    const wrapped = this.guard(topic, listener);
    this.emitter.on(topic, wrapped);
    return () => this.emitter.off(topic, wrapped);
  }

  /** Suscripción a TODOS los topics (fan-out del WS). Devuelve la función de baja. */
  subscribeAll(listener: BusListener): () => void {
    const wrapped = this.guard("*", listener);
    this.emitter.on("*", wrapped);
    return () => this.emitter.off("*", wrapped);
  }

  /**
   * Envoltorio de seguridad: un listener que lanza (síncrono) o cuya promesa
   * se rechaza (asíncrono) queda registrado y no sale del bus. Sin esto, un
   * listener asíncrono suelto tumbaba el proceso por `unhandledRejection`.
   */
  private guard(topic: string, listener: BusListener): (event: PersistedEvent) => void {
    return (event: PersistedEvent): void => {
      try {
        const result = listener(event);
        if (result && typeof (result as Promise<void>).catch === "function") {
          void (result as Promise<void>).catch((error: unknown) => {
            this.onListenerError(topic, error);
          });
        }
      } catch (error) {
        this.onListenerError(topic, error);
      }
    };
  }

  /**
   * Resume por `since_seq`: eventos del topic con seq > sinceSeq.
   * Sirve del ring buffer SOLO cuando puede garantizar continuidad Y frescura
   * (su último seq coincide con el persistido — la DB es la fuente de verdad);
   * en cualquier otro caso cae a la DB.
   */
  async getSince(topic: string, sinceSeq = 0, limit = 1000): Promise<PersistedEvent[]> {
    const buffer = this.buffers.get(topic);
    if (buffer && buffer.newestSeq === (await dbLastSeq(this.db, topic))) {
      const buffered = buffer.since(sinceSeq);
      if (buffered !== null) {
        return buffered.slice(0, limit);
      }
    }
    return await listEventsSince(this.db, topic, sinceSeq, limit);
  }

  /** Último seq persistido del topic (0 si nunca se emitió nada). */
  async lastSeq(topic: string): Promise<number> {
    return await dbLastSeq(this.db, topic);
  }

  private bufferFor(topic: string): RingBuffer<PersistedEvent> {
    let buffer = this.buffers.get(topic);
    if (!buffer) {
      buffer = new RingBuffer<PersistedEvent>(this.bufferSize);
      this.buffers.set(topic, buffer);
    }
    return buffer;
  }
}
