/** REST del tablero: projects, tasks y snapshot board/:projectId (stage×status). */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  errors,
  Stage,
  TaskPriority,
  TaskStatus,
  BlockedReason,
  ProjectType,
  type TaskStatus as TaskStatusT,
} from "@agentos/shared";
import {
  appendAudit,
  appendTaskEvent,
  attachArtifact,
  boardTasks,
  createProject,
  getAgentBySlug,
  getProject,
  getTask,
  listDocs,
  listArtifacts,
  listProjects,
  listProjectSources,
  listRunsForTask,
  listTaskEvents,
  listTasks,
  setGateState,
  updateProject,
  updateTask,
  type Task,
} from "@agentos/db";
import { GATE_G1_PLAN } from "@agentos/core";
import type { ApiContext } from "../context.js";
import { parse } from "../http-errors.js";
import {
  listTaskAssignees,
  listTasksWithAssignees,
  normalizePersonIds,
  replaceTaskAssignees,
  taskWithAssignees,
  validatePeopleForProject,
} from "../task-contract.js";

/** Epoch ms is canonical in SQLite/PG; accepting ISO keeps REST ergonomic. */
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

const CreateProjectBody = z.object({
  org_id: z.string().min(1),
  name: z.string().min(1),
  type: ProjectType,
  stage: Stage.optional(),
  workspace_path: z.string().optional(),
});

const UpdateProjectBody = z.object({
  expected_version: z.number().int().positive(),
  name: z.string().min(1).optional(),
  stage: Stage.optional(),
  workspace_path: z.string().optional(),
});

const GateBody = z.object({
  gate: z.literal(GATE_G1_PLAN).default(GATE_G1_PLAN),
  decision: z.enum(["approve", "reject"]),
  note: z.string().optional(),
});

const CreateTaskBody = z.object({
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
});

const UpdateTaskBody = z.object({
  expected_version: z.number().int().positive(),
  title: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  definition_of_done: z.string().nullable().optional(),
  activity_type: z.string().nullable().optional(),
  priority: TaskPriority.optional(),
  due_at: DueAt,
});

const MoveTaskBody = z.object({
  to: TaskStatus,
  expected_version: z.number().int().positive(),
  note: z.string().optional(),
  blocked_reason: BlockedReason.optional(),
});

const CommentBody = z.object({ body: z.string().min(1) });

const AssignBody = z.object({
  expected_version: z.number().int().positive(),
  agent_slug: z.string().nullable().optional(),
  assignee_person_ids: z.array(z.string().min(1)).max(100).optional(),
  primary_assignee_person_id: z.string().min(1).nullable().optional(),
  /** Entrada singular histórica; se transforma en una lista de una persona. */
  person_id: z.string().nullable().optional(),
});

const ArtifactBody = z.object({
  kind: z.string().min(1),
  title: z.string().min(1),
  content: z.string().optional(),
  path: z.string().optional(),
});

const DecisionBody = z.object({
  expected_version: z.number().int().positive(),
  note: z.string().optional(),
});

const RejectBody = z.object({
  expected_version: z.number().int().positive(),
  note: z.string().min(1),
});

