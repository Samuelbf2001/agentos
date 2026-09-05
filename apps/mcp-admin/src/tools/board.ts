/**
 * Tools del tablero (tasks.* + board.get). Capa fina sobre BoardEngine de
 * @agentos/core: la máquina de estados, gates, anti-teatro y expected_version
 * viven allí — aquí solo se traduce y se audita la mutación (source 'mcp').
 */
import { z } from "zod";
import { BlockedReason, errors, Stage, TaskPriority, TaskStatus } from "@agentos/shared";
import {
  attachArtifact,
  appendTaskEvent,
  boardTasks,
  getTask,
  listArtifacts,
  listLabelsForTasks,
  listTaskEvents,
  listTaskLabels,
  listTasks,
  normalizeLabel,
  replaceTaskAssignees,
  replaceTaskLabels,
  updateTask,
  type AgentosDb,
  type Task,
} from "@agentos/db";
import { auditMutation, findIdempotentMutation, mustGetPerson } from "../context.js";
import { defineAdminTool as def, type AdminToolDefinition } from "../registry.js";
import { resolveAgentRef } from "../resolve.js";

const Reason = z.string().max(2000).optional();
const IdempotencyKey = z.string().min(1).max(200).optional();

/**
 * Epoch ms es lo canónico en SQLite/PG; se acepta ISO para que quien llame por
 * MCP no tenga que hacer la conversión. Copiado deliberadamente de
 * apps/api/src/routes/board.ts (mismo comportamiento, sin importar entre apps).
 */
const DueAt = z.preprocess(
  (value) => {
    if (value === null || value === undefined || typeof value === "number") return value;
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed) return value;
      const numeric = Number(trimmed);
      if (Number.isFinite(numeric)) return numeric;
      const parsed = Date.parse(trimmed);
      if (Number.isFinite(parsed)) return parsed;
    }
    return value;
  },
  z.number().int().nonnegative().nullable().optional(),
);

function mustGetTask(db: AgentosDb, taskId: string): Task {
  const task = getTask(db, taskId);
  if (!task) throw errors.notFound("task", taskId);
  return task;
}

function taskAuditFields(task: Task): Record<string, unknown> {
  return {
    title: task.title,
    description: task.description,
    definitionOfDone: task.definitionOfDone,
    status: task.status,
    stage: task.stage,
    activityType: task.activityType,
    priority: task.priority,
    assigneeAgentId: task.assigneeAgentId,
    assigneePersonId: task.assigneePersonId,
    dueAt: task.dueAt,
    orderKey: task.orderKey,
    version: task.version,
  };
}

