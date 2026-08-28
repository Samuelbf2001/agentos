/**
 * Contexto y metodología (ARCHITECTURE §8b — el activo de la plataforma):
 * knowledge.* (Context Hub tipado con fuente), processes.* (entidades de
 * primera clase) y methodology.* (update crea VERSIÓN nueva, nunca pisa).
 */
import { z } from "zod";
import { errors, KnowledgeKind, ProcessStatus, ProcessStep, ProcessVariant } from "@agentos/shared";
import {
  getDoc,
  getMethodology,
  getProcess,
  listDocs,
  listMethodologies,
  listProcesses,
  searchDocs,
  upsertDoc,
  upsertMethodology,
  upsertProcess,
} from "@agentos/db";
import { auditMutation, findIdempotentMutation } from "../context.js";
import { defineAdminTool as def, type AdminToolDefinition } from "../registry.js";

const Reason = z.string().max(2000).optional();
const IdempotencyKey = z.string().min(1).max(200).optional();

export const knowledgeTools: AdminToolDefinition[] = [
  def({
    name: "agentos.knowledge.search",
    description: "Búsqueda FTS sobre el Context Hub (knowledge_docs).",
    schema: z.object({ query: z.string().min(1), limit: z.number().int().positive().max(100).optional() }),
    readOnly: true,
    handler(ctx, args) {
      return searchDocs(ctx.db, args.query, args.limit ?? 20);
    },
  }),

  def({
    name: "agentos.knowledge.get",
    description: "Devuelve un documento del Context Hub por id.",
    schema: z.object({ doc_id: z.string().min(1) }),
    readOnly: true,
    handler(ctx, args) {
      const doc = getDoc(ctx.db, args.doc_id);
      if (!doc) throw errors.notFound("knowledge_doc", args.doc_id);
      return doc;
    },
  }),

  def({
    name: "agentos.knowledge.list",
    description: "Lista documentos del Context Hub por organización, proyecto o tipo.",
    schema: z.object({
      org_id: z.string().optional(),
      project_id: z.string().optional(),
      kind: KnowledgeKind.optional(),
    }),
    readOnly: true,
    handler(ctx, args) {
      return listDocs(ctx.db, {
        orgId: args.org_id,
        projectId: args.project_id,
        kind: args.kind,
      });
    },
  }),

  def({
    name: "agentos.knowledge.upsert_doc",
    description:
      "Crea o actualiza (con id) un documento TIPADO del Context Hub, con source_refs (provenance).",
    schema: z.object({
      id: z.string().optional(),
      org_id: z.string().nullable().optional(),
      project_id: z.string().nullable().optional(),
      kind: KnowledgeKind,
      title: z.string().min(1),
      body_md: z.string().min(1),
      source_refs: z.array(z.record(z.string(), z.unknown())).optional(),
      tags: z.array(z.string()).optional(),
      reason: Reason,
      idempotency_key: IdempotencyKey,
    }),
    readOnly: false,
    handler(ctx, args) {
      const previous = findIdempotentMutation(ctx, "knowledge.upsert_doc", args.idempotency_key);
      if (previous?.entityId) {
        const existing = getDoc(ctx.db, previous.entityId);
        if (existing) return { doc: existing, idempotent: true };
      }
      const before = args.id ? getDoc(ctx.db, args.id) : undefined;
      const doc = upsertDoc(ctx.db, {
        id: args.id,
        orgId: args.org_id ?? before?.orgId ?? null,
        projectId: args.project_id ?? before?.projectId ?? null,
        kind: args.kind,
        title: args.title,
        bodyMd: args.body_md,
        sourceRefs: args.source_refs ?? before?.sourceRefs ?? null,
        tags: args.tags ?? before?.tags ?? null,
        createdBy: before?.createdBy ?? ctx.actor,
      });
      auditMutation(ctx, {
        action: "knowledge.upsert_doc",
        entityType: "knowledge_doc",
        entityId: doc.id,
        before: before ? { kind: before.kind, title: before.title, bodyMd: before.bodyMd } : null,
        after: { kind: doc.kind, title: doc.title, bodyMd: doc.bodyMd },
        reason: args.reason,
        idempotencyKey: args.idempotency_key,
      });
      return { doc };
    },
  }),
];

