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
  type ApprovalKind,
  type BlockedReason,
  type TaskPriority,
  type TaskStatus,
} from "@agentos/shared";
import {
  appendAudit,
  appendTaskEvent,
  claimApprovalReconciliation,
  claimTask as repoClaimTask,
  ConfigKeys,
  countArtifacts,
  countDelegations,
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
  listTasks,
  maxOrderKey,
  reapExpiredLeases,
  renewLease as repoRenewLease,
  setConfig,
  setGateState,
  transitionTaskStatus,
  updateTask,
  type AgentosDb,
  type Approval,
  type Project,
  type Task,
} from "@agentos/db";
import { noopEventSink, type EventSink } from "../events.js";
import { respawnCadenceInstance } from "../modules.js";
import { computeOrgChainHealth, type OrgChainHealth } from "../org.js";
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

/** Orden del ciclo Entender → Construir → Operar (gate de fase, M6a). */
const STAGE_ORDER: Record<Task["stage"], number> = { ENTENDER: 0, CONSTRUIR: 1, OPERAR: 2 };

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

/**
 * Dependencias inyectadas para reconciliar el efecto de una aprobación decidida
 * (Gate 2, fix Q2). Viven "por encima" de core —el gateway de tools en
 * @agentos/tools ejecuta el efecto; el despachador de apps/api encola la
 * reanudación— así que core las recibe como callbacks OPACOS y no se crea ciclo
 * de dependencias. La reconciliación en sí (comentar, desbloquear, orquestar) es
 * compartida: el route REST y el drenado del despachador la ejecutan igual.
 */
export interface ApprovalReconcileDeps {
  /** Ejecuta el efecto de un tool_call aprobado (gateway.executeApproved). El
   * resultado es opaco para core (un GatewayResult de @agentos/tools). */
  executeApproved(approval: Approval): Promise<unknown>;
  /** Encola el run de reanudación tras ejecutar el efecto; devuelve runId o null. */
  enqueueResume(approval: Approval, executed: unknown): Promise<string | null> | string | null;
}

export interface ReconcileResult {
  approval: Approval;
  /** GatewayResult del efecto ejecutado (solo tool_call aprobado), o null. */
  executed: unknown | null;
  /** Run de reanudación encolado (solo tool_call aprobado), o null. */
  resumeRunId: string | null;
  /** false si la aprobación seguía pendiente o ya la había reconciliado otro. */
  reconciled: boolean;
}

/** Estado de las dependencias de una tarjeta (§13.4) — para la API/UI y el guard. */
export interface DependencyState {
  taskId: string;
  dependsOn: string[];
  /** Deps que NO están en DONE. Una dep borrada/inexistente cuenta como insatisfecha (fail-closed). */
  unsatisfied: string[];
  satisfied: boolean;
}

export async function dependencyState(db: AgentosDb, taskId: string): Promise<DependencyState> {
  const task = await getTask(db, taskId);
  if (!task) throw errors.notFound("task", taskId);
  const dependsOn = task.dependsOn ?? [];
  const unsatisfied: string[] = [];
  for (const id of dependsOn) {
    if ((await getTask(db, id))?.status !== "DONE") unsatisfied.push(id);
  }
  return { taskId: task.id, dependsOn, unsatisfied, satisfied: unsatisfied.length === 0 };
}

