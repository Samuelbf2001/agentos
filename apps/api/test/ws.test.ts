/**
 * WebSocket /ws: subscribe con since_seq recupera el hueco; un evento nuevo
 * llega en vivo sin duplicar seq; token inválido → rechazo (close 4401).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { publishRaw } from "../src/bus-bridge.js";
import { makeFixture, waitFor, type TestFixture } from "./helpers.js";

let fx: TestFixture;
let baseUrl: string;

beforeAll(async () => {
  fx = await makeFixture();
  await fx.api.app.listen({ port: 0, host: "127.0.0.1" });
  const address = fx.api.app.server.address();
  if (typeof address === "string" || address === null) throw new Error("sin puerto");
  baseUrl = `ws://127.0.0.1:${address.port}/ws`;
});
afterAll(async () => {
  await fx.close();
});

interface WsEventMsg {
  type: string;
  topic?: string;
  seq?: number;
  event?: { type: string; payload: unknown };
  [k: string]: unknown;
}

function collect(socket: WebSocket): WsEventMsg[] {
  const received: WsEventMsg[] = [];
  socket.on("message", (raw) => {
    received.push(JSON.parse(String(raw)) as WsEventMsg);
  });
  return received;
}

function connect(token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${baseUrl}?token=${encodeURIComponent(token)}`);
    socket.on("open", () => resolve(socket));
    socket.on("error", reject);
  });
}

describe("WebSocket multiplexado", () => {
  it("subscribe con since_seq sirve el hueco y sigue en vivo sin duplicar", async () => {
    const topic = `board:${fx.project.id}`;
    // Tres eventos ANTES de conectar (el "hueco").
    await publishRaw(fx.api.ctx.bus, topic, { type: "task.moved", payload: { n: 1 } });
    await publishRaw(fx.api.ctx.bus, topic, { type: "task.moved", payload: { n: 2 } });
    await publishRaw(fx.api.ctx.bus, topic, { type: "task.moved", payload: { n: 3 } });

    const socket = await connect(fx.token);
    const received = collect(socket);
    try {
      // Reconexión típica: el cliente vio hasta seq=1.
      socket.send(JSON.stringify({ type: "subscribe", topic, since_seq: 1 }));
      await waitFor(() => received.some((m) => m.type === "subscribed"), { label: "subscribed" });

      const backlog = received.filter((m) => m.type === "event");
      expect(backlog.map((m) => m.seq)).toEqual([2, 3]);

      // Evento nuevo en vivo.
      await publishRaw(fx.api.ctx.bus, topic, { type: "task.moved", payload: { n: 4 } });
      await waitFor(() => received.filter((m) => m.type === "event").length === 3, {
        label: "evento en vivo",
      });
      const seqs = received.filter((m) => m.type === "event").map((m) => m.seq);
      expect(seqs).toEqual([2, 3, 4]); // sin huecos ni duplicados

      // ping/pong.
      socket.send(JSON.stringify({ type: "ping" }));
      await waitFor(() => received.some((m) => m.type === "pong"), { label: "pong" });
    } finally {
      socket.close();
    }
  });

  it("un evento publicado MIENTRAS se lee el hueco se entrega exactamente una vez", async () => {
    const topic = "thread:ws-hueco";
    const bus = fx.api.ctx.bus;
    await publishRaw(bus, topic, { type: "message.inbound", payload: { n: 1 } });

    // Se instrumenta getSince para publicar justo antes y justo después de leer
    // el hueco: uno cae en el hueco Y en el buffer vivo (no debe duplicarse) y
    // el otro solo en el buffer vivo (antes se perdía: la suscripción se
    // registraba DESPUÉS de la lectura).
    const original = bus.getSince.bind(bus);
    bus.getSince = async (t: string, since?: number, limit?: number) => {
      if (t !== topic) return await original(t, since, limit);
      await publishRaw(bus, topic, { type: "message.inbound", payload: { n: 2 } });
      const out = await original(t, since, limit);
      await publishRaw(bus, topic, { type: "message.inbound", payload: { n: 3 } });
      return out;
    };

    const socket = await connect(fx.token);
    const received = collect(socket);
    try {
      socket.send(JSON.stringify({ type: "subscribe", topic, since_seq: 0 }));
      await waitFor(() => received.filter((m) => m.type === "event").length === 3, {
        label: "los tres eventos",
      });
      await new Promise((r) => setTimeout(r, 100)); // margen para un duplicado tardío
      expect(received.filter((m) => m.type === "event").map((m) => m.seq)).toEqual([1, 2, 3]);
    } finally {
      bus.getSince = original;
      socket.close();
    }
  });

  it("unsubscribe corta el flujo del topic", async () => {
    const topic = `thread:ws-test`;
    const socket = await connect(fx.token);
    const received = collect(socket);
    try {
      socket.send(JSON.stringify({ type: "subscribe", topic, since_seq: 0 }));
      await waitFor(() => received.some((m) => m.type === "subscribed"));
      socket.send(JSON.stringify({ type: "unsubscribe", topic }));
      await waitFor(() => received.some((m) => m.type === "unsubscribed"));

      await publishRaw(fx.api.ctx.bus, topic, { type: "message.inbound", payload: {} });
      await new Promise((r) => setTimeout(r, 100));
      expect(received.filter((m) => m.type === "event")).toHaveLength(0);
    } finally {
      socket.close();
    }
  });

  it("token inválido → close 4401", async () => {
    const closeCode = await new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(`${baseUrl}?token=invalido`);
      socket.on("close", (code) => resolve(code));
      socket.on("error", reject);
      setTimeout(() => reject(new Error("sin close")), 4000);
    });
    expect(closeCode).toBe(4401);
  });

  it("topic con forma inválida → error, sin suscripción", async () => {
    const socket = await connect(fx.token);
    const received = collect(socket);
    try {
      socket.send(JSON.stringify({ type: "subscribe", topic: "cualquier-cosa" }));
      await waitFor(() => received.some((m) => m.type === "error"), { label: "error" });
      expect(received.find((m) => m.type === "error")!.code).toBe("invalid_topic");
    } finally {
      socket.close();
    }
  });
});
