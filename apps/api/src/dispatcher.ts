/**
 * Despachador determinista (B4, dentro de apps/api — ARCHITECTURE §1):
 *
 * (a) toma tareas READY con agente asignado por prioridad+antigüedad, hace
 *     claim atómico vía core y lanza el run por RunnerPool con el runner del
 *     agente, prompt de 3 capas (core/prompt) y DomainTools del catálogo;
 * (b) al terminar el run: si la tool movió la tarea, se respeta; si el run
 *     murió sin moverla, suelta el lease (READY, o BLOCKED 'stuck' al agotar
 *     intentos);
 * (c) reanudación por aprobación (Gate 2): run con resume_of_run_id;
 * (d) auto-crítica de Quinn cuando una tarea con activity_type técnico entra a
 *     REVIEW (lista configurable en app_config; Quinn real llega en B7);
 * (e) respeta kill switch y agents.status='paused'.
 */
import {
  AgentosError,
  ErrorCodes,
  newId,
  nowMs,
  parseProjectBudget,
  projectBudgetKey,
  type ProjectBudget,
} from "@agentos/shared";
import {
  ConfigKeys,
  createRun,
  getAgent,
  getAgentBySlug,
  getConfig,
  getDefaultProviderProfile,
  getProject,
  getProviderProfile,
  getRun,
  getTask,
  getThread,
  listDispatchableTasks,
  listMessages,
  listPendingApprovals,
  listReconcilableApprovals,
  appendMessage,
  setConfig,
  sumRunCostForProject,
  updateRun,
  type Agent,
  type AgentosDb,
  type Approval,
  type PersistedEvent,
  type ProviderProfile,
  type Run,
  type Task,
  type Thread,
} from "@agentos/db";
import { channelTopic, runTopic, threadTopic, type EventBus } from "@agentos/events";
import {
  assemblePrompt,
  QUINN_REVIEWED_ACTIVITY_TYPES,
  type ApprovalReconcileDeps,
  type BoardEngine,
  type ReconcileResult,
} from "@agentos/core";
import type { GatewayResult, ToolCallContext, ToolRuntime } from "@agentos/tools";
import type { RunBudget, RunInput, RunnerPool, RunTraceContext } from "@agentos/runners";
import type { ModelMessage } from "ai";
import { domainPayload, publishRaw } from "./bus-bridge.js";
import { bindDomainTools, claudeCodeAllowlist } from "./domain-tools.js";

export const QUINN_ACTIVITY_TYPES_KEY = "quinn_review_activity_types";
/**
 * Tipos que disparan la auto-crítica de Quinn al entrar a REVIEW. Es la MISMA
 * fuente única (`QUINN_REVIEWED_ACTIVITY_TYPES` de @agentos/core) que usa la
 * política `computeRequiresApproval` (fix Q1): así todo entregable que Quinn
 * revisa exige también REVIEW + aprobación humana y no puede ir directo a DONE.
 * Antes esta lista y la de la política vivían separadas y se desincronizaban.
 */
export const DEFAULT_QUINN_ACTIVITY_TYPES: string[] = [...QUINN_REVIEWED_ACTIVITY_TYPES];

/**
 * Log del despachador. Existe para que NINGÚN rechazo quede suelto: un
 * listener del bus o una promesa flotante que lance mataba el proceso entero
 * por `unhandledRejection`. Todo lo que aquí se registra es no fatal — el
 * siguiente tick reintenta.
 */
const log = {
  error(scope: string, err: unknown): void {
    console.error(`[dispatcher] ${scope}:`, err);
  },
};

export interface DispatcherOptions {
  db: AgentosDb;
  bus: EventBus;
  engine: BoardEngine;
  toolRuntime: ToolRuntime;
  pool: RunnerPool;
  /** Orquestador y cara del chat (US-1). */
  chatAgentSlug?: string;
  /** Crítico de REVIEW (US-10, stub configurado por app_config). */
  critiqueAgentSlug?: string;
  dispatchIntervalMs?: number;
  reaperIntervalMs?: number;
  leaseMs?: number;
  maxAttempts?: number;
  maxDispatchPerTick?: number;
  now?: () => number;
}