export interface BoardEngine {
  createTask(input: CreateTaskInput, opts: { actor: string; runId?: string | null }): Promise<Task>;
  moveTask(input: MoveTaskInput): Promise<Task>;
  /**
   * CA-M2.3 (§13.4): promueve BACKLOG→READY (actor system, por la MISMA máquina,
   * con task_events y eventos de board) las tareas del proyecto con depends_on
   * no vacío y TODAS sus dependencias en DONE. Corre sola al llegar cualquier
   * tarea del proyecto a DONE vía moveTask; también es invocable directa.
   * Devuelve los ids promovidos. Fail-soft por tarea: la que no pueda entrar a
   * READY (DoD vacía, Gate 1 pendiente, carrera) se queda en BACKLOG.
   */
  promoteUnblockedTasks(projectId: string, ctx?: { runId?: string | null }): Promise<string[]>;
  claim(input: ClaimInput): Promise<{ claimed: boolean; task?: Task }>;
  renewLease(taskId: string, leaseMs?: number): Promise<boolean>;
  reap(): Promise<{ requeued: string[]; blocked: string[] }>;
  approveGate(projectId: string, gate: GateName, personId: string, note?: string): Promise<Project>;
  requestApproval(input: RequestApprovalInput): Promise<Approval>;
  decideApproval(
    approvalId: string,
    decision: "approved" | "rejected",
    personId: string,
    note?: string,
  ): Promise<DecideApprovalResult>;
  /**
   * Reconcilia el efecto de una aprobación YA decidida (Gate 2, fix Q2): ejecuta
   * el efecto del tool_call aprobado (vía deps) + encola la reanudación, o
   * desbloquea la tarjeta de pregunta/entregable. Es idempotente y exactamente-
   * una-vez (reclamo atómico de `reconciled_at`). La llaman AMBOS caminos: el
   * route REST tras decidir, y el despachador al drenar decisiones del MCP admin.
   */
  reconcileDecidedApproval(
    approvalId: string,
    deps: ApprovalReconcileDeps,
  ): Promise<ReconcileResult>;
  listPendingApprovals(): Promise<Approval[]>;
  delegate(input: DelegateInput): Promise<Task>;
  isKillSwitchActive(): Promise<boolean>;
  setKillSwitch(active: boolean, actor: string, reason?: string): Promise<void>;
  isAgentPaused(agentIdOrSlug: string): Promise<boolean>;
  /** Salud de la cadena de mando del agente (Fase 2). Solo mira a sus ancestros. */
  orgChainHealth(agentIdOrSlug: string): Promise<OrgChainHealth>;
  /**
   * ¿El agente puede tomar trabajo AHORA? true sii está `active` Y su cadena de
   * mando está sana. NO mira el kill switch (global, se comprueba por tick). Guarda
   * silenciosa del despachador: una cadena rota espera igual que un agente pausado.
   */
  isAgentAssignable(agentIdOrSlug: string): Promise<boolean>;
  /**
   * Lanza kill_switch_active / policy_denied / agent_not_assignable si el agente
   * no puede correr. La cadena rota (ancestro terminado, manager faltante, ciclo)
   * bloquea la asignación y la ejecución con reason clara (Fase 2).
   */
  assertAgentCanRun(agentIdOrSlug: string): Promise<void>;
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

  async function publishBoard(
    projectId: string,
    type: string,
    payload: Record<string, unknown>,
    runId?: string | null,
  ): Promise<void> {
    await sink.publish(`board:${projectId}`, { type, payload, runId: runId ?? null });
  }

  async function mustGetTask(taskId: string): Promise<Task> {
    const task = await getTask(db, taskId);
    if (!task) throw errors.notFound("task", taskId);
    return task;
  }

  async function mustGetProject(projectId: string): Promise<Project> {
    const project = await getProject(db, projectId);
    if (!project) throw errors.notFound("project", projectId);
    return project;
  }

  /**
   * Gate de fase (M6a generaliza el Gate 1 sin cambiar su caso clásico).
   *
   * Semántica de `projects.gate_state` (verificada y documentada al encadenar
   * fases — US-M3): es el estado del gate de cierre de la FASE ACTUAL del
   * proyecto. Nace 'pending' al disparar una fase; el humano lo aprueba al
   * cerrar esa fase; y el motor de launch lo devuelve a 'pending' cuando la
   * SIGUIENTE fase se dispara sobre el mismo proyecto (el gate vigente pasa a
   * ser el del cierre de la fase nueva).
   *
   * Regla: una tarea de una etapa POSTERIOR a la del proyecto no sale de
   * BACKLOG sin ese gate aprobado; las tareas de la etapa actual (o anteriores)
   * fluyen. Con el proyecto en ENTENDER esto es EXACTAMENTE el Gate 1 clásico:
   * CONSTRUIR bloqueado hasta aprobar g1_plan.
   */
  async function assertGate1(task: Pick<Task, "stage" | "projectId">): Promise<void> {
    const project = await mustGetProject(task.projectId);
    if (STAGE_ORDER[task.stage] <= STAGE_ORDER[project.stage]) return;
    if (project.gateState !== "approved") {
      throw new AgentosError(
        ErrorCodes.GATE_NOT_PASSED,
        `Gate de fase (${GATE_G1_PLAN}) no aprobado en el proyecto ${project.id}: ` +
          `las tareas de ${task.stage} no salen de BACKLOG con el proyecto en ` +
          `${project.stage} (gate_state=${project.gateState})`,
        { projectId: project.id, gate: GATE_G1_PLAN, gateState: project.gateState },
      );
    }
  }