export const boardTools: AdminToolDefinition[] = [
  def({
    name: "agentos.tasks.list",
    description:
      "Lista tareas con filtros por proyecto, estado, agente asignado (id o slug), persona responsable o etiqueta.",
    schema: z.object({
      project_id: z.string().optional(),
      status: TaskStatus.optional(),
      assignee_agent: z.string().optional(),
      assignee_person_id: z.string().optional(),
      label: z.string().optional(),
    }),
    readOnly: true,
    handler(ctx, args) {
      const assigneeAgentId = args.assignee_agent
        ? resolveAgentRef(ctx.db, args.assignee_agent).id
        : undefined;
      const rows = listTasks(ctx.db, {
        projectId: args.project_id,
        status: args.status,
        assigneeAgentId,
        // `personId` es el filtro canónico del repo: incluye responsables no primarios.
        personId: args.assignee_person_id,
      });
      // Una sola consulta de etiquetas para todas las filas evita N+1 al pintar el tablero.
      const labels = listLabelsForTasks(ctx.db, rows.map((t) => t.id));
      const withLabels = rows.map((t) => ({ ...t, labels: labels.get(t.id) ?? [] }));
      if (!args.label) return withLabels;
      const wanted = normalizeLabel(args.label);
      return withLabels.filter((t) => t.labels.includes(wanted));
    },
  }),

  def({
    name: "agentos.tasks.get",
    description: "Devuelve una tarea con su timeline (task_events) y artefactos.",
    schema: z.object({ task_id: z.string().min(1) }),
    readOnly: true,
    handler(ctx, args) {
      const task = mustGetTask(ctx.db, args.task_id);
      return {
        task,
        events: listTaskEvents(ctx.db, task.id),
        artifacts: listArtifacts(ctx.db, task.id),
      };
    },
  }),

  def({
    name: "agentos.tasks.create",
    description:
      "Crea una tarea en BACKLOG. requires_approval lo calcula la política de core (solo puede subirse). " +
      "Acepta due_at, una lista de responsables (assignee_person_ids) y labels iniciales.",
    schema: z.object({
      project_id: z.string().min(1),
      title: z.string().min(1),
      stage: Stage,
      description: z.string().optional(),
      definition_of_done: z.string().optional(),
      activity_type: z.string().optional(),
      priority: TaskPriority.optional(),
      assignee_agent: z.string().optional(),
      /** Entrada singular histórica; si llega `assignee_person_ids`, ésta manda. */
      assignee_person_id: z.string().optional(),
      assignee_person_ids: z.array(z.string().min(1)).max(100).optional(),
      primary_assignee_person_id: z.string().min(1).nullable().optional(),
      due_at: DueAt,
      labels: z.array(z.string()).max(20).optional(),
      parent_task_id: z.string().optional(),
      external_effect: z.boolean().optional(),
      requires_approval: z.boolean().optional(),
      reason: Reason,
      idempotency_key: IdempotencyKey,
    }),
    readOnly: false,
    async handler(ctx, args) {
      const previous = findIdempotentMutation(ctx, "tasks.create", args.idempotency_key);
      if (previous?.entityId) {
        const existing = getTask(ctx.db, previous.entityId);
        if (existing) return { task: existing, labels: listTaskLabels(ctx.db, existing.id), idempotent: true };
      }
      const assigneeAgentId = args.assignee_agent
        ? resolveAgentRef(ctx.db, args.assignee_agent).id
        : null;
      // Misma regla que POST /api/tasks: la lista manda si llega; si no, la
      // entrada singular se traduce a una lista de una sola persona primaria.
      const personIds =
        args.assignee_person_ids !== undefined
          ? args.assignee_person_ids
          : args.assignee_person_id
            ? [args.assignee_person_id]
            : [];
      const primaryPersonId =
        args.primary_assignee_person_id !== undefined
          ? args.primary_assignee_person_id
          : args.assignee_person_ids !== undefined
            ? null
            : (args.assignee_person_id ?? null);
      const task = ctx.engine.createTask(
        {
          projectId: args.project_id,
          title: args.title,
          stage: args.stage,
          description: args.description,
          definitionOfDone: args.definition_of_done,
          activityType: args.activity_type,
          priority: args.priority,
          assigneeAgentId,
          assigneePersonId: primaryPersonId,
          parentTaskId: args.parent_task_id ?? null,
          externalEffect: args.external_effect,
          requiresApproval: args.requires_approval,
        },
        { actor: ctx.actor },
      );
      let savedTask: Task = task;
      if (args.due_at !== undefined) {
        savedTask = await updateTask(ctx.db, task.id, { dueAt: args.due_at }, savedTask.version);
      }
      if (personIds.length > 0) {
        // mcp-admin no tiene NotificationProcessor: se registra la asignación
        // vía la tabla puente, sin los avisos que sí dispara apps/api.
        const assigned = await replaceTaskAssignees(
          ctx.db,
          savedTask.id,
          { personIds, primaryPersonId },
          savedTask.version,
        );
        savedTask = assigned;
      }
      const labels =
        args.labels !== undefined ? await replaceTaskLabels(ctx.db, savedTask.id, args.labels, ctx.actor) : [];
      auditMutation(ctx, {
        action: "tasks.create",
        entityType: "task",
        entityId: savedTask.id,
        before: null,
        after: taskAuditFields(savedTask),
        reason: args.reason,
        idempotencyKey: args.idempotency_key,
      });
      return { task: savedTask, labels };
    },
  }),

  def({
    name: "agentos.tasks.update",
    description:
      "Actualiza campos editables de una tarea (título, descripción, DoD, prioridad, activity_type, " +
      "due_at) con expected_version; labels reemplaza el conjunto completo sin consumir la versión.",
    schema: z.object({
      task_id: z.string().min(1),
      expected_version: z.number().int().positive(),
      patch: z.object({
        title: z.string().min(1).optional(),
        description: z.string().nullable().optional(),
        definition_of_done: z.string().nullable().optional(),
        activity_type: z.string().nullable().optional(),
        priority: TaskPriority.optional(),
        due_at: DueAt,
        /** Reemplazo completo del conjunto de etiquetas (no un merge). */
        labels: z.array(z.string()).max(20).optional(),
      }),
      reason: Reason,
    }),
    readOnly: false,
    async handler(ctx, args) {
      const task = mustGetTask(ctx.db, args.task_id);
      if (Object.keys(args.patch).length === 0) {
        throw errors.validation("tasks.update con patch vacío: nada que hacer");
      }
      const before = taskAuditFields(task);
      // Capturado ANTES de reemplazar: si el patch sólo trae `labels`, es la
      // única forma de que la auditoría registre el cambio (igual que REST).
      const labelsBefore = args.patch.labels !== undefined ? listTaskLabels(ctx.db, task.id) : undefined;
      const patch: Partial<Task> = {};
      if (args.patch.title !== undefined) patch.title = args.patch.title;
      if (args.patch.description !== undefined) patch.description = args.patch.description;
      if (args.patch.definition_of_done !== undefined) patch.definitionOfDone = args.patch.definition_of_done;
      if (args.patch.activity_type !== undefined) patch.activityType = args.patch.activity_type;
      if (args.patch.priority !== undefined) patch.priority = args.patch.priority;
      if (args.patch.due_at !== undefined) patch.dueAt = args.patch.due_at;
      // Las etiquetas son metadato de clasificación, no una transición de la
      // máquina de estados: no consumen expected_version, igual que en REST.
      let updated: Task = task;
      if (Object.keys(patch).length > 0) {
        updated = await updateTask(ctx.db, task.id, patch, args.expected_version);
      }
      const labels =
        args.patch.labels !== undefined
          ? await replaceTaskLabels(ctx.db, task.id, args.patch.labels, ctx.actor)
          : listTaskLabels(ctx.db, task.id);
      auditMutation(ctx, {
        action: "tasks.update",
        entityType: "task",
        entityId: task.id,
        before: labelsBefore !== undefined ? { ...before, labels: labelsBefore } : before,
        after: labelsBefore !== undefined ? { ...taskAuditFields(updated), labels } : taskAuditFields(updated),
        reason: args.reason,
      });
      return { ...updated, labels };
    },
  }),

  def({
    name: "agentos.tasks.move",
    description:
      "Mueve una tarea por la máquina de estados de core (expected_version obligatoria; " +
      "REVIEW/DONE exigen artefacto; transiciones fuera de la matriz → error de dominio).",
    schema: z.object({
      task_id: z.string().min(1),
      to: TaskStatus,
      expected_version: z.number().int().positive(),
      note: z.string().optional(),
      blocked_reason: BlockedReason.optional(),
      reason: Reason,
    }),
    readOnly: false,
    handler(ctx, args) {
      const task = mustGetTask(ctx.db, args.task_id);
      const before = { status: task.status, version: task.version };
      const moved = ctx.engine.moveTask({
        taskId: task.id,
        to: args.to,
        expectedVersion: args.expected_version,
        actor: ctx.actor,
        note: args.note,
        blockedReason: args.blocked_reason,
      });
      auditMutation(ctx, {
        action: "tasks.move",
        entityType: "task",
        entityId: task.id,
        before,
        after: { status: moved.status, version: moved.version },
        reason: args.reason ?? args.note,
      });
      return moved;
    },
  }),

  def({
    name: "agentos.tasks.comment",
    description: "Añade un comentario al timeline de la tarea (task_events, append-only).",
    schema: z.object({
      task_id: z.string().min(1),
      body: z.string().min(1),
      idempotency_key: IdempotencyKey,
    }),
    readOnly: false,
    handler(ctx, args) {
      const previous = findIdempotentMutation(ctx, "tasks.comment", args.idempotency_key);
      if (previous?.entityId) return { event_id: previous.entityId, idempotent: true };
      const task = mustGetTask(ctx.db, args.task_id);
      const event = appendTaskEvent(ctx.db, {
        taskId: task.id,
        kind: "comment",
        actor: ctx.actor,
        payload: { body: args.body },
      });
      ctx.sink.publish(`board:${task.projectId}`, {
        type: "task.commented",
        payload: { taskId: task.id, eventId: event.id, actor: ctx.actor },
      });
      auditMutation(ctx, {
        action: "tasks.comment",
        entityType: "task_event",
        entityId: event.id,
        before: null,
        after: { taskId: task.id, body: args.body },
        idempotencyKey: args.idempotency_key,
      });
      return { event };
    },
  }),

  def({
    name: "agentos.tasks.assign",
    description:
      "Asigna la tarea a un agente (id o slug) y/o a una persona, con expected_version.",
    schema: z.object({
      task_id: z.string().min(1),
      expected_version: z.number().int().positive(),
      assignee_agent: z.string().nullable().optional(),
      assignee_person_id: z.string().nullable().optional(),
      reason: Reason,
    }),
    readOnly: false,
    handler(ctx, args) {
      if (args.assignee_agent === undefined && args.assignee_person_id === undefined) {
        throw errors.validation("tasks.assign exige assignee_agent y/o assignee_person_id");
      }
      const task = mustGetTask(ctx.db, args.task_id);
      const before = {
        assigneeAgentId: task.assigneeAgentId,
        assigneePersonId: task.assigneePersonId,
      };
      const patch: Partial<Task> = {};
      if (args.assignee_agent !== undefined) {
        patch.assigneeAgentId =
          args.assignee_agent === null ? null : resolveAgentRef(ctx.db, args.assignee_agent).id;
      }
      if (args.assignee_person_id !== undefined) {
        patch.assigneePersonId =
          args.assignee_person_id === null ? null : mustGetPerson(ctx.db, args.assignee_person_id).id;
      }
      const updated = updateTask(ctx.db, task.id, patch, args.expected_version);
      appendTaskEvent(ctx.db, {
        taskId: task.id,
        kind: "assigned",
        actor: ctx.actor,
        payload: {
          assigneeAgentId: updated.assigneeAgentId,
          assigneePersonId: updated.assigneePersonId,
        },
      });
      auditMutation(ctx, {
        action: "tasks.assign",
        entityType: "task",
        entityId: task.id,
        before,
        after: {
          assigneeAgentId: updated.assigneeAgentId,
          assigneePersonId: updated.assigneePersonId,
        },
        reason: args.reason,
      });
      return updated;
    },
  }),

  def({
    name: "agentos.tasks.attach_artifact",
    description:
      "Adjunta un artefacto (evidencia) a una tarea — sin artefacto no hay REVIEW ni DONE (anti-teatro).",
    schema: z.object({
      task_id: z.string().min(1),
      kind: z.string().min(1),
      title: z.string().min(1),
      content: z.string().optional(),
      path: z.string().optional(),
      reason: Reason,
      idempotency_key: IdempotencyKey,
    }),
    readOnly: false,
    handler(ctx, args) {
      const previous = findIdempotentMutation(ctx, "tasks.attach_artifact", args.idempotency_key);
      if (previous?.entityId) return { artifact_id: previous.entityId, idempotent: true };
      const task = mustGetTask(ctx.db, args.task_id);
      const artifact = attachArtifact(ctx.db, {
        taskId: task.id,
        kind: args.kind,
        title: args.title,
        content: args.content ?? null,
        path: args.path ?? null,
        createdBy: ctx.actor,
      });
      ctx.sink.publish(`board:${task.projectId}`, {
        type: "task.artifact_attached",
        payload: { taskId: task.id, artifactId: artifact.id },
      });
      auditMutation(ctx, {
        action: "tasks.attach_artifact",
        entityType: "artifact",
        entityId: artifact.id,
        before: null,
        after: { taskId: task.id, kind: args.kind, title: args.title },
        reason: args.reason,
        idempotencyKey: args.idempotency_key,
      });
      return { artifact };
    },
  }),

  def({
    name: "agentos.tasks.approve",
    description:
      "Aprueba una tarea en REVIEW → DONE. Exige person_id humano (REVIEW→DONE solo lo hace un humano).",
    schema: z.object({
      task_id: z.string().min(1),
      expected_version: z.number().int().positive(),
      person_id: z.string().min(1),
      note: z.string().optional(),
    }),
    readOnly: false,
    handler(ctx, args) {
      const person = mustGetPerson(ctx.db, args.person_id);
      const task = mustGetTask(ctx.db, args.task_id);
      const before = { status: task.status, version: task.version };
      const moved = ctx.engine.moveTask({
        taskId: task.id,
        to: "DONE",
        expectedVersion: args.expected_version,
        actor: `person:${person.id}`,
        note: args.note,
      });
      auditMutation(ctx, {
        action: "tasks.approve",
        entityType: "task",
        entityId: task.id,
        before,
        after: { status: moved.status, version: moved.version, approvedBy: person.id },
        reason: args.note,
      });
      return moved;
    },
  }),

  def({
    name: "agentos.tasks.reject",
    description:
      "Rechaza una tarea en REVIEW → IN_PROGRESS con nota obligatoria para el agente (person_id humano).",
    schema: z.object({
      task_id: z.string().min(1),
      expected_version: z.number().int().positive(),
      person_id: z.string().min(1),
      note: z.string().min(1, "la nota de rechazo es obligatoria"),
    }),
    readOnly: false,
    handler(ctx, args) {
      const person = mustGetPerson(ctx.db, args.person_id);
      const task = mustGetTask(ctx.db, args.task_id);
      const before = { status: task.status, version: task.version };
      const moved = ctx.engine.moveTask({
        taskId: task.id,
        to: "IN_PROGRESS",
        expectedVersion: args.expected_version,
        actor: `person:${person.id}`,
        note: args.note,
      });
      auditMutation(ctx, {
        action: "tasks.reject",
        entityType: "task",
        entityId: task.id,
        before,
        after: { status: moved.status, version: moved.version, rejectedBy: person.id },
        reason: args.note,
      });
      return moved;
    },
  }),

  def({
    name: "agentos.tasks.reorder",
    description:
      "Cambia el order_key fraccionario de una tarea dentro de su columna (expected_version obligatoria).",
    schema: z.object({
      task_id: z.string().min(1),
      expected_version: z.number().int().positive(),
      order_key: z.string().min(1).max(64),
      reason: Reason,
    }),
    readOnly: false,
    handler(ctx, args) {
      const task = mustGetTask(ctx.db, args.task_id);
      const before = { orderKey: task.orderKey, version: task.version };
      const updated = updateTask(ctx.db, task.id, { orderKey: args.order_key }, args.expected_version);
      ctx.sink.publish(`board:${task.projectId}`, {
        type: "task.reordered",
        payload: { taskId: task.id, orderKey: updated.orderKey },
      });
      auditMutation(ctx, {
        action: "tasks.reorder",
        entityType: "task",
        entityId: task.id,
        before,
        after: { orderKey: updated.orderKey, version: updated.version },
        reason: args.reason,
      });
      return updated;
    },
  }),

  def({
    name: "agentos.board.get",
    description:
      "Snapshot del tablero de un proyecto agrupado por stage × status (orden de columna).",
    schema: z.object({ project_id: z.string().min(1) }),
    readOnly: true,
    handler(ctx, args) {
      const rows = boardTasks(ctx.db, args.project_id);
      const stages: Record<string, Record<string, Task[]>> = {};
      for (const t of rows) {
        const byStatus = (stages[t.stage] ??= {});
        (byStatus[t.status] ??= []).push(t);
      }
      return { project_id: args.project_id, stages, total: rows.length };
    },
  }),
];
