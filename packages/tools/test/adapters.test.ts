import { describe, expect, it } from "vitest";
import { wireName } from "../src/catalog.js";
import { asAiSdkTools } from "../src/adapters/ai-sdk.js";
import { asSdkMcpServer, MCP_SERVER_NAME } from "../src/adapters/mcp.js";
import { toolsFixture } from "./helpers.js";

describe("wireName", () => {
  it("sustituye puntos por guiones bajos (regla de proveedores/MCP)", () => {
    expect(wireName("tasks.create")).toBe("tasks_create");
    expect(wireName("delegate")).toBe("delegate");
  });
});

describe("adaptador Vercel AI SDK", () => {
  it("materializa el catálogo completo con el MISMO schema Zod declarado", () => {
    const f = toolsFixture();
    const tools = asAiSdkTools(f.runtime, f.ctxFor(f.alex));
    expect(Object.keys(tools).length).toBe(f.runtime.catalog.size);
    for (const def of f.runtime.catalog.values()) {
      const t = tools[wireName(def.name)]!;
      expect(t).toBeDefined();
      expect(t.description).toBe(def.description);
      // El schema del catálogo ES el inputSchema del tool() — una sola definición.
      expect(t.inputSchema).toBe(def.schema);
      expect(typeof t.execute).toBe("function");
    }
  });

  it("execute pasa por el gateway (política + audit) y devuelve el resultado", async () => {
    const f = toolsFixture();
    const tools = asAiSdkTools(f.runtime, f.ctxFor(f.alex));
    const result = await tools.methodology_list!.execute!(
      {},
      { toolCallId: "t1", messages: [] },
    );
    expect(result).toMatchObject({ status: "ok" });
  });

  it("respeta el filtro de nombres (allowlist del agente)", () => {
    const f = toolsFixture();
    const tools = asAiSdkTools(f.runtime, f.ctxFor(f.quinn), {
      names: f.quinn.toolsAllowlist,
    });
    expect(Object.keys(tools).sort()).toEqual(["board_get", "tasks_get", "tasks_list"]);
  });
});

describe("adaptador MCP (createSdkMcpServer)", () => {
  it("crea el servidor in-process 'agentos' (namespacing mcp__agentos__<tool>)", () => {
    const f = toolsFixture();
    const server = asSdkMcpServer(f.runtime, f.ctxFor(f.alex));
    expect(server.type).toBe("sdk");
    expect(server.name).toBe(MCP_SERVER_NAME);
    expect(server.instance).toBeDefined();
  });

  it("acepta el filtro de nombres sin romper el server", () => {
    const f = toolsFixture();
    const server = asSdkMcpServer(f.runtime, f.ctxFor(f.quinn), { names: f.quinn.toolsAllowlist });
    expect(server.name).toBe(MCP_SERVER_NAME);
  });
});
