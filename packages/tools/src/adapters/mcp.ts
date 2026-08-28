/**
 * Adaptador MCP in-process (ARCHITECTURE §4): el catálogo como servidor SDK de
 * @anthropic-ai/claude-agent-sdk. Con el server "agentos", ClaudeCodeRunner ve
 * las tools como `mcp__agentos__<tool>` (puntos → guiones bajos).
 * TODA ejecución pasa por el gateway (política + audit + Gate 2).
 */
import { createSdkMcpServer, tool as sdkTool } from "@anthropic-ai/claude-agent-sdk";
import { isAgentosError } from "@agentos/shared";
import { wireName } from "../catalog.js";
import type { ToolCallContext, ToolRuntime } from "../types.js";

export const MCP_SERVER_NAME = "agentos";

export interface AsSdkMcpServerOptions {
  /** Limita a estos nombres canónicos (p. ej. la allowlist del agente). */
  names?: string[];
  version?: string;
}

/** Config de servidor MCP in-process para las options de query() del Agent SDK. */
export function asSdkMcpServer(
  runtime: ToolRuntime,
  ctx: ToolCallContext,
  opts: AsSdkMcpServerOptions = {},
): ReturnType<typeof createSdkMcpServer> {
  const tools = [];
  for (const def of runtime.catalog.values()) {
    if (opts.names && !opts.names.includes(def.name)) continue;
    tools.push(
      sdkTool(wireName(def.name), def.description, def.schema.shape, async (args: unknown) => {
        try {
          const result = await runtime.execute(ctx, def.name, args);
          return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
        } catch (err) {
          // El error de dominio vuelve al agente como resultado con isError —
          // jamás rompe el turno del proveedor.
          const payload = isAgentosError(err)
            ? { status: "error", code: err.code, message: err.message }
            : { status: "error", message: err instanceof Error ? err.message : String(err) };
          return { content: [{ type: "text" as const, text: JSON.stringify(payload) }], isError: true };
        }
      }),
    );
  }
  return createSdkMcpServer({ name: MCP_SERVER_NAME, version: opts.version ?? "0.1.0", tools });
}
