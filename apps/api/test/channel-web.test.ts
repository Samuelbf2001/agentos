/**
 * Canal web (ARCHITECTURE §9): mensaje → thread creado → run de Alex encolado;
 * duplicado por (channel, message_id) → deduped silencioso, sin segundo run.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getRun, getThread, listMessages, listRuns, listThreads } from "@agentos/db";
import { makeFixture, waitFor, type TestFixture } from "./helpers.js";

let fx: TestFixture;

beforeAll(async () => {
  fx = await makeFixture();
});
afterAll(async () => {
  await fx.close();
});

describe("canal web", () => {
  it("mensaje entrante crea thread, persiste mensaje y encola run de Alex", async () => {
    fx.aiRunner.setBehavior(() => ({ text: "Hola, soy Alex. Creo el proyecto y su backlog." }));

    const res = await fx.api.app.inject({
      method: "POST",
      url: "/v1/channels/web/events",
      headers: fx.authHeaders,
      payload: {
        external_user_id: "u-ernesto",
        external_chat_id: "chat-1",
        message_id: "msg-001",
        text: "Arranca un assessment para ACME S.A., 40 empleados, manufactura",
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { deduped: boolean; thread_id: string; run_id: string };
    expect(body.deduped).toBe(false);
    expect(body.run_id).toBeTruthy();

    const thread = getThread(fx.db, body.thread_id)!;
    expect(thread.channel).toBe("web");
    expect(thread.sessionKey).toBe("web:chat-1:main");

    // Run de Alex encolado con trigger 'chat'.
    const run = getRun(fx.db, body.run_id)!;
    expect(run.trigger).toBe("chat");
    expect(run.agentId).toBe(fx.alex.id);

    // El runner fake termina y el mensaje del asistente aterriza en el thread.
    await waitFor(() => getRun(fx.db, body.run_id)!.status === "succeeded", {
      label: "run de chat terminado",
    });
    const messages = await waitFor(() => {
      const all = listMessages(fx.db, body.thread_id);
      return all.some((m) => m.role === "assistant") ? all : undefined;
    });
    const assistant = messages.find((m) => m.role === "assistant")!;
    expect(assistant.content).toContain("soy Alex");
    expect(assistant.runId).toBe(body.run_id);

    // La salida final se publicó al topic del canal y al del thread.
    const channelEvents = fx.api.ctx.bus.getSince("channel:web", 0);
    expect(channelEvents.some((e) => e.type === "message.final")).toBe(true);
    const threadEvents = fx.api.ctx.bus.getSince(`thread:${body.thread_id}`, 0);
    expect(threadEvents.some((e) => e.type === "TEXT_MESSAGE_CONTENT")).toBe(true);
    expect(threadEvents.some((e) => e.type === "message.final")).toBe(true);
  });

  it("duplicado por message_id → 200 {deduped:true} y ningún segundo run", async () => {
    const runsBefore = listRuns(fx.db, {}).length;
    const threadsBefore = listThreads(fx.db, "web").length;

    const res = await fx.api.app.inject({
      method: "POST",
      url: "/v1/channels/web/events",
      headers: fx.authHeaders,
      payload: {
        external_user_id: "u-ernesto",
        external_chat_id: "chat-1",
        message_id: "msg-001", // MISMO message_id
        text: "Arranca un assessment para ACME S.A., 40 empleados, manufactura",
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { deduped: boolean; run_id: string | null };
    expect(body.deduped).toBe(true);
    expect(body.run_id).toBeNull();

    expect(listRuns(fx.db, {}).length).toBe(runsBefore);
    expect(listThreads(fx.db, "web").length).toBe(threadsBefore);
  });

  it("sin sesión ni secreto de canal → 401", async () => {
    const res = await fx.api.app.inject({
      method: "POST",
      url: "/v1/channels/web/events",
      payload: {
        external_user_id: "u",
        external_chat_id: "c",
        message_id: "msg-401",
        text: "hola",
      },
    });
    expect(res.statusCode).toBe(401);
  });
});
