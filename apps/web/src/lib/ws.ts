/**
 * Cliente WebSocket (spec B5 §1):
 *
 * - Reconexión con backoff 1s → 15s.
 * - subscribe por topic con since_seq (resume del hueco desde el servidor).
 * - REGLA: el WS es optimización, nunca fuente de verdad. Si llega un evento
 *   no contiguo (seq > lastSeq + 1) el hueco es irrecuperable para el buffer
 *   → se dispara onGap() para refetchear el snapshot REST.
 */
import type { TopicEvent } from "./types";

export interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((ev?: unknown) => void) | null;
  onclose: ((ev?: unknown) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

export type WsStatus = "connecting" | "open" | "closed";

export interface SubscribeOptions {
  /** Último seq conocido (del snapshot REST). 0 = historia completa. */
  sinceSeq?: number;
  onEvent: (ev: TopicEvent) => void;
  /** Hueco irrecuperable detectado → refetch de snapshot REST. */
  onGap?: (ev: TopicEvent) => void;
  /** Confirmación del servidor tras servir el hueco. */
  onSubscribed?: (lastSeq: number) => void;
}

interface Sub extends SubscribeOptions {
  topic: string;
  lastSeq: number;
  /** true una vez enviada la orden subscribe en la conexión actual. */
  sent: boolean;
}

export interface WsClientOptions {
  url: string;
  makeSocket?: (url: string) => WebSocketLike;
  onStatus?: (status: WsStatus) => void;
  /** Backoff: arranque y tope (tests lo acortan). */
  backoffBaseMs?: number;
  backoffMaxMs?: number;
}

const OPEN = 1;

export class WsClient {
  private socket: WebSocketLike | null = null;
  private subs = new Map<string, Sub>();
  private closed = false;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly makeSocket: (url: string) => WebSocketLike;
  private readonly baseMs: number;
  private readonly maxMs: number;

  constructor(private readonly opts: WsClientOptions) {
    this.makeSocket =
      opts.makeSocket ?? ((url: string) => new WebSocket(url) as unknown as WebSocketLike);
    this.baseMs = opts.backoffBaseMs ?? 1_000;
    this.maxMs = opts.backoffMaxMs ?? 15_000;
  }

  connect(): void {
    if (this.closed) return;
    this.opts.onStatus?.("connecting");
    let socket: WebSocketLike;
    try {
      socket = this.makeSocket(this.opts.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      this.attempt = 0;
      this.opts.onStatus?.("open");
      // Resuscribir todo con el último seq visto (resume del hueco).
      for (const sub of this.subs.values()) {
        sub.sent = false;
        this.sendSubscribe(sub);
      }
    };
    socket.onmessage = (ev) => this.handleMessage(String(ev.data));
    const onDown = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.opts.onStatus?.("closed");
      this.scheduleReconnect();
    };
    socket.onclose = onDown;
    socket.onerror = () => {
      /* onclose sigue al error; no reconectar dos veces */
    };
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const s = this.socket;
    this.socket = null;
    if (s) {
      s.onclose = null;
      s.close();
    }
  }

  /** Suscribe un topic; devuelve la función de baja. */
  subscribe(topic: string, options: SubscribeOptions): () => void {
    const sub: Sub = {
      ...options,
      topic,
      lastSeq: options.sinceSeq ?? 0,
      sent: false,
    };
    this.subs.set(topic, sub);
    this.sendSubscribe(sub);
    return () => {
      if (this.subs.get(topic) !== sub) return;
      this.subs.delete(topic);
      this.sendRaw({ type: "unsubscribe", topic });
    };
  }

  /**
   * Historia one-shot de un topic (Reproducir, US-7): pide since_seq=0 y
   * recolecta hasta la confirmación `subscribed` (el servidor sirve el hueco
   * ANTES de confirmar). Sin volver a llamar al LLM: solo eventos persistidos.
   */
  fetchHistory(topic: string, timeoutMs = 10_000): Promise<TopicEvent[]> {
    return new Promise((resolve, reject) => {
      const events: TopicEvent[] = [];
      const timer = setTimeout(() => {
        off();
        reject(new Error(`timeout leyendo la historia de ${topic}`));
      }, timeoutMs);
      const off = this.subscribe(topic, {
        sinceSeq: 0,
        onEvent: (ev) => events.push(ev),
        onSubscribed: () => {
          clearTimeout(timer);
          off();
          resolve(events);
        },
      });
    });
  }

  // ── interno ───────────────────────────────────────────────────────────────

  private sendSubscribe(sub: Sub): void {
    if (sub.sent) return;
    const ok = this.sendRaw({
      type: "subscribe",
      topic: sub.topic,
      since_seq: sub.lastSeq,
    });
    if (ok) sub.sent = true;
  }

  private sendRaw(msg: Record<string, unknown>): boolean {
    if (!this.socket || this.socket.readyState !== OPEN) return false;
    try {
      this.socket.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  private handleMessage(raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    if (msg.type === "event") {
      const topic = String(msg.topic ?? "");
      const sub = this.subs.get(topic);
      if (!sub) return;
      const inner = (msg.event ?? {}) as {
        id?: string;
        type?: string;
        payload?: unknown;
        run_id?: string | null;
        created_at?: number;
      };
      const seq = Number(msg.seq ?? 0);
      if (seq <= sub.lastSeq) return; // duplicado
      const ev: TopicEvent = {
        topic,
        seq,
        type: String(inner.type ?? ""),
        payload: (inner.payload ?? {}) as Record<string, unknown>,
        runId: inner.run_id ?? null,
        createdAt: inner.created_at ?? 0,
      };
      const contiguous = sub.lastSeq === 0 || seq === sub.lastSeq + 1;
      sub.lastSeq = seq;
      if (!contiguous && sub.onGap) {
        // Hueco irrecuperable: el snapshot REST es la fuente de verdad.
        sub.onGap(ev);
        return;
      }
      sub.onEvent(ev);
      return;
    }
    if (msg.type === "subscribed") {
      const sub = this.subs.get(String(msg.topic ?? ""));
      if (sub) {
        const lastSeq = Number(msg.last_seq ?? 0);
        if (lastSeq > sub.lastSeq) sub.lastSeq = lastSeq;
        sub.onSubscribed?.(lastSeq);
      }
      return;
    }
    // hello / pong / unsubscribed / error: sin estado que mantener aquí.
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    const delay = Math.min(this.baseMs * 2 ** this.attempt, this.maxMs);
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}
