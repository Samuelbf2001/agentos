import { AgentosError, DAY_MS, ErrorCodes, nowMs, type AgentRuntime } from "@agentos/shared";
import {
  ConfigKeys,
  createRun,
  getConfig,
  getRun,
  sumRunCostBetween,
  updateRun,
  type AgentosDb,
  type Run,
} from "@agentos/db";
import { EventBus, SWARM_TOPIC, runTopic } from "@agentos/events";
import type { AgentRunner, RunInput, RunTraceContext } from "./types.js";

/** Semáforos por runtime (ARCHITECTURE §3), configurables por app_config. */
export const DEFAULT_RUNNER_LIMITS: Record<AgentRuntime, number> = {
  claude_code: 3,
  ai_sdk: 10,
};

/** Claves de app_config que lee el pool. */
export const PoolConfigKeys = {
  /** false → kill switch activo: no arranca nuevos y cancela activos. */
  AGENTS_ENABLED: "agents_enabled",
  limitFor(runtime: AgentRuntime): string {
    return `runner_limit_${runtime}`;
  },
} as const;

export interface PoolSubmission {
  runtime: AgentRuntime;
  input: RunInput;
  ctx: RunTraceContext;
  /** Timeout duro específico de este run (default: defaultTimeoutMs del pool). */
  timeoutMs?: number;
}

export interface PoolHandle {
  runId: string;
  /** Resuelve con la fila final de `runs` (nunca rechaza por errores del run). */
  done: Promise<Run>;
}

export interface RunnerPoolOptions {
  db: AgentosDb;
  bus: EventBus;
  runners: Partial<Record<AgentRuntime, AgentRunner>>;
  /** Overrides de semáforo (menor prioridad que app_config). */
  limits?: Partial<Record<AgentRuntime, number>>;
  /** Timeout duro por run en ms (undefined = sin timeout). */
  defaultTimeoutMs?: number;
  /** Presupuesto: tope USD por run (se combina con budget del input, gana el menor). */
  maxUsdPerRun?: number;
  /** Presupuesto: tope USD por día (suma de runs.cost_usd del día). */
  maxUsdPerDay?: number;
  now?: () => number;
}

interface ActiveJob {
  runId: string;
  runtime: AgentRuntime;
  runner: AgentRunner;
  timer?: ReturnType<typeof setTimeout>;
  resolve: (run: Run) => void;
}

interface QueuedJob {
  runId: string;
  runtime: AgentRuntime;
  input: RunInput;
  ctx: RunTraceContext;
  timeoutMs?: number;
  resolve: (run: Run) => void;
}

/**
 * RunnerPool (ARCHITECTURE §3, spec B2): semáforos independientes por runtime,
 * cola FIFO VISIBLE (fila runs en 'queued' + evento al bus), timeouts duros,
 * presupuesto por run y por día, kill switch y cancelación individual.
 */
export class RunnerPool {
  private readonly db: AgentosDb;
  private readonly bus: EventBus;
  private readonly runners: Partial<Record<AgentRuntime, AgentRunner>>;
  private readonly limitOverrides: Partial<Record<AgentRuntime, number>>;
  private readonly defaultTimeoutMs: number | undefined;
  private readonly maxUsdPerRun: number | undefined;
  private readonly maxUsdPerDay: number | undefined;
  private readonly now: () => number;

  private readonly running = new Map<string, ActiveJob>();
  private readonly queues = new Map<AgentRuntime, QueuedJob[]>();

  constructor(options: RunnerPoolOptions) {
    this.db = options.db;
    this.bus = options.bus;
    this.runners = options.runners;
    this.limitOverrides = options.limits ?? {};
    this.defaultTimeoutMs = options.defaultTimeoutMs;
    this.maxUsdPerRun = options.maxUsdPerRun;
    this.maxUsdPerDay = options.maxUsdPerDay;
    this.now = options.now ?? nowMs;
  }

  // ── Estado consultable ────────────────────────────────────────────────────

  /** ¿Kill switch activo? (app_config.agents_enabled=false o kill_switch=true). */
  killSwitchActive(): boolean {
    const enabled = getConfig<boolean>(this.db, PoolConfigKeys.AGENTS_ENABLED);
    if (enabled === false) return true;
    const killSwitch = getConfig<boolean>(this.db, ConfigKeys.KILL_SWITCH);
    return killSwitch === true;
  }

