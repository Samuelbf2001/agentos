/**
 * WebSocket multiplexado por topics (ARCHITECTURE §2):
 *
 * - Auth por token de sesión (?token=... en la URL); inválido → close 4401.
 * - Mensajes de control mínimos: subscribe/unsubscribe {topic, since_seq} y
 *   ping/pong. Las ACCIONES van por REST — el WS es optimización, nunca fuente
 *   de verdad.
 * - subscribe con since_seq sirve el hueco con getSince del bus (ring buffer o
 *   DB) y sigue en vivo sin perder ni duplicar seq (todo el handler es síncrono
 *   sobre el bus mono-proceso).
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import { isValidTopic } from "@agentos/events";
import type { PersistedEvent } from "@agentos/db";
import type { ApiContext } from "./context.js";

interface Subscription {
  unsubscribe: () => void;
}

export function registerWs(app: FastifyInstance, ctx: ApiContext): void {
  app.get("/ws", { websocket: true }, (socket: WebSocket, req: FastifyRequest) => {
    const query = req.query as { token?: string };
    const session = ctx.auth.verifyToken(query.token ?? null);
    if (!session) {
      socket.close(4401, "unauthorized");
      return;
    }

    const subs = new Map<string, Subscription>();

    const send = (payload: unknown): void => {
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify(payload));
      }
    };

    const sendEvent = (event: PersistedEvent): void => {
      send({
        type: "event",
        topic: event.topic,
        seq: event.seq,
        event: {
          id: event.id,
          type: event.type,
          payload: event.payload,
          run_id: event.runId,
          created_at: event.createdAt,
        },
      });
    };

    function subscribe(topic: string, sinceSeq: number | undefined): void {
      if (!isValidTopic(topic)) {
        send({ type: "error", code: "invalid_topic", topic });
        return;
      }
      subs.get(topic)?.unsubscribe();
      subs.delete(topic);

      // Sin since_seq: solo en vivo desde el último seq persistido.
      let lastSent = sinceSeq ?? ctx.bus.lastSeq(topic);

      // 1) Hueco primero (síncrono: nada puede intercalarse en un solo proceso).
      if (sinceSeq !== undefined) {
        for (const event of ctx.bus.getSince(topic, sinceSeq)) {
          sendEvent(event);
          lastSent = event.seq;
        }
      }
      // 2) En vivo, filtrando cualquier seq ya servido.
      const unsubscribe = ctx.bus.subscribe(topic, (event) => {
        if (event.seq <= lastSent) return;
        lastSent = event.seq;
        sendEvent(event);
      });
      subs.set(topic, { unsubscribe });
      send({ type: "subscribed", topic, last_seq: lastSent });
    }

    socket.on("message", (raw: Buffer | string) => {
      let msg: { type?: string; topic?: string; since_seq?: number };
      try {
        msg = JSON.parse(String(raw));
      } catch {
        send({ type: "error", code: "invalid_json" });
        return;
      }
      switch (msg.type) {
        case "subscribe": {
          if (typeof msg.topic !== "string") {
            send({ type: "error", code: "missing_topic" });
            return;
          }
          const since =
            typeof msg.since_seq === "number" && msg.since_seq >= 0 ? msg.since_seq : undefined;
          subscribe(msg.topic, since);
          return;
        }
        case "unsubscribe": {
          if (typeof msg.topic !== "string") return;
          subs.get(msg.topic)?.unsubscribe();
          subs.delete(msg.topic);
          send({ type: "unsubscribed", topic: msg.topic });
          return;
        }
        case "ping": {
          send({ type: "pong", ts: Date.now() });
          return;
        }
        default:
          send({ type: "error", code: "unknown_message_type" });
      }
    });

    const cleanup = (): void => {
      for (const sub of subs.values()) sub.unsubscribe();
      subs.clear();
    };
    socket.on("close", cleanup);
    socket.on("error", cleanup);

    send({ type: "hello", person_id: session.personId, ts: Date.now() });
  });
}
