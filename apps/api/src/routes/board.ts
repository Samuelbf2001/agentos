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
  getArtifact,
  getOrganization,
  getProject,
  getTask,
  listDocs,
  listArtifacts,
  listLabelCatalog,
  listLabelsForTasks,
  listAssignablePeople,
  listOrganizations,
  listProjects,
  listProjectSources,
  listRunsForTask,
  listTaskEvents,
  listTaskLabels,
  listTasks,
  maxOrderKey,
  normalizeLabel,
  replaceTaskLabels,
  searchTasks,
  setGateState,
  updateProject,
  updateTask,
  validateTaskAssigneeOrganization,
  type AgentosDb,
  type Task,
} from "@agentos/db";
import fs from "node:fs";
import { ErrorCodes, isAgentosError, newId } from "@agentos/shared";
import {
  artifactsRoot,
  guessContentType,
  maxArtifactBytes,
  resolveArtifactPath,
  safeFileName,
  storeArtifactFile,
} from "../artifact-files.js";
import { GATE_G1_PLAN } from "@agentos/core";
import type { ApiContext } from "../context.js";
import { parse } from "../http-errors.js";
import { CreateTaskBody, DueAt, createTaskFromBody } from "../task-create.js";
import {
  listTaskAssignees,
  listTasksWithAssignees,
  normalizePersonIds,
  replaceTaskAssignees,
  taskWithAssignees,
  validatePeopleForProject,
} from "../task-contract.js";

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

