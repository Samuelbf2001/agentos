/**
 * artifacts.write — escribe un fichero bajo el workspace del proyecto y
 * registra la fila en `artifacts` (evidencia para la regla anti-teatro).
 */
import path from "node:path";
import fs from "node:fs";
import { z } from "zod";
import { errors } from "@agentos/shared";
import { attachArtifact, getProject, getTask } from "@agentos/db";
import type { ToolDefinition } from "../types.js";
import { defineTool as def } from "../catalog.js";

/** Rechaza rutas absolutas, `..` y backslashes: el artefacto vive DENTRO del workspace. */
function safeRelativePath(filename: string): string {
  const normalized = filename.replace(/\\/g, "/");
  if (path.isAbsolute(normalized) || /^[A-Za-z]:/.test(normalized)) {
    throw errors.validation(`filename debe ser relativo al workspace: ${filename}`);
  }
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length === 0 || segments.some((s) => s === "..")) {
    throw errors.validation(`filename inválido (sin '..' ni vacío): ${filename}`);
  }
  return segments.join("/");
}

export const artifactTools: ToolDefinition[] = [
  def({
    name: "artifacts.write",
    description:
      "Escribe un fichero bajo el workspace del proyecto y lo adjunta como artefacto de la tarea.",
    schema: z.object({
      task_id: z.string().min(1),
      filename: z.string().min(1),
      content: z.string(),
      kind: z.string().optional(),
      title: z.string().optional(),
    }),
    flags: { read_only: false, external_effect: false, requires_approval: false },
    async handler(ctx, args) {
      const task = await getTask(ctx.db, args.task_id);
      if (!task) throw errors.notFound("task", args.task_id);
      const project = await getProject(ctx.db, task.projectId);
      if (!project) throw errors.notFound("project", task.projectId);

      const base = project.workspacePath ?? path.join(ctx.workspaceRoot, project.id);
      const rel = safeRelativePath(args.filename);
      const fullPath = path.join(base, rel);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, args.content, "utf8");

      const artifact = await attachArtifact(ctx.db, {
        taskId: task.id,
        runId: ctx.run_id ?? null,
        kind: args.kind ?? "file",
        title: args.title ?? rel,
        path: fullPath,
        createdBy: ctx.actor,
      });
      await ctx.sink.publish(`board:${task.projectId}`, {
        type: "task.artifact_attached",
        payload: { taskId: task.id, artifactId: artifact.id, path: fullPath },
        runId: ctx.run_id ?? null,
      });
      return { artifact_id: artifact.id, path: fullPath };
    },
  }),
];
