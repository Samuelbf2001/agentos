/** REST de operación: agents, runs (con cancel real), approvals, threads,
 * contexto (knowledge/processes/methodologies) y config (kill switch). */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AgentStatus, AgentAutonomy, KnowledgeKind, RunStatus, errors } from "@agentos/shared";
import {
  appendAudit,
  appendTaskEvent,
  getAgent,
  getAgentBySlug,
  getApproval,
  getDoc,
  getMethodology,
  getProcess,
  getRun,
  getTask,
  getThread,
  listAgents,
  listArtifacts,
  listConfig,
  listDocs,
  listMessages,
  listMethodologies,
  listProcesses,
  listRuns,
  listRunsByRoot,
  listSpans,
  listTasks,
  listThreads,
  searchDocs,
  updateAgent,
  upsertDoc,
} from "@agentos/db";
import type { ToolCallContext } from "@agentos/tools";
import type { ApiContext } from "../context.js";
import { parse } from "../http-errors.js";

const UpdateAgentBody = z.object({
  expected_version: z.number().int().positive(),
  name: z.string().min(1).optional(),
  model: z.string().nullable().optional(),
  autonomy: AgentAutonomy.optional(),
  tools_allowlist: z.array(z.string()).optional(),
  limits: z.record(z.string(), z.unknown()).nullable().optional(),
});

const SetStatusBody = z.object({
  expected_version: z.number().int().positive(),
  status: AgentStatus,
  reason: z.string().optional(),
});

const DecideBody = z.object({
  decision: z.enum(["approved", "rejected"]),
  note: z.string().optional(),
});

const UpsertDocBody = z.object({
  id: z.string().optional(),
  org_id: z.string().nullable().optional(),
  project_id: z.string().nullable().optional(),
  kind: KnowledgeKind,
  title: z.string().min(1),
  body_md: z.string().min(1),
  source_refs: z.array(z.record(z.string(), z.unknown())).optional(),
  tags: z.array(z.string()).optional(),
});

const KillSwitchBody = z.object({
  active: z.boolean(),
  reason: z.string().optional(),
});

