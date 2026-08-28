/**
 * Costura tools↔runners (B4): los runners declaran la interfaz laxa
 * `DomainTools` (asAiSdkTools/asSdkMcpServer) sin depender de @agentos/tools;
 * el paquete tools expone los adaptadores reales. Este módulo los une SIN
 * editar ninguno de los dos paquetes.
 *
 * Además resuelve la allowlist para claude_code: los nombres canónicos del
 * catálogo ("tasks.move") se ven desde el CLI como `mcp__agentos__tasks_move`;
 * las entradas sin punto (tools built-in tipo "Read"/"Bash") pasan tal cual.
 */
import type { ToolSet } from "ai";
import {
  asAiSdkTools,
  asSdkMcpServer,
  wireName,
  MCP_SERVER_NAME,
  type ToolCallContext,
  type ToolRuntime,
} from "@agentos/tools";
import type { DomainTools } from "@agentos/runners";

export interface BoundDomainTools extends DomainTools {
  /** ToolSet ya materializado para AiSdkRunner (input.tools). */
  toolSet: ToolSet;
}

/** Liga el catálogo al contexto de UN run concreto (ctx viaja en cada llamada). */
export function bindDomainTools(
  runtime: ToolRuntime,
  ctx: ToolCallContext,
  allowlist?: string[] | null,
): BoundDomainTools {
  const names = allowlist && allowlist.length > 0 ? allowlist : undefined;
  const opts = names ? { names } : {};
  return {
    toolSet: asAiSdkTools(runtime, ctx, opts) as unknown as ToolSet,
    asAiSdkTools: () => asAiSdkTools(runtime, ctx, opts) as Record<string, unknown>,
    asSdkMcpServer: () => asSdkMcpServer(runtime, ctx, opts),
  };
}

/**
 * Allowlist efectiva para el CLI de claude_code: tools de catálogo con
 * namespacing MCP + built-ins (sin punto) tal cual.
 */
export function claudeCodeAllowlist(allowlist: string[] | null | undefined): string[] {
  if (!allowlist) return [];
  return allowlist.map((name) =>
    name.includes(".") ? `mcp__${MCP_SERVER_NAME}__${wireName(name)}` : name,
  );
}
