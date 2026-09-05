/** Tools de proyectos, incl. Gate 1 (set_gate con person_id humano — core audita). */
import { z } from "zod";
import { errors, ProjectType, Stage } from "@agentos/shared";
import {
  createProject,
  getProject,
  listProjects,
  updateProject,
  type AgentosDb,
  type Project,
} from "@agentos/db";
import { GATE_G1_PLAN } from "@agentos/core";
import { auditMutation, findIdempotentMutation, mustGetPerson } from "../context.js";
import { defineAdminTool as def, type AdminToolDefinition } from "../registry.js";

const Reason = z.string().max(2000).optional();
const IdempotencyKey = z.string().min(1).max(200).optional();

async function mustGetProject(db: AgentosDb, id: string): Promise<Project> {
  const project = await getProject(db, id);
  if (!project) throw errors.notFound("project", id);
  return project;
}

function projectAuditFields(p: Project): Record<string, unknown> {
  return {
    name: p.name,
    type: p.type,
    stage: p.stage,
    gateState: p.gateState,
    workspacePath: p.workspacePath,
    version: p.version,
  };
}

export const projectTools: AdminToolDefinition[] = [
  def({
    name: "agentos.projects.list",
    description: "Lista proyectos (opcionalmente por organización).",
    schema: z.object({ org_id: z.string().optional() }),
    readOnly: true,
    async handler(ctx, args) {
      return await listProjects(ctx.db, args.org_id);
    },
  }),

  def({
    name: "agentos.projects.get",
    description: "Devuelve un proyecto por id (tipo, etapa, estado del Gate 1).",
    schema: z.object({ project_id: z.string().min(1) }),
    readOnly: true,
    async handler(ctx, args) {
      return await mustGetProject(ctx.db, args.project_id);
    },
  }),

  def({
    name: "agentos.projects.create",
    description: "Crea un proyecto (assessment|transform|ops) en etapa ENTENDER, gate pendiente.",
    schema: z.object({
      org_id: z.string().min(1),
      name: z.string().min(1),
      type: ProjectType,
      workspace_path: z.string().optional(),
      reason: Reason,
      idempotency_key: IdempotencyKey,
    }),
    readOnly: false,
    async handler(ctx, args) {
      const previous = await findIdempotentMutation(ctx, "projects.create", args.idempotency_key);
      if (previous?.entityId) {
        const existing = await getProject(ctx.db, previous.entityId);
        if (existing) return { project: existing, idempotent: true };
      }
      const project = await createProject(ctx.db, {
        orgId: args.org_id,
        name: args.name,
        type: args.type,
        workspacePath: args.workspace_path ?? null,
      });
      await auditMutation(ctx, {
        action: "projects.create",
        entityType: "project",
        entityId: project.id,
        before: null,
        after: projectAuditFields(project),
        reason: args.reason,
        idempotencyKey: args.idempotency_key,
      });
      return { project };
    },
  }),

  def({
    name: "agentos.projects.update",
    description: "Actualiza nombre/etapa/workspace de un proyecto con expected_version.",
    schema: z.object({
      project_id: z.string().min(1),
      expected_version: z.number().int().positive(),
      patch: z.object({
        name: z.string().min(1).optional(),
        stage: Stage.optional(),
        workspace_path: z.string().nullable().optional(),
      }),
      reason: Reason,
    }),
    readOnly: false,
    async handler(ctx, args) {
      const project = await mustGetProject(ctx.db, args.project_id);
      if (Object.keys(args.patch).length === 0) {
        throw errors.validation("projects.update con patch vacío: nada que hacer");
      }
      const before = projectAuditFields(project);
      const patch: Partial<Project> = {};
      if (args.patch.name !== undefined) patch.name = args.patch.name;
      if (args.patch.stage !== undefined) patch.stage = args.patch.stage;
      if (args.patch.workspace_path !== undefined) patch.workspacePath = args.patch.workspace_path;
      const updated = await updateProject(ctx.db, project.id, patch, args.expected_version);
      await auditMutation(ctx, {
        action: "projects.update",
        entityType: "project",
        entityId: project.id,
        before,
        after: projectAuditFields(updated),
        reason: args.reason,
      });
      return updated;
    },
  }),

  def({
    name: "agentos.projects.set_gate",
    description:
      "Aprueba el Gate 1 (g1_plan) de un proyecto con person_id humano — habilita las tareas de CONSTRUIR. " +
      "La auditoría la escribe el motor de core.",
    schema: z.object({
      project_id: z.string().min(1),
      gate: z.literal(GATE_G1_PLAN).default(GATE_G1_PLAN),
      person_id: z.string().min(1),
      note: z.string().optional(),
    }),
    readOnly: false,
    async handler(ctx, args) {
      const person = await mustGetPerson(ctx.db, args.person_id);
      const project = await ctx.engine.approveGate(args.project_id, GATE_G1_PLAN, person.id, args.note);
      return { project, gate: args.gate, approved_by: person.id };
    },
  }),
];
