/**
 * Motor del tablero (ARCHITECTURE §6) — la mitad del diseño.
 *
 * - Máquina de 7 estados con matriz de permisos por actor (state-machine.ts).
 * - Toda transición usa `expected_version` (conflicto → error de dominio, jamás
 *   last-write-wins) y escribe `task_events` con actor y run_id.
 * - Claim con lease (UPDATE condicional validado en packages/db), latido y reaper.
 * - Regla anti-teatro: nada llega a REVIEW/DONE sin fila en `artifacts`.
 * - Gate 1 (proyecto): tareas CONSTRUIR no salen de BACKLOG sin g1 aprobado.
 * - Gate 2 (tool call): approvals con payload literal + digest; aprobar un
 *   tool_call devuelve el payload para que el despachador (B4) ejecute.
 * - Delegación = crear tarea hija con payload tipado; depth máx 3, fan-out máx 4
 *   por run — se RECHAZA con error claro, no se trunca.
 */
import { z } from "zod";
import {
  AgentosError,
  ErrorCodes,
  errors,
  nowMs,
  type ApprovalKind,
  type BlockedReason,
  type TaskPriority,
  type TaskStatus,
} from "@agentos/shared";
import {
  appendAudit,
  appendTaskEvent,
  claimTask as repoClaimTask,
  ConfigKeys,
  countArtifacts,
  createApproval,
  createTask as repoCreateTask,
  decideApproval as repoDecideApproval,
  digestPayload,
  getAgent,
  getAgentBySlug,
  getApproval,
  getConfig,
  getProject,
  getTask,
  listPendingApprovals,
  reapExpiredLeases,
  renewLease as repoRenewLease,
  setConfig,
  setGateState,
  updateTask,
  type AgentosDb,
  type Approval,
  type Project,
  type Task,
} from "@agentos/db";
import { noopEventSink, type EventSink } from "../events.js";
import { computeRequiresApproval } from "./policy.js";
import { actorKind, assertTransitionAllowed, type ActorKind } from "./state-machine.js";

// ── Configuración ───────────────────────────────────────────────────────────

export interface BoardEngineOptions {
  db: AgentosDb;
  sink?: EventSink;
  /** Agentes que pueden BACKLOG→READY (ARCHITECTURE §6: solo el orquestador). */
  orchestratorSlugs?: string[];
  leaseMs?: number;
  maxAttempts?: number;
  maxDelegationDepth?: number;
  maxFanOutPerRun?: number;
}

export const DEFAULT_ORCHESTRATOR_SLUGS = ["alex"];
export const MAX_DELEGATION_DEPTH = 3;
export const MAX_FAN_OUT_PER_RUN = 4;

/** El único gate de proyecto del MVP (cierre de ENTENDER → habilita CONSTRUIR). */
export const GATE_G1_PLAN = "g1_plan" as const;
export type GateName = typeof GATE_G1_PLAN;

// ── Tipos de entrada ────────────────────────────────────────────────────────

export interface CreateTaskInput {
  projectId: string;
  title: string;
  description?: string | null;
  definitionOfDone?: string | null;
  stage: Task["stage"];
  activityType?: string | null;
  priority?: TaskPriority;
  assigneeAgentId?: string | null;
  assigneePersonId?: string | null;
  parentTaskId?: string | null;
  externalEffect?: boolean;
  /** Solo puede SUBIR el control (la política nunca se rebaja). */
  requiresApproval?: boolean;
}

export interface MoveTaskInput {
  taskId: string;
  to: TaskStatus;
  expectedVersion: number;
  actor: string; // ActorRef: agent:<slug> | person:<id> | system:<comp>
  runId?: string | null;
  note?: string;
  blockedReason?: BlockedReason;
}

export interface ClaimInput {
  taskId: string;
  agentId: string; // id de DB del agente
  runId?: string | null;
  leaseMs?: number;
}

