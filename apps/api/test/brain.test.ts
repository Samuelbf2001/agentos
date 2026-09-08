import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SourceConnectorError, type WhatsAppHubConnector } from "@agentos/shared";
import { createWhatsAppHubConnector } from "../src/connectors/whatsapphub.js";
import { makeFixture, type TestFixture } from "./helpers.js";

function emptyConnector(configured = false): WhatsAppHubConnector {
  return {
    isConfigured: () => configured,
    ...(configured ? { isOverviewConfigured: () => true } : {}),
    async listMeetings() {
      return { meetings: [] };
    },
    async getMeeting(id) {
      return { id };
    },
    async getMeetingMarkdown() {
      return "";
    },
    async listContacts() {
      return [];
    },
    async getDossierMarkdown() {
      return "";
    },
  };
}

async function overview(fx: TestFixture) {
  return fx.api.app.inject({
    method: "GET",
    url: "/api/brain/overview",
    headers: fx.authHeaders,
  });
}

describe("GET /api/brain/overview", () => {
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("requiere sesión", async () => {
    const fx = await makeFixture({ whatsappHub: emptyConnector() });
    try {
      const response = await fx.api.app.inject({ method: "GET", url: "/api/brain/overview" });
      expect(response.statusCode).toBe(401);
    } finally {
      await fx.close();
    }
  });

  it("expone datos locales reales sin correos/teléfonos y conserva el catálogo de etapas Notion", async () => {
    // Sin esto el test lee `<cwd>/data/notion-snapshots` y el resultado depende
    // de si la máquina tiene snapshots reales en disco: verde desde el paquete,
    // rojo desde la raíz del monorepo.
    vi.stubEnv("AGENTOS_NOTION_SNAPSHOT_PATH", path.join(os.tmpdir(), "agentos-brain-no-snapshot"));
    const fx = await makeFixture({ whatsappHub: emptyConnector() });
    try {
      const response = await overview(fx);
      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        core: { counts: Record<string, number>; people: Array<Record<string, unknown>> };
        agents: { items: Array<Record<string, unknown>> };
        sources: Array<Record<string, unknown>>;
      };
      const shape = response.json() as Record<string, unknown>;
      expect(Object.keys(shape)).toEqual(["generated_at", "core", "agents", "sources", "modules"]);
      expect(Object.keys(shape.agents as Record<string, unknown>)).toEqual(["items", "tree", "health"]);
      expect(body.core.counts).toMatchObject({
        projects: 1,
        tasks: 0,
        people: 1,
        internal_people: 1,
        agents: 2,
        knowledge_docs: 0,
        project_sources: 0,
      });
      expect(body.core.people[0]).toEqual({
        id: fx.person.id,
        full_name: "Ernesto",
        role: "Operador",
        is_internal: true,
      });
      expect(body.core.people[0]).not.toHaveProperty("email");
      expect(body.agents.items[0]).not.toHaveProperty("tools_allowlist");
      const notion = body.sources.find((item) => item.id === "notion")!;
      expect(notion.status).toBe("not_configured");
      expect(notion.stages).toEqual({
        tasks: ["Sin empezar", "StandBy/Sin Información", "Realizando", "En validación", "Completada"],
        projects: ["Sin empezar", "OnBoarding", "Implementacion", "En espera", "Finalizado", "Soporte Recurrente"],
      });
      expect(body.sources.find((item) => item.id === "agentos")?.status).toBe("connected");
      expect((shape.modules as Array<Record<string, unknown>>).every((item) =>
        typeof item.description === "string" &&
        ["available", "partial", "offline"].includes(String(item.status)),
      )).toBe(true);
    } finally {
      await fx.close();
    }
  });

  it("marca fuentes no configuradas sin inventar conteos", async () => {
    const fx = await makeFixture({ whatsappHub: emptyConnector() });
    try {
      vi.stubEnv("AGENTOS_LLM_WIKI_PATH", "");
      vi.stubEnv("AGENTOS_NOTION_SNAPSHOT_PATH", path.join(os.tmpdir(), "agentos-brain-no-snapshot"));
      const response = await overview(fx);
      const body = response.json() as { sources: Array<{ id: string; status: string; counts: Record<string, number> }> };
      expect(body.sources.find((item) => item.id === "whatsapphub")).toMatchObject({
        status: "not_configured",
        counts: {},
      });
      expect(body.sources.find((item) => item.id === "llm_wiki")).toMatchObject({
        status: "not_configured",
        counts: {},
      });
      expect(body.sources.find((item) => item.id === "notion")).toMatchObject({
        status: "not_configured",
        counts: {},
      });
    } finally {
      await fx.close();
    }
  });

  it("combina agregados remotos, inventario LLM Wiki y manifest Notion sin exponer IDs", async () => {
    const root = await fsTemp("agentos-brain-");
    temporaryRoots.push(root);
    const wiki = path.join(root, "wiki");
    const snapshots = path.join(root, "snapshots");
    await mkdir(path.join(wiki, "nested"), { recursive: true });
    await mkdir(path.join(snapshots, "run-1"), { recursive: true });
    await writeFile(path.join(wiki, "one.md"), "no se debe leer en esta ruta\n", "utf8");
    await writeFile(path.join(wiki, "nested", "two.MD"), "contenido privado\n", "utf8");
    await writeFile(path.join(wiki, "nested", "ignore.txt"), "texto\n", "utf8");
    await writeFile(
      path.join(snapshots, "run-1", "manifest.json"),
      JSON.stringify({
        captured_at: "2026-09-03T17:00:00.000Z",
        status: "completed",
        sources: [
          { key: "tasks", pages_captured: 12, page_ids: ["secret-task-id"] },
          { key: "projects", pages_captured: 3, page_ids: ["secret-project-id"] },
        ],
      }),
      "utf8",
    );
    vi.stubEnv("AGENTOS_LLM_WIKI_PATH", wiki);
    vi.stubEnv("AGENTOS_NOTION_SNAPSHOT_PATH", snapshots);

    const remote: WhatsAppHubConnector = {
      ...emptyConnector(false),
      isOverviewConfigured: () => true,
      async getWikiStats() {
        return {
          counts: { contacts: 363, messages_inbound: 12, messages_outbound: 9 },
          lastActivity: "2026-09-03T16:00:00.000Z",
        };
      },
      async getWikiPagesStatus() {
        return {
          total: 440,
          byType: { entity: 44, meeting: 21 },
          lastIngestedAt: "2026-09-03T15:00:00.000Z",
        };
      },
    };
    const fx = await makeFixture({ whatsappHub: remote });
    try {
      const response = await overview(fx);
      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        sources: Array<{ id: string; status: string; counts: Record<string, number>; last_snapshot_at?: string; stages?: unknown }>;
        modules: Array<{ id: string; source_id: string; status: string }>;
      };
      const remoteSource = body.sources.find((item) => item.id === "whatsapphub")!;
      expect(remoteSource).toMatchObject({
        status: "connected",
        counts: { contacts: 363, messages_inbound: 12, messages_outbound: 9, wiki_pages: 440, wiki_pages_entity: 44, wiki_pages_meeting: 21 },
      });
      const wikiSource = body.sources.find((item) => item.id === "llm_wiki")!;
      expect(wikiSource).toMatchObject({ status: "connected", counts: { markdown_files: 2 } });
      const notion = body.sources.find((item) => item.id === "notion")!;
      expect(notion).toMatchObject({ status: "connected", counts: { tasks: 12, projects: 3 }, last_snapshot_at: "2026-09-03T17:00:00.000Z" });
      expect(JSON.stringify(notion)).not.toContain("secret-task-id");
      expect(JSON.stringify(notion)).not.toContain("secret-project-id");
      expect(body.modules.find((item) => item.id === "wiki")).toMatchObject({ source_id: "llm_wiki", status: "available" });
      expect(body.modules.find((item) => item.id === "notion-migration")).toMatchObject({ source_id: "notion", status: "available" });
    } finally {
      await fx.close();
    }
  });

  it("degrada solo WhatsAppHub cuando falla uno de sus agregados", async () => {
    const remote: WhatsAppHubConnector = {
      ...emptyConnector(false),
      isOverviewConfigured: () => true,
      async getWikiStats() {
        throw new SourceConnectorError("unreachable", "sin detalles");
      },
      async getWikiPagesStatus() {
        return { total: 2, byType: {}, lastIngestedAt: null };
      },
    };
    const fx = await makeFixture({ whatsappHub: remote });
    try {
      const response = await overview(fx);
      const body = response.json() as { sources: Array<{ id: string; status: string; counts: Record<string, number> }> };
      expect(body.sources.find((item) => item.id === "whatsapphub")).toMatchObject({ status: "degraded", counts: { wiki_pages: 2 } });
      expect(body.sources.find((item) => item.id === "agentos")?.status).toBe("connected");
    } finally {
      await fx.close();
    }
  });

  it("no declara conectado un manifest Notion incompleto", async () => {
    const root = await fsTemp("agentos-brain-partial-notion-");
    temporaryRoots.push(root);
    await mkdir(path.join(root, "run-1"), { recursive: true });
    await writeFile(
      path.join(root, "run-1", "manifest.json"),
      JSON.stringify({
        captured_at: "2026-09-03T17:00:00.000Z",
        status: "completed",
        sources: [{ key: "tasks", pages_captured: 12 }],
      }),
      "utf8",
    );
    vi.stubEnv("AGENTOS_NOTION_SNAPSHOT_PATH", root);
    const fx = await makeFixture({ whatsappHub: emptyConnector() });
    try {
      const response = await overview(fx);
      const body = response.json() as { sources: Array<{ id: string; status: string; counts: Record<string, number> }> };
      expect(body.sources.find((item) => item.id === "notion")).toMatchObject({
        status: "degraded",
        counts: { tasks: 12 },
      });
    } finally {
      await fx.close();
    }
  });

  it("degrada WhatsAppHub si responde 200 con agregados inválidos", async () => {
    const invalidFetch: typeof fetch = async () => new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const remote = createWhatsAppHubConnector({ baseUrl: "https://example.invalid", fetchFn: invalidFetch });
    const fx = await makeFixture({ whatsappHub: remote });
    try {
      const response = await overview(fx);
      const body = response.json() as { sources: Array<{ id: string; status: string; counts: Record<string, number> }> };
      expect(body.sources.find((item) => item.id === "whatsapphub")).toMatchObject({
        status: "degraded",
        counts: {},
      });
    } finally {
      await fx.close();
    }
  });
});

async function fsTemp(prefix: string): Promise<string> {
  return await (await import("node:fs/promises")).mkdtemp(path.join(os.tmpdir(), prefix));
}