  /** Límite efectivo del semáforo: app_config > override del constructor > default. */
  limitFor(runtime: AgentRuntime): number {
    const fromConfig = getConfig<number>(this.db, PoolConfigKeys.limitFor(runtime));
    if (typeof fromConfig === "number" && fromConfig >= 0) return fromConfig;
    return this.limitOverrides[runtime] ?? DEFAULT_RUNNER_LIMITS[runtime];
  }

  /** Snapshot de cola y activos por runtime (cola FIFO visible). */
  snapshot(): { running: Record<string, string[]>; queued: Record<string, string[]> } {
    const running: Record<string, string[]> = {};
    for (const job of this.running.values()) {
      (running[job.runtime] ??= []).push(job.runId);
    }
    const queued: Record<string, string[]> = {};
    for (const [runtime, jobs] of this.queues) {
      queued[runtime] = jobs.map((j) => j.runId);
    }
    return { running, queued };
  }

  /** Coste ya gastado en el día del instante `at` (suma de runs.cost_usd). */
  spentTodayUsd(at: number = this.now()): number {
    const dayStart = new Date(at);
    dayStart.setHours(0, 0, 0, 0);
    return sumRunCostBetween(this.db, dayStart.getTime(), dayStart.getTime() + DAY_MS);
  }

  // ── Ciclo de vida ─────────────────────────────────────────────────────────

  submit(submission: PoolSubmission): PoolHandle {
    const { runtime, ctx } = submission;

    if (this.killSwitchActive()) {
      throw new AgentosError(
        ErrorCodes.KILL_SWITCH_ACTIVE,
        "Kill switch activo (app_config.agents_enabled=false): no se arrancan runs nuevos",
      );
    }

    const runner = this.runners[runtime];
    if (!runner) {
      throw new AgentosError(ErrorCodes.RUNNER_UNAVAILABLE, `No hay runner registrado para runtime '${runtime}'`);
    }

    // Presupuesto por día (NFR-5): si ya se gastó el tope, no arranca.
    const maxUsdPerDay =
      this.maxUsdPerDay ?? getConfig<number>(this.db, ConfigKeys.BUDGET_MAX_COST_PER_DAY_USD);
    if (typeof maxUsdPerDay === "number") {
      const spent = this.spentTodayUsd();
      if (spent >= maxUsdPerDay) {
        throw new AgentosError(
          ErrorCodes.BUDGET_EXCEEDED,
          `Presupuesto diario agotado: gastado ${spent.toFixed(4)} USD de ${maxUsdPerDay} USD`,
          { spent, maxUsdPerDay },
        );
      }
    }

    // Presupuesto por run: gana el tope más restrictivo.
    const maxUsdPerRun =
      this.maxUsdPerRun ?? getConfig<number>(this.db, ConfigKeys.BUDGET_MAX_COST_PER_RUN_USD);
    let input = submission.input;
    if (typeof maxUsdPerRun === "number") {
      const requested = input.budget?.maxUsd;
      const effective = requested === undefined ? maxUsdPerRun : Math.min(requested, maxUsdPerRun);
      input = { ...input, budget: { ...input.budget, maxUsd: effective } };
    }

    // Fila runs en 'queued' ANTES de decidir si arranca: estado consultable.
    if (!getRun(this.db, ctx.runId)) {
      createRun(this.db, {
        id: ctx.runId,
        rootRunId: ctx.rootRunId,
        parentRunId: ctx.parentRunId ?? null,
        agentId: ctx.agentId ?? null,
        taskId: ctx.taskId ?? null,
        projectId: ctx.projectId ?? null,
        trigger: ctx.trigger ?? "manual",
        runtime,
        providerProfileId: input.provider.id,
        model: input.model ?? input.agent.model ?? null,
        status: "queued",
      });
    }

    let resolve!: (run: Run) => void;
    const done = new Promise<Run>((r) => {
      resolve = r;
    });
    const job: QueuedJob = {
      runId: ctx.runId,
      runtime,
      input,
      ctx,
      ...(submission.timeoutMs !== undefined ? { timeoutMs: submission.timeoutMs } : {}),
      resolve,
    };

    const runningCount = this.runningCount(runtime);
    if (runningCount < this.limitFor(runtime)) {
      this.start(job, runner);
    } else {
      const queue = this.queues.get(runtime) ?? [];
      queue.push(job);
      this.queues.set(runtime, queue);
      const event = {
        type: "RUN_QUEUED" as const,
        timestamp: this.now(),
        runId: ctx.runId,
        runtime,
        position: queue.length,
      };
      this.bus.publish(runTopic(ctx.runId), event);
      this.bus.publish(SWARM_TOPIC, event);
    }

    return { runId: ctx.runId, done };
  }

