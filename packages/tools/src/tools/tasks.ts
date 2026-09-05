/** Tools de tablero: tasks.* y board.get (día 1, ARCHITECTURE §4). */
import { z } from "zod";
import { errors, Stage, TaskPriority, TaskStatus, BlockedReason } from "@agentos/shared";
import {
  appendAudit,
  appendTaskEvent,
  attachArtifact,
  getAgentBySlug,
  getProject,
  getTask,
  getTaskWithAssignees,
  listDocs,
  listArtifacts,
  listProjectSources,
  listRunsForTask,
  listTaskEvents,
  listTasksWithAssignees,
  replaceTaskAssignees,
  updateTask,
  validateTaskAssigneeOrganization,
} from "@agentos/db";
import type { ToolDefinition } from "../types.js";
import { defineTool as def } from "../catalog.js";

const DueAt = z.preprocess(
  (value) => {
    if (value === null || value === undefined || typeof value === "number") return value;
    if (typeof value === "string") {
      const trimmed = value.trim();
      const numeric = Number(trimmed);
      if (trimmed && Number.isFinite(numeric)) return numeric;
      const parsed = Date.parse(trimmed);
      if (Number.isFinite(parsed)) return parsed;
    }
    return value;
  },
  z.number().int().nonnegative().nullable().optional(),
);

function personSelection(args: {
  assignee_person_id?: string;
  assignee_person_ids?: string[];
  primary_assignee_person_id?: string | null;
}): { personIds: string[]; primaryPersonId: string | null } {
  const hasList = args.assignee_person_ids !== undefined;
  const source = hasList ? args.assignee_person_ids! : args.assignee_person_id ? [args.assignee_person_id] : [];
  const personIds = source.map((id) => id.trim()).filter(Boolean);
  if (new Set(personIds).size !== personIds.length) {
    throw errors.validation("Una tarea no puede tener el mismo responsable dos veces", { personIds });
  }
  const primary =
    args.primary_assignee_person_id !== undefined
      ? args.primary_assignee_person_id?.trim() || null
      : hasList
        ? null
        : args.assignee_person_id ?? null;
  if (primary && !personIds.includes(primary)) {
    throw errors.validation("primary_assignee_person_id debe pertenecer a assignee_person_ids", { primary });
  }
  return { personIds, primaryPersonId: primary };
}