/** Payload tipado de delegación (patrón handoff de OpenBot — nunca texto libre). */
export const DelegationPayload = z.object({
  tarea: z.string().min(1, "tarea es obligatoria"),
  limites: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  forma_de_buena_respuesta: z.string().min(1, "forma_de_buena_respuesta es obligatoria"),
});
export type DelegationPayload = z.infer<typeof DelegationPayload>;

export interface DelegateInput {
  parentTaskId: string;
  payload: DelegationPayload;
  /** slug o id del agente asignado a la tarea hija. */
  assignee: string;
  actor: string;
  runId?: string | null;
}

export interface RequestApprovalInput {
  kind: ApprovalKind;
  payload: Record<string, unknown>;
  runId?: string | null;
  taskId?: string | null;
  projectId?: string | null;
  requestedBy?: string | null;
}

export interface DecideApprovalResult {
  approval: Approval;
  /**
   * Si se aprobó un tool_call: el payload LITERAL aprobado, para que el
   * despachador (B4) ejecute el efecto y encole el run de reanudación.
   */
  executePayload?: Record<string, unknown>;
}

export interface BoardEngine {
  createTask(input: CreateTaskInput, opts: { actor: string; runId?: string | null }): Task;
  moveTask(input: MoveTaskInput): Task;
  claim(input: ClaimInput): { claimed: boolean; task?: Task };
  renewLease(taskId: string, leaseMs?: number): boolean;
  reap(): { requeued: string[]; blocked: string[] };
  approveGate(projectId: string, gate: GateName, personId: string, note?: string): Project;
  requestApproval(input: RequestApprovalInput): Approval;
  decideApproval(
    approvalId: string,
    decision: "approved" | "rejected",
    personId: string,
    note?: string,
  ): DecideApprovalResult;
  listPendingApprovals(): Approval[];
  delegate(input: DelegateInput): Task;
  isKillSwitchActive(): boolean;
  setKillSwitch(active: boolean, actor: string, reason?: string): void;
  isAgentPaused(agentIdOrSlug: string): boolean;
  /** Lanza kill_switch_active / policy_denied si el agente no puede correr. */
  assertAgentCanRun(agentIdOrSlug: string): void;
}

// ── Motor ───────────────────────────────────────────────────────────────────

