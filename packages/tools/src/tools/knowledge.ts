/** Context Hub (ARCHITECTURE §8b): knowledge.search/get/upsert_doc/list. */
import { z } from "zod";
import { errors, KnowledgeKind } from "@agentos/shared";
import { getDoc, listDocs, searchDocs, upsertDoc } from "@agentos/db";
import type { ToolDefinition } from "../types.js";
import { defineTool as def } from "../catalog.js";

export const knowledgeTools: ToolDefinition[] = [
  def({
    name: "knowledge.search",
    description:
      "Busca en el Context Hub (FTS). Devuelve hits con doc id y snippet del contenido; usa knowledge.get para leer el doc completo.",
    schema: z.object({ query: z.string().min(1), limit: z.number().int().positive().max(50).optional() }),
    flags: { read_only: true, external_effect: false, requires_approval: false },
    handler(ctx, args) {
      return searchDocs(ctx.db, args.query, args.limit ?? 20);
    },
  }),

  def({
    name: "knowledge.get",
    description: "Lee un documento del Context Hub por id.",
    schema: z.object({ doc_id: z.string().min(1) }),
    flags: { read_only: true, external_effect: false, requires_approval: false },
    handler(ctx, args) {
      const doc = getDoc(ctx.db, args.doc_id);
      if (!doc) throw errors.notFound("knowledge_doc", args.doc_id);
      return doc;
    },
  }),

  def({
    name: "knowledge.upsert_doc",
    description:
      "Registra o actualiza un documento TIPADO del Context Hub (con fuente en source_refs). Todo hallazgo relevante va aquí.",
    schema: z.object({
      id: z.string().optional(),
      org_id: z.string().optional(),
      project_id: z.string().optional(),
      kind: KnowledgeKind,
      title: z.string().min(1),
      body_md: z.string().min(1),
      source_refs: z.array(z.record(z.string(), z.unknown())).optional(),
      tags: z.array(z.string()).optional(),
    }),
    flags: { read_only: false, external_effect: false, requires_approval: false },
    handler(ctx, args) {
      return upsertDoc(ctx.db, {
        id: args.id,
        orgId: args.org_id ?? null,
        projectId: args.project_id ?? ctx.project_id ?? null,
        kind: args.kind,
        title: args.title,
        bodyMd: args.body_md,
        sourceRefs: args.source_refs ?? null,
        tags: args.tags ?? null,
        createdBy: ctx.actor,
      });
    },
  }),

  def({
    name: "knowledge.list",
    description: "Lista documentos del Context Hub filtrando por org, proyecto o tipo.",
    schema: z.object({
      org_id: z.string().optional(),
      project_id: z.string().optional(),
      kind: KnowledgeKind.optional(),
    }),
    flags: { read_only: true, external_effect: false, requires_approval: false },
    handler(ctx, args) {
      return listDocs(ctx.db, { orgId: args.org_id, projectId: args.project_id, kind: args.kind });
    },
  }),
];