function assignmentChanged(
  before: readonly { personId: string; isPrimary: boolean }[],
  after: readonly { personId: string; isPrimary: boolean }[],
): boolean {
  const beforeIds = before.map((row) => row.personId).sort();
  const afterIds = after.map((row) => row.personId).sort();
  return JSON.stringify(beforeIds) !== JSON.stringify(afterIds) ||
    (before.find((row) => row.isPrimary)?.personId ?? null) !==
      (after.find((row) => row.isPrimary)?.personId ?? null);
}

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
      assignee_person_ids: z.array(z.string().min(1)).max(100).optional(),
      primary_assignee_person_id: z.string().min(1).nullable().optional(),
      due_at: DueAt,
      parent_task_id: z.string().optional(),
      external_effect: z.boolean().optional(),
      requires_approval: z.boolean().optional(),
    }),
    flags: { read_only: false, external_effect: false, requires_approval: false },
    async handler(ctx, args) {
      const selection = personSelection(args);
      if (selection.personIds.length > 0) {
        validateTaskAssigneeOrganization(ctx.db, args.project_id, selection.personIds);
      }
      let assigneeAgentId: string | null = null;
      if (args.assignee_agent_slug) {
        const agent = getAgentBySlug(ctx.db, args.assignee_agent_slug);
        if (!agent) throw errors.notFound("agent", args.assignee_agent_slug);
        assigneeAgentId = agent.id;
      }
      let task = ctx.engine.createTask(
        {
          projectId: args.project_id,
          title: args.title,
          stage: args.stage,
          description: args.description,
          definitionOfDone: args.definition_of_done,
          activityType: args.activity_type,
          priority: args.priority,
          assigneeAgentId,
          assigneePersonId: selection.primaryPersonId,
          parentTaskId: args.parent_task_id ?? null,
          externalEffect: args.external_effect,
          requiresApproval: args.requires_approval,
        },
        { actor: ctx.actor, runId: ctx.run_id },
      );
      if (args.due_at !== undefined) {
        task = updateTask(ctx.db, task.id, { dueAt: args.due_at }, task.version);
      }
      if (selection.personIds.length > 0) {
        const assigned = replaceTaskAssignees(
          ctx.db,
          task.id,
          {
            personIds: selection.personIds,
            primaryPersonId: selection.primaryPersonId,
            assignedBy: ctx.actor,
          },
          task.version,
        );
        task = assigned;
        if (assignmentChanged([], assigned.assignees)) {
          appendTaskEvent(ctx.db, {
            taskId: task.id,
            runId: ctx.run_id ?? null,
            kind: "assigned",
            actor: ctx.actor,
            payload: {
              beforePersonIds: [],
              afterPersonIds: selection.personIds,
              primaryPersonId: selection.primaryPersonId,
            },
          });
          appendAudit(ctx.db, {
            actor: ctx.actor,
            source: ctx.actor.startsWith("agent:") ? "agent" : ctx.actor.startsWith("person:") ? "ui" : "system",
            action: "task.assign",
            entityType: "task",
            entityId: task.id,
            before: { assigneePersonIds: [], primaryAssigneePersonId: null },
            after: { assigneePersonIds: selection.personIds, primaryAssigneePersonId: selection.primaryPersonId },
            runId: ctx.run_id ?? null,
          });
          await ctx.notifyAssignment?.({
            task,
            beforePersonIds: [],
            afterAssignees: assigned.assignees,
            actor: ctx.actor,
          });
        }
      }
      return { ...task, assignees: getTaskWithAssignees(ctx.db, task.id)?.assignees ?? [] };
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
    description: "Lista tareas filtrando por proyecto, estado, agente o responsable humano.",
    schema: z.object({
      project_id: z.string().optional(),
      status: TaskStatus.optional(),
      assignee_agent_id: z.string().optional(),
      assignee_person_id: z.string().optional(),
    }),
    flags: { read_only: true, external_effect: false, requires_approval: false },
    handler(ctx, args) {
      return listTasksWithAssignees(ctx.db, {
        projectId: args.project_id,
        status: args.status,
        assigneeAgentId: args.assignee_agent_id,
        assigneePersonId: args.assignee_person_id,
      });
    },
  }),

  def({
    name: "tasks.get",
    description: "Devuelve una tarea con responsables, timeline, artefactos y contexto del proyecto.",
    schema: z.object({ task_id: z.string().min(1) }),
    flags: { read_only: true, external_effect: false, requires_approval: false },
    handler(ctx, args) {
      const task = getTaskWithAssignees(ctx.db, args.task_id);
      if (!task) throw errors.notFound("task", args.task_id);
      const sources = listProjectSources(ctx.db, { projectId: task.projectId });
      const documents = listDocs(ctx.db, { projectId: task.projectId });
      return {
        task,
        events: listTaskEvents(ctx.db, task.id),
        artifacts: listArtifacts(ctx.db, task.id),
        assignees: task.assignees,
        project_sources: sources,
        sources,
        knowledge_docs: documents,
        documents,
        runs: listRunsForTask(ctx.db, task.id),
      };
    },
  }),

  def({
    name: "tasks.assign_people",
    description:
      "Reemplaza atómicamente los responsables humanos de una tarea (con expected_version). No cambia el agente ni envía correo arbitrario.",
    schema: z.object({
      task_id: z.string().min(1),
      assignee_person_ids: z.array(z.string().min(1)).max(100),
      primary_assignee_person_id: z.string().min(1).nullable().optional(),
      expected_version: z.number().int().positive(),
    }),
    flags: { read_only: false, external_effect: false, requires_approval: false },
    async handler(ctx, args) {
      const before = getTaskWithAssignees(ctx.db, args.task_id);
      if (!before) throw errors.notFound("task", args.task_id);
      const primary = args.primary_assignee_person_id ?? null;
      if (primary && !args.assignee_person_ids.includes(primary)) {
        throw errors.validation("primary_assignee_person_id debe pertenecer a assignee_person_ids");
      }
      const assigned = replaceTaskAssignees(
        ctx.db,
        args.task_id,
        {
          personIds: args.assignee_person_ids,
          primaryPersonId: primary,
          assignedBy: ctx.actor,
        },
        args.expected_version,
      );
      const changed = assignmentChanged(before.assignees, assigned.assignees);
      appendTaskEvent(ctx.db, {
        taskId: args.task_id,
        runId: ctx.run_id ?? null,
        kind: "assigned",
        actor: ctx.actor,
        payload: {
          beforePersonIds: before.assignees.map((row) => row.personId),
          afterPersonIds: assigned.assignees.map((row) => row.personId),
          primaryPersonId: assigned.assignees.find((row) => row.isPrimary)?.personId ?? null,
        },
      });
      appendAudit(ctx.db, {
        actor: ctx.actor,
        source: ctx.actor.startsWith("agent:") ? "agent" : ctx.actor.startsWith("person:") ? "ui" : "system",
        action: "task.assign",
        entityType: "task",
        entityId: args.task_id,
        before: {
          assigneePersonIds: before.assignees.map((row) => row.personId),
          primaryAssigneePersonId: before.assignees.find((row) => row.isPrimary)?.personId ?? null,
        },
        after: {
          assigneePersonIds: assigned.assignees.map((row) => row.personId),
          primaryAssigneePersonId: assigned.assignees.find((row) => row.isPrimary)?.personId ?? null,
        },
        runId: ctx.run_id ?? null,
      });
      if (changed) {
          await ctx.notifyAssignment?.({
            task: assigned,
            beforePersonIds: before.assignees.map((row) => row.personId),
            beforePrimaryPersonId: before.assignees.find((row) => row.isPrimary)?.personId ?? null,
            afterAssignees: assigned.assignees,
          actor: ctx.actor,
        });
      }
      return { ...assigned, assignees: assigned.assignees };
    },
  }),

  def({
    name: "tasks.set_due_date",
    description:
      "Fija o limpia el vencimiento de una tarea con expected_version. No cambia estado, responsables ni ejecuta avisos directamente.",
    schema: z.object({
      task_id: z.string().min(1),
      due_at: DueAt.refine((value) => value !== undefined, "due_at es obligatorio; usa null para limpiar el vencimiento"),
      expected_version: z.number().int().positive(),
    }),
    flags: { read_only: false, external_effect: false, requires_approval: false },
    handler(ctx, args) {
      const before = getTask(ctx.db, args.task_id);
      if (!before) throw errors.notFound("task", args.task_id);
      const task = updateTask(ctx.db, args.task_id, { dueAt: args.due_at ?? null }, args.expected_version);
      appendTaskEvent(ctx.db, {
        taskId: task.id,
        runId: ctx.run_id ?? null,
        kind: "due_date_changed",
        actor: ctx.actor,
        payload: { beforeDueAt: before.dueAt, afterDueAt: task.dueAt },
      });
      appendAudit(ctx.db, {
        actor: ctx.actor,
        source: ctx.actor.startsWith("agent:") ? "agent" : ctx.actor.startsWith("person:") ? "ui" : "system",
        action: "task.set_due_date",
        entityType: "task",
        entityId: task.id,
        before: { dueAt: before.dueAt },
        after: { dueAt: task.dueAt },
        runId: ctx.run_id ?? null,
      });
      ctx.sink.publish(`board:${task.projectId}`, {
        type: "task.updated",
        payload: { taskId: task.id, dueAt: task.dueAt },
        runId: ctx.run_id ?? null,
      });
      return task;
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
      const rows = listTasksWithAssignees(ctx.db, { projectId: args.project_id });
      const byStatus: Record<string, typeof rows> = {};
      for (const t of rows) (byStatus[t.status] ??= []).push(t);
      return { project_id: args.project_id, columns: byStatus, total: rows.length };
    },
  }),
];