  /**
   * Clave de orden al FINAL de la columna: estrictamente mayor que el máximo
   * actual, crecimiento acotado (~1 carácter por cada 13 inserciones).
   */
  async function nextOrderKey(projectId: string, status: TaskStatus): Promise<string> {
    const last = await maxOrderKey(db, projectId, status);
    if (!last) return "m";
    const tail = last.charCodeAt(last.length - 1);
    if (tail < "z".charCodeAt(0)) return last.slice(0, -1) + String.fromCharCode(tail + 1);
    return `${last}m`;
  }

  async function resolveAgent(idOrSlug: string) {
    return (await getAgent(db, idOrSlug)) ?? (await getAgentBySlug(db, idOrSlug));
  }

  // ── Kill switch y pausado ─────────────────────────────────────────────────

  async function isKillSwitchActive(): Promise<boolean> {
    const value = await getConfig(db, ConfigKeys.KILL_SWITCH);
    if (value === true || value === "on" || value === 1) return true;
    if (typeof value === "object" && value !== null && (value as { active?: unknown }).active === true) return true;
    return false;
  }

  async function isAgentPaused(agentIdOrSlug: string): Promise<boolean> {
    const agent = await resolveAgent(agentIdOrSlug);
    if (!agent) throw errors.notFound("agent", agentIdOrSlug);
    return agent.status !== "active";
  }

  async function orgChainHealth(agentIdOrSlug: string): Promise<OrgChainHealth> {
    const agent = await resolveAgent(agentIdOrSlug);
    if (!agent) throw errors.notFound("agent", agentIdOrSlug);
    return computeOrgChainHealth(db, agent.id);
  }

  async function isAgentAssignable(agentIdOrSlug: string): Promise<boolean> {
    const agent = await resolveAgent(agentIdOrSlug);
    if (!agent) throw errors.notFound("agent", agentIdOrSlug);
    if (agent.status !== "active") return false;
    return (await computeOrgChainHealth(db, agent.id)).status === "healthy";
  }

  async function assertAgentCanRun(agentIdOrSlug: string): Promise<void> {
    if (await isKillSwitchActive()) {
      throw new AgentosError(ErrorCodes.KILL_SWITCH_ACTIVE, "Kill switch activo: no arrancan trabajos nuevos");
    }
    const agent = await resolveAgent(agentIdOrSlug);
    if (!agent) throw errors.notFound("agent", agentIdOrSlug);
    if (agent.status !== "active") {
      throw new AgentosError(
        ErrorCodes.POLICY_DENIED,
        `Agente ${agent.slug} está "${agent.status}" — no puede tomar trabajo`,
        { agentId: agent.id, status: agent.status },
      );
    }
    // Fase 2: la salud de la cadena de mando gobierna la asignabilidad. Un agente
    // activo pero con ancestro terminado/faltante o en ciclo NO es asignable.
    const health = await computeOrgChainHealth(db, agent.id);
    if (health.status !== "healthy") {
      throw errors.notAssignable(agent.slug, health.status, {
        agentId: agent.id,
        offendingAgentId: health.offendingAgentId ?? null,
      });
    }
  }

  // ── Crear tarea ───────────────────────────────────────────────────────────

  async function createTask(input: CreateTaskInput, ctx: { actor: string; runId?: string | null }): Promise<Task> {
    if (!input.title.trim()) throw errors.validation("title es obligatorio");
    await mustGetProject(input.projectId);
    // Política determinista: el llamador puede SUBIR el control, nunca bajarlo.
    const requiresApproval =
      computeRequiresApproval({ externalEffect: input.externalEffect, activityType: input.activityType }) ||
      input.requiresApproval === true;

    const task = await repoCreateTask(db, {
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
      orderKey: await nextOrderKey(input.projectId, "BACKLOG"),
    });
    await appendTaskEvent(db, {
      taskId: task.id,
      runId: ctx.runId ?? null,
      kind: "created",
      toStatus: task.status,
      actor: ctx.actor,
      payload: { requiresApproval },
    });
    await publishBoard(
      task.projectId,
      "task.created",
      { taskId: task.id, status: task.status, actor: ctx.actor },
      ctx.runId,
    );
    return task;
  }

