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
  listArtifacts,
  listProjects,
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

  app.get("/api/projects", async () => ({ projects: listProjects(db) }));

  app.get("/api/projects/:id", async (req) => {
    const { id } = req.params as { id: string };
    const project = getProject(db, id);
    if (!project) throw errors.notFound("project", id);
    return { project };
  });

  app.post("/api/projects", async (req, reply) => {
    const body = parse(CreateProjectBody, req.body);
    const project = createProject(db, {
      orgId: body.org_id,
      name: body.name,
      type: body.type,
      stage: body.stage ?? "ENTENDER",
      gateState: "pending",
      workspacePath: body.workspace_path ?? null,
    });
    appendAudit(db, {
      actor: personActor(req),
      source: "ui",
      action: "project.create",
      entityType: "project",
      entityId: project.id,
      after: { name: project.name, type: project.type },
    });
    sink.publish(`board:${project.id}`, { type: "project.created", payload: { projectId: project.id } });
    reply.status(201);
    return { project };
  });

  app.patch("/api/projects/:id", async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(UpdateProjectBody, req.body);
    const before = getProject(db, id);
    if (!before) throw errors.notFound("project", id);
    const project = updateProject(
      db,
      id,
      {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.stage !== undefined ? { stage: body.stage } : {}),
        ...(body.workspace_path !== undefined ? { workspacePath: body.workspace_path } : {}),
      },
      body.expected_version,
    );
    appendAudit(db, {
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
      const project = engine.approveGate(id, GATE_G1_PLAN, personId, body.note);
      return { project };
    }
    const before = getProject(db, id);
    if (!before) throw errors.notFound("project", id);
    const project = setGateState(db, id, "rejected", before.version);
    appendAudit(db, {
      actor: personActor(req),
      source: "ui",
      action: "gate.reject",
      entityType: "project",
      entityId: id,
      before: { gateState: before.gateState },
      after: { gateState: project.gateState, gate: body.gate },
      reason: body.note ?? null,
    });
    sink.publish(`board:${id}`, { type: "gate.rejected", payload: { gate: body.gate, by: personId } });
    return { project };
  });

  // ── Board snapshot (stage×status) ─────────────────────────────────────────

  app.get("/api/board/:projectId", async (req) => {
    const { projectId } = req.params as { projectId: string };
    const project = getProject(db, projectId);
    if (!project) throw errors.notFound("project", projectId);
    const rows = boardTasks(db, projectId);
    const columns: Partial<Record<TaskStatusT, Task[]>> = {};
    const cells: Record<string, Partial<Record<TaskStatusT, Task[]>>> = {};
    for (const t of rows) {
      (columns[t.status] ??= []).push(t);
      ((cells[t.stage] ??= {})[t.status] ??= []).push(t);
    }
    return {
      project,
      board_seq: ctx.bus.lastSeq(`board:${projectId}`),
      total: rows.length,
      columns,
      cells,
    };
  });

  // ── Tasks ─────────────────────────────────────────────────────────────────

  app.get("/api/tasks", async (req) => {
    const q = req.query as { project_id?: string; status?: string; assignee_agent_id?: string };
    const status = q.status ? parse(TaskStatus, q.status) : undefined;
    return {
      tasks: listTasks(db, {
        ...(q.project_id ? { projectId: q.project_id } : {}),
        ...(status ? { status } : {}),
        ...(q.assignee_agent_id ? { assigneeAgentId: q.assignee_agent_id } : {}),
      }),
    };
  });

  app.get("/api/tasks/:id", async (req) => {
    const { id } = req.params as { id: string };
    const task = getTask(db, id);
    if (!task) throw errors.notFound("task", id);
    return {
      task,
      events: listTaskEvents(db, id),
      artifacts: listArtifacts(db, id),
      runs: listRunsForTask(db, id),
    };
  });

  app.post("/api/tasks", async (req, reply) => {
    const body = parse(CreateTaskBody, req.body);
    let assigneeAgentId: string | null = null;
    if (body.assignee_agent_slug) {
      const agent = getAgentBySlug(db, body.assignee_agent_slug);
      if (!agent) throw errors.notFound("agent", body.assignee_agent_slug);
      assigneeAgentId = agent.id;
    }
    const task = engine.createTask(
      {
        projectId: body.project_id,
        title: body.title,
        stage: body.stage,
        description: body.description ?? null,
        definitionOfDone: body.definition_of_done ?? null,
        activityType: body.activity_type ?? null,
        priority: body.priority ?? "normal",
        assigneeAgentId,
        assigneePersonId: body.assignee_person_id ?? null,
        parentTaskId: body.parent_task_id ?? null,
        ...(body.external_effect !== undefined ? { externalEffect: body.external_effect } : {}),
        ...(body.requires_approval !== undefined ? { requiresApproval: body.requires_approval } : {}),
      },
      { actor: personActor(req) },
    );
    reply.status(201);
    return { task };
  });

  app.patch("/api/tasks/:id", async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(UpdateTaskBody, req.body);
    const task = updateTask(
      db,
      id,
      {
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.definition_of_done !== undefined ? { definitionOfDone: body.definition_of_done } : {}),
        ...(body.activity_type !== undefined ? { activityType: body.activity_type } : {}),
        ...(body.priority !== undefined ? { priority: body.priority } : {}),
      },
      body.expected_version,
    );
    return { task };
  });

  app.post("/api/tasks/:id/move", async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(MoveTaskBody, req.body);
    const task = engine.moveTask({
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
    const task = getTask(db, id);
    if (!task) throw errors.notFound("task", id);
    const event = appendTaskEvent(db, {
      taskId: id,
      kind: "comment",
      actor: personActor(req),
      payload: { body: body.body },
    });
    sink.publish(`board:${task.projectId}`, {
      type: "task.commented",
      payload: { taskId: id, eventId: event.id, actor: personActor(req) },
    });
    reply.status(201);
    return { event };
  });

  app.post("/api/tasks/:id/assign", async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(AssignBody, req.body);
    const before = getTask(db, id);
    if (!before) throw errors.notFound("task", id);
    let assigneeAgentId: string | null | undefined;
    if (body.agent_slug !== undefined) {
      if (body.agent_slug === null) assigneeAgentId = null;
      else {
        const agent = getAgentBySlug(db, body.agent_slug);
        if (!agent) throw errors.notFound("agent", body.agent_slug);
        assigneeAgentId = agent.id;
      }
    }
    const task = updateTask(
      db,
      id,
      {
        ...(assigneeAgentId !== undefined ? { assigneeAgentId } : {}),
        ...(body.person_id !== undefined ? { assigneePersonId: body.person_id } : {}),
      },
      body.expected_version,
    );
    appendTaskEvent(db, {
      taskId: id,
      kind: "assigned",
      actor: personActor(req),
      payload: { agentSlug: body.agent_slug ?? null, personId: body.person_id ?? null },
    });
    sink.publish(`board:${task.projectId}`, {
      type: "task.assigned",
      payload: { taskId: id, actor: personActor(req) },
    });
    return { task };
  });

  app.post("/api/tasks/:id/artifacts", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parse(ArtifactBody, req.body);
    const task = getTask(db, id);
    if (!task) throw errors.notFound("task", id);
    const artifact = attachArtifact(db, {
      taskId: id,
      kind: body.kind,
      title: body.title,
      content: body.content ?? null,
      path: body.path ?? null,
      createdBy: personActor(req),
    });
    sink.publish(`board:${task.projectId}`, {
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
    const before = getTask(db, id);
    if (!before) throw errors.notFound("task", id);
    const task = engine.moveTask({
      taskId: id,
      to: "DONE",
      expectedVersion: body.expected_version,
      actor: personActor(req),
      ...(body.note !== undefined ? { note: body.note } : {}),
    });
    appendAudit(db, {
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
    const before = getTask(db, id);
    if (!before) throw errors.notFound("task", id);
    const rejected = engine.moveTask({
      taskId: id,
      to: "IN_PROGRESS",
      expectedVersion: body.expected_version,
      actor: personActor(req),
      note: body.note,
    });
    appendAudit(db, {
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
    const task = engine.moveTask({
      taskId: id,
      to: "READY",
      expectedVersion: rejected.version,
      actor: "system:dispatcher",
      note: "reencolada tras rechazo de revisión",
    });
    return { task };
  });
}
