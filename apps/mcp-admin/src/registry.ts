/**
 * Registro y despacho de tools del MCP admin.
 *
 * Los DOS perfiles comparten la misma base de código (ARCHITECTURE §7):
 * todas las tools se registran siempre; en `ro` el despacho rechaza toda
 * mutación con `read_only_profile` ANTES de validar argumentos (fail-closed).
 */
import { errors } from "@agentos/shared";
import type { z } from "zod";
import type { AdminContext } from "./context.js";
import { AdminErrorCodes, McpAdminError } from "./errors.js";

export interface AdminToolDefinition<
  S extends z.ZodObject<z.ZodRawShape> = z.ZodObject<z.ZodRawShape>,
> {
  /** Nombre canónico `agentos.<dominio>.<acción>`. */
  name: string;
  description: string;
  schema: S;
  /** true = disponible en perfil ro; false = mutación (solo rw). */
  readOnly: boolean;
  handler: (ctx: AdminContext, args: z.infer<S>) => unknown | Promise<unknown>;
}

/** Helper con inferencia: el handler recibe args tipados por su schema. */
export function defineAdminTool<S extends z.ZodObject<z.ZodRawShape>>(
  def: AdminToolDefinition<S>,
): AdminToolDefinition {
  return def as unknown as AdminToolDefinition;
}

export function buildAdminCatalog(groups: AdminToolDefinition[][]): Map<string, AdminToolDefinition> {
  const catalog = new Map<string, AdminToolDefinition>();
  for (const group of groups) {
    for (const tool of group) {
      if (catalog.has(tool.name)) {
        throw errors.validation(`Tool duplicada en el MCP admin: ${tool.name}`);
      }
      catalog.set(tool.name, tool);
    }
  }
  return catalog;
}

/**
 * Despacho único: perfil → schema → handler. Lanza (no envuelve) para que
 * los tests puedan asertar códigos; la capa MCP convierte a payload isError.
 */
export async function dispatchAdminTool(
  catalog: ReadonlyMap<string, AdminToolDefinition>,
  ctx: AdminContext,
  name: string,
  rawArgs: unknown,
): Promise<unknown> {
  const tool = catalog.get(name);
  if (!tool) {
    throw new McpAdminError(AdminErrorCodes.UNKNOWN_TOOL, `Tool desconocida: ${name}`);
  }
  if (ctx.profile === "ro" && !tool.readOnly) {
    throw new McpAdminError(
      AdminErrorCodes.READ_ONLY_PROFILE,
      `Perfil ro: la mutación ${name} está prohibida (el perfil ro es el único expuesto a agentes)`,
      { tool: name, profile: ctx.profile },
    );
  }
  const parsed = tool.schema.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    throw errors.validation(`Argumentos inválidos para ${name}`, parsed.error.issues);
  }
  return tool.handler(ctx, parsed.data);
}
