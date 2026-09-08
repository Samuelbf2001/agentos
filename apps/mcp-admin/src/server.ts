/**
 * Servidor MCP `agentos-admin` (ARCHITECTURE §7): mismo catálogo para los dos
 * perfiles; el despacho aplica `ro` (mutación → read_only_profile) y todo error
 * vuelve al cliente como resultado isError con código estable — nunca rompe el turno.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AdminContext } from "./context.js";
import { toErrorPayload } from "./errors.js";
import {
  buildAdminCatalog,
  dispatchAdminTool,
  type AdminToolDefinition,
} from "./registry.js";
import { agentTools, promptTools } from "./tools/agents.js";
import { boardTools } from "./tools/board.js";
import { moduleTools } from "./tools/modules.js";
import { projectTools } from "./tools/projects.js";
import { runTools } from "./tools/runs.js";
import { approvalTools } from "./tools/approvals.js";
import { providerTools } from "./tools/providers.js";
import { knowledgeTools, methodologyTools, processTools } from "./tools/context-hub.js";
import { orgGraphTools } from "./tools/org-graph.js";
import { auditTools, configTools, peopleTools } from "./tools/system.js";

export const SERVER_NAME = "agentos-admin";
export const SERVER_VERSION = "0.1.0";

export function buildAdminToolCatalog(): Map<string, AdminToolDefinition> {
  return buildAdminCatalog([
    agentTools,
    promptTools,
    boardTools,
    projectTools,
    moduleTools,
    runTools,
    approvalTools,
    providerTools,
    knowledgeTools,
    processTools,
    orgGraphTools,
    methodologyTools,
    configTools,
    peopleTools,
    auditTools,
  ]);
}

function toJson(value: unknown): string {
  return JSON.stringify(value ?? null, null, 2);
}

/**
 * Construye una instancia McpServer sobre un contexto. Barata de crear: el
 * transporte HTTP stateless crea una por request; stdio usa una sola.
 */
export function createAdminServer(
  ctx: AdminContext,
  catalog: Map<string, AdminToolDefinition> = buildAdminToolCatalog(),
): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  for (const tool of catalog.values()) {
    server.registerTool(
      tool.name,
      {
        title: tool.name,
        description:
          ctx.profile === "ro" && !tool.readOnly
            ? `${tool.description} [PERFIL ro: esta mutación siempre responde read_only_profile]`
            : tool.description,
        inputSchema: tool.schema.shape,
        annotations: {
          readOnlyHint: tool.readOnly,
          destructiveHint: false,
          openWorldHint: false,
        },
      },
      async (args: unknown) => {
        try {
          const result = await dispatchAdminTool(catalog, ctx, tool.name, args);
          return { content: [{ type: "text" as const, text: toJson(result) }] };
        } catch (err) {
          return {
            content: [{ type: "text" as const, text: toJson(toErrorPayload(err)) }],
            isError: true,
          };
        }
      },
    );
  }
  return server;
}
