/** Tools de tablero: tasks.* y board.get (día 1, ARCHITECTURE §4). */
import { z } from "zod";
import { errors, Stage, TaskPriority, TaskStatus, BlockedReason } from "@agentos/shared";
import {
  appendTaskEvent,
  attachArtifact,
  boardTasks,
  getAgentBySlug,
  getProject,
  getTask,
  listArtifacts,
  listTaskEvents,
  listTasks,
} from "@agentos/db";
import type { ToolDefinition } from "../types.js";
import { defineTool as def } from "../catalog.js";

export const taskTools: ToolDefinition[] = [
  def({
    name: "tasks.create",
    description:
      "Crea una tarea en BACKLOG del proyecto. requires_approval lo calcula la política de la plataforma (no se puede rebajar).",
    schema: z.object({
      project_id: z.string().min(1),
      title: z.string().min(1),
      stage: Stage,
      description: z.string().optional(),
      definition_of_done: z.string().optional(),
      activity_type: z.string().optional(),
      priority: TaskPriority.optional(),
      assignee_agent_slug: z.string().optional(),
      assignee_person_id: z.string().optional(),
      parent_task_id: z.string().optional(),
      external_effect: z.boolean().optional(),
      requires_approval: z.boolean().optional(),
    }),
    flags: { read_only: false, external_effect: false, requires_approval: false },
    handler(ctx, args) {
      let assigneeAgentId: string | null = null;
      if (args.assignee_agent_slug) {
        const agent = getAgentBySlug(ctx.db, args.assignee_agent_slug);
        if (!agent) throw errors.notFound("agent", args.assignee_agent_slug);
        assigneeAgentId = agent.id;
      }
      return ctx.engine.createTask(
        {
          projectId: args.project_id,
          title: args.title,
          stage: args.stage,
          description: args.description,
          definitionOfDone: args.definition_of_done,
          activityType: args.activity_type,
          priority: args.priority,
          assigneeAgentId,
          assigneePersonId: args.assignee_person_id ?? null,
          parentTaskId: args.parent_task_id ?? null,
          externalEffect: args.external_effect,
          requiresApproval: args.requires_approval,
        },
        { actor: ctx.actor, runId: ctx.run_id },
      );
    },
  }),

  def({
    name: "tasks.claim",
    description:
      "Reclama atómicamente una tarea READY con lease. {claimed:false} = otro la tomó primero (no es un error).",
    schema: z.object({ task_id: z.string().min(1), lease_ms: z.number().int().positive().optional() }),
    flags: { read_only: false, external_effect: false, requires_approval: false },
    handler(ctx, args) {
      return ctx.engine.claim({
        taskId: args.task_id,
        agentId: ctx.agent_id,
        runId: ctx.run_id,
        leaseMs: args.lease_ms,
      });
    },
  }),

  def({
    name: "tasks.move",
    description:
      "Mueve una tarea por la máquina de estados (con expected_version). REVIEW/DONE exigen artefacto; DONE con requires_approval exige humano.",
    schema: z.object({
      task_id: z.string().min(1),
      to: TaskStatus,
      expected_version: z.number().int().positive(),
      note: z.string().optional(),
      blocked_reason: BlockedReason.optional(),
    }),
    flags: { read_only: false, external_effect: false, requires_approval: false },
    handler(ctx, args) {
      return ctx.engine.moveTask({
        taskId: args.task_id,
        to: args.to,
        expectedVersion: args.expected_version,
        actor: ctx.actor,
        runId: ctx.run_id,
        note: args.note,
        blockedReason: args.blocked_reason,
      });
    },
  }),

  def({
    name: "tasks.comment",
    description: "Añade un comentario al timeline de la tarea (task_events, append-only).",
    schema: z.object({ task_id: z.string().min(1), body: z.string().min(1) }),
    flags: { read_only: false, external_effect: false, requires_approval: false },
    handler(ctx, args) {
      const task = getTask(ctx.db, args.task_id);
      if (!task) throw errors.notFound("task", args.task_id);
      const event = appendTaskEvent(ctx.db, {
        taskId: task.id,
        runId: ctx.run_id ?? null,
        kind: "comment",
        actor: ctx.actor,
        payload: { body: args.body },
      });
      ctx.sink.publish(`board:${task.projectId}`, {
        type: "task.commented",
        payload: { taskId: task.id, eventId: event.id, actor: ctx.actor },
        runId: ctx.run_id ?? null,
      });
      return event;
    },
  }),

  def({
    name: "tasks.attach_artifact",
    description:
      "Adjunta un artefacto (evidencia) a una tarea. Sin artefacto, la tarea no puede llegar a REVIEW ni DONE.",
    schema: z.object({
      task_id: z.string().min(1),
      kind: z.string().min(1),
      title: z.string().min(1),
      content: z.string().optional(),
      path: z.string().optional(),
    }),
    flags: { read_only: false, external_effect: false, requires_approval: false },
    handler(ctx, args) {
      const task = getTask(ctx.db, args.task_id);
      if (!task) throw errors.notFound("task", args.task_id);
      const artifact = attachArtifact(ctx.db, {
        taskId: task.id,
        runId: ctx.run_id ?? null,
        kind: args.kind,
        title: args.title,
        content: args.content ?? null,
        path: args.path ?? null,
        createdBy: ctx.actor,
      });
      ctx.sink.publish(`board:${task.projectId}`, {
        type: "task.artifact_attached",
        payload: { taskId: task.id, artifactId: artifact.id },
        runId: ctx.run_id ?? null,
      });
      return artifact;
    },
  }),

  def({
    name: "tasks.list",
    description: "Lista tareas filtrando por proyecto, estado o agente asignado.",
    schema: z.object({
      project_id: z.string().optional(),
      status: TaskStatus.optional(),
      assignee_agent_id: z.string().optional(),
    }),
    flags: { read_only: true, external_effect: false, requires_approval: false },
    handler(ctx, args) {
      return listTasks(ctx.db, {
        projectId: args.project_id,
        status: args.status,
        assigneeAgentId: args.assignee_agent_id,
      });
    },
  }),

  def({
    name: "tasks.get",
    description: "Devuelve una tarea con su timeline y artefactos.",
    schema: z.object({ task_id: z.string().min(1) }),
    flags: { read_only: true, external_effect: false, requires_approval: false },
    handler(ctx, args) {
      const task = getTask(ctx.db, args.task_id);
      if (!task) throw errors.notFound("task", args.task_id);
      return {
        task,
        events: listTaskEvents(ctx.db, task.id),
        artifacts: listArtifacts(ctx.db, task.id),
      };
    },
  }),

  def({
    name: "board.get",
    description: "Tablero de un proyecto: tareas agrupadas por estado (orden de columna).",
    schema: z.object({ project_id: z.string().min(1) }),
    flags: { read_only: true, external_effect: false, requires_approval: false },
    handler(ctx, args) {
      // H2: un project_id inexistente es not_found, NUNCA un tablero vacío OK
      // (un tablero vacío falso alimenta la alucinación de ids inventados).
      if (!getProject(ctx.db, args.project_id)) throw errors.notFound("project", args.project_id);
      const rows = boardTasks(ctx.db, args.project_id);
      const byStatus: Record<string, typeof rows> = {};
      for (const t of rows) (byStatus[t.status] ??= []).push(t);
      return { project_id: args.project_id, columns: byStatus, total: rows.length };
    },
  }),
];