const LabelsBody = z.object({
  labels: z.array(z.string()).max(20),
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

const MoveTaskProjectBody = z.object({
  project_id: z.string().min(1),
  expected_version: z.number().int().positive(),
});

const CommentBody = z.object({ body: z.string().min(1) });

/**
 * Clave de orden al FINAL de una columna: mismo algoritmo que `nextOrderKey`
 * del motor del tablero (crear/delegar) y que `readyOrderKey` de los módulos,
 * sobre el mismo `maxOrderKey` de `@agentos/db`. El motor no exporta el suyo
 * (función privada de `createBoardEngine`) y este archivo no toca packages/core.
 */
async function nextOrderKey(db: AgentosDb, projectId: string, status: TaskStatusT): Promise<string> {
  const last = await maxOrderKey(db, projectId, status);
  if (!last) return "m";
  const tail = last.charCodeAt(last.length - 1);
  if (tail < "z".charCodeAt(0)) return last.slice(0, -1) + String.fromCharCode(tail + 1);
  return `${last}m`;
}

const AssignBody = z.object({
  expected_version: z.number().int().positive(),
  agent_slug: z.string().nullable().optional(),
  assignee_person_ids: z.array(z.string().min(1)).max(100).optional(),
  primary_assignee_person_id: z.string().min(1).nullable().optional(),
  /** Entrada singular histórica; se transforma en una lista de una persona. */
  person_id: z.string().nullable().optional(),
});

const ArtifactBody = z
  .object({
    kind: z.string().min(1),
    title: z.string().min(1),
    /** Enlace o texto de referencia; nunca una ruta de servidor (B1: `path` no se acepta desde el body). */
    content: z.string().optional(),
  })
  .refine((body) => body.kind !== "link" || (!!body.content && /^https?:\/\//i.test(body.content)), {
    message: "Un artefacto de enlace requiere `content` con una URL http(s)://",
    path: ["content"],
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

  app.get("/api/projects", async () => {
    const projects = await listProjects(db);
    // Una sola consulta a organizaciones (mapa en memoria) para evitar N+1
    // al resolver el nombre del cliente por cada proyecto.
    const orgs = await listOrganizations(db);
    const orgNameById = new Map(orgs.map((org) => [org.id, org.name]));
    return {
      projects: projects.map((project) => ({
        ...project,
        orgName: orgNameById.get(project.orgId) ?? null,
      })),
    };
  });

  app.get("/api/projects/:id", async (req) => {
    const { id } = req.params as { id: string };
    const project = await getProject(db, id);
    if (!project) throw errors.notFound("project", id);
    const org = await getOrganization(db, project.orgId);
    return { project: { ...project, orgName: org?.name ?? null } };
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

  /**
   * Personas asignables a un proyecto: las de su organización más el personal
   * interno (I3), que puede asignarse a cualquier proyecto. La regla se
   * valida también en el repositorio; esta ruta existe para que el selector
   * de la interfaz ofrezca SÓLO opciones válidas en vez de dejar que el
   * humano elija una que la API va a rechazar.
   */
  app.get("/api/projects/:id/people", async (req) => {
    const { id } = req.params as { id: string };
    const project = await getProject(db, id);
    if (!project) throw errors.notFound("project", id);
    const rows = await listAssignablePeople(db, project.orgId);
    return {
      org_id: project.orgId,
      people: rows.map((person) => ({
        id: person.id,
        full_name: person.fullName,
        role: person.role,
        email: person.email,
        is_internal: person.isInternal,
      })),
    };
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
        label: z.string().min(1).optional(),
        /** "1"/"true": tareas de la persona de la sesión, sin repetir su id. */
        mine: z.string().optional(),
      }),
      req.query,
    );
    const status = q.status ? parse(TaskStatus, q.status) : undefined;
    const mine = q.mine === "1" || q.mine === "true";
    const personId = mine ? req.session!.personId : q.assignee_person_id;
    return {
      tasks: await listTasksWithAssignees(db, {
        ...(q.project_id ? { projectId: q.project_id } : {}),
        ...(status ? { status } : {}),
        ...(q.assignee_agent_id ? { assigneeAgentId: q.assignee_agent_id } : {}),
        ...(personId ? { assigneePersonId: personId } : {}),
        ...(q.label ? { label: normalizeLabel(q.label) } : {}),
      }),
    };
  });

  /**
   * Búsqueda de tareas (título, descripción, DoD y comentarios). El motor vive
   * en `@agentos/db`: FTS5 en SQLite, tsvector en Postgres, misma forma.
   */
  app.get("/api/tasks/search", async (req) => {
    const q = parse(
      z.object({
        q: z.string().min(1),
        project_id: z.string().min(1).optional(),
        mine: z.string().optional(),
        limit: z.coerce.number().int().positive().max(50).optional(),
      }),
      req.query,
    );
    const mine = q.mine === "1" || q.mine === "true";
    const hits = await searchTasks(db, q.q, {
      limit: q.limit ?? 20,
      ...(q.project_id ? { projectId: q.project_id } : {}),
      ...(mine ? { personId: req.session!.personId } : {}),
    });
    // El nombre del proyecto se resuelve aquí: la caja de búsqueda es global y
    // el resultado tiene que decir a qué proyecto pertenece cada tarjeta.
    const projectNames = new Map((await listProjects(db)).map((p) => [p.id, p.name]));
    // Una sola consulta de etiquetas para todos los aciertos: evita N+1 (y en
    // Postgres, N viajes de red por búsqueda).
    const labels = await listLabelsForTasks(
      db,
      hits.map((hit) => hit.id),
    );
    return {
      query: q.q,
      hits: hits.map((hit) => ({
        ...hit,
        project_name: projectNames.get(hit.projectId) ?? null,
        labels: labels.get(hit.id) ?? [],
      })),
    };
  });

  /** Catálogo de etiquetas en uso (para el filtro del tablero y el autocompletar). */
  app.get("/api/labels", async (req) => {
    const q = parse(z.object({ project_id: z.string().min(1).optional() }), req.query);
    return {
      labels: await listLabelCatalog(db, { ...(q.project_id ? { projectId: q.project_id } : {}) }),
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

  /** El alta vive en `task-create.ts`: mismo camino que usa Notas al convertir propuestas. */
  app.post("/api/tasks", async (req, reply) => {
    const body = parse(CreateTaskBody, req.body);
    const savedTask = await createTaskFromBody(ctx, { body, actor: personActor(req), log: req.log });
    reply.status(201);
    return { task: await taskWithAssignees(db, savedTask) };
  });

  /**
   * Etiquetas de una tarjeta: reemplazo completo del conjunto. NO consume
   * `expected_version` a propósito — clasificar no es una transición de la
   * máquina de estados y no debe invalidar la ficha que el humano tiene abierta.
   */
  app.put("/api/tasks/:id/labels", async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(LabelsBody, req.body);
    const task = await getTask(db, id);
    if (!task) throw errors.notFound("task", id);
    const before = await listTaskLabels(db, id);
    const labels = await replaceTaskLabels(db, id, body.labels, personActor(req));
    await appendAudit(db, {
      actor: personActor(req),
      source: "ui",
      action: "task.labels",
      entityType: "task",
      entityId: id,
      before: { labels: before },
      after: { labels },
    });
    sink.publish(`board:${task.projectId}`, {
      type: "task.labels_changed",
      payload: { taskId: id, labels, actor: personActor(req) },
    });
    return { task: await taskWithAssignees(db, (await getTask(db, id))!), labels };
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
    const updated = await taskWithAssignees(db, task);
    // Igual que etiquetas y comentarios: sin este evento, el resto de pestañas
    // no se enteraba de un cambio de título/prioridad/vencimiento.
    await sink.publish(`board:${task.projectId}`, { type: "task.updated", payload: { task: updated } });
    return { task: updated };
  });

  /**
   * Cambio de proyecto de una tarjeta (ficha estilo Notion). No es una
   * transición de la máquina de estados: conserva estado, etapa y responsables,
   * pero exige que TODO lo que la tarjeta referencia siga siendo válido en el
   * destino. Nada se limpia en silencio: si un responsable no pertenece al
   * cliente del proyecto destino (ni es interno) o si padre/dependencias
   * quedan en otro proyecto, se rechaza nombrando el conflicto.
   */
  app.post("/api/tasks/:id/project", async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(MoveTaskProjectBody, req.body);
    const before = await getTask(db, id);
    if (!before) throw errors.notFound("task", id);
    const target = await getProject(db, body.project_id);
    if (!target) throw errors.notFound("project", body.project_id);
    if (before.version !== body.expected_version) {
      throw errors.versionConflict("task", id, body.expected_version);
    }
    if (target.id === before.projectId) {
      throw errors.validation("La tarea ya pertenece a ese proyecto", { taskId: id, projectId: target.id });
    }

    // Responsables: misma regla de aislamiento humano que crear/asignar (I3),
    // evaluada contra la organización del proyecto DESTINO.
    const assignees = await listTaskAssignees(db, id);
    try {
      await validateTaskAssigneeOrganization(
        db,
        target.id,
        assignees.map((row) => row.personId),
      );
    } catch (err) {
      if (!isAgentosError(err, ErrorCodes.VALIDATION_ERROR)) throw err;
      const details = (err.details ?? {}) as { personId?: string };
      const offender = assignees.find((row) => row.personId === details.personId);
      const name = offender?.person?.fullName ?? details.personId ?? "desconocido";
      throw errors.validation(
        `El responsable ${name} no pertenece al cliente del proyecto destino "${target.name}" ni es personal interno`,
        {
          taskId: id,
          personId: details.personId ?? null,
          personName: offender?.person?.fullName ?? null,
          fromProjectId: before.projectId,
          toProjectId: target.id,
          targetOrgId: target.orgId,
        },
      );
    }

    // Jerarquía y dependencias: no pueden quedar apuntando a otro proyecto.
    if (before.parentTaskId) {
      const parent = await getTask(db, before.parentTaskId);
      if (parent && parent.projectId !== target.id) {
        throw errors.validation(
          `La tarea padre "${parent.title}" pertenece a otro proyecto; muévela primero o desvincúlala`,
          { taskId: id, parentTaskId: parent.id, parentProjectId: parent.projectId, toProjectId: target.id },
        );
      }
    }
    for (const depId of before.dependsOn ?? []) {
      const dep = await getTask(db, depId);
      if (dep && dep.projectId !== target.id) {
        throw errors.validation(
          `La tarea depende de "${dep.title}", que pertenece a otro proyecto; muévela primero o quita la dependencia`,
          { taskId: id, dependsOnTaskId: dep.id, dependencyProjectId: dep.projectId, toProjectId: target.id },
        );
      }
    }

    const orderKey = await nextOrderKey(db, target.id, before.status);
    const moved = await updateTask(db, id, { projectId: target.id, orderKey }, body.expected_version);
    await appendAudit(db, {
      actor: personActor(req),
      source: "ui",
      action: "task.moved_project",
      entityType: "task",
      entityId: id,
      before: { projectId: before.projectId, orderKey: before.orderKey },
      after: { projectId: moved.projectId, orderKey: moved.orderKey },
    });
    const task = await taskWithAssignees(db, moved);
    // Los dos tableros tienen que reaccionar: el viejo quita la tarjeta y el
    // nuevo la añade. Mismo payload en ambos topics.
    const payload = { task, from_project_id: before.projectId, to_project_id: target.id };
    await sink.publish(`board:${before.projectId}`, { type: "task.moved_project", payload });
    await sink.publish(`board:${target.id}`, { type: "task.moved_project", payload });
    return { task };
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
      try {
        await ctx.notifications.notifyAssignment({
          task,
          beforePersonIds: beforeAssignees.map((row) => row.personId),
          afterAssignees,
          actor: personActor(req),
          beforePrimaryPersonId: beforeAssignees.find((row) => row.isPrimary)?.personId ?? null,
        });
      } catch (err) {
        // La asignación ya quedó escrita: un fallo al avisar no debe tumbar la
        // petición ni reportarse como error al cliente.
        req.log.warn({ err, taskId: id }, "No se pudo enviar el aviso de asignación de la tarea");
      }
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
      createdBy: personActor(req),
    });
    await sink.publish(`board:${task.projectId}`, {
      type: "task.artifact_attached",
      payload: { taskId: id, artifactId: artifact.id },
    });
    reply.status(201);
    return { artifact };
  });

  /**
   * Subida real de un archivo como artefacto (multipart/form-data, campo
   * `file`; `title` opcional). El binario NUNCA entra en la base ni en el
   * repositorio: se escribe bajo la raíz de artefactos y la fila guarda la
   * ruta relativa. Es lo que permite cerrar una tarea desde la interfaz sin
   * relajar la regla anti-teatro del motor.
   */
  app.post("/api/tasks/:id/artifacts/upload", async (req, reply) => {
    const { id } = req.params as { id: string };
    const task = await getTask(db, id);
    if (!task) throw errors.notFound("task", id);
    const project = await getProject(db, task.projectId);
    if (!project) throw errors.notFound("project", task.projectId);

    const upload = await req.file();
    if (!upload) throw errors.validation("Falta el archivo (campo multipart `file`)");
    let data: Buffer;
    try {
      data = await upload.toBuffer();
    } catch (err) {
      // Distingue el límite de tamaño de `@fastify/multipart` (código estable
      // de la librería) de cualquier otro fallo de lectura del stream.
      if ((err as { code?: string } | undefined)?.code === "FST_REQ_FILE_TOO_LARGE") {
        return reply.status(413).send({
          error: {
            code: "file_too_large",
            message: `El archivo supera el límite de ${Math.round(maxArtifactBytes() / (1024 * 1024))} MB`,
          },
        });
      }
      throw err;
    }
    if (data.byteLength === 0) throw errors.validation("El archivo está vacío");

    const declaredTitle = (upload.fields?.title as { value?: unknown } | undefined)?.value;
    const title =
      typeof declaredTitle === "string" && declaredTitle.trim()
        ? declaredTitle.trim()
        : safeFileName(upload.filename ?? "archivo");
    const artifactId = newId();
    const root = artifactsRoot(project);
    const stored = storeArtifactFile({
      root,
      projectId: project.id,
      taskId: id,
      artifactId,
      fileName: upload.filename ?? "archivo",
      data,
    });
    const artifact = await attachArtifact(db, {
      id: artifactId,
      taskId: id,
      kind: "file",
      title,
      content: null,
      path: stored.relativePath,
      meta: {
        originalName: upload.filename ?? null,
        mimeType: upload.mimetype ?? null,
        bytes: stored.bytes,
        storage: "artifacts_root",
      },
      createdBy: personActor(req),
    });
    await appendAudit(db, {
      actor: personActor(req),
      source: "ui",
      action: "task.artifact_upload",
      entityType: "task",
      entityId: id,
      after: { artifactId: artifact.id, title, bytes: stored.bytes },
    });
    await sink.publish(`board:${task.projectId}`, {
      type: "task.artifact_attached",
      payload: { taskId: id, artifactId: artifact.id },
    });
    reply.status(201);
    return { artifact };
  });

  /** Descarga del binario de un artefacto subido (o escrito por un runner). */
  app.get("/api/artifacts/:id/download", async (req, reply) => {
    const { id } = req.params as { id: string };
    const artifact = await getArtifact(db, id);
    if (!artifact) throw errors.notFound("artifact", id);
    if (!artifact.path) {
      throw errors.validation("Este artefacto no tiene archivo: su contenido es texto", { artifactId: id });
    }
    // Sólo se sirven binarios que ESTA API escribió bajo la raíz de artefactos
    // (B1): cualquier otro origen de `path` responde 404 sin revelar rutas.
    const meta = (artifact.meta ?? {}) as {
      originalName?: string | null;
      mimeType?: string | null;
      storage?: string | null;
    };
    if (meta.storage !== "artifacts_root") throw errors.notFound("artifact_file", id);
    const task = await getTask(db, artifact.taskId);
    const project = (task ? await getProject(db, task.projectId) : null) ?? null;
    const absolute = resolveArtifactPath(artifactsRoot(project), artifact.path);
    if (!fs.existsSync(absolute)) throw errors.notFound("artifact_file", id);
    const fileName = safeFileName(meta.originalName || artifact.title);
    reply
      .header("content-type", guessContentType(fileName, meta.mimeType ?? null))
      .header("content-disposition", `attachment; filename="${fileName}"`);
    return reply.send(fs.createReadStream(absolute));
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
