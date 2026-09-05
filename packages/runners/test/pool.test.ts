import { describe, expect, it } from "vitest";
import { ErrorCodes, isAgentosError, newId, nowMs, type AgentRuntime } from "@agentos/shared";
import { createRun, getRun, listRunsByStatus, setConfig, updateRun, type AgentosDb } from "@agentos/db";
import { EventBus, SWARM_TOPIC } from "@agentos/events";
import type { AgUiEvent } from "@agentos/events";
import { RunnerPool, type PoolSubmission } from "../src/pool.js";
import type { AgentRunner, RunInput, RunTraceContext } from "../src/types.js";
import { makeCtx, makeDb, makeProfile, tick } from "./helpers.js";

/** Runner controlable: cada run espera a que el test lo libere (o lo cancele). */
class FakeRunner implements AgentRunner {
  readonly runtime: AgentRuntime;
  readonly started: string[] = [];
  readonly inputs = new Map<string, RunInput>();
  private readonly gates = new Map<string, { resolve: () => void; promise: Promise<void> }>();
  private readonly cancelledRuns = new Set<string>();

  constructor(
    private readonly db: AgentosDb,
    runtime: AgentRuntime = "ai_sdk",
  ) {
    this.runtime = runtime;
  }

  private gate(runId: string) {
    let gate = this.gates.get(runId);
    if (!gate) {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => {
        resolve = r;
      });
      gate = { resolve, promise };
      this.gates.set(runId, gate);
    }
    return gate;
  }

  release(runId: string): void {
    this.gate(runId).resolve();
  }

  async cancel(runId: string): Promise<void> {
    this.cancelledRuns.add(runId);
    this.gate(runId).resolve();
  }

  async *run(input: RunInput, ctx: RunTraceContext): AsyncIterable<AgUiEvent> {
    this.started.push(ctx.runId);
    this.inputs.set(ctx.runId, input);
    await updateRun(this.db, ctx.runId, { status: "running", startedAt: nowMs() });
    yield { type: "RUN_STARTED", timestamp: nowMs(), runId: ctx.runId };
    await this.gate(ctx.runId).promise;
    if (this.cancelledRuns.has(ctx.runId)) {
      await updateRun(this.db, ctx.runId, { status: "cancelled", error: "cancelled", finishedAt: nowMs() });
      yield { type: "RUN_ERROR", timestamp: nowMs(), runId: ctx.runId, code: "cancelled", message: "cancelado" };
      return;
    }
    await updateRun(this.db, ctx.runId, { status: "succeeded", finishedAt: nowMs() });
    yield { type: "RUN_FINISHED", timestamp: nowMs(), runId: ctx.runId };
  }
}

async function setup(poolOptions: Partial<ConstructorParameters<typeof RunnerPool>[0]> = {}) {
  const db = makeDb();
  const bus = new EventBus(db);
  const profile = await makeProfile(db);
  const fake = new FakeRunner(db);
  const pool = new RunnerPool({
    db,
    bus,
    runners: { ai_sdk: fake },
    ...poolOptions,
  });
  const submission = (): PoolSubmission => {
    const ctx = makeCtx();
    return {
      runtime: "ai_sdk",
      input: {
        agent: { slug: "fake" },
        systemPrompt: "",
        messages: [],
        provider: profile,
      },
      ctx,
    };
  };
  return { db, bus, profile, fake, pool, submission };
}

