/**
 * 2brain › Conversaciones (REST): proxy de solo lectura de los chats de
 * WhatsApp del agente y su registro de acciones. Conector SIEMPRE mock —
 * ninguna llamada real sale de los tests.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SourceConnectorError, type WhatsAppHubConnector } from "@agentos/shared";
import { makeFixture, type TestFixture } from "./helpers.js";

interface HubCall {
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
}

interface MockState {
  fail: boolean;
  calls: HubCall[];
}

const NOT_IMPLEMENTED = async () => {
  throw new Error("not implemented");
};

function makeMockConnector(state: MockState): WhatsAppHubConnector {
  return {
    isConfigured: () => true,
    listMeetings: NOT_IMPLEMENTED,
    getMeeting: NOT_IMPLEMENTED,
    getMeetingMarkdown: NOT_IMPLEMENTED,
    listContacts: NOT_IMPLEMENTED,
    getDossierMarkdown: NOT_IMPLEMENTED,
    async hubGetJson(path, query) {
      state.calls.push({ path, query });
      if (state.fail) {
        throw new SourceConnectorError(
          "unreachable",
          "No se pudo conectar con WhatsAppHub (/api/agent). ¿VPS caído? Reintenta más tarde.",
        );
      }
      if (path === "/api/agent/chats") {
        return {
          count: 1,
          threads: [
            {
              phone: "584121234567",
              lastBody: "Se volvió a parar la línea 2",
              lastAt: "2026-09-01T10:00:00.000Z",
              count: 3,
              // Clave que el hub podría añadir mañana: NO debe llegar al cliente.
              internalDebugFlag: true,
            },
          ],
        };
      }
      if (path === "/api/agent/chats/584121234567/messages") {
        return {
          phone: "584121234567",
          count: 1,
          messages: [
            {
              id: 1,
              phone: "584121234567",
              direction: "in",
              body: "Se volvió a parar la línea 2, el plan no llegó.",
              wamid: "wamid-secreto-1",
              created_at: "2026-09-01T10:00:00.000Z",
            },
          ],
        };
      }
      if (path === "/api/agent/actions") {
        return {
          count: 1,
          actions: [
            {
              id: 9,
              location_id: "default",
              action_type: "wiki_notes",
              status: "done",
              payload: { to: "584121234567", note: "Recordatorio" },
              result: { ok: true },
              created_at: "2026-09-01T09:00:00.000Z",
            },
          ],
        };
      }
      throw new Error(`ruta no mockeada en el test: ${path}`);
    },
    hubSendJson: NOT_IMPLEMENTED,
    hubGetText: NOT_IMPLEMENTED,
    hubGetRaw: NOT_IMPLEMENTED,
  };
}

describe("2brain › Conversaciones (REST)", () => {
  let fx: TestFixture;
  let state: MockState;

  beforeEach(async () => {
    state = { fail: false, calls: [] };
    fx = await makeFixture({ whatsappHub: makeMockConnector(state) });
  });

  afterEach(async () => {
    await fx.close();
  });

  it("exige sesión (401 sin token)", async () => {
    const res = await fx.api.app.inject({ method: "GET", url: "/api/brain/conversaciones/chats" });
    expect(res.statusCode).toBe(401);
  });

  it("GET /chats devuelve los hilos y descarta claves que la vista no usa", async () => {
    const res = await fx.api.app.inject({
      method: "GET",
      url: "/api/brain/conversaciones/chats",
      headers: fx.authHeaders,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { threads: Array<Record<string, unknown>> };
    expect(body.threads).toHaveLength(1);
    expect(body.threads[0]).toEqual({
      phone: "584121234567",
      lastBody: "Se volvió a parar la línea 2",
      lastAt: "2026-09-01T10:00:00.000Z",
      count: 3,
    });
    expect(body.threads[0]).not.toHaveProperty("internalDebugFlag");
    expect(state.calls[0]?.path).toBe("/api/agent/chats");
  });

  it("GET /chats/:phone/messages valida el limit de entrada (400 si no es 1..500)", async () => {
    const res = await fx.api.app.inject({
      method: "GET",
      url: "/api/brain/conversaciones/chats/584121234567/messages?limit=0",
      headers: fx.authHeaders,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_error");
  });

  it("GET /chats/:phone/messages devuelve mensajes, con 200 de límite por defecto", async () => {
    const res = await fx.api.app.inject({
      method: "GET",
      url: "/api/brain/conversaciones/chats/584121234567/messages",
      headers: fx.authHeaders,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { phone: string; messages: Array<Record<string, unknown>> };
    expect(body.phone).toBe("584121234567");
    expect(body.messages).toEqual([
      {
        id: 1,
        direction: "in",
        body: "Se volvió a parar la línea 2, el plan no llegó.",
        created_at: "2026-09-01T10:00:00.000Z",
      },
    ]);
    expect(body.messages[0]).not.toHaveProperty("wamid");
    expect(state.calls[0]).toEqual({
      path: "/api/agent/chats/584121234567/messages",
      query: { limit: 200 },
    });
  });

  it("GET /chats/:phone/messages pasa un limit explícito al hub", async () => {
    const res = await fx.api.app.inject({
      method: "GET",
      url: "/api/brain/conversaciones/chats/584121234567/messages?limit=50",
      headers: fx.authHeaders,
    });
    expect(res.statusCode).toBe(200);
    expect(state.calls[0]?.query).toEqual({ limit: 50 });
  });

  it("GET /acciones filtra por status y limit, y descarta location_id", async () => {
    const res = await fx.api.app.inject({
      method: "GET",
      url: "/api/brain/conversaciones/acciones?status=done&limit=10",
      headers: fx.authHeaders,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { actions: Array<Record<string, unknown>> };
    expect(body.actions).toEqual([
      {
        id: 9,
        action_type: "wiki_notes",
        status: "done",
        payload: { to: "584121234567", note: "Recordatorio" },
        result: { ok: true },
        created_at: "2026-09-01T09:00:00.000Z",
      },
    ]);
    expect(body.actions[0]).not.toHaveProperty("location_id");
    expect(state.calls[0]).toEqual({ path: "/api/agent/actions", query: { limit: 10, status: "done" } });
  });

  it("GET /acciones sin status no manda el filtro al hub", async () => {
    const res = await fx.api.app.inject({
      method: "GET",
      url: "/api/brain/conversaciones/acciones",
      headers: fx.authHeaders,
    });
    expect(res.statusCode).toBe(200);
    expect(state.calls[0]).toEqual({ path: "/api/agent/actions", query: { limit: 100 } });
  });

  it("502 provider_error legible cuando el hub falla", async () => {
    state.fail = true;
    const res = await fx.api.app.inject({
      method: "GET",
      url: "/api/brain/conversaciones/chats",
      headers: fx.authHeaders,
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe("provider_error");
  });
});
