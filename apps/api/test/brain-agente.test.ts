/**
 * Agente 2brain (REST): estado, config y edición del prompt tras el conector
 * WhatsAppHub. Conector SIEMPRE mock — ninguna llamada real sale de los tests.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SourceConnectorError, type WhatsAppHubConnector } from "@agentos/shared";
import { queryAudit } from "@agentos/db";
import { makeFixture, type TestFixture } from "./helpers.js";

interface MockState {
  promptOverride: string | null;
  failStatus: boolean;
  calls: Array<{ method: string; path: string; body?: unknown }>;
}

const TOOLS = [
  { name: "notion.create_task", description: "Crea una tarea en Notion", input_schema: { type: "object" } },
  { name: "wiki.save_note", description: "Guarda una nota en el wiki", input_schema: { type: "object" }, secret_internal: "no-deberia-salir" },
];

const CHAT_TOOLS = [{ name: "whatsapp.send_reminder", description: "Envía un recordatorio", input_schema: null }];

function makeMockConnector(state: MockState): WhatsAppHubConnector {
  return {
    isConfigured: () => true,
    async listMeetings() {
      throw new Error("not implemented");
    },
    async getMeeting() {
      throw new Error("not implemented");
    },
    async getMeetingMarkdown() {
      throw new Error("not implemented");
    },
    async listContacts() {
      throw new Error("not implemented");
    },
    async getDossierMarkdown() {
      throw new Error("not implemented");
    },
    async hubGetText() {
      throw new Error("not implemented");
    },
    async hubGetRaw() {
      throw new Error("not implemented");
    },
    async hubGetJson(path) {
      state.calls.push({ method: "GET", path });
      if (path === "/api/agent/status") {
        if (state.failStatus) {
          throw new SourceConnectorError("unreachable", "No se pudo conectar con WhatsAppHub (/api/agent/status).");
        }
        return { notion: true, kapso: false, whatsapp_reminders: true, wiki_notes: true, api_secret_key: "no-deberia-salir" };
      }
      if (path === "/api/agent/config") {
        return {
          promptDefault: "Prompt por defecto de extracción.",
          promptOverride: state.promptOverride,
          promptEffective: state.promptOverride || "Prompt por defecto de extracción.",
          tools: TOOLS,
          chatTools: CHAT_TOOLS,
          chatEnabled: true,
          wiki_sync_key: "no-deberia-salir",
        };
      }
      throw new Error(`ruta no mockeada: ${path}`);
    },
    async hubSendJson(method, path, body) {
      state.calls.push({ method, path, body });
      if (path === "/api/agent/config") {
        const prompt = (body as { prompt: string | null }).prompt;
        state.promptOverride = prompt && prompt.trim() ? prompt.trim() : null;
        return {
          promptDefault: "Prompt por defecto de extracción.",
          promptOverride: state.promptOverride,
          promptEffective: state.promptOverride || "Prompt por defecto de extracción.",
          tools: TOOLS,
          chatTools: CHAT_TOOLS,
          chatEnabled: true,
        };
      }
      throw new Error(`ruta no mockeada: ${path}`);
    },
  };
}

describe("Agente 2brain (REST)", () => {
  let fx: TestFixture;
  let state: MockState;

  beforeEach(async () => {
    state = { promptOverride: null, failStatus: false, calls: [] };
    fx = await makeFixture({ whatsappHub: makeMockConnector(state) });
  });

  afterEach(async () => {
    await fx.close();
  });

  it("exige sesión (401 sin token)", async () => {
    const res = await fx.api.app.inject({ method: "GET", url: "/api/brain/agente/status" });
    expect(res.statusCode).toBe(401);
  });

  it("GET /status proxea el hub y filtra claves desconocidas", async () => {
    const res = await fx.api.app.inject({
      method: "GET",
      url: "/api/brain/agente/status",
      headers: fx.authHeaders,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual({ notion: true, kapso: false, whatsapp_reminders: true, wiki_notes: true });
    expect(body).not.toHaveProperty("api_secret_key");
  });

  it("GET /config expone el prompt y las herramientas, sin las claves ajenas del hub", async () => {
    const res = await fx.api.app.inject({
      method: "GET",
      url: "/api/brain/agente/config",
      headers: fx.authHeaders,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      prompt_default: string;
      prompt_override: string | null;
      prompt_effective: string;
      tools: Array<Record<string, unknown>>;
      chat_tools: Array<Record<string, unknown>>;
      chat_enabled: boolean;
    };
    expect(body.prompt_default).toBe("Prompt por defecto de extracción.");
    expect(body.prompt_override).toBeNull();
    expect(body.prompt_effective).toBe("Prompt por defecto de extracción.");
    expect(body.tools).toHaveLength(2);
    expect(body.tools[0]).toEqual({
      name: "notion.create_task",
      description: "Crea una tarea en Notion",
      input_schema: { type: "object" },
    });
    expect(body.tools[0]).not.toHaveProperty("secret_internal");
    expect(body.chat_tools).toHaveLength(1);
    expect(body.chat_enabled).toBe(true);
    expect(body).not.toHaveProperty("wiki_sync_key");
  });

  it("PUT /config guarda el override, lo refleja en prompt_effective y audita solo la longitud", async () => {
    const draft = "Extrae únicamente decisiones y compromisos con fecha.";
    const res = await fx.api.app.inject({
      method: "PUT",
      url: "/api/brain/agente/config",
      headers: fx.authHeaders,
      payload: { prompt: draft },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { prompt_override: string | null; prompt_effective: string };
    expect(body.prompt_override).toBe(draft);
    expect(body.prompt_effective).toBe(draft);
    expect(state.calls.at(-1)).toMatchObject({ method: "PUT", path: "/api/agent/config", body: { prompt: draft } });

    const entries = await queryAudit(fx.db, { action: "brain_agent.prompt_updated" });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.after).toMatchObject({ promptLength: draft.length, isOverride: true });
    expect(JSON.stringify(entries[0]!.after)).not.toContain(draft);
  });

  it("PUT /config con prompt null restablece el default", async () => {
    await fx.api.app.inject({
      method: "PUT",
      url: "/api/brain/agente/config",
      headers: fx.authHeaders,
      payload: { prompt: "algo temporal" },
    });
    const res = await fx.api.app.inject({
      method: "PUT",
      url: "/api/brain/agente/config",
      headers: fx.authHeaders,
      payload: { prompt: null },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { prompt_override: string | null; prompt_effective: string };
    expect(body.prompt_override).toBeNull();
    expect(body.prompt_effective).toBe("Prompt por defecto de extracción.");

    // queryAudit ordena descendente por fecha: la más reciente es este reset.
    const entries = await queryAudit(fx.db, { action: "brain_agent.prompt_updated" });
    expect(entries[0]!.after).toMatchObject({ promptLength: 0, isOverride: false });
  });

  it("PUT /config con más de 50 000 caracteres → 400", async () => {
    const res = await fx.api.app.inject({
      method: "PUT",
      url: "/api/brain/agente/config",
      headers: fx.authHeaders,
      payload: { prompt: "a".repeat(50_001) },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe("validation_error");
  });

  it("PUT /config con prompt no-string/no-null → 400", async () => {
    const res = await fx.api.app.inject({
      method: "PUT",
      url: "/api/brain/agente/config",
      headers: fx.authHeaders,
      payload: { prompt: 42 },
    });
    expect(res.statusCode).toBe(400);
  });

  it("error del conector → 502 legible (no cuelga)", async () => {
    state.failStatus = true;
    const res = await fx.api.app.inject({
      method: "GET",
      url: "/api/brain/agente/status",
      headers: fx.authHeaders,
    });
    expect(res.statusCode).toBe(502);
    expect((res.json() as { error: { code: string } }).error.code).toBe("provider_error");
  });
});