export interface TickReport {
  skipped?: "kill_switch" | "reentrant";
  dispatched: string[];
  /** Errores no fatales del ciclo (se reintenta en el siguiente tick). */
  errors: string[];
}

export interface Dispatcher {
  start(): void;
  stop(): void;
  /** Un ciclo del despachador (expuesto para tests deterministas). */
  tick(): Promise<TickReport>;
  reap(): Promise<{ requeued: string[]; blocked: string[] }>;
  enqueueChatRun(params: { threadId: string; text: string }): Promise<{ runId: string }>;
  enqueueApprovalResume(
    approval: Approval,
    executed: GatewayResult,
  ): Promise<{ runId: string } | null>;
  /**
   * Reconcilia una aprobación YA decidida (Gate 2, fix Q2): ejecuta el efecto del
   * tool_call + encola la reanudación, o desbloquea la tarjeta de pregunta/
   * entregable. La llama el route REST tras decidir; el tick del despachador la
   * usa para drenar las decisiones tomadas por el MCP admin.
   */
  reconcileApproval(approvalId: string): Promise<ReconcileResult>;
  /** runId → taskId de los runs de tarea en vuelo (para latido de lease). */
  inflight(): ReadonlyMap<string, string>;
}

/**
 * §13.4: combina `agents.limits` con el presupuesto de proyecto que el launch
 * dejó en `app_config['budget:project:<id>']`. El tope efectivo por run es
 * `min(max_usd del agente, per_run_usd del proyecto)` — el más estricto manda;
 * si solo existe uno, aplica ese. Exportada para tests.
 */
export function budgetFromLimits(
  limits: Record<string, unknown> | null | undefined,
  projectBudget?: ProjectBudget | null,
): RunBudget | undefined {
  const num = (...keys: string[]): number | undefined => {
    for (const k of keys) {
      const v = limits?.[k];
      if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
    }
    return undefined;
  };
  const budget: RunBudget = {};
  const maxSteps = num("max_steps", "maxSteps");
  const maxTokens = num("max_tokens", "maxTokens");
  const agentMaxUsd = num("max_usd", "maxUsd");
  const perRunUsd = projectBudget?.perRunUsd;
  const maxUsd =
    agentMaxUsd !== undefined && perRunUsd !== undefined
      ? Math.min(agentMaxUsd, perRunUsd)
      : (agentMaxUsd ?? perRunUsd);
  const maxMs = num("max_ms", "maxMs");
  if (maxSteps !== undefined) budget.maxSteps = maxSteps;
  if (maxTokens !== undefined) budget.maxTokens = maxTokens;
  if (maxUsd !== undefined) budget.maxUsd = maxUsd;
  if (maxMs !== undefined) budget.maxMs = maxMs;
  return Object.keys(budget).length > 0 ? budget : undefined;
}

