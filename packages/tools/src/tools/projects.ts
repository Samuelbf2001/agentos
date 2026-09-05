/** Tools de proyectos: projects.get / projects.update. */
import { z } from "zod";
import { errors, Stage } from "@agentos/shared";
import { getProject, updateProject } from "@agentos/db";
import type { ToolDefinition } from "../types.js";
import { defineTool as def } from "../catalog.js";

export const projectTools: ToolDefinition[] = [
  def({
    name: "projects.get",
    description: "Devuelve un proyecto (tipo, etapa, gate_state, workspace).",
    schema: z.object({ project_id: z.string().min(1) }),
    flags: { read_only: true, external_effect: false, requires_approval: false },
    async handler(ctx, args) {
      const project = await getProject(ctx.db, args.project_id);
      if (!project) throw errors.notFound("project", args.project_id);
      return project;
    },
  }),
  def({
    name: "projects.update",
    description:
      "Actualiza nombre/etapa/workspace de un proyecto con expected_version (el gate G1 NO se toca por aquí: usa approveGate humano).",
    schema: z.object({
      project_id: z.string().min(1),
      expected_version: z.number().int().positive(),
      name: z.string().min(1).optional(),
      stage: Stage.optional(),
      workspace_path: z.string().optional(),
    }),
    flags: { read_only: false, external_effect: false, requires_approval: false },
    handler(ctx, args) {
      const patch: Record<string, unknown> = {};
      if (args.name !== undefined) patch.name = args.name;
      if (args.stage !== undefined) patch.stage = args.stage;
      if (args.workspace_path !== undefined) patch.workspacePath = args.workspace_path;
      if (Object.keys(patch).length === 0) {
        throw errors.validation("projects.update sin campos que actualizar");
      }
      return updateProject(ctx.db, args.project_id, patch, args.expected_version);
    },
  }),
];
