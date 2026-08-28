/** Procesos mapeados (entidad de primera clase, §8b): processes.list/get/upsert/link_source. */
import { z } from "zod";
import { errors, ProcessStatus, ProcessStep, ProcessVariant } from "@agentos/shared";
import { getProcess, linkSource, listProcesses, upsertProcess } from "@agentos/db";
import type { ToolDefinition } from "../types.js";
import { defineTool as def } from "../catalog.js";

export const processTools: ToolDefinition[] = [
  def({
    name: "processes.list",
    description: "Lista los procesos mapeados de una organización.",
    schema: z.object({ org_id: z.string().optional() }),
    flags: { read_only: true, external_effect: false, requires_approval: false },
    handler(ctx, args) {
      return listProcesses(ctx.db, args.org_id);
    },
  }),

  def({
    name: "processes.get",
    description: "Lee un proceso mapeado (pasos SIPOC, sistemas, pain points, fuentes).",
    schema: z.object({ process_id: z.string().min(1) }),
    flags: { read_only: true, external_effect: false, requires_approval: false },
    handler(ctx, args) {
      const proc = getProcess(ctx.db, args.process_id);
      if (!proc) throw errors.notFound("process", args.process_id);
      return proc;
    },
  }),

  def({
    name: "processes.upsert",
    description:
      "Crea o actualiza un proceso mapeado como entidad (nombre, dueño, as_is/to_be, pasos, sistemas, pain points, refs ISO). " +
      "Incluye source_doc_ids con los doc ids del Context Hub que lo sustentan (provenance, CA-12.5).",
    schema: z.object({
      id: z.string().optional(),
      org_id: z.string().min(1),
      name: z.string().min(1),
      owner_person: z.string().optional(),
      variant: ProcessVariant.optional(),
      steps: z.array(ProcessStep).optional(),
      systems: z.array(z.string()).optional(),
      pain_points: z.array(z.string()).optional(),
      iso_refs: z.array(z.string()).optional(),
      source_doc_ids: z
        .array(z.string().min(1))
        .optional()
        .describe("doc ids del Context Hub que sustentan el proceso (entrevistas, evidencia)"),
      status: ProcessStatus.optional(),
    }),
    flags: { read_only: false, external_effect: false, requires_approval: false },
    handler(ctx, args) {
      const process = upsertProcess(ctx.db, {
        id: args.id,
        orgId: args.org_id,
        name: args.name,
        ownerPerson: args.owner_person ?? null,
        variant: args.variant ?? "as_is",
        steps: args.steps ?? null,
        systems: args.systems ?? null,
        painPoints: args.pain_points ?? null,
        isoRefs: args.iso_refs ?? null,
        ...(args.source_doc_ids !== undefined ? { sourceDocIds: args.source_doc_ids } : {}),
        status: args.status ?? "draft",
      });
      // H8: un as_is sin fuentes viola la regla de provenance — se acepta (draft)
      // pero se devuelve el aviso para que el agente lo corrija con link_source.
      if ((process.sourceDocIds ?? []).length === 0 && process.variant === "as_is") {
        return {
          ...process,
          warning:
            "Proceso as_is SIN source_doc_ids: enlaza sus fuentes (processes.link_source o source_doc_ids) antes de darlo por terminado (provenance, CA-12.5)",
        };
      }
      return process;
    },
  }),

  def({
    name: "processes.link_source",
    description: "Enlaza un knowledge_doc como fuente que sustenta el proceso (provenance).",
    schema: z.object({ process_id: z.string().min(1), doc_id: z.string().min(1) }),
    flags: { read_only: false, external_effect: false, requires_approval: false },
    handler(ctx, args) {
      return linkSource(ctx.db, args.process_id, args.doc_id);
    },
  }),
];
