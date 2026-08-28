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
      "Crea o actualiza un proceso mapeado como entidad (nombre, dueño, as_is/to_be, pasos, sistemas, pain points, refs ISO).",
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
      status: ProcessStatus.optional(),
    }),
    flags: { read_only: false, external_effect: false, requires_approval: false },
    handler(ctx, args) {
      return upsertProcess(ctx.db, {
        id: args.id,
        orgId: args.org_id,
        name: args.name,
        ownerPerson: args.owner_person ?? null,
        variant: args.variant ?? "as_is",
        steps: args.steps ?? null,
        systems: args.systems ?? null,
        painPoints: args.pain_points ?? null,
        isoRefs: args.iso_refs ?? null,
        status: args.status ?? "draft",
      });
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