export function registerOpsRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const { db, engine, pool, dispatcher, toolRuntime, sink } = ctx;

  const personActor = (req: { session?: { personId: string } | undefined }): string =>
    `person:${req.session!.personId}`;

  // ── Agents ────────────────────────────────────────────────────────────────

  app.get("/api/agents", async () => ({ agents: listAgents(db) }));

  app.get("/api/agents/:ref", async (req) => {
    const { ref } = req.params as { ref: string };
    const agent = getAgent(db, ref) ?? getAgentBySlug(db, ref);
    if (!agent) throw errors.notFound("agent", ref);
    return { agent };
  });

  app.patch("/api/agents/:id", async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(UpdateAgentBody, req.body);
    const before = getAgent(db, id) ?? getAgentBySlug(db, id);
    if (!before) throw errors.notFound("agent", id);
    const agent = updateAgent(
      db,
      before.id,
      {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.model !== undefined ? { model: body.model } : {}),
        ...(body.autonomy !== undefined ? { autonomy: body.autonomy } : {}),
        ...(body.tools_allowlist !== undefined ? { toolsAllowlist: body.tools_allowlist } : {}),
        ...(body.limits !== undefined ? { limits: body.limits } : {}),
      },
      body.expected_version,
    );
    appendAudit(db, {
      actor: personActor(req),
      source: "ui",
      action: "agent.update",
      entityType: "agent",
      entityId: agent.id,
      before: { name: before.name, model: before.model, autonomy: before.autonomy },
      after: { name: agent.name, model: agent.model, autonomy: agent.autonomy },
    });
    return { agent };
  });

  /** set_status: pausar/reactivar un agente concreto (US-11 CA-11.2). */
  app.post("/api/agents/:id/status", async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(SetStatusBody, req.body);
    const before = getAgent(db, id) ?? getAgentBySlug(db, id);
    if (!before) throw errors.notFound("agent", id);
    const agent = updateAgent(db, before.id, { status: body.status }, body.expected_version);
    appendAudit(db, {
      actor: personActor(req),
      source: "ui",
      action: "agent.set_status",
      entityType: "agent",
      entityId: agent.id,
      before: { status: before.status },
      after: { status: agent.status },
      reason: body.reason ?? null,
    });
    sink.publish("swarm", {
      type: "agent.status",
      payload: { agentId: agent.id, slug: agent.slug, status: agent.status },
    });
    return { agent };
  });

  // ── Runs ──────────────────────────────────────────────────────────────────

  app.get("/api/runs", async (req) => {
    const q = req.query as {
      status?: string;
      task_id?: string;
      project_id?: string;
      agent_id?: string;
      limit?: string;
    };
    const status = q.status ? parse(RunStatus, q.status) : undefined;
    const limit = q.limit ? Number(q.limit) : undefined;
    return {
      runs: listRuns(db, {
        ...(status ? { status } : {}),
        ...(q.task_id ? { taskId: q.task_id } : {}),
        ...(q.project_id ? { projectId: q.project_id } : {}),
        ...(q.agent_id ? { agentId: q.agent_id } : {}),
        ...(limit !== undefined && Number.isFinite(limit) ? { limit } : {}),
      }),
    };
  });

  app.get("/api/runs/:id", async (req) => {
    const { id } = req.params as { id: string };
    const run = getRun(db, id);
    if (!run) throw errors.notFound("run", id);
    return {
      run,
      spans: listSpans(db, id),
      tree: listRunsByRoot(db, run.rootRunId),
      last_seq: ctx.bus.lastSeq(`run:${id}`),
    };
  });

  /** Cancelación real vía RunnerPool (US-11 CA-11.3). */
  app.post("/api/runs/:id/cancel", async (req) => {
    const { id } = req.params as { id: string };
    const before = getRun(db, id);
    if (!before) throw errors.notFound("run", id);
    await pool.cancel(id, `cancelled por ${personActor(req)}`);
    const run = getRun(db, id)!;
    appendAudit(db, {
      actor: personActor(req),
      source: "ui",
      action: "run.cancel",
      entityType: "run",
      entityId: id,
      before: { status: before.status },
      after: { status: run.status },
      runId: id,
    });
    return { run };
  });

  // ── Approvals (Gate 2: decidir → ejecutar → reanudar) ─────────────────────

  app.get("/api/approvals/pending", async () => ({ approvals: engine.listPendingApprovals() }));

  /**
   * Bandeja "Esperando por ti" (US-4 CA-4.2, fix H10): TODO lo que espera a un
   * humano en un solo snapshot — aprobaciones pendientes (tools/preguntas/gates)
   * Y entregables en REVIEW con sus artefactos (REVIEW→DONE solo lo mueve un
   * humano, así que toda tarjeta en REVIEW espera por ti).
   */
  app.get("/api/waiting", async () => ({
    approvals: engine.listPendingApprovals(),
    review_tasks: listTasks(db, { status: "REVIEW" }).map((task) => ({
      task,
      artifacts: listArtifacts(db, task.id),
    })),
  }));

  app.get("/api/approvals/:id", async (req) => {
    const { id } = req.params as { id: string };
    const approval = getApproval(db, id);
    if (!approval) throw errors.notFound("approval", id);
    return { approval };
  });

  app.post("/api/approvals/:id/decide", async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(DecideBody, req.body);
    const personId = req.session!.personId;
    const result = engine.decideApproval(id, body.decision, personId, body.note);
    const approval = result.approval;

    /**
     * H9 (cierre del ciclo ask_human): una pregunta/entregable decidido deja la
     * respuesta en el timeline y devuelve la tarjeta BLOCKED(approval) a READY —
     * el agente retoma con la respuesta visible en sus últimos eventos.
     * (Las tool_call van por su propio camino: ejecutar + run de reanudación.)
     */
    function recordAndUnblock(decisionLabel: string): void {
      if (!approval.taskId) return;
      const task = getTask(db, approval.taskId);
      if (!task) return;
      appendTaskEvent(db, {
        taskId: task.id,
        runId: approval.runId ?? null,
        kind: "comment",
        actor: personActor(req),
        payload: { body: `Aprobación ${id} ${decisionLabel}${body.note ? `: ${body.note}` : ""}` },
      });
      if (approval.kind !== "tool_call" && task.status === "BLOCKED" && task.blockedReason === "approval") {
        try {
          engine.moveTask({
            taskId: task.id,
            to: "READY",
            expectedVersion: task.version,
            actor: "system:approvals",
            note: `aprobación ${id} resuelta (${decisionLabel.toLowerCase()}): la tarjeta vuelve a la cola`,
          });
        } catch {
          /* otro actor la movió: su movimiento manda */
        }
      }
    }

    if (body.decision === "rejected") {
      // La nota queda en el timeline de la tarea; preguntas/entregables vuelven a la cola.
      recordAndUnblock("RECHAZADA");
      return { approval, executed: null, resume_run_id: null };
    }

    // Aprobado + pregunta/entregable: respuesta al timeline y tarjeta a la cola.
    if (approval.kind !== "tool_call") recordAndUnblock("APROBADA");

    // Aprobado + tool_call: la PLATAFORMA ejecuta el efecto (executeApproved,
    // digest verificado) y encola el run de reanudación con resume_of_run_id.
    let executed = null;
    let resumeRunId: string | null = null;
    if (result.executePayload) {
      const originRun = approval.runId ? getRun(db, approval.runId) : undefined;
      const execCtx: ToolCallContext = {
        run_id: approval.runId ?? null,
        agent_id: originRun?.agentId ?? "system",
        task_id: approval.taskId ?? null,
        project_id: approval.projectId ?? null,
        actor: "system:approvals",
      };
      executed = await toolRuntime.executeApproved(execCtx, id);
      const resume = dispatcher.enqueueApprovalResume(approval, executed);
      resumeRunId = resume?.runId ?? null;
    }
    return { approval, executed, resume_run_id: resumeRunId };
  });

  // ── Threads / messages ────────────────────────────────────────────────────

  app.get("/api/threads", async (req) => {
    const q = req.query as { channel?: string };
    return { threads: listThreads(db, q.channel) };
  });

  app.get("/api/threads/:id", async (req) => {
    const { id } = req.params as { id: string };
    const thread = getThread(db, id);
    if (!thread) throw errors.notFound("thread", id);
    return { thread, last_seq: ctx.bus.lastSeq(`thread:${id}`) };
  });

  app.get("/api/threads/:id/messages", async (req) => {
    const { id } = req.params as { id: string };
    const thread = getThread(db, id);
    if (!thread) throw errors.notFound("thread", id);
    const q = req.query as { limit?: string };
    const limit = q.limit ? Number(q.limit) : undefined;
    return { messages: listMessages(db, id, Number.isFinite(limit) ? limit : undefined) };
  });

  // ── Contexto: knowledge / processes / methodologies (§8b) ─────────────────

  app.get("/api/knowledge", async (req) => {
    const q = req.query as { org_id?: string; project_id?: string; kind?: string };
    const kind = q.kind ? parse(KnowledgeKind, q.kind) : undefined;
    return {
      docs: listDocs(db, {
        ...(q.org_id ? { orgId: q.org_id } : {}),
        ...(q.project_id ? { projectId: q.project_id } : {}),
        ...(kind ? { kind } : {}),
      }),
    };
  });

  app.get("/api/knowledge/search", async (req) => {
    const q = req.query as { q?: string; limit?: string };
    if (!q.q?.trim()) throw errors.validation("Parámetro q obligatorio");
    const limit = q.limit ? Number(q.limit) : undefined;
    return { hits: searchDocs(db, q.q, Number.isFinite(limit) ? limit : undefined) };
  });

  app.get("/api/knowledge/:id", async (req) => {
    const { id } = req.params as { id: string };
    const doc = getDoc(db, id);
    if (!doc) throw errors.notFound("knowledge_doc", id);
    return { doc };
  });

  app.put("/api/knowledge", async (req) => {
    const body = parse(UpsertDocBody, req.body);
    const doc = upsertDoc(db, {
      ...(body.id ? { id: body.id } : {}),
      orgId: body.org_id ?? null,
      projectId: body.project_id ?? null,
      kind: body.kind,
      title: body.title,
      bodyMd: body.body_md,
      sourceRefs: body.source_refs ?? null,
      tags: body.tags ?? null,
      createdBy: personActor(req),
    });
    return { doc };
  });

  app.get("/api/processes", async (req) => {
    const q = req.query as { org_id?: string };
    return { processes: listProcesses(db, q.org_id) };
  });

  app.get("/api/processes/:id", async (req) => {
    const { id } = req.params as { id: string };
    const process = getProcess(db, id);
    if (!process) throw errors.notFound("process", id);
    return { process };
  });

  app.get("/api/methodologies", async () => ({ methodologies: listMethodologies(db) }));

  app.get("/api/methodologies/:slug", async (req) => {
    const { slug } = req.params as { slug: string };
    const methodology = getMethodology(db, slug);
    if (!methodology) throw errors.notFound("methodology", slug);
    return { methodology };
  });

  // ── Config: kill switch / pause_all / resume_all (US-11) ──────────────────

  app.get("/api/config", async () => ({ config: listConfig(db) }));

  app.get("/api/config/kill-switch", async () => ({ active: engine.isKillSwitchActive() }));

  async function setKillSwitch(
    active: boolean,
    actor: string,
    reason?: string,
  ): Promise<{ active: boolean }> {
    engine.setKillSwitch(active, actor, reason);
    if (active) {
      // ≤10 s (CA-11.1): no arrancan runs nuevos y los activos se cancelan YA.
      await pool.cancelAll("kill_switch");
    }
    return { active: engine.isKillSwitchActive() };
  }

  app.put("/api/config/kill-switch", async (req) => {
    const body = parse(KillSwitchBody, req.body);
    return setKillSwitch(body.active, personActor(req), body.reason);
  });

  app.post("/api/config/pause-all", async (req) => {
    const body = parse(z.object({ reason: z.string().optional() }), req.body ?? {});
    return setKillSwitch(true, personActor(req), body.reason ?? "pause_all");
  });

  app.post("/api/config/resume-all", async (req) => {
    const body = parse(z.object({ reason: z.string().optional() }), req.body ?? {});
    return setKillSwitch(false, personActor(req), body.reason ?? "resume_all");
  });
}
