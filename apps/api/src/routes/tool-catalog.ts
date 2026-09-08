/**
 * Catálogo de tools de dominio (para la UI: allowlist al "convertir en agente").
 */
import type { FastifyInstance } from "fastify";
import type { ApiContext } from "../context.js";

export function registerToolCatalogRoutes(app: FastifyInstance, ctx: ApiContext): void {
  app.get("/api/tools/catalog", async () => {
    const tools = [...ctx.toolRuntime.catalog.values()]
      .map((t) => ({
        name: t.name,
        description: t.description,
        read_only: t.flags.read_only,
        external_effect: t.flags.external_effect,
        requires_approval: t.flags.requires_approval,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { tools };
  });
}
