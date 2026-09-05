/**
 * WebSocket multiplexado por topics (ARCHITECTURE §2):
 *
 * - Auth por token de sesión (?token=... en la URL); inválido → close 4401.
 * - Mensajes de control mínimos: subscribe/unsubscribe {topic, since_seq} y
 *   ping/pong. Las ACCIONES van por REST — el WS es optimización, nunca fuente
 *   de verdad.
 * - subscribe con since_seq sirve el hueco con getSince del bus (ring buffer o
 *   DB) y sigue en vivo sin perder ni duplicar seq. Leer el hueco es ASÍNCRONO
 *   (la DB manda), así que el orden es: suscribirse PRIMERO a un buffer en
 *   memoria, leer el hueco, y volcar el buffer deduplicando por seq — nada
 *   publicado durante la lectura se pierde ni se entrega dos veces.
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

    async function subscribe(topic: string, sinceSeq: number | undefined): Promise<void> {
      if (!isValidTopic(topic)) {
        send({ type: "error", code: "invalid_topic", topic });
        return;
      }
      subs.get(topic)?.unsubscribe();
      subs.delete(topic);

      let lastSent = 0;
      const deliver = (event: PersistedEvent): void => {
        if (event.seq <= lastSent) return; // dedupe por seq
        lastSent = event.seq;
        sendEvent(event);
      };

      // 1) SUSCRIPCIÓN PRIMERO, a un buffer en memoria: leer el hueco cede el
      //    hilo (lastSeq/getSince van a la DB) y lo que se publique mientras
      //    tanto se perdía si nos suscribíamos después.
      let live = false;
      const pending: PersistedEvent[] = [];
      const unsubscribe = ctx.bus.subscribe(topic, (event) => {
        if (live) deliver(event);
        else pending.push(event);
      });
      const sub: Subscription = { unsubscribe };
      subs.set(topic, sub);

      // 2) Hueco. Sin since_seq: solo en vivo desde el último seq persistido.
      lastSent = sinceSeq ?? (await ctx.bus.lastSeq(topic));
      if (sinceSeq !== undefined) {
        for (const event of await ctx.bus.getSince(topic, sinceSeq)) deliver(event);
      }

      // La suscripción pudo reemplazarse (otro subscribe) o cerrarse el socket
      // mientras leíamos: en ese caso este volcado ya no es nuestro.
      if (subs.get(topic) !== sub) return;

      // 3) Volcado del buffer: `deliver` descarta lo que el hueco ya sirvió.
      for (const event of pending) deliver(event);
      pending.length = 0;
      live = true;
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
          const topic = msg.topic;
          const since =
            typeof msg.since_seq === "number" && msg.since_seq >= 0 ? msg.since_seq : undefined;
          void subscribe(topic, since).catch((err: unknown) => {
            app.log.error({ err, topic }, "ws: subscribe falló");
            send({ type: "error", code: "subscribe_failed", topic });
          });
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