  // ── Transición ────────────────────────────────────────────────────────────

  async function moveTask(input: MoveTaskInput, internal?: { viaClaim?: boolean }): Promise<Task> {
    const task = await mustGetTask(input.taskId);
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
    if (from === "BACKLOG" && to !== "CANCELLED") await assertGate1(task);

    // 4. BACKLOG→READY: solo orquestador-o-humano-o-sistema, y exige DoD + asignado.
    let dependencyOverride: string[] | null = null;
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
      // 4b. Guard de dependencias (§13.4, fail-closed): con depends_on sin
      // cerrar, system y agent RECHAZAN; el humano puede forzar (override) y
      // queda auditado como tal (audit_log, mismo helper que el resto).
      const deps = await dependencyState(db, task.id);
      if (!deps.satisfied) {
        if (kind !== "human") {
          throw new AgentosError(
            ErrorCodes.DEPENDENCY_NOT_SATISFIED,
            `BACKLOG→READY rechazada: la tarea ${task.id} tiene dependencias sin cerrar ` +
              `(${deps.unsatisfied.join(", ")}); solo un humano puede forzarla`,
            { taskId: task.id, unsatisfied: deps.unsatisfied, actorKind: kind },
          );
        }
        dependencyOverride = deps.unsatisfied;
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
    if ((to === "REVIEW" || to === "DONE") && (await countArtifacts(db, task.id)) < 1) {
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
    const blockedReason = to === "BLOCKED" ? (input.blockedReason ?? "manual") : null;
    const resetAttempts = from === "BLOCKED" && to === "READY";
    const ok = await transitionTaskStatus(db, {
      taskId: task.id,
      from,
      to,
      blockedReason,
      resetAttempts,
      expectedVersion: input.expectedVersion,
    });
    if (!ok) {
      if (!(await getTask(db, task.id))) throw errors.notFound("task", task.id);
      throw errors.versionConflict("task", task.id, input.expectedVersion);
    }

    await appendTaskEvent(db, {
      taskId: task.id,
      runId: input.runId ?? null,
      kind: "moved",
      fromStatus: from,
      toStatus: to,
      actor: input.actor,
      payload: {
        ...(input.note ? { note: input.note } : {}),
        ...(blockedReason ? { blockedReason } : {}),
        ...(dependencyOverride ? { dependencyOverride: true, unsatisfiedDependsOn: dependencyOverride } : {}),
      },
    });
    // Override humano del guard de dependencias: queda auditado como tal (§13.4).
    if (dependencyOverride) {
      await appendAudit(db, {
        actor: input.actor,
        source: "ui",
        action: "task.dependency_override",
        entityType: "task",
        entityId: task.id,
        before: { status: from },
        after: { status: to, unsatisfiedDependsOn: dependencyOverride },
        reason: input.note ?? null,
        runId: input.runId ?? null,
      });
    }
    await publishBoard(task.projectId, "task.moved", { taskId: task.id, from, to, actor: input.actor }, input.runId);
    // H10: la bandeja "Esperando por ti" incluye entregables en REVIEW; avisar
    // por el topic approvals para que la UI refresque el badge en vivo.
    if (to === "REVIEW" || from === "REVIEW") {
      await sink.publish("approvals", {
        type: "review.changed",
        payload: { taskId: task.id, from, to },
        runId: input.runId ?? null,
      });
    }
    // Hook de promoción (CA-M2.3, §13.4): esta transición es el ÚNICO camino de
    // dominio a DONE (REST approve, MCP approve y reconcileDecidedApproval pasan
    // por aquí) — al cerrar, promover dependientes en el mismo flujo secuencial
    // inmediato (el motor no abre transacciones; SQL crudo suelto como siempre).
    if (to === "DONE") {
      await promoteUnblockedTasks(task.projectId, { runId: input.runId ?? null });
      // Hook de cadencia (CA-M3.4 — M6a): si la tarea cerrada es una instancia
      // de plantilla `cadence` CONFIRMADA en el recibo de su launch, nace la
      // SIGUIENTE instancia. Mismo patrón fail-soft que la promoción: un fallo
      // de la cadencia jamás tumba el DONE que la disparó.
      try {
        const respawned = await respawnCadenceInstance(db, task.id, { runId: input.runId ?? null });
        if (respawned) {
          await publishBoard(
            task.projectId,
            "task.created",
            { taskId: respawned.id, status: respawned.status, actor: "system:cadence", cadence: true },
            input.runId,
          );
        }
      } catch {
        /* fail-soft: la instancia siguiente la crea un humano o el próximo cierre */
      }
    }
    return (await getTask(db, task.id))!;
  }

  /** Ver doc en la interfaz BoardEngine (CA-M2.3). */
  async function promoteUnblockedTasks(projectId: string, ctx?: { runId?: string | null }): Promise<string[]> {
    // Ya viene ordenado por (status, order_key).
    const rows = await listTasks(db, { projectId, status: "BACKLOG" });
    const promoted: string[] = [];
    for (const row of rows) {
      const task = await getTask(db, row.id);
      if (!task || task.status !== "BACKLOG") continue;
      const deps = task.dependsOn ?? [];
      // Sin depends_on no hay auto-promoción: BACKLOG "a secas" es decisión
      // humana (despriorizada o recién creada) y el sistema no la pisa.
      if (deps.length === 0) continue;
      let allDone = true;
      for (const id of deps) {
        if ((await getTask(db, id))?.status !== "DONE") {
          allDone = false;
          break;
        }
      }
      if (!allDone) continue;
      try {
        await moveTask({
          taskId: task.id,
          to: "READY",
          expectedVersion: task.version,
          actor: "system:dependencies",
          runId: ctx?.runId ?? null,
          note: "todas las dependencias en DONE: la tarea entra a la cola (CA-M2.3)",
        });
        promoted.push(task.id);
      } catch {
        // Fail-soft por tarea: DoD vacía, sin asignado, Gate 1 pendiente o
        // carrera de versión no tumban el DONE que disparó la promoción; la
        // tarjeta se queda en BACKLOG y la retoma un humano o el siguiente DONE.
      }
    }
    return promoted;
  }

  // ── Claim / lease / reaper ────────────────────────────────────────────────

  async function claim(input: ClaimInput): Promise<{ claimed: boolean; task?: Task }> {
    const agent = await resolveAgent(input.agentId);
    if (!agent) throw errors.notFound("agent", input.agentId);
    await assertAgentCanRun(agent.id);

    const task = await mustGetTask(input.taskId);
    // Una tarea asignada a otro agente no se roba: carrera perdida, no error.
    if (task.assigneeAgentId && task.assigneeAgentId !== agent.id) {
      return { claimed: false };
    }

    // UPDATE condicional ya validado en packages/db (changes=0 = carrera perdida).
    const result = await repoClaimTask(db, {
      taskId: input.taskId,
      agentId: agent.slug,
      leaseMs: input.leaseMs ?? defaultLeaseMs,
      runId: input.runId ?? undefined,
    });
    if (!result.claimed || !result.task) return { claimed: false };

    let claimed = result.task;
    if (!claimed.assigneeAgentId) {
      claimed = await updateTask(db, claimed.id, { assigneeAgentId: agent.id }, claimed.version);
    }
    await publishBoard(
      claimed.projectId,
      "task.claimed",
      { taskId: claimed.id, agent: agent.slug, leaseUntil: claimed.leaseUntil },
      input.runId,
    );
    return { claimed: true, task: claimed };
  }

  async function renewLease(taskId: string, leaseMs?: number): Promise<boolean> {
    return repoRenewLease(db, taskId, leaseMs ?? defaultLeaseMs);
  }

  async function reap(): Promise<{ requeued: string[]; blocked: string[] }> {
    const result = await reapExpiredLeases(db, maxAttempts);
    for (const id of [...result.requeued, ...result.blocked]) {
      const task = await getTask(db, id);
      if (task) {
        await publishBoard(task.projectId, "task.reaped", {
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

  async function approveGate(projectId: string, gate: GateName, personId: string, note?: string): Promise<Project> {
    if (gate !== GATE_G1_PLAN) {
      throw errors.validation(`Gate desconocido: "${gate}" (el MVP solo tiene ${GATE_G1_PLAN})`);
    }
    const project = await mustGetProject(projectId);
    const before = { gateState: project.gateState };
    const updated = await setGateState(db, projectId, "approved", project.version);
    await appendAudit(db, {
      actor: `person:${personId}`,
      source: "ui",
      action: "gate.approve",
      entityType: "project",
      entityId: projectId,
      before,
      after: { gateState: updated.gateState, gate },
      reason: note ?? null,
    });
    await publishBoard(projectId, "gate.approved", { gate, by: personId });
    return updated;
  }

  // ── Gate 2: approvals (payload literal + digest) ──────────────────────────

  async function requestApproval(input: RequestApprovalInput): Promise<Approval> {
    try {
      const approval = await createApproval(db, {
        kind: input.kind,
        payload: input.payload,
        runId: input.runId ?? null,
        taskId: input.taskId ?? null,
        projectId: input.projectId ?? null,
        requestedBy: input.requestedBy ?? null,
      });
      await sink.publish("approvals", {
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
        const pending = await listPendingApprovals(db);
        const existing = pending.find((a) => a.actionDigest === digest && a.runId === input.runId);
        if (existing) return existing;
      }
      throw err;
    }
  }

  async function decideApproval(
    approvalId: string,
    decision: "approved" | "rejected",
    personId: string,
    note?: string,
  ): Promise<DecideApprovalResult> {
    const approval = await getApproval(db, approvalId);
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
    const updated = await repoDecideApproval(db, approvalId, {
      status: decision,
      decidedByPersonId: personId,
      note,
    });
    await appendAudit(db, {
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
    await sink.publish("approvals", {
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

  /**
   * Reconciliación post-decisión compartida (fix Q2). `decideApproval` SOLO fija
   * el estado; esta función ejecuta el efecto real de la decisión. Antes vivía
   * inline en el route REST y el MCP admin (otro proceso, sin runtime) dejaba la
   * tarjeta BLOCKED para siempre. Ahora ambos convergen aquí: REST la llama tras
   * decidir; el despachador la drena para las decisiones tomadas por el MCP.
   */
  async function reconcileDecidedApproval(
    approvalId: string,
    deps: ApprovalReconcileDeps,
  ): Promise<ReconcileResult> {
    const approval = await getApproval(db, approvalId);
    if (!approval) throw errors.notFound("approval", approvalId);
    // Aún pendiente (no decidida): nada que reconciliar.
    if (approval.status === "pending") {
      return { approval, executed: null, resumeRunId: null, reconciled: false };
    }
    // Reclamo atómico exactamente-una-vez: si ya la reconcilió otro (REST o un
    // tick del despachador), no repetir el efecto externo.
    if (!(await claimApprovalReconciliation(db, approvalId))) {
      return {
        approval: (await getApproval(db, approvalId)) ?? approval,
        executed: null,
        resumeRunId: null,
        reconciled: false,
      };
    }

    const approved = approval.status === "approved";
    const isToolCall = approval.kind === "tool_call";
    const decisionLabel = approved ? "APROBADA" : "RECHAZADA";
    const decidedActor = approval.decidedByPersonId
      ? `person:${approval.decidedByPersonId}`
      : "system:approvals";
    const task = approval.taskId ? await getTask(db, approval.taskId) : undefined;

    // Comentario en el timeline: un tool_call APROBADO no comenta aquí — su
    // resultado se lo cuenta al agente el run de reanudación.
    if (task && !(approved && isToolCall)) {
      await appendTaskEvent(db, {
        taskId: task.id,
        runId: approval.runId ?? null,
        kind: "comment",
        actor: decidedActor,
        payload: {
          body: `Aprobación ${approvalId} ${decisionLabel}${approval.note ? `: ${approval.note}` : ""}`,
        },
      });
    }

    let executed: unknown | null = null;
    let resumeRunId: string | null = null;

    if (approved && isToolCall) {
      // La PLATAFORMA ejecuta el efecto (digest verificado en el gateway) y encola
      // el run de reanudación con resume_of_run_id (que desbloquea y reclama).
      executed = await deps.executeApproved(approval);
      resumeRunId = await deps.enqueueResume(approval, executed);
    } else if (task && !isToolCall && task.status === "BLOCKED" && task.blockedReason === "approval") {
      // Pregunta/entregable decidido: la tarjeta vuelve a la cola con la respuesta
      // visible en su timeline (mismo comportamiento que tenía el route REST).
      try {
        await moveTask({
          taskId: task.id,
          to: "READY",
          expectedVersion: task.version,
          actor: "system:approvals",
          note: `aprobación ${approvalId} resuelta (${decisionLabel.toLowerCase()}): la tarjeta vuelve a la cola`,
        });
      } catch {
        /* otro actor la movió: su movimiento manda */
      }
    }

    return {
      approval: (await getApproval(db, approvalId)) ?? approval,
      executed,
      resumeRunId,
      reconciled: true,
    };
  }

  // ── Delegación ────────────────────────────────────────────────────────────

  async function delegationDepth(taskId: string): Promise<number> {
    let depth = 0;
    let current = await getTask(db, taskId);
    while (current?.parentTaskId) {
      depth += 1;
      if (depth > 32) throw errors.validation("Ciclo de parent_task_id detectado");
      current = await getTask(db, current.parentTaskId);
    }
    return depth;
  }

  async function delegate(input: DelegateInput): Promise<Task> {
    const parsed = DelegationPayload.safeParse(input.payload);
    if (!parsed.success) {
      throw errors.validation(
        "Payload de delegación inválido: se exige {tarea, limites, forma_de_buena_respuesta}",
        parsed.error.issues,
      );
    }
    const payload = parsed.data;
    const parent = await mustGetTask(input.parentTaskId);

    // Depth máx 3: la hija quedaría a depth(parent)+1. Se rechaza, no se trunca.
    const childDepth = (await delegationDepth(parent.id)) + 1;
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
    const fanOut = await countDelegations(db, parent.id, runId);
    if (fanOut >= maxFanOut) {
      throw new AgentosError(
        ErrorCodes.DELEGATION_LIMIT,
        `Delegación rechazada: fan-out ${fanOut + 1} supera el máximo ${maxFanOut} por run. ` +
          "Consolida subtareas o espera a que terminen las delegadas.",
        { parentTaskId: parent.id, fanOut: fanOut + 1, maxFanOut },
      );
    }

    const assignee = await resolveAgent(input.assignee);
    if (!assignee) throw errors.notFound("agent", input.assignee);

    // La hija hereda stage: si es CONSTRUIR sin G1 aprobado, fail-closed.
    await assertGate1({ stage: parent.stage, projectId: parent.projectId });

    const limites = Array.isArray(payload.limites) ? payload.limites.join("; ") : payload.limites;
    const requiresApproval = computeRequiresApproval({ externalEffect: false, activityType: "delegation" });
    // Nace directamente en READY: la delegación garantiza por construcción el
    // invariante de READY (DoD = forma de buena respuesta + asignado).
    const child = await repoCreateTask(db, {
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
      orderKey: await nextOrderKey(parent.projectId, "READY"),
    });

    await appendTaskEvent(db, {
      taskId: child.id,
      runId,
      kind: "created",
      toStatus: "READY",
      actor: input.actor,
      payload: { delegated: true, parentTaskId: parent.id, limites },
    });
    await appendTaskEvent(db, {
      taskId: parent.id,
      runId,
      kind: "delegated",
      actor: input.actor,
      payload: { childTaskId: child.id, assignee: assignee.slug },
    });
    await publishBoard(
      parent.projectId,
      "task.delegated",
      { parentTaskId: parent.id, childTaskId: child.id, assignee: assignee.slug, actor: input.actor },
      runId,
    );
    return child;
  }

  // ── Kill switch (setter) ──────────────────────────────────────────────────

  async function setKillSwitch(active: boolean, actor: string, reason?: string): Promise<void> {
    const before = { active: await isKillSwitchActive() };
    await setConfig(db, ConfigKeys.KILL_SWITCH, active);
    await appendAudit(db, {
      actor,
      source: actorKind(actor) === "human" ? "ui" : "system",
      action: active ? "kill_switch.on" : "kill_switch.off",
      entityType: "app_config",
      entityId: ConfigKeys.KILL_SWITCH,
      before,
      after: { active },
      reason: reason ?? null,
    });
    await sink.publish("swarm", { type: active ? "kill_switch.on" : "kill_switch.off", payload: { actor } });
  }

  return {
    createTask,
    moveTask: (input) => moveTask(input),
    promoteUnblockedTasks,
    claim,
    renewLease,
    reap,
    approveGate,
    requestApproval,
    decideApproval,
    reconcileDecidedApproval,
    listPendingApprovals: () => listPendingApprovals(db),
    delegate,
    isKillSwitchActive,
    setKillSwitch,
    isAgentPaused,
    orgChainHealth,
    isAgentAssignable,
    assertAgentCanRun,
  };
}
