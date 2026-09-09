/**
 * Alta de una tarea desde la interfaz: el ÚNICO camino por el que un humano
 * crea tarjetas (`POST /api/tasks`) y el que reutiliza la fase 3 de Notas al
 * convertir propuestas en tareas (`POST /api/notes/:id/commit-tasks`).
 *
 * Todo pasa por `BoardEngine.createTask` (invariantes del tablero, evento
 * `task.created` en `board:<projectId>`) y por los repositorios de
 * `@agentos/db`; este módulo sólo orquesta: vencimiento, responsables,
 * etiquetas y avisos. Ninguna ruta debe copiar esta secuencia.
 */
import { z } from "zod";
import { errors, Stage, TaskPriority } from "@agentos/shared";
import {
  appendAudit,
  appendTaskEvent,
  getAgentBySlug,
  getProject,
  replaceTaskLabels,
  updateTask,
  type Task,
} from "@agentos/db";
import type { ApiContext } from "./context.js";
import { normalizePersonIds, replaceTaskAssignees, validatePeopleForProject } from "./task-contract.js";

/** Epoch ms is canonical in SQLite/PG; accepting ISO keeps REST ergonomic. */
export const DueAt = z.preprocess(
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

export const CreateTaskBody = z.object({
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
  /** Etiquetas iniciales; se normalizan (minúsculas, sin duplicados). */
  labels: z.array(z.string()).max(20).optional(),
});
export type CreateTaskBody = z.infer<typeof CreateTaskBody>;

export interface CreateTaskFromBodyInput {
  body: CreateTaskBody;
  /** `person:<id>` de la sesión (o el actor que corresponda). */
  actor: string;
  /** Logger de la petición: un aviso fallido no rompe el alta. */
  log?: { warn(obj: unknown, msg: string): void } | undefined;
}

/**
 * Crea la tarea con el motor del tablero y completa vencimiento, responsables
 * (tabla canónica `task_assignees`, evento `assigned`, aviso) y etiquetas.
 * Devuelve la fila final; el llamante decide cómo la sirve.
 */
export async function createTaskFromBody(
  ctx: Pick<ApiContext, "db" | "engine" | "notifications">,
  input: CreateTaskFromBodyInput,
): Promise<Task> {
  const { db, engine } = ctx;
  const { body, actor } = input;
  const project = await getProject(db, body.project_id);
  if (!project) throw errors.notFound("project", body.project_id);
  const selection = normalizePersonIds(
    body.assignee_person_ids !== undefined
      ? body.assignee_person_ids
      : body.assignee_person_id
        ? [body.assignee_person_id]
        : [],
    body.primary_assignee_person_id !== undefined
      ? body.primary_assignee_person_id
      : body.assignee_person_ids !== undefined
        ? null
        : body.assignee_person_id ?? null,
  );
  await validatePeopleForProject(db, project, selection.personIds, selection.primaryPersonId);
  let assigneeAgentId: string | null = null;
  if (body.assignee_agent_slug) {
    const agent = await getAgentBySlug(db, body.assignee_agent_slug);
    if (!agent) throw errors.notFound("agent", body.assignee_agent_slug);
    assigneeAgentId = agent.id;
  }
  const task = await engine.createTask(
    {
      projectId: body.project_id,
      title: body.title,
      stage: body.stage,
      description: body.description ?? null,
      definitionOfDone: body.definition_of_done ?? null,
      activityType: body.activity_type ?? null,
      priority: body.priority ?? "normal",
      assigneeAgentId,
      assigneePersonId: selection.primaryPersonId,
      parentTaskId: body.parent_task_id ?? null,
      ...(body.external_effect !== undefined ? { externalEffect: body.external_effect } : {}),
      ...(body.requires_approval !== undefined ? { requiresApproval: body.requires_approval } : {}),
    },
    { actor },
  );
  let savedTask = task;
  if (body.due_at !== undefined && body.due_at !== null) {
    savedTask = await updateTask(db, task.id, { dueAt: body.due_at }, savedTask.version);
  } else if (body.due_at === null) {
    savedTask = await updateTask(db, task.id, { dueAt: null }, savedTask.version);
  }
  if (selection.personIds.length > 0) {
    const assigned = await replaceTaskAssignees(db, {
      taskId: savedTask.id,
      personIds: selection.personIds,
      primaryPersonId: selection.primaryPersonId,
      assignedBy: actor,
      expectedVersion: savedTask.version,
    });
    savedTask = assigned.task;
    // La tarea es nueva: aunque BoardEngine haya materializado la persona
    // primaria legacy durante createTask, para avisos la asignación completa
    // es un cambio real y se registra una sola vez por persona.
    await appendTaskEvent(db, {
      taskId: savedTask.id,
      kind: "assigned",
      actor,
      payload: {
        beforePersonIds: [],
        afterPersonIds: selection.personIds,
        primaryPersonId: selection.primaryPersonId,
      },
    });
    await appendAudit(db, {
      actor,
      source: "ui",
      action: "task.assign",
      entityType: "task",
      entityId: savedTask.id,
      before: { assigneePersonIds: [], primaryAssigneePersonId: null },
      after: { assigneePersonIds: selection.personIds, primaryAssigneePersonId: selection.primaryPersonId },
    });
    try {
      await ctx.notifications.notifyAssignment({
        task: savedTask,
        beforePersonIds: [],
        afterAssignees: assigned.assignees,
        actor,
        beforePrimaryPersonId: null,
      });
    } catch (err) {
      // La tarea y la asignación ya quedaron escritas: un fallo al avisar
      // (proveedor caído, etc.) no debe reportarse como error de la petición.
      input.log?.warn({ err, taskId: savedTask.id }, "No se pudo enviar el aviso de asignación de la tarea");
    }
  }
  if (body.labels && body.labels.length > 0) {
    await replaceTaskLabels(db, savedTask.id, body.labels, actor);
  }
  // `task.created` ya lo publica BoardEngine.createTask: no se duplica aquí.
  return savedTask;
}