export async function createDispatcher(opts: DispatcherOptions): Promise<Dispatcher> {
  const {
    db,
    bus,
    engine,
    toolRuntime,
    pool,
  } = opts;
  const chatAgentSlug = opts.chatAgentSlug ?? "alex";
  const critiqueAgentSlug = opts.critiqueAgentSlug ?? "quinn";
  const dispatchIntervalMs = opts.dispatchIntervalMs ?? 1_000;
  const reaperIntervalMs = opts.reaperIntervalMs ?? 30_000;
  const leaseMs = opts.leaseMs ?? 60_000;
  const maxAttempts = opts.maxAttempts ?? 3;
  const maxDispatchPerTick = opts.maxDispatchPerTick ?? 5;
  const now = opts.now ?? nowMs;

  const inflight = new Map<string, string>(); // runId → taskId
  const critiqued = new Set<string>(); // `${taskId}:${version}` ya criticados
  let ticking = false;
  let disposed = false;
  let tickTimer: ReturnType<typeof setInterval> | undefined;
  let reaperTimer: ReturnType<typeof setInterval> | undefined;

  // Config por defecto de la auto-crítica (editable en caliente por app_config).
  if ((await getConfig(db, QUINN_ACTIVITY_TYPES_KEY)) === undefined) {
    await setConfig(db, QUINN_ACTIVITY_TYPES_KEY, DEFAULT_QUINN_ACTIVITY_TYPES);
  }

  async function resolveProvider(agent: Agent): Promise<ProviderProfile> {
    const profile =
      (agent.providerProfileId ? await getProviderProfile(db, agent.providerProfileId) : undefined) ??
      (await getDefaultProviderProfile(db));
    if (!profile) {
      throw new AgentosError(
        ErrorCodes.PROVIDER_NOT_CONFIGURED,
        `El agente ${agent.slug} no tiene perfil de proveedor y no hay perfil por defecto`,
        { agentId: agent.id },
      );
    }
    return profile;
  }

  interface BuildParams {
    agent: Agent;
    provider: ProviderProfile;
    taskId?: string | null;
    projectId?: string | null;
    /** Hilo que disparó el run (chat): sus ids REALES van al prompt volatile (H1). */
    thread?: Thread | null;
    userText: string;
    history?: ModelMessage[];
  }

  async function buildRunInput(params: BuildParams): Promise<RunInput> {
    const { agent, provider } = params;
    const assembled = await assemblePrompt(db, {
      agent,
      project: params.projectId ?? null,
      task: params.taskId ?? null,
      thread: params.thread ?? null,
    });
    const toolCtx: ToolCallContext = {
      run_id: null, // se fija por run en bindRunInput
      agent_id: agent.id,
      task_id: params.taskId ?? null,
      project_id: params.projectId ?? null,
      actor: `agent:${agent.slug}`,
    };
    void toolCtx;
    const messages: ModelMessage[] = [
      ...(params.history ?? []),
      { role: "user", content: params.userText },
    ];
    const project = params.projectId ? await getProject(db, params.projectId) : undefined;
    // Único call site (§13.4): límites del agente + presupuesto del proyecto.
    const projectBudget = params.projectId
      ? parseProjectBudget(await getConfig(db, projectBudgetKey(params.projectId)))
      : null;
    const budget = budgetFromLimits(agent.limits, projectBudget);
    return {
      agent: {
        slug: agent.slug,
        name: agent.name,
        model: agent.model,
        toolsAllowlist:
          agent.runtime === "claude_code"
            ? claudeCodeAllowlist(agent.toolsAllowlist)
            : (agent.toolsAllowlist ?? []),
        ...(agent.autonomy ? { autonomy: agent.autonomy } : {}),
      },
      systemPrompt: assembled.full,
      messages,
      prompt: params.userText,
      provider,
      ...(budget ? { budget } : {}),
      ...(project?.workspacePath ? { workspacePath: project.workspacePath } : {}),
    };
  }

  /** Liga tools de dominio y contexto de trazabilidad a un runId concreto. */
  function bindRunInput(input: RunInput, agent: Agent, ctx: RunTraceContext): RunInput {
    const toolCtx: ToolCallContext = {
      run_id: ctx.runId,
      agent_id: agent.id,
      task_id: ctx.taskId ?? null,
      project_id: ctx.projectId ?? null,
      actor: `agent:${agent.slug}`,
    };
    const bound = bindDomainTools(toolRuntime, toolCtx, agent.toolsAllowlist);
    return {
      ...input,
      tools: bound.toolSet,
      domainTools: bound,
    };
  }

  // ── (b) reconciliación post-run ───────────────────────────────────────────

  function otherRunHoldsTask(taskId: string, exceptRunId: string): boolean {
    for (const [runId, tid] of inflight) {
      if (tid === taskId && runId !== exceptRunId) return true;
    }
    return false;
  }

  async function afterTaskRun(run: Run, taskId: string): Promise<void> {
    inflight.delete(run.id);
    const task = await getTask(db, taskId);
    if (!task) return;
    // Si la tool movió la tarea (REVIEW, BLOCKED, DONE, ...), se respeta.
    if (task.status !== "IN_PROGRESS") return;
    // Otro run (p. ej. reanudación) la tiene reclamada: no tocar.
    if (otherRunHoldsTask(taskId, run.id)) return;
    // H9: el agente dejó una aprobación/pregunta pendiente sin mover la tarjeta
    // → la plataforma la fuerza a BLOCKED(approval). Devolverla a READY haría
    // que el despachador la re-despache y el agente repita la pregunta (run y
    // aprobación duplicados). Convención: pregunta pendiente ⇒ BLOCKED.
    const pendingApproval = (await listPendingApprovals(db)).find((a) => a.taskId === taskId);
    // El run terminó sin moverla → soltar lease; intentos agotados → stuck.
    const stuck = !pendingApproval && task.attempts >= maxAttempts;
    try {
      await engine.moveTask({
        taskId,
        to: pendingApproval || stuck ? "BLOCKED" : "READY",
        expectedVersion: task.version,
        actor: "system:dispatcher",
        runId: run.id,
        note: pendingApproval
          ? `aprobación ${pendingApproval.id} pendiente: la tarjeta espera la respuesta humana`
          : `run ${run.status}${run.error ? `: ${run.error}` : ""} sin mover la tarea`,
        ...(pendingApproval
          ? { blockedReason: "approval" as const }
          : stuck
            ? { blockedReason: "stuck" as const }
            : {}),
      });
    } catch {
      // Carrera con otro actor que ya la movió: su movimiento manda.
    }
  }

  async function releaseClaim(taskId: string, runId: string, note: string): Promise<void> {
    const task = await getTask(db, taskId);
    if (!task || task.status !== "IN_PROGRESS") return;
    try {
      await engine.moveTask({
        taskId,
        to: "READY",
        expectedVersion: task.version,
        actor: "system:dispatcher",
        runId,
        note,
      });
    } catch {
      /* ya la movió otro actor */
    }
  }

  // ── (a) despacho de una tarea READY ───────────────────────────────────────

  async function dispatchTask(task: Task): Promise<string | null> {
    if (!task.assigneeAgentId) return null;
    const agent = await getAgent(db, task.assigneeAgentId);
    // (e) agente pausado/desactivado o con cadena de mando rota (ancestro
    // terminado/faltante, ciclo): su cola espera, no se roba ni se ejecuta.
    if (!agent || !(await engine.isAgentAssignable(agent.id))) return null;

    const provider = await resolveProvider(agent);
    const runId = newId();
    // La fila `runs` nace ANTES del claim: task_events.run_id tiene FK a runs
    // y el claim queda ligado al run exacto que movió la tarjeta (§10).
    await createRun(db, {
      id: runId,
      rootRunId: runId,
      agentId: agent.id,
      taskId: task.id,
      projectId: task.projectId,
      trigger: "dispatcher",
      runtime: agent.runtime,
      providerProfileId: provider.id,
      model: agent.model ?? null,
      status: "queued",
    });

    const claim = await engine.claim({ taskId: task.id, agentId: agent.id, runId, leaseMs });
    if (!claim.claimed) {
      // Carrera perdida: otro tick/proceso ganó; el run nunca corrió.
      await updateRun(db, runId, { status: "cancelled", error: "claim_lost", finishedAt: now() });
      return null;
    }

    try {
      const userText =
        `Tienes reclamada la tarea ${task.id} ("${task.title}").\n` +
        `Trabájala con tus tools de plataforma (mueve estados con tasks.move, adjunta evidencia ` +
        `con tasks.attach_artifact o artifacts.write). Recuerda: nada llega a REVIEW/DONE sin artefacto, ` +
        `y si tu tarea exige aprobación humana su cierre pasa por REVIEW.`;
      const base = await buildRunInput({
        agent,
        provider,
        taskId: task.id,
        projectId: task.projectId,
        userText,
      });
      const ctx: RunTraceContext = {
        runId,
        rootRunId: runId,
        parentRunId: null,
        taskId: task.id,
        projectId: task.projectId,
        agentId: agent.id,
        actor: `agent:${agent.slug}`,
        trigger: "dispatcher",
      };
      const input = bindRunInput(base, agent, ctx);
      const handle = await pool.submit({ runtime: agent.runtime, input, ctx });
      inflight.set(runId, task.id);
      void handle.done
        .then((run) => afterTaskRun(run, task.id))
        .catch((err: unknown) => log.error(`afterTaskRun(${task.id})`, err));
      return runId;
    } catch (err) {
      // No se pudo lanzar el run (kill switch, presupuesto, runner ausente):
      // el claim no puede quedarse con la tarea secuestrada.
      const message = err instanceof Error ? err.message : String(err);
      await releaseClaim(task.id, runId, `despacho fallido: ${message}`);
      const run = await getRun(db, runId);
      if (run && (run.status === "queued" || run.status === "running")) {
        await updateRun(db, runId, { status: "cancelled", error: message, finishedAt: now() });
      }
      return null;
    }
  }

  async function renewLeases(): Promise<void> {
    for (const [, taskId] of inflight) {
      await engine.renewLease(taskId, leaseMs);
    }
  }

  /**
   * Corte de presupuesto de fase (§13.4): con `budget:project:<id>.phase_usd`
   * declarado y el gasto acumulado (suma de runs.cost_usd del proyecto) ≥ tope,
   * el proyecto NO recibe despachos nuevos. Cache por tick: un cálculo por
   * proyecto aunque haya varias candidatas.
   */
  async function isPhaseBudgetExhausted(
    projectId: string,
    cache: Map<string, boolean>,
  ): Promise<boolean> {
    const cached = cache.get(projectId);
    if (cached !== undefined) return cached;
    const budget = parseProjectBudget(await getConfig(db, projectBudgetKey(projectId)));
    const exhausted =
      budget?.phaseUsd !== undefined && (await sumRunCostForProject(db, projectId)) >= budget.phaseUsd;
    cache.set(projectId, exhausted);
    return exhausted;
  }

  async function tick(): Promise<TickReport> {
    if (ticking) return { skipped: "reentrant", dispatched: [], errors: [] };
    ticking = true;
    try {
      // (e) kill switch: cancela activos si se encendió por fuera y no lanza nada.
      await pool.refreshKillSwitch();
      if (await engine.isKillSwitchActive()) return { skipped: "kill_switch", dispatched: [], errors: [] };
      await renewLeases();
      // (c.2) Gate 2: reconcilia aprobaciones decididas por el MCP admin (u otra
      // ruta que solo fijó el estado) antes de despachar — desbloquea sus tareas.
      await reconcilePendingApprovals();
      const dispatched: string[] = [];
      const tickErrors: string[] = [];
      const phaseBudgetCache = new Map<string, boolean>();
      for (const task of await listDispatchableTasks(db, now(), maxDispatchPerTick)) {
        try {
          // §13.4: fase sin presupuesto restante → sus tareas esperan (ni claim ni run).
          if (await isPhaseBudgetExhausted(task.projectId, phaseBudgetCache)) continue;
          const runId = await dispatchTask(task);
          if (runId) dispatched.push(runId);
        } catch (err) {
          // Kill switch/presupuesto a mitad de bucle: lo reintenta el siguiente tick.
          tickErrors.push(err instanceof Error ? err.message : String(err));
        }
      }
      return { dispatched, errors: tickErrors };
    } finally {
      ticking = false;
    }
  }

  // ── Canal chat (US-1): run de Alex por mensaje entrante ───────────────────

  interface StreamState {
    text: string;
    finalized: boolean;
  }

  /**
   * Reenvía los deltas del run al topic del thread y, al terminar, persiste el
   * mensaje del asistente y publica el OutboundMessage final al thread y al
   * canal (ARCHITECTURE §9: canal sin edición ignora parciales).
   */
  function attachThreadForwarder(runId: string, thread: Thread, agent: Agent): void {
    const state: StreamState = { text: "", finalized: false };
    // El cuerpo va aparte para que su rechazo quede SIEMPRE capturado: un
    // listener asíncrono que lanza tumbaba el proceso por `unhandledRejection`.
    const forward = async (persisted: PersistedEvent): Promise<void> => {
      const payload = (persisted.payload ?? {}) as Record<string, unknown> & { type?: string };
      const type = persisted.type;
      if (type === "TEXT_MESSAGE_START" || type === "TEXT_MESSAGE_CONTENT" || type === "TEXT_MESSAGE_END") {
        if (type === "TEXT_MESSAGE_CONTENT" && typeof payload.delta === "string") {
          state.text += payload.delta;
        }
        await publishRaw(bus, threadTopic(thread.id), payload as { type: string }, runId);
        return;
      }
      if (type === "RUN_FINISHED" || type === "RUN_ERROR" || type === "RUN_CANCELLED") {
        if (state.finalized) return;
        state.finalized = true;
        unsubscribe();
        const isError = type !== "RUN_FINISHED";
        let text = state.text;
        if (!text && type === "RUN_FINISHED" && typeof payload.result === "string") {
          text = payload.result;
        }
        if (!text) {
          text = isError
            ? `El agente no pudo responder (${String(payload.code ?? payload.reason ?? "error")}: ${String(payload.message ?? "run terminado sin texto")})`
            : "(el agente terminó sin texto)";
        }
        const { message } = await appendMessage(db, {
          threadId: thread.id,
          role: "assistant",
          content: text,
          runId,
          actor: `agent:${agent.slug}`,
          ...(isError ? { meta: { error: true } } : {}),
        });
        const outbound = {
          type: "message.final",
          payload: {
            channel: thread.channel,
            thread_id: thread.id,
            message_id: message.id,
            run_id: runId,
            role: "assistant",
            text,
            final: true,
            ...(isError ? { error: String(payload.code ?? payload.message ?? "error") } : {}),
          },
        };
        await publishRaw(bus, threadTopic(thread.id), outbound, runId);
        await publishRaw(bus, channelTopic(thread.channel), outbound, runId);
      }
    };
    const unsubscribe = bus.subscribe(runTopic(runId), (persisted) => {
      void forward(persisted).catch((err: unknown) =>
        log.error(`forwarder del thread ${thread.id} (run ${runId})`, err),
      );
    });
  }

  async function enqueueChatRun(params: {
    threadId: string;
    text: string;
  }): Promise<{ runId: string }> {
    const thread = await getThread(db, params.threadId);
    if (!thread) {
      throw new AgentosError(ErrorCodes.NOT_FOUND, `thread no encontrado: ${params.threadId}`);
    }
    const agent = await getAgentBySlug(db, chatAgentSlug);
    if (!agent) {
      throw new AgentosError(
        ErrorCodes.RUNNER_UNAVAILABLE,
        `No existe el agente orquestador "${chatAgentSlug}" (¿seed aplicado?)`,
      );
    }
    await engine.assertAgentCanRun(agent.id);
    const provider = await resolveProvider(agent);
    const runId = newId();

    // Historial del hilo (sin el volatile del tablero: es conversación).
    const history: ModelMessage[] = (await listMessages(db, thread.id))
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
    // El mensaje entrante ya está persistido y es el último del historial.
    const last = history[history.length - 1];
    const historyWithoutLast =
      last && last.role === "user" && last.content === params.text ? history.slice(0, -1) : history;

    const base = await buildRunInput({
      agent,
      provider,
      projectId: thread.projectId,
      thread,
      userText: params.text,
      history: historyWithoutLast,
    });
    const ctx: RunTraceContext = {
      runId,
      rootRunId: runId,
      parentRunId: null,
      taskId: null,
      projectId: thread.projectId,
      agentId: agent.id,
      actor: `agent:${agent.slug}`,
      trigger: "chat",
    };
    const input = bindRunInput(base, agent, ctx);
    attachThreadForwarder(runId, thread, agent);
    await pool.submit({ runtime: agent.runtime, input, ctx });
    return { runId };
  }

  // ── (c) reanudación tras aprobación (Gate 2) ──────────────────────────────

  async function enqueueApprovalResume(
    approval: Approval,
    executed: GatewayResult,
  ): Promise<{ runId: string } | null> {
    const originRun = approval.runId ? await getRun(db, approval.runId) : undefined;
    const agentId =
      originRun?.agentId ?? (await getTask(db, approval.taskId ?? ""))?.assigneeAgentId;
    const agent = agentId ? await getAgent(db, agentId) : undefined;
    // Cadena rota (o agente pausado): la reanudación espera igual que el despacho.
    if (!agent || !(await engine.isAgentAssignable(agent.id))) return null;

    const provider = await resolveProvider(agent);
    const runId = newId();
    const payload = approval.payload as { tool?: string; args?: unknown };

    // Fila runs con resume_of_run_id ANTES del submit (el pool respeta filas
    // pre-creadas): la reanudación es visible y navegable (US-7).
    await createRun(db, {
      id: runId,
      parentRunId: approval.runId ?? null,
      ...(originRun ? { rootRunId: originRun.rootRunId } : {}),
      agentId: agent.id,
      taskId: approval.taskId ?? null,
      projectId: approval.projectId ?? null,
      trigger: "approval_resume",
      runtime: agent.runtime,
      providerProfileId: provider.id,
      model: agent.model ?? null,
      status: "queued",
      resumeOfRunId: approval.runId ?? null,
    });

    // La tarea bloqueada por la aprobación vuelve a manos del agente.
    let claimed = false;
    if (approval.taskId) {
      const task = await getTask(db, approval.taskId);
      if (task && task.status === "BLOCKED") {
        try {
          await engine.moveTask({
            taskId: task.id,
            to: "READY",
            expectedVersion: task.version,
            actor: "system:approvals",
            runId,
            note: `aprobación ${approval.id} resuelta`,
          });
          claimed = (await engine.claim({ taskId: task.id, agentId: agent.id, runId, leaseMs }))
            .claimed;
        } catch {
          /* otro actor la movió; la reanudación sigue */
        }
      }
      if (claimed) inflight.set(runId, approval.taskId);
    }

    const resultText =
      executed.status === "ok" ? JSON.stringify(executed.result) : JSON.stringify(executed);
    const userText =
      `Tu solicitud de la tool "${payload.tool ?? "?"}" fue APROBADA por un humano y la plataforma ` +
      `ya ejecutó el efecto. Resultado literal: ${resultText}\n` +
      `Continúa la tarea desde donde la dejaste; si ya está completa, muévela con tasks.move y adjunta evidencia.`;

    try {
      const base = await buildRunInput({
        agent,
        provider,
        taskId: approval.taskId ?? null,
        projectId: approval.projectId ?? null,
        userText,
      });
      const ctx: RunTraceContext = {
        runId,
        rootRunId: originRun?.rootRunId ?? runId,
        parentRunId: approval.runId ?? null,
        taskId: approval.taskId ?? null,
        projectId: approval.projectId ?? null,
        agentId: agent.id,
        actor: `agent:${agent.slug}`,
        trigger: "approval_resume",
      };
      const input = bindRunInput(base, agent, ctx);
      const handle = await pool.submit({ runtime: agent.runtime, input, ctx });
      if (approval.taskId) {
        const taskId = approval.taskId;
        void handle.done
          .then((run) => afterTaskRun(run, taskId))
          .catch((err: unknown) => log.error(`afterTaskRun(${taskId})`, err));
      }
      return { runId };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      inflight.delete(runId);
      if (approval.taskId && claimed) {
        await releaseClaim(approval.taskId, runId, `reanudación fallida: ${message}`);
      }
      await updateRun(db, runId, { status: "cancelled", error: message, finishedAt: now() });
      return null;
    }
  }

  // ── (c.2) reconciliación de aprobaciones decididas (fix Q2) ────────────────
  //
  // El efecto del tool_call y el resume viven en apps/api (gateway + despachador);
  // el MCP admin es otro proceso sin ese runtime. Estas deps se inyectan en la
  // función compartida de core, y el drenado (reconcilePendingApprovals) recoge
  // las decisiones que el MCP dejó sin reconciliar — nada queda huérfano.
  const reconcileDeps: ApprovalReconcileDeps = {
    executeApproved: async (approval) => {
      const originRun = approval.runId ? await getRun(db, approval.runId) : undefined;
      const execCtx: ToolCallContext = {
        run_id: approval.runId ?? null,
        agent_id: originRun?.agentId ?? "system",
        task_id: approval.taskId ?? null,
        project_id: approval.projectId ?? null,
        actor: "system:approvals",
      };
      return toolRuntime.executeApproved(execCtx, approval.id);
    },
    enqueueResume: async (approval, executed) =>
      (await enqueueApprovalResume(approval, executed as GatewayResult))?.runId ?? null,
  };

  function reconcileApproval(approvalId: string): Promise<ReconcileResult> {
    return engine.reconcileDecidedApproval(approvalId, reconcileDeps);
  }

  /** Drena las decisiones decididas-pero-sin-reconciliar (típicamente del MCP admin). */
  async function reconcilePendingApprovals(): Promise<void> {
    for (const approval of await listReconcilableApprovals(db)) {
      try {
        await reconcileApproval(approval.id);
      } catch {
        // Un fallo puntual no debe tumbar el tick. El reclamo atómico ya marcó
        // reconciled_at, así que el efecto externo NO se reejecuta en bucle.
      }
    }
  }

  // ── (d) auto-crítica de Quinn al entrar a REVIEW ──────────────────────────

  const unsubscribeCritique = bus.subscribeAll((persisted) => {
    void critiqueOnReview(persisted).catch((err: unknown) =>
      log.error("auto-crítica de Quinn", err),
    );
  });

  async function critiqueOnReview(persisted: PersistedEvent): Promise<void> {
    if (disposed) return;
    if (persisted.type !== "task.moved") return;
    const p = domainPayload(persisted);
    if (p.to !== "REVIEW" || typeof p.taskId !== "string") return;
    // Dedupe SÍNCRONO, antes de cualquier await: la key sale del propio evento
    // (una entrada a REVIEW = un evento = una crítica). Antes se construía con
    // `task.version` leído DESPUÉS de cuatro awaits — o sea la versión ACTUAL,
    // no la del movimiento: dos entradas a REVIEW podían colapsar en la misma
    // key (crítica perdida) según cómo se intercalaran las lecturas.
    const key = `${p.taskId}:${persisted.seq}`;
    if (critiqued.has(key)) return;
    critiqued.add(key);
    try {
      const task = await getTask(db, p.taskId);
      if (!task?.activityType) return;
      const list = (await getConfig<string[]>(db, QUINN_ACTIVITY_TYPES_KEY)) ?? [];
      if (!list.includes(task.activityType)) return;
      const quinn = await getAgentBySlug(db, critiqueAgentSlug);
      if (!quinn || !(await engine.isAgentAssignable(quinn.id))) return;
      if (task.assigneeAgentId === quinn.id) return; // Quinn nunca revisa su propio trabajo
      const provider = await resolveProvider(quinn);
      const runId = newId();
      const userText =
        `La tarea ${task.id} ("${task.title}") entró a REVIEW con activity_type "${task.activityType}". ` +
        `Critícala como adversario: revisa sus artefactos (tasks.get), busca fallos y evidencia faltante. ` +
        `Si encuentras un fallo, crea una tarea hija tipo bug con la reproducción. NUNCA apruebes ni cierres tareas.`;
      const base = await buildRunInput({
        agent: quinn,
        provider,
        taskId: task.id,
        projectId: task.projectId,
        userText,
      });
      const ctx: RunTraceContext = {
        runId,
        rootRunId: runId,
        parentRunId: null,
        taskId: task.id,
        projectId: task.projectId,
        agentId: quinn.id,
        actor: `agent:${quinn.slug}`,
        trigger: "system",
      };
      const input = bindRunInput(base, quinn, ctx);
      await pool.submit({ runtime: quinn.runtime, input, ctx });
    } catch {
      critiqued.delete(key); // kill switch/presupuesto: reintentable
    }
  }

  // ── Ciclo de vida ─────────────────────────────────────────────────────────

  function start(): void {
    if (tickTimer || disposed) return;
    tickTimer = setInterval(() => {
      void tick().catch((err: unknown) => log.error("tick", err));
    }, dispatchIntervalMs);
    reaperTimer = setInterval(() => {
      void engine.reap().catch((err: unknown) => log.error("reap", err));
    }, reaperIntervalMs);
  }

  function stop(): void {
    disposed = true;
    if (tickTimer) clearInterval(tickTimer);
    if (reaperTimer) clearInterval(reaperTimer);
    tickTimer = undefined;
    reaperTimer = undefined;
    unsubscribeCritique();
  }

  return {
    start,
    stop,
    tick,
    reap: () => engine.reap(),
    enqueueChatRun,
    enqueueApprovalResume,
    reconcileApproval,
    inflight: () => inflight,
  };
}