export function createBoardEngine(opts: BoardEngineOptions): BoardEngine {
  const db = opts.db;
  const sink: EventSink = opts.sink ?? noopEventSink;
  const orchestrators = opts.orchestratorSlugs ?? DEFAULT_ORCHESTRATOR_SLUGS;
  const defaultLeaseMs = opts.leaseMs ?? 60_000;
  const maxAttempts = opts.maxAttempts ?? 3;
  const maxDepth = opts.maxDelegationDepth ?? MAX_DELEGATION_DEPTH;
  const maxFanOut = opts.maxFanOutPerRun ?? MAX_FAN_OUT_PER_RUN;

  function publishBoard(projectId: string, type: string, payload: Record<string, unknown>, runId?: string | null): void {
    sink.publish(`board:${projectId}`, { type, payload, runId: runId ?? null });
  }

  function mustGetTask(taskId: string): Task {
    const task = getTask(db, taskId);
    if (!task) throw errors.notFound("task", taskId);
    return task;
  }

  function mustGetProject(projectId: string): Project {
    const project = getProject(db, projectId);
    if (!project) throw errors.notFound("project", projectId);
    return project;
  }

  /** Gate 1: una tarea CONSTRUIR no sale de BACKLOG sin g1_plan aprobado. */
  function assertGate1(task: Pick<Task, "stage" | "projectId">): void {
    if (task.stage !== "CONSTRUIR") return;
    const project = mustGetProject(task.projectId);
    if (project.gateState !== "approved") {
      throw new AgentosError(
        ErrorCodes.GATE_NOT_PASSED,
        `Gate 1 (${GATE_G1_PLAN}) no aprobado en el proyecto ${project.id}: ` +
          `las tareas de CONSTRUIR no salen de BACKLOG (gate_state=${project.gateState})`,
        { projectId: project.id, gate: GATE_G1_PLAN, gateState: project.gateState },
      );
    }
  }

  /**
   * Clave de orden al FINAL de la columna: estrictamente mayor que el máximo
   * actual, crecimiento acotado (~1 carácter por cada 13 inserciones).
   */
  function nextOrderKey(projectId: string, status: TaskStatus): string {
    const row = db.$client
      .prepare(`SELECT max(order_key) AS mk FROM tasks WHERE project_id = ? AND status = ?`)
      .get(projectId, status) as { mk: string | null } | undefined;
    const last = row?.mk;
    if (!last) return "m";
    const tail = last.charCodeAt(last.length - 1);
    if (tail < "z".charCodeAt(0)) return last.slice(0, -1) + String.fromCharCode(tail + 1);
    return `${last}m`;
  }

  function resolveAgent(idOrSlug: string) {
    return getAgent(db, idOrSlug) ?? getAgentBySlug(db, idOrSlug);
  }

  // ── Kill switch y pausado ─────────────────────────────────────────────────

  function isKillSwitchActive(): boolean {
    const value = getConfig(db, ConfigKeys.KILL_SWITCH);
    if (value === true || value === "on" || value === 1) return true;
    if (typeof value === "object" && value !== null && (value as { active?: unknown }).active === true) return true;
    return false;
  }

  function isAgentPaused(agentIdOrSlug: string): boolean {
    const agent = resolveAgent(agentIdOrSlug);
    if (!agent) throw errors.notFound("agent", agentIdOrSlug);
    return agent.status !== "active";
  }

  function assertAgentCanRun(agentIdOrSlug: string): void {
    if (isKillSwitchActive()) {
      throw new AgentosError(ErrorCodes.KILL_SWITCH_ACTIVE, "Kill switch activo: no arrancan trabajos nuevos");
    }
    const agent = resolveAgent(agentIdOrSlug);
    if (!agent) throw errors.notFound("agent", agentIdOrSlug);
    if (agent.status !== "active") {
      throw new AgentosError(
        ErrorCodes.POLICY_DENIED,
        `Agente ${agent.slug} está "${agent.status}" — no puede tomar trabajo`,
        { agentId: agent.id, status: agent.status },
      );
    }
  }

  // ── Crear tarea ───────────────────────────────────────────────────────────

  function createTask(input: CreateTaskInput, ctx: { actor: string; runId?: string | null }): Task {
    if (!input.title.trim()) throw errors.validation("title es obligatorio");
    mustGetProject(input.projectId);
    // Política determinista: el llamador puede SUBIR el control, nunca bajarlo.
    const requiresApproval =
      computeRequiresApproval({ externalEffect: input.externalEffect, activityType: input.activityType }) ||
      input.requiresApproval === true;

    const task = repoCreateTask(db, {
      projectId: input.projectId,
      parentTaskId: input.parentTaskId ?? null,
      title: input.title,
      description: input.description ?? null,
      definitionOfDone: input.definitionOfDone ?? null,
      stage: input.stage,
      status: "BACKLOG",
      activityType: input.activityType ?? null,
      priority: input.priority ?? "normal",
      assigneeAgentId: input.assigneeAgentId ?? null,
      assigneePersonId: input.assigneePersonId ?? null,
      requiresApproval,
      externalEffect: input.externalEffect ?? false,
      orderKey: nextOrderKey(input.projectId, "BACKLOG"),
    });
    appendTaskEvent(db, {
      taskId: task.id,
      runId: ctx.runId ?? null,
      kind: "created",
      toStatus: task.status,
      actor: ctx.actor,
      payload: { requiresApproval },
    });
    publishBoard(task.projectId, "task.created", { taskId: task.id, status: task.status, actor: ctx.actor }, ctx.runId);
    return task;
  }

  // ── Transición ────────────────────────────────────────────────────────────

  function moveTask(input: MoveTaskInput, internal?: { viaClaim?: boolean }): Task {
    const task = mustGetTask(input.taskId);
    const from = task.status;
    const to = input.to;
    const kind: ActorKind = actorKind(input.actor);

    // 1. Matriz de permisos por actor (fail-closed).
    assertTransitionAllowed(kind, from, to);

    // 2. Agente READY→IN_PROGRESS solo vía tasks.claim.
    if (kind === "agent" && from === "READY" && to === "IN_PROGRESS" && !internal?.viaClaim) {
      throw new AgentosError(
        ErrorCodes.INVALID_TRANSITION,
        "Un agente toma tareas únicamente vía tasks.claim (claim atómico con lease), no con move",
        { from, to },
      );
    }

    // 3. Gate 1: salir de BACKLOG (salvo cancelación humana) exige g1 aprobado en CONSTRUIR.
    if (from === "BACKLOG" && to !== "CANCELLED") assertGate1(task);

    // 4. BACKLOG→READY: solo orquestador-o-humano, y exige DoD + asignado.
    if (from === "BACKLOG" && to === "READY") {
      if (kind === "agent") {
        const slug = input.actor.slice("agent:".length);
        if (!orchestrators.includes(slug)) {
          throw new AgentosError(
            ErrorCodes.INVALID_TRANSITION,
            `BACKLOG→READY solo lo hace el orquestador (${orchestrators.join(", ")}) o un humano; no "${slug}"`,
            { from, to, actor: input.actor },
          );
        }
      }
      if (!task.definitionOfDone?.trim()) {
        throw errors.validation("BACKLOG→READY exige definition_of_done no vacía", { taskId: task.id });
      }
      if (!task.assigneeAgentId && !task.assigneePersonId) {
        throw errors.validation("BACKLOG→READY exige un asignado (agente o persona)", { taskId: task.id });
      }
    }

    // 5. Agente → DONE con requires_approval: jamás (va por REVIEW + humano).
    if (kind === "agent" && to === "DONE" && task.requiresApproval) {
      throw new AgentosError(
        ErrorCodes.HUMAN_APPROVAL_REQUIRED,
        "La tarea exige aprobación humana: un agente la lleva a REVIEW, un humano la cierra",
        { taskId: task.id },
      );
    }

    // 6. Regla anti-teatro: a REVIEW/DONE solo con ≥1 artefacto.
    if ((to === "REVIEW" || to === "DONE") && countArtifacts(db, task.id) < 1) {
      throw new AgentosError(
        ErrorCodes.MISSING_ARTIFACT,
        `No se llega a ${to} sin al menos un artefacto adjunto (regla anti-teatro)`,
        { taskId: task.id, to },
      );
    }

    // 7. Rechazo de revisión: nota obligatoria.
    if (from === "REVIEW" && to === "IN_PROGRESS" && !input.note?.trim()) {
      throw errors.validation("Rechazar una revisión exige nota para el agente", { taskId: task.id });
    }

    // 8. UPDATE atómico con expected_version + estado origen (jamás last-write-wins).
    const now = nowMs();
    const blockedReason = to === "BLOCKED" ? (input.blockedReason ?? "manual") : null;
    const resetAttempts = from === "BLOCKED" && to === "READY";
    const res = db.$client
      .prepare(
        `UPDATE tasks
         SET status = @to,
             blocked_reason = @blockedReason,
             lease_until = NULL,
             attempts = CASE WHEN @resetAttempts = 1 THEN 0 ELSE attempts END,
             version = version + 1,
             updated_at = @now
         WHERE id = @taskId AND version = @expectedVersion AND status = @from`,
      )
      .run({
        taskId: task.id,
        to,
        from,
        blockedReason,
        resetAttempts: resetAttempts ? 1 : 0,
        expectedVersion: input.expectedVersion,
        now,
      });
    if (res.changes === 0) {
      if (!getTask(db, task.id)) throw errors.notFound("task", task.id);
      throw errors.versionConflict("task", task.id, input.expectedVersion);
    }

    appendTaskEvent(db, {
      taskId: task.id,
      runId: input.runId ?? null,
      kind: "moved",
      fromStatus: from,
      toStatus: to,
      actor: input.actor,
      payload: {
        ...(input.note ? { note: input.note } : {}),
        ...(blockedReason ? { blockedReason } : {}),
      },
    });
    publishBoard(task.projectId, "task.moved", { taskId: task.id, from, to, actor: input.actor }, input.runId);
    // H10: la bandeja "Esperando por ti" incluye entregables en REVIEW; avisar
    // por el topic approvals para que la UI refresque el badge en vivo.
    if (to === "REVIEW" || from === "REVIEW") {
      sink.publish("approvals", {
        type: "review.changed",
        payload: { taskId: task.id, from, to },
        runId: input.runId ?? null,
      });
    }
    return getTask(db, task.id)!;
  }

  // ── Claim / lease / reaper ────────────────────────────────────────────────

  function claim(input: ClaimInput): { claimed: boolean; task?: Task } {
    const agent = resolveAgent(input.agentId);
    if (!agent) throw errors.notFound("agent", input.agentId);
    assertAgentCanRun(agent.id);

    const task = mustGetTask(input.taskId);
    // Una tarea asignada a otro agente no se roba: carrera perdida, no error.
    if (task.assigneeAgentId && task.assigneeAgentId !== agent.id) {
      return { claimed: false };
    }

    // UPDATE condicional ya validado en packages/db (changes=0 = carrera perdida).
    const result = repoClaimTask(db, {
      taskId: input.taskId,
      agentId: agent.slug,
      leaseMs: input.leaseMs ?? defaultLeaseMs,
      runId: input.runId ?? undefined,
    });
    if (!result.claimed || !result.task) return { claimed: false };

    let claimed = result.task;
    if (!claimed.assigneeAgentId) {
      claimed = updateTask(db, claimed.id, { assigneeAgentId: agent.id }, claimed.version);
    }
    publishBoard(
      claimed.projectId,
      "task.claimed",
      { taskId: claimed.id, agent: agent.slug, leaseUntil: claimed.leaseUntil },
      input.runId,
    );
    return { claimed: true, task: claimed };
  }

  function renewLease(taskId: string, leaseMs?: number): boolean {
    return repoRenewLease(db, taskId, leaseMs ?? defaultLeaseMs);
  }

  function reap(): { requeued: string[]; blocked: string[] } {
    const result = reapExpiredLeases(db, maxAttempts);
    for (const id of [...result.requeued, ...result.blocked]) {
      const task = getTask(db, id);
      if (task) {
        publishBoard(task.projectId, "task.reaped", {
          taskId: id,
          to: task.status,
          blockedReason: task.blockedReason,
          attempts: task.attempts,
        });
      }
    }
    return result;
  }

  // ── Gates ─────────────────────────────────────────────────────────────────

  function approveGate(projectId: string, gate: GateName, personId: string, note?: string): Project {
    if (gate !== GATE_G1_PLAN) {
      throw errors.validation(`Gate desconocido: "${gate}" (el MVP solo tiene ${GATE_G1_PLAN})`);
    }
    const project = mustGetProject(projectId);
    const before = { gateState: project.gateState };
    const updated = setGateState(db, projectId, "approved", project.version);
    appendAudit(db, {
      actor: `person:${personId}`,
      source: "ui",
      action: "gate.approve",
      entityType: "project",
      entityId: projectId,
      before,
      after: { gateState: updated.gateState, gate },
      reason: note ?? null,
    });
    publishBoard(projectId, "gate.approved", { gate, by: personId });
    return updated;
  }

  // ── Gate 2: approvals (payload literal + digest) ──────────────────────────

  function requestApproval(input: RequestApprovalInput): Approval {
    try {
      const approval = createApproval(db, {
        kind: input.kind,
        payload: input.payload,
        runId: input.runId ?? null,
        taskId: input.taskId ?? null,
        projectId: input.projectId ?? null,
        requestedBy: input.requestedBy ?? null,
      });
      sink.publish("approvals", {
        type: "approval.requested",
        payload: { approvalId: approval.id, kind: approval.kind, taskId: approval.taskId },
        runId: input.runId ?? null,
      });
      return approval;
    } catch (err) {
      // unique(action_digest, run_id): repetir la MISMA acción en el MISMO run es
      // idempotente — se devuelve la aprobación existente, no se duplica.
      if (err instanceof Error && /UNIQUE constraint failed/i.test(err.message) && input.runId) {
        const digest = digestPayload(input.payload);
        const existing = listPendingApprovals(db).find(
          (a) => a.actionDigest === digest && a.runId === input.runId,
        );
        if (existing) return existing;
      }
      throw err;
    }
  }

  function decideApproval(
    approvalId: string,
    decision: "approved" | "rejected",
    personId: string,
    note?: string,
  ): DecideApprovalResult {
    const approval = getApproval(db, approvalId);
    if (!approval) throw errors.notFound("approval", approvalId);
    if (approval.status !== "pending") {
      throw new AgentosError(
        ErrorCodes.CONFLICT,
        `La aprobación ${approvalId} ya fue decidida (${approval.status}); no se decide dos veces`,
        { approvalId, status: approval.status },
      );
    }
    // El digest liga la aprobación al payload LITERAL: si no coinciden, alguien
    // cambió los argumentos y la aprobación es inválida (fail-closed).
    if (digestPayload(approval.payload) !== approval.actionDigest) {
      throw new AgentosError(
        ErrorCodes.APPROVAL_INVALIDATED,
        "El payload no coincide con el digest aprobado: la aprobación queda invalidada",
        { approvalId },
      );
    }

    const before = { status: approval.status };
    const updated = repoDecideApproval(db, approvalId, {
      status: decision,
      decidedByPersonId: personId,
      note,
    });
    appendAudit(db, {
      actor: `person:${personId}`,
      source: "ui",
      action: `approval.${decision}`,
      entityType: "approval",
      entityId: approvalId,
      before,
      after: { status: updated.status, kind: updated.kind },
      reason: note ?? null,
      runId: updated.runId ?? null,
    });
    sink.publish("approvals", {
      type: `approval.${decision}`,
      payload: { approvalId, kind: updated.kind, taskId: updated.taskId },
      runId: updated.runId ?? null,
    });

    return {
      approval: updated,
      executePayload:
        decision === "approved" && updated.kind === "tool_call"
          ? (updated.payload as Record<string, unknown>)
          : undefined,
    };
  }

  // ── Delegación ────────────────────────────────────────────────────────────

  function delegationDepth(taskId: string): number {
    let depth = 0;
    let current = getTask(db, taskId);
    while (current?.parentTaskId) {
      depth += 1;
      if (depth > 32) throw errors.validation("Ciclo de parent_task_id detectado");
      current = getTask(db, current.parentTaskId);
    }
    return depth;
  }

  function delegate(input: DelegateInput): Task {
    const parsed = DelegationPayload.safeParse(input.payload);
    if (!parsed.success) {
      throw errors.validation(
        "Payload de delegación inválido: se exige {tarea, limites, forma_de_buena_respuesta}",
        parsed.error.issues,
      );
    }
    const payload = parsed.data;
    const parent = mustGetTask(input.parentTaskId);

    // Depth máx 3: la hija quedaría a depth(parent)+1. Se rechaza, no se trunca.
    const childDepth = delegationDepth(parent.id) + 1;
    if (childDepth > maxDepth) {
      throw new AgentosError(
        ErrorCodes.DELEGATION_LIMIT,
        `Delegación rechazada: profundidad ${childDepth} supera el máximo ${maxDepth}. ` +
          "Cierra la cadena actual o pide ayuda humana (ask_human).",
        { parentTaskId: parent.id, depth: childDepth, maxDepth },
      );
    }

    // Fan-out máx 4 por run: se cuentan las delegaciones YA hechas desde esta
    // tarea por este run (task_events kind='delegated').
    const runId = input.runId ?? null;
    const fanOutRow = db.$client
      .prepare(
        `SELECT count(*) AS n FROM task_events
         WHERE task_id = ? AND kind = 'delegated'
           AND ((run_id IS NULL AND ? IS NULL) OR run_id = ?)`,
      )
      .get(parent.id, runId, runId) as { n: number };
    if (fanOutRow.n >= maxFanOut) {
      throw new AgentosError(
        ErrorCodes.DELEGATION_LIMIT,
        `Delegación rechazada: fan-out ${fanOutRow.n + 1} supera el máximo ${maxFanOut} por run. ` +
          "Consolida subtareas o espera a que terminen las delegadas.",
        { parentTaskId: parent.id, fanOut: fanOutRow.n + 1, maxFanOut },
      );
    }

    const assignee = resolveAgent(input.assignee);
    if (!assignee) throw errors.notFound("agent", input.assignee);

    // La hija hereda stage: si es CONSTRUIR sin G1 aprobado, fail-closed.
    assertGate1({ stage: parent.stage, projectId: parent.projectId });

    const limites = Array.isArray(payload.limites) ? payload.limites.join("; ") : payload.limites;
    const requiresApproval = computeRequiresApproval({ externalEffect: false, activityType: "delegation" });
    // Nace directamente en READY: la delegación garantiza por construcción el
    // invariante de READY (DoD = forma de buena respuesta + asignado).
    const child = repoCreateTask(db, {
      projectId: parent.projectId,
      parentTaskId: parent.id,
      title: payload.tarea.length > 140 ? `${payload.tarea.slice(0, 137)}...` : payload.tarea,
      description: `Delegada desde ${parent.id} por ${input.actor}.\n\nTarea: ${payload.tarea}\n\nLímites: ${limites}`,
      definitionOfDone: payload.forma_de_buena_respuesta,
      stage: parent.stage,
      status: "READY",
      activityType: "delegation",
      priority: parent.priority,
      assigneeAgentId: assignee.id,
      requiresApproval,
      externalEffect: false,
      orderKey: nextOrderKey(parent.projectId, "READY"),
    });

    appendTaskEvent(db, {
      taskId: child.id,
      runId,
      kind: "created",
      toStatus: "READY",
      actor: input.actor,
      payload: { delegated: true, parentTaskId: parent.id, limites },
    });
    appendTaskEvent(db, {
      taskId: parent.id,
      runId,
      kind: "delegated",
      actor: input.actor,
      payload: { childTaskId: child.id, assignee: assignee.slug },
    });
    publishBoard(
      parent.projectId,
      "task.delegated",
      { parentTaskId: parent.id, childTaskId: child.id, assignee: assignee.slug, actor: input.actor },
      runId,
    );
    return child;
  }

  // ── Kill switch (setter) ──────────────────────────────────────────────────

  function setKillSwitch(active: boolean, actor: string, reason?: string): void {
    const before = { active: isKillSwitchActive() };
    setConfig(db, ConfigKeys.KILL_SWITCH, active);
    appendAudit(db, {
      actor,
      source: actorKind(actor) === "human" ? "ui" : "system",
      action: active ? "kill_switch.on" : "kill_switch.off",
      entityType: "app_config",
      entityId: ConfigKeys.KILL_SWITCH,
      before,
      after: { active },
      reason: reason ?? null,
    });
    sink.publish("swarm", { type: active ? "kill_switch.on" : "kill_switch.off", payload: { actor } });
  }

  return {
    createTask,
    moveTask: (input) => moveTask(input),
    claim,
    renewLease,
    reap,
    approveGate,
    requestApproval,
    decideApproval,
    listPendingApprovals: () => listPendingApprovals(db),
    delegate,
    isKillSwitchActive,
    setKillSwitch,
    isAgentPaused,
    assertAgentCanRun,
  };
}