export function registerBoardRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const { db, engine, sink } = ctx;

  const personActor = (req: { session?: { personId: string } | undefined }): string =>
    `person:${req.session!.personId}`;

  // ── Projects ──────────────────────────────────────────────────────────────

  app.get("/api/projects", async () => ({ projects: await listProjects(db) }));

  app.get("/api/projects/:id", async (req) => {
    const { id } = req.params as { id: string };
    const project = await getProject(db, id);
    if (!project) throw errors.notFound("project", id);
    return { project };
  });

  app.post("/api/projects", async (req, reply) => {
    const body = parse(CreateProjectBody, req.body);
    const project = await createProject(db, {
      orgId: body.org_id,
      name: body.name,
      type: body.type,
      stage: body.stage ?? "ENTENDER",
      gateState: "pending",
      workspacePath: body.workspace_path ?? null,
    });
    await appendAudit(db, {
      actor: personActor(req),
      source: "ui",
      action: "project.create",
      entityType: "project",
      entityId: project.id,
      after: { name: project.name, type: project.type },
    });
    await sink.publish(`board:${project.id}`, { type: "project.created", payload: { projectId: project.id } });
    reply.status(201);
    return { project };
  });

  app.patch("/api/projects/:id", async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(UpdateProjectBody, req.body);
    const before = await getProject(db, id);
    if (!before) throw errors.notFound("project", id);
    const project = await updateProject(
      db,
      id,
      {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.stage !== undefined ? { stage: body.stage } : {}),
        ...(body.workspace_path !== undefined ? { workspacePath: body.workspace_path } : {}),
      },
      body.expected_version,
    );
    await appendAudit(db, {
      actor: personActor(req),
      source: "ui",
      action: "project.update",
      entityType: "project",
      entityId: id,
      before: { name: before.name, stage: before.stage },
      after: { name: project.name, stage: project.stage },
    });
    return { project };
  });

  /** Gate 1 (set_gate): aprobar habilita CONSTRUIR; rechazar lo deja cerrado. */
  app.post("/api/projects/:id/gate", async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(GateBody, req.body);
    const personId = req.session!.personId;
    if (body.decision === "approve") {
      const project = await engine.approveGate(id, GATE_G1_PLAN, personId, body.note);
      return { project };
    }
    const before = await getProject(db, id);
    if (!before) throw errors.notFound("project", id);
    const project = await setGateState(db, id, "rejected", before.version);
    await appendAudit(db, {
      actor: personActor(req),
      source: "ui",
      action: "gate.reject",
      entityType: "project",
      entityId: id,
      before: { gateState: before.gateState },
      after: { gateState: project.gateState, gate: body.gate },
      reason: body.note ?? null,
    });
    await sink.publish(`board:${id}`, { type: "gate.rejected", payload: { gate: body.gate, by: personId } });
    return { project };
  });

  // ── Board snapshot (stage×status) ─────────────────────────────────────────

  app.get("/api/board/:projectId", async (req) => {
    const { projectId } = req.params as { projectId: string };
    const project = await getProject(db, projectId);
    if (!project) throw errors.notFound("project", projectId);
    const rows = await listTasksWithAssignees(db, { projectId });
    const columns: Partial<Record<TaskStatusT, Task[]>> = {};
    const cells: Record<string, Partial<Record<TaskStatusT, Task[]>>> = {};
    for (const t of rows) {
      (columns[t.status] ??= []).push(t);
      ((cells[t.stage] ??= {})[t.status] ??= []).push(t);
    }
    return {
      project,
      board_seq: await ctx.bus.lastSeq(`board:${projectId}`),
      total: rows.length,
      columns,
      cells,
    };
  });

  // ── Tasks ─────────────────────────────────────────────────────────────────

  app.get("/api/tasks", async (req) => {
    const q = parse(
      z.object({
        project_id: z.string().min(1).optional(),
        status: z.string().optional(),
        assignee_agent_id: z.string().min(1).optional(),
        assignee_person_id: z.string().min(1).optional(),
      }),
      req.query,
    );
    const status = q.status ? parse(TaskStatus, q.status) : undefined;
    return {
      tasks: await listTasksWithAssignees(db, {
        ...(q.project_id ? { projectId: q.project_id } : {}),
        ...(status ? { status } : {}),
        ...(q.assignee_agent_id ? { assigneeAgentId: q.assignee_agent_id } : {}),
        ...(q.assignee_person_id ? { assigneePersonId: q.assignee_person_id } : {}),
      }),
    };
  });

  app.get("/api/tasks/:id", async (req) => {
    const { id } = req.params as { id: string };
    const task = await getTask(db, id);
    if (!task) throw errors.notFound("task", id);
    const project = await getProject(db, task.projectId);
    if (!project) throw errors.notFound("project", task.projectId);
    const assigneeTask = await taskWithAssignees(db, task);
    const projectSources = await listProjectSources(db, { projectId: project.id });
    const knowledgeDocs = await listDocs(db, { projectId: project.id });
    return {
      task: assigneeTask,
      project,
      assignees: assigneeTask.assignees,
      events: await listTaskEvents(db, id),
      artifacts: await listArtifacts(db, id),
      runs: await listRunsForTask(db, id),
      /** Referencias existentes: no se copian ni se indexan archivos aquí. */
      project_sources: projectSources,
      sources: projectSources,
      knowledge_docs: knowledgeDocs,
      documents: knowledgeDocs,
    };
  });

  app.post("/api/tasks", async (req, reply) => {
    const body = parse(CreateTaskBody, req.body);
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
      { actor: personActor(req) },
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
        assignedBy: personActor(req),
        expectedVersion: savedTask.version,
      });
      savedTask = assigned.task;
      // La tarea es nueva: aunque BoardEngine haya materializado la persona
      // primaria legacy durante createTask, para avisos la asignación completa
      // es un cambio real y se registra una sola vez por persona.
      if (selection.personIds.length > 0) {
        await appendTaskEvent(db, {
          taskId: savedTask.id,
          kind: "assigned",
          actor: personActor(req),
          payload: {
            beforePersonIds: [],
            afterPersonIds: selection.personIds,
            primaryPersonId: selection.primaryPersonId,
          },
        });
        await appendAudit(db, {
          actor: personActor(req),
          source: "ui",
          action: "task.assign",
          entityType: "task",
          entityId: savedTask.id,
          before: { assigneePersonIds: [], primaryAssigneePersonId: null },
          after: { assigneePersonIds: selection.personIds, primaryAssigneePersonId: selection.primaryPersonId },
        });
        await ctx.notifications.notifyAssignment({
          task: savedTask,
          beforePersonIds: [],
          afterAssignees: assigned.assignees,
          actor: personActor(req),
          beforePrimaryPersonId: null,
        });
      }
    }
    reply.status(201);
    return { task: await taskWithAssignees(db, savedTask) };
  });

  app.patch("/api/tasks/:id", async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(UpdateTaskBody, req.body);
    const before = await getTask(db, id);
    if (!before) throw errors.notFound("task", id);
    const task = await updateTask(
      db,
      id,
      {
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.definition_of_done !== undefined ? { definitionOfDone: body.definition_of_done } : {}),
        ...(body.activity_type !== undefined ? { activityType: body.activity_type } : {}),
        ...(body.priority !== undefined ? { priority: body.priority } : {}),
        ...(body.due_at !== undefined ? { dueAt: body.due_at } : {}),
      },
      body.expected_version,
    );
    await appendAudit(db, {
      actor: personActor(req),
      source: "ui",
      action: "task.update",
      entityType: "task",
      entityId: id,
      before: { title: before.title, dueAt: before.dueAt },
      after: { title: task.title, dueAt: task.dueAt },
    });
    return { task: await taskWithAssignees(db, task) };
  });

  app.post("/api/tasks/:id/move", async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(MoveTaskBody, req.body);
    const task = await engine.moveTask({
      taskId: id,
      to: body.to,
      expectedVersion: body.expected_version,
      actor: personActor(req),
      ...(body.note !== undefined ? { note: body.note } : {}),
      ...(body.blocked_reason !== undefined ? { blockedReason: body.blocked_reason } : {}),
    });
    return { task };
  });

  app.post("/api/tasks/:id/comment", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parse(CommentBody, req.body);
    const task = await getTask(db, id);
    if (!task) throw errors.notFound("task", id);
    const event = await appendTaskEvent(db, {
      taskId: id,
      kind: "comment",
      actor: personActor(req),
      payload: { body: body.body },
    });
    await sink.publish(`board:${task.projectId}`, {
      type: "task.commented",
      payload: { taskId: id, eventId: event.id, actor: personActor(req) },
    });
    reply.status(201);
    return { event };
  });

  app.post("/api/tasks/:id/assign", async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(AssignBody, req.body);
    const before = await getTask(db, id);
    if (!before) throw errors.notFound("task", id);
    const beforeAssignees = await listTaskAssignees(db, id);
    let assigneeAgentId: string | null | undefined;
    if (body.agent_slug !== undefined) {
      if (body.agent_slug === null) assigneeAgentId = null;
      else {
        const agent = await getAgentBySlug(db, body.agent_slug);
        if (!agent) throw errors.notFound("agent", body.agent_slug);
        assigneeAgentId = agent.id;
      }
    }
    const humanSelectionProvided =
      body.assignee_person_ids !== undefined ||
      body.primary_assignee_person_id !== undefined ||
      body.person_id !== undefined;
    let task = before;
    let assignmentChanged = false;
    let afterAssignees = beforeAssignees;

    // La entrada singular se conserva sólo como compatibilidad; cuando llega
    // la lista nueva, ésta es la autoridad y no se mezclan ambos contratos.
    if (humanSelectionProvided) {
      const personIds =
        body.assignee_person_ids !== undefined
          ? body.assignee_person_ids
          : body.person_id
            ? [body.person_id]
            : [];
      const primary =
        body.primary_assignee_person_id !== undefined
          ? body.primary_assignee_person_id
          : body.assignee_person_ids !== undefined
            ? null
            : body.person_id ?? null;
      const selection = normalizePersonIds(personIds, primary);
      const project = await getProject(db, before.projectId);
      if (!project) throw errors.notFound("project", before.projectId);
      await validatePeopleForProject(db, project, selection.personIds, selection.primaryPersonId);

      // Si también cambia el agente, primero se actualiza su proyección y se
      // usa la versión resultante para el reemplazo humano. Ambos guards son
      // optimistic-locking; una carrera siempre devuelve conflicto.
      if (assigneeAgentId !== undefined) {
        task = await updateTask(db, id, { assigneeAgentId }, body.expected_version);
        const assigned = await replaceTaskAssignees(db, {
          taskId: id,
          personIds: selection.personIds,
          primaryPersonId: selection.primaryPersonId,
          assignedBy: personActor(req),
          expectedVersion: task.version,
        });
        task = assigned.task;
        afterAssignees = assigned.assignees;
        assignmentChanged = assigned.changed;
      } else {
        const assigned = await replaceTaskAssignees(db, {
          taskId: id,
          personIds: selection.personIds,
          primaryPersonId: selection.primaryPersonId,
          assignedBy: personActor(req),
          expectedVersion: body.expected_version,
        });
        task = assigned.task;
        afterAssignees = assigned.assignees;
        assignmentChanged = assigned.changed;
      }
    } else {
      task = await updateTask(
        db,
        id,
        { ...(assigneeAgentId !== undefined ? { assigneeAgentId } : {}) },
        body.expected_version,
      );
    }

    if (humanSelectionProvided || assigneeAgentId !== undefined) {
      await appendTaskEvent(db, {
        taskId: id,
        kind: "assigned",
        actor: personActor(req),
        payload: {
          agentSlug: body.agent_slug ?? null,
          beforePersonIds: beforeAssignees.map((row) => row.personId),
          afterPersonIds: afterAssignees.map((row) => row.personId),
          primaryPersonId: afterAssignees.find((row) => row.isPrimary)?.personId ?? null,
        },
      });
      await appendAudit(db, {
        actor: personActor(req),
        source: "ui",
        action: "task.assign",
        entityType: "task",
        entityId: id,
        before: {
          assigneeAgentId: before.assigneeAgentId,
          assigneePersonIds: beforeAssignees.map((row) => row.personId),
          primaryAssigneePersonId: beforeAssignees.find((row) => row.isPrimary)?.personId ?? null,
        },
        after: {
          assigneeAgentId: task.assigneeAgentId,
          assigneePersonIds: afterAssignees.map((row) => row.personId),
          primaryAssigneePersonId: afterAssignees.find((row) => row.isPrimary)?.personId ?? null,
        },
      });
      await sink.publish(`board:${task.projectId}`, {
        type: "task.assigned",
        payload: { taskId: id, actor: personActor(req) },
      });
    }
    if (assignmentChanged) {
      await ctx.notifications.notifyAssignment({
        task,
        beforePersonIds: beforeAssignees.map((row) => row.personId),
        afterAssignees,
        actor: personActor(req),
        beforePrimaryPersonId: beforeAssignees.find((row) => row.isPrimary)?.personId ?? null,
      });
    }
    return { task: await taskWithAssignees(db, task), assignees: afterAssignees };
  });

  app.post("/api/tasks/:id/artifacts", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parse(ArtifactBody, req.body);
    const task = await getTask(db, id);
    if (!task) throw errors.notFound("task", id);
    const artifact = await attachArtifact(db, {
      taskId: id,
      kind: body.kind,
      title: body.title,
      content: body.content ?? null,
      path: body.path ?? null,
      createdBy: personActor(req),
    });
    await sink.publish(`board:${task.projectId}`, {
      type: "task.artifact_attached",
      payload: { taskId: id, artifactId: artifact.id },
    });
    reply.status(201);
    return { artifact };
  });

  /** Aprobación de REVIEW (US-4): REVIEW→DONE solo humano; decisión auditada. */
  app.post("/api/tasks/:id/approve", async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(DecisionBody, req.body);
    const before = await getTask(db, id);
    if (!before) throw errors.notFound("task", id);
    const task = await engine.moveTask({
      taskId: id,
      to: "DONE",
      expectedVersion: body.expected_version,
      actor: personActor(req),
      ...(body.note !== undefined ? { note: body.note } : {}),
    });
    await appendAudit(db, {
      actor: personActor(req),
      source: "ui",
      action: "task.review_approve",
      entityType: "task",
      entityId: id,
      before: { status: before.status },
      after: { status: task.status },
      reason: body.note ?? null,
    });
    return { task };
  });

  /**
   * Rechazo de REVIEW (US-4 CA-4.3): vuelve a IN_PROGRESS con nota obligatoria
   * y se reencola (READY) para que el MISMO agente la retome con la nota en su
   * timeline como input.
   */
  app.post("/api/tasks/:id/reject", async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(RejectBody, req.body);
    const before = await getTask(db, id);
    if (!before) throw errors.notFound("task", id);
    const rejected = await engine.moveTask({
      taskId: id,
      to: "IN_PROGRESS",
      expectedVersion: body.expected_version,
      actor: personActor(req),
      note: body.note,
    });
    await appendAudit(db, {
      actor: personActor(req),
      source: "ui",
      action: "task.review_reject",
      entityType: "task",
      entityId: id,
      before: { status: before.status },
      after: { status: rejected.status },
      reason: body.note,
    });
    // Reencolar para el despachador (transición de sistema: IN_PROGRESS→READY).
    const task = await engine.moveTask({
      taskId: id,
      to: "READY",
      expectedVersion: rejected.version,
      actor: "system:dispatcher",
      note: "reencolada tras rechazo de revisión",
    });
    return { task };
  });
}
