/**
 * delegate — crear tarea hija con payload tipado (depth máx 3, fan-out máx 4/run)
 * ask_human — pedir ayuda/decisión humana (crea approval; el humano decide en la bandeja)
 */
import { z } from "zod";
import { errors } from "@agentos/shared";
import { getTask } from "@agentos/db";
import type { ToolDefinition } from "../types.js";
import { defineTool as def } from "../catalog.js";

export const delegationTools: ToolDefinition[] = [
  def({
    name: "delegate",
    description:
      "Delega creando una tarea hija tipada asignada a otro agente. Límite: profundidad 3, fan-out 4 por run — al superarlo se RECHAZA (consolida o pide ayuda).",
    schema: z.object({
      tarea: z.string().min(1),
      limites: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
      forma_de_buena_respuesta: z.string().min(1),
      assignee: z.string().min(1).describe("slug del agente asignado"),
      parent_task_id: z.string().optional().describe("por defecto, la tarea actual del run"),
    }),
    flags: { read_only: false, external_effect: false, requires_approval: false },
    async handler(ctx, args) {
      const parentTaskId = args.parent_task_id ?? ctx.task_id;
      if (!parentTaskId) {
        throw errors.validation("delegate exige parent_task_id (o un run con tarea actual)");
      }
      return await ctx.engine.delegate({
        parentTaskId,
        payload: {
          tarea: args.tarea,
          limites: args.limites,
          forma_de_buena_respuesta: args.forma_de_buena_respuesta,
        },
        assignee: args.assignee,
        actor: ctx.actor,
        runId: ctx.run_id,
      });
    },
  }),

  def({
    name: "ask_human",
    description:
      "Pide una decisión o respuesta humana (kind question) o presenta un entregable (kind deliverable). Crea una aprobación pendiente; mueve tu tarea a BLOCKED (approval) y cierra el turno.",
    schema: z.object({
      kind: z.enum(["question", "deliverable"]),
      title: z.string().min(1),
      body: z.string().min(1),
      task_id: z.string().optional(),
    }),
    flags: { read_only: false, external_effect: false, requires_approval: false },
    async handler(ctx, args) {
      const taskId = args.task_id ?? ctx.task_id ?? null;
      const task = taskId ? await getTask(ctx.db, taskId) : null;
      // ApprovalKind no tiene 'question': se persiste como 'deliverable' con
      // payload.type distinguiendo pregunta vs entregable (schemas de shared son intocables).
      const approval = await ctx.engine.requestApproval({
        kind: "deliverable",
        payload: { type: args.kind, title: args.title, body: args.body, task_id: taskId },
        runId: ctx.run_id,
        taskId,
        projectId: task?.projectId ?? ctx.project_id ?? null,
        requestedBy: ctx.actor,
      });
      return { status: "pending_approval", approval_id: approval.id };
    },
  }),
];