  /** Cancela un run individual (activo o en cola). */
  async cancel(runId: string, reason = "cancelled"): Promise<void> {
    const active = this.running.get(runId);
    if (active) {
      await active.runner.cancel(runId);
      return;
    }
    for (const [runtime, queue] of this.queues) {
      const index = queue.findIndex((j) => j.runId === runId);
      if (index === -1) continue;
      const [job] = queue.splice(index, 1);
      const run = updateRun(this.db, runId, { error: reason, status: "cancelled", finishedAt: this.now() });
      const event = {
        type: "RUN_CANCELLED" as const,
        timestamp: this.now(),
        runId,
        reason,
      };
      this.bus.publish(runTopic(runId), event);
      this.bus.publish(SWARM_TOPIC, event);
      job!.resolve(run);
      void runtime;
      return;
    }
  }

  /** Cancela TODO: cola primero, luego activos (kill switch). */
  async cancelAll(reason = "kill_switch"): Promise<void> {
    const queuedIds = [...this.queues.values()].flat().map((j) => j.runId);
    for (const runId of queuedIds) {
      await this.cancel(runId, reason);
    }
    const activeIds = [...this.running.keys()];
    await Promise.all(activeIds.map((runId) => this.cancel(runId, reason)));
  }

  /**
   * Relee el kill switch de app_config y, si está activo, cancela activos y
   * cola. Devuelve true si actuó. (El caller decide la cadencia de polling.)
   */
  async refreshKillSwitch(): Promise<boolean> {
    if (!this.killSwitchActive()) return false;
    await this.cancelAll("kill_switch");
    return true;
  }

  // ── Interno ───────────────────────────────────────────────────────────────

  private runningCount(runtime: AgentRuntime): number {
    let count = 0;
    for (const job of this.running.values()) {
      if (job.runtime === runtime) count += 1;
    }
    return count;
  }

  private start(job: QueuedJob, runner: AgentRunner): void {
    const active: ActiveJob = {
      runId: job.runId,
      runtime: job.runtime,
      runner,
      resolve: job.resolve,
    };
    this.running.set(job.runId, active);

    const timeoutMs = job.timeoutMs ?? this.defaultTimeoutMs;
    if (timeoutMs !== undefined && timeoutMs > 0) {
      active.timer = setTimeout(() => {
        void runner.cancel(job.runId);
      }, timeoutMs);
    }

    void this.drive(active, job);
  }

  private async drive(active: ActiveJob, job: QueuedJob): Promise<void> {
    try {
      for await (const event of active.runner.run(job.input, job.ctx)) {
        this.bus.publish(runTopic(job.runId), event);
      }
    } catch (error) {
      // Un runner que LANZA (en vez de emitir RUN_ERROR) no debe dejar la fila colgada.
      const current = getRun(this.db, job.runId);
      if (current && (current.status === "running" || current.status === "queued")) {
        const message = error instanceof Error ? error.message : String(error);
        updateRun(this.db, job.runId, { status: "failed", error: message, finishedAt: this.now() });
      }
    } finally {
      if (active.timer) clearTimeout(active.timer);
      this.running.delete(job.runId);
      const finalRun = getRun(this.db, job.runId);
      if (finalRun) job.resolve(finalRun);
      this.pump(job.runtime);
    }
  }

  private pump(runtime: AgentRuntime): void {
    const runner = this.runners[runtime];
    if (!runner) return;
    const queue = this.queues.get(runtime);
    if (!queue || queue.length === 0) return;
    while (queue.length > 0 && this.runningCount(runtime) < this.limitFor(runtime)) {
      const job = queue.shift()!;
      const event = {
        type: "RUN_DEQUEUED" as const,
        timestamp: this.now(),
        runId: job.runId,
        runtime,
      };
      this.bus.publish(runTopic(job.runId), event);
      this.bus.publish(SWARM_TOPIC, event);
      this.start(job, runner);
    }
  }
}
