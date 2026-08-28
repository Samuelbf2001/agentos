/**
 * WS client: resume con since_seq pide el hueco; hueco irrecuperable (seq no
 * contiguo) dispara el refetch de snapshot; reconexión con backoff 1s→15s.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WsClient, type WebSocketLike } from "../src/lib/ws";
import type { TopicEvent } from "../src/lib/types";

class FakeSocket implements WebSocketLike {
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  onopen: ((ev?: unknown) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(): void {
    this.readyState = 3;
  }
  // Helpers del test:
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  drop(): void {
    this.readyState = 3;
    this.onclose?.();
  }
  emitEvent(topic: string, seq: number, type: string, payload: Record<string, unknown> = {}): void {
    this.onmessage?.({
      data: JSON.stringify({
        type: "event",
        topic,
        seq,
        event: { id: `e${seq}`, type, payload, run_id: null, created_at: seq },
      }),
    });
  }
  confirm(topic: string, lastSeq: number): void {
    this.onmessage?.({ data: JSON.stringify({ type: "subscribed", topic, last_seq: lastSeq }) });
  }
}

describe("WsClient", () => {
  let sockets: FakeSocket[];
  let client: WsClient;

  beforeEach(() => {
    vi.useFakeTimers();
    sockets = [];
  });
  afterEach(() => {
    client?.close();
    vi.useRealTimers();
  });

  function makeClient(): WsClient {
    client = new WsClient({
      url: "ws://test/ws?token=x",
      makeSocket: () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s;
      },
    });
    return client;
  }

  it("subscribe manda since_seq del snapshot para pedir el hueco", () => {
    const c = makeClient();
    c.connect();
    const s = sockets[0]!;
    s.open();
    c.subscribe("board:p1", { sinceSeq: 41, onEvent: () => {} });
    expect(s.sent).toContainEqual({ type: "subscribe", topic: "board:p1", since_seq: 41 });
  });

  it("entrega el hueco en orden y descarta duplicados por seq", () => {
    const c = makeClient();
    c.connect();
    const s = sockets[0]!;
    s.open();
    const seen: number[] = [];
    c.subscribe("board:p1", { sinceSeq: 10, onEvent: (ev: TopicEvent) => seen.push(ev.seq) });
    s.emitEvent("board:p1", 11, "task.moved");
    s.emitEvent("board:p1", 12, "task.moved");
    s.emitEvent("board:p1", 12, "task.moved"); // duplicado
    expect(seen).toEqual([11, 12]);
  });

  it("hueco irrecuperable (seq no contiguo) dispara onGap → refetch snapshot", () => {
    const c = makeClient();
    c.connect();
    const s = sockets[0]!;
    s.open();
    const seen: number[] = [];
    const gaps: number[] = [];
    c.subscribe("board:p1", {
      sinceSeq: 5,
      onEvent: (ev) => seen.push(ev.seq),
      onGap: (ev) => gaps.push(ev.seq),
    });
    s.emitEvent("board:p1", 6, "task.moved");
    // Se perdieron 7..40 (buffer del server desbordado): llega el 41 directo.
    s.emitEvent("board:p1", 41, "task.moved");
    expect(seen).toEqual([6]);
    expect(gaps).toEqual([41]);
    // Y después del gap la continuidad sigue desde 41.
    s.emitEvent("board:p1", 42, "task.moved");
    expect(seen).toEqual([6, 42]);
  });

  it("al reconectar re-subscribe con el último seq visto (resume)", async () => {
    const c = makeClient();
    c.connect();
    const first = sockets[0]!;
    first.open();
    c.subscribe("board:p1", { sinceSeq: 5, onEvent: () => {} });
    first.emitEvent("board:p1", 6, "task.moved");
    first.emitEvent("board:p1", 7, "task.moved");

    first.drop();
    // backoff base: 1 s
    await vi.advanceTimersByTimeAsync(1_000);
    const second = sockets[1]!;
    expect(second).toBeDefined();
    second.open();
    expect(second.sent).toContainEqual({ type: "subscribe", topic: "board:p1", since_seq: 7 });
  });

  it("backoff exponencial 1s→15s en fallos consecutivos y reset al reconectar", async () => {
    const c = makeClient();
    c.connect();
    sockets[0]!.open();
    // Caídas consecutivas SIN reconexión exitosa: 1s, 2s, 4s, 8s, 15s, 15s.
    const delays: number[] = [];
    for (let i = 0; i < 6; i++) {
      const before = sockets.length;
      sockets[sockets.length - 1]!.drop();
      let waited = 0;
      while (sockets.length === before && waited < 20_000) {
        await vi.advanceTimersByTimeAsync(500);
        waited += 500;
      }
      delays.push(waited);
      // No abrimos el socket: el siguiente drop simula otro intento fallido.
    }
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 15_000, 15_000]);

    // Conexión exitosa → el backoff se resetea a 1 s.
    sockets[sockets.length - 1]!.open();
    const before = sockets.length;
    sockets[sockets.length - 1]!.drop();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sockets.length).toBe(before + 1);
  });

  it("fetchHistory recolecta el topic completo hasta la confirmación subscribed", async () => {
    const c = makeClient();
    c.connect();
    const s = sockets[0]!;
    s.open();
    const promise = c.fetchHistory("run:r1");
    s.emitEvent("run:r1", 1, "RUN_STARTED", { runId: "r1" });
    s.emitEvent("run:r1", 2, "TEXT_MESSAGE_CONTENT", { messageId: "m", delta: "hola" });
    s.confirm("run:r1", 2);
    const events = await promise;
    expect(events.map((e) => e.type)).toEqual(["RUN_STARTED", "TEXT_MESSAGE_CONTENT"]);
    // La suscripción one-shot se dio de baja.
    expect(s.sent).toContainEqual({ type: "unsubscribe", topic: "run:r1" });
  });
});
