/**
 * Catálogo de tools (ARCHITECTURE §4): cada tool se declara UNA vez
 * {name, description, schema Zod, handler, flags} y se materializa en dos
 * adaptadores (AI SDK y MCP in-process). El gateway es la única puerta de ejecución.
 */
import { errors } from "@agentos/shared";
import type { z } from "zod";
import type { ToolDefinition } from "./types.js";
import { taskTools } from "./tools/tasks.js";
import { projectTools } from "./tools/projects.js";
import { artifactTools } from "./tools/artifacts.js";
import { delegationTools } from "./tools/delegation.js";
import { knowledgeTools } from "./tools/knowledge.js";
import { processTools } from "./tools/processes.js";
import { methodologyTools } from "./tools/methodology.js";
import { isoTools } from "./tools/iso.js";
import { emailTools } from "./tools/email.js";

/** Helper con inferencia de tipos: el handler recibe args ya tipados por su schema. */
export function defineTool<S extends z.ZodObject<z.ZodRawShape>>(d: ToolDefinition<S>): ToolDefinition {
  return d as unknown as ToolDefinition;
}

/** Nombre canónico (con puntos) → nombre de cable válido para proveedores/MCP. */
export function wireName(name: string): string {
  return name.replace(/\./g, "_");
}

/** Construye el catálogo día 1. Nombres duplicados = error de programación. */
export function buildCatalog(extra: ToolDefinition[] = []): Map<string, ToolDefinition> {
  const catalog = new Map<string, ToolDefinition>();
  const all = [
    ...taskTools,
    ...projectTools,
    ...artifactTools,
    ...delegationTools,
    ...knowledgeTools,
    ...processTools,
    ...methodologyTools,
    ...isoTools,
    ...emailTools,
    ...extra,
  ];
  for (const tool of all) {
    if (catalog.has(tool.name)) {
      throw errors.validation(`Tool duplicada en el catálogo: ${tool.name}`);
    }
    catalog.set(tool.name, tool);
  }
  return catalog;
}