describe("RunnerPool", () => {
  it("semáforo respeta el límite y la cola es FIFO y visible (estado queued + eventos)", async () => {
    const { db, bus, fake, pool, submission } = await setup({ limits: { ai_sdk: 2 } });
    const [s1, s2, s3, s4] = [submission(), submission(), submission(), submission()];
    const h1 = await pool.submit(s1);
    const h2 = await pool.submit(s2);
    const h3 = await pool.submit(s3);
    const h4 = await pool.submit(s4);
    await tick();

    // Solo 2 corren; el resto espera en cola FIFO.
    expect(fake.started).toEqual([s1.ctx.runId, s2.ctx.runId]);
    expect((await getRun(db, s3.ctx.runId))!.status).toBe("queued");
    expect((await getRun(db, s4.ctx.runId))!.status).toBe("queued");
    expect(pool.snapshot().queued.ai_sdk).toEqual([s3.ctx.runId, s4.ctx.runId]);
    // Estado 'queued' consultable vía repositorio (cola visible).
    expect((await listRunsByStatus(db, "queued")).map((r) => r.id)).toEqual([s3.ctx.runId, s4.ctx.runId]);
    // Evento RUN_QUEUED con posición publicado al bus.
    const swarm = await bus.getSince(SWARM_TOPIC, 0);
    const queuedEvents = swarm.filter((e) => e.type === "RUN_QUEUED");
    expect(queuedEvents.map((e) => (e.payload as { runId: string; position: number }).position)).toEqual([1, 2]);

    // Al liberar uno, entra el siguiente EN ORDEN.
    fake.release(s1.ctx.runId);
    await h1.done;
    await tick();
    expect(fake.started).toEqual([s1.ctx.runId, s2.ctx.runId, s3.ctx.runId]);
    const dequeued = (await bus.getSince(SWARM_TOPIC, 0)).filter((e) => e.type === "RUN_DEQUEUED");
    expect(dequeued.map((e) => (e.payload as { runId: string }).runId)).toEqual([s3.ctx.runId]);

    fake.release(s2.ctx.runId);
    fake.release(s3.ctx.runId);
    await Promise.all([h2.done, h3.done]);
    await tick();
    fake.release(s4.ctx.runId);
    const run4 = await h4.done;
    expect(run4.status).toBe("succeeded");
  });

  it("kill switch: no arranca nuevos (submit rechaza)", async () => {
    const { db, pool, submission } = await setup();
    await setConfig(db, "agents_enabled", false);
    await expect(pool.submit(submission())).rejects.toSatisfy((err) =>
      isAgentosError(err, ErrorCodes.KILL_SWITCH_ACTIVE),
    );
  });

  it("kill switch: cancela activos y cola al refrescar", async () => {
    const { db, fake, pool, submission } = await setup({ limits: { ai_sdk: 1 } });
    const s1 = submission();
    const s2 = submission();
    const h1 = await pool.submit(s1);
    const h2 = await pool.submit(s2); // queda en cola
    await tick();
    expect(fake.started).toEqual([s1.ctx.runId]);

    await setConfig(db, "agents_enabled", false);
    const acted = await pool.refreshKillSwitch();
    expect(acted).toBe(true);

    const [r1, r2] = await Promise.all([h1.done, h2.done]);
    expect(r1.status).toBe("cancelled");
    expect(r2.status).toBe("cancelled");
    expect(r2.error).toBe("kill_switch");
    expect(pool.snapshot().queued.ai_sdk ?? []).toEqual([]);
  });

  it("timeout duro mata el run (cancelación vía runner)", async () => {
    const { pool, submission } = await setup({ defaultTimeoutMs: 30 });
    const handle = await pool.submit(submission());
    const run = await handle.done; // el timer cancela sin que nadie libere
    expect(run.status).toBe("cancelled");
  });

  it("presupuesto por día: si ya se gastó el tope, submit rechaza budget_exceeded", async () => {
    const { db, pool, submission } = await setup({ maxUsdPerDay: 1 });
    const prevId = newId();
    await createRun(db, {
      id: prevId,
      rootRunId: prevId,
      trigger: "manual",
      runtime: "ai_sdk",
      status: "succeeded",
      costUsd: 2,
    });
    await expect(pool.submit(submission())).rejects.toSatisfy((err) =>
      isAgentosError(err, ErrorCodes.BUDGET_EXCEEDED),
    );
  });

  it("presupuesto por run: el tope global recorta el budget.maxUsd del input", async () => {
    const { fake, pool, submission } = await setup({ maxUsdPerRun: 0.5 });
    const s = submission();
    s.input.budget = { maxUsd: 2 };
    const handle = await pool.submit(s);
    await tick();
    expect(fake.inputs.get(s.ctx.runId)?.budget?.maxUsd).toBe(0.5);
    fake.release(s.ctx.runId);
    await handle.done;
  });

  it("cancelación individual de un run en cola", async () => {
    const { db, fake, pool, submission } = await setup({ limits: { ai_sdk: 1 } });
    const s1 = submission();
    const s2 = submission();
    const h1 = await pool.submit(s1);
    const h2 = await pool.submit(s2);
    await tick();

    await pool.cancel(s2.ctx.runId, "ya no hace falta");
    const run2 = await h2.done;
    expect(run2.status).toBe("cancelled");
    expect(run2.error).toBe("ya no hace falta");
    expect(pool.snapshot().queued.ai_sdk ?? []).toEqual([]);
    // El activo sigue vivo y termina normal.
    fake.release(s1.ctx.runId);
    expect((await h1.done).status).toBe("succeeded");
    expect((await getRun(db, s1.ctx.runId))!.status).toBe("succeeded");
  });

  it("runner que LANZA (en vez de emitir RUN_ERROR) no deja la fila colgada", async () => {
    const db = makeDb();
    const bus = new EventBus(db);
    const profile = await makeProfile(db);
    const explosivo: AgentRunner = {
      runtime: "ai_sdk",
      // eslint-disable-next-line require-yield
      async *run(_input, ctx) {
        await updateRun(db, ctx.runId, { status: "running" });
        throw new Error("bum");
      },
      async cancel() {},
    };
    const pool = new RunnerPool({ db, bus, runners: { ai_sdk: explosivo } });
    const ctx = makeCtx();
    const handle = await pool.submit({
      runtime: "ai_sdk",
      input: { agent: { slug: "x" }, systemPrompt: "", messages: [], provider: profile },
      ctx,
    });
    const run = await handle.done;
    expect(run.status).toBe("failed");
    expect(run.error).toBe("bum");
  });
});