export const processTools: AdminToolDefinition[] = [
  def({
    name: "agentos.processes.list",
    description: "Lista procesos mapeados (opcionalmente por organización).",
    schema: z.object({ org_id: z.string().optional() }),
    readOnly: true,
    handler(ctx, args) {
      return listProcesses(ctx.db, args.org_id);
    },
  }),

  def({
    name: "agentos.processes.get",
    description: "Devuelve un proceso mapeado por id (pasos SIPOC, sistemas, pain points, refs ISO).",
    schema: z.object({ process_id: z.string().min(1) }),
    readOnly: true,
    handler(ctx, args) {
      const process = getProcess(ctx.db, args.process_id);
      if (!process) throw errors.notFound("process", args.process_id);
      return process;
    },
  }),

  def({
    name: "agentos.processes.upsert",
    description: "Crea o actualiza (con id) un proceso mapeado — entidad de primera clase, no un párrafo.",
    schema: z.object({
      id: z.string().optional(),
      org_id: z.string().min(1),
      name: z.string().min(1),
      owner_person: z.string().nullable().optional(),
      variant: ProcessVariant.optional(),
      steps: z.array(ProcessStep).optional(),
      systems: z.array(z.string()).optional(),
      pain_points: z.array(z.string()).optional(),
      iso_refs: z.array(z.string()).optional(),
      source_doc_ids: z.array(z.string()).optional(),
      status: ProcessStatus.optional(),
      reason: Reason,
      idempotency_key: IdempotencyKey,
    }),
    readOnly: false,
    handler(ctx, args) {
      const previous = findIdempotentMutation(ctx, "processes.upsert", args.idempotency_key);
      if (previous?.entityId) {
        const existing = getProcess(ctx.db, previous.entityId);
        if (existing) return { process: existing, idempotent: true };
      }
      const before = args.id ? getProcess(ctx.db, args.id) : undefined;
      const process = upsertProcess(ctx.db, {
        id: args.id,
        orgId: args.org_id,
        name: args.name,
        ownerPerson: args.owner_person ?? before?.ownerPerson ?? null,
        variant: args.variant ?? before?.variant ?? "as_is",
        steps: args.steps ?? before?.steps ?? null,
        systems: args.systems ?? before?.systems ?? null,
        painPoints: args.pain_points ?? before?.painPoints ?? null,
        isoRefs: args.iso_refs ?? before?.isoRefs ?? null,
        sourceDocIds: args.source_doc_ids ?? before?.sourceDocIds ?? null,
        status: args.status ?? before?.status ?? "draft",
      });
      auditMutation(ctx, {
        action: "processes.upsert",
        entityType: "process",
        entityId: process.id,
        before: before ? { name: before.name, status: before.status, variant: before.variant } : null,
        after: { name: process.name, status: process.status, variant: process.variant },
        reason: args.reason,
        idempotencyKey: args.idempotency_key,
      });
      return { process };
    },
  }),
];

export const methodologyTools: AdminToolDefinition[] = [
  def({
    name: "agentos.methodology.list",
    description: "Lista las metodologías registradas (todas las versiones).",
    schema: z.object({}),
    readOnly: true,
    handler(ctx) {
      return listMethodologies(ctx.db);
    },
  }),

  def({
    name: "agentos.methodology.get",
    description: "Devuelve una metodología por slug (última versión, o la versión pedida).",
    schema: z.object({ slug: z.string().min(1), version: z.number().int().positive().optional() }),
    readOnly: true,
    handler(ctx, args) {
      const methodology = getMethodology(ctx.db, args.slug, args.version);
      if (!methodology) {
        throw errors.notFound("methodology", `${args.slug}${args.version ? ` v${args.version}` : ""}`);
      }
      return methodology;
    },
  }),

  def({
    name: "agentos.methodology.update",
    description:
      "Actualiza una metodología creando una VERSIÓN nueva (slug, version+1) — el historial nunca se pisa.",
    schema: z.object({
      slug: z.string().min(1),
      body_md: z.string().min(1),
      changelog: z.string().optional(),
      reason: Reason,
    }),
    readOnly: false,
    handler(ctx, args) {
      const current = getMethodology(ctx.db, args.slug);
      const nextVersion = (current?.version ?? 0) + 1;
      const created = upsertMethodology(ctx.db, {
        slug: args.slug,
        version: nextVersion,
        bodyMd: args.body_md,
        changelog: args.changelog ?? `v${nextVersion} via MCP (${ctx.actor})`,
      });
      auditMutation(ctx, {
        action: "methodology.update",
        entityType: "methodology",
        entityId: created.id,
        before: current ? { slug: current.slug, version: current.version, bodyMd: current.bodyMd } : null,
        after: { slug: created.slug, version: created.version, bodyMd: created.bodyMd },
        reason: args.reason,
      });
      return { methodology: created, previous_version: current?.version ?? null };
    },
  }),
];
