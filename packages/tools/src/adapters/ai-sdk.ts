/**
 * Adaptador Vercel AI SDK (ARCHITECTURE §4): el catálogo entero como objetos
 * `tool()` para AiSdkRunner. TODA ejecución sigue pasando por el gateway
 * (política + audit); el adaptador no abre puertas.
 */
import { tool as aiTool, type Tool } from "ai";
import { wireName } from "../catalog.js";
import type { ToolCallContext, ToolRuntime } from "../types.js";

export interface AsAiSdkToolsOptions {
  /** Limita a estos nombres canónicos (p. ej. la allowlist del agente). */
  names?: string[];
}

/**
 * Devuelve `{ [nombre_de_cable]: tool() }` listo para `streamText({ tools })`.
 * Los nombres de cable sustituyen '.' por '_' (regla de proveedores);
 * el gateway se invoca SIEMPRE con el nombre canónico.
 */
export function asAiSdkTools(
  runtime: ToolRuntime,
  ctx: ToolCallContext,
  opts: AsAiSdkToolsOptions = {},
): Record<string, Tool> {
  const tools: Record<string, Tool> = {};
  for (const def of runtime.catalog.values()) {
    if (opts.names && !opts.names.includes(def.name)) continue;
    tools[wireName(def.name)] = aiTool({
      description: def.description,
      inputSchema: def.schema,
      execute: async (args: unknown) => runtime.execute(ctx, def.name, args),
    });
  }
  return tools;
}
