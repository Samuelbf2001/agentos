/**
 * Fixtures de integración de apps/api: DB temporal seedeada a mano y runner
 * FAKE que emite eventos AG-UI programados. LLM SIEMPRE mock — ninguna llamada
 * real sale de los tests.
 */
import { newId, nowMs, type AgentRuntime } from "@agentos/shared";
import {
  createAgent,
  createOrganization,
  createPerson,
  createProject,
  createTask,
  getAgentBySlug,
  getOrganizationByName,
  getPersonByFullName,
  getProjectByName,
  getTask,
  upsertProviderProfile,
  type Agent,
  type AgentosDb,
  type Organization,
  type Person,
  type Project,
  type ProviderProfile,
  type Task,
} from "@agentos/db";
import {
  ensureRunningRun,
  finishRunRow,
  type AgentRunner,
  type RunInput,
  type RunTraceContext,
} from "@agentos/runners";
import { wireName } from "@agentos/tools";
import { buildApi, type Api } from "../src/server.js";
import type { ApiOptions } from "../src/context.js";

export const TEST_PASSWORD = "test-pass";

// ── Runner fake (AG-UI programado) ──────────────────────────────────────────

export interface FakeCall {
  input: RunInput;
  ctx: RunTraceContext;
}

export type FakeBehavior = (
  input: RunInput,
  ctx: RunTraceContext,
) => Promise<{ text?: string } | void> | { text?: string } | void;

export interface FakeRunnerHandle {
  runner: AgentRunner;
  calls: FakeCall[];
  setBehavior(fn: FakeBehavior | undefined): void;
}

export function makeFakeRunner(getDb: () => AgentosDb, runtime: AgentRuntime): FakeRunnerHandle {
  const calls: FakeCall[] = [];
  const cancelled = new Set<string>();
  let behavior: FakeBehavior | undefined;

  const runner: AgentRunner = {
    runtime,
    async cancel(runId: string): Promise<void> {
      cancelled.add(runId);
    },
    async *run(input, ctx) {
      const db = getDb();
      calls.push({ input, ctx });
      await ensureRunningRun(db, input, ctx, runtime);
      yield {
        type: "RUN_STARTED" as const,
        timestamp: nowMs(),
        runId: ctx.runId,
        rootRunId: ctx.rootRunId,
        parentRunId: ctx.parentRunId ?? null,
        agentId: ctx.agentId ?? null,
        taskId: ctx.taskId ?? null,
        projectId: ctx.projectId ?? null,
      };
      let outcome: { text?: string } | void;
      try {
        outcome = behavior ? await behavior(input, ctx) : undefined;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await finishRunRow(db, ctx.runId, {
          status: "failed",
          usage: { tokensIn: null, tokensOut: null, tokensCacheRead: null, tokensCacheWrite: null },
          costUsd: null,
          error: message,
        });
        yield { type: "RUN_ERROR" as const, timestamp: nowMs(), runId: ctx.runId, message, code: "provider_error" };
        return;
      }
      if (cancelled.has(ctx.runId)) {
        await finishRunRow(db, ctx.runId, {
          status: "cancelled",
          usage: { tokensIn: null, tokensOut: null, tokensCacheRead: null, tokensCacheWrite: null },
          costUsd: null,
          error: "cancelled",
        });
        yield { type: "RUN_ERROR" as const, timestamp: nowMs(), runId: ctx.runId, message: "Run cancelado", code: "cancelled" };
        return;
      }
      const text = outcome?.text ?? "OK (runner fake)";
      const messageId = newId();
      yield { type: "TEXT_MESSAGE_START" as const, timestamp: nowMs(), runId: ctx.runId, messageId, role: "assistant" as const };
      yield { type: "TEXT_MESSAGE_CONTENT" as const, timestamp: nowMs(), runId: ctx.runId, messageId, delta: text };
      yield { type: "TEXT_MESSAGE_END" as const, timestamp: nowMs(), runId: ctx.runId, messageId };
      await finishRunRow(db, ctx.runId, {
        status: "succeeded",
        usage: { tokensIn: 10, tokensOut: 5, tokensCacheRead: null, tokensCacheWrite: null },
        costUsd: null,
      });
      yield {
        type: "RUN_FINISHED" as const,
        timestamp: nowMs(),
        runId: ctx.runId,
        usage: { tokensIn: 10, tokensOut: 5 },
        costUsd: null,
      };
    },
  };

  return {
    runner,
    calls,
    setBehavior(fn) {
      behavior = fn;
    },
  };
}

/** Ejecuta una tool del catálogo desde el runner fake vía el ToolSet del input
 * (mismo camino que un run real: adaptador AI SDK → gateway → handler). */
export async function callTool(
  input: RunInput,
  canonicalName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const tools = input.tools as
    | Record<string, { execute?: (a: unknown, o: unknown) => Promise<unknown> }>
    | undefined;
  const tool = tools?.[wireName(canonicalName)];
  if (!tool?.execute) {
    throw new Error(`Tool no disponible en el ToolSet del run: ${canonicalName}`);
  }
  return tool.execute(args, { toolCallId: newId(), messages: [] });
}

// ── Fixture de API ──────────────────────────────────────────────────────────

export interface TestFixture {
  api: Api;
  db: AgentosDb;
  token: string;
  person: Person;
  org: Organization;
  project: Project;
  alex: Agent;
  sam: Agent;
  provider: ProviderProfile;
  aiRunner: FakeRunnerHandle;
  ccRunner: FakeRunnerHandle;
  authHeaders: { authorization: string };
  close(): Promise<void>;
}

export const SAM_ALLOWLIST = [
  "tasks.claim",
  "tasks.move",
  "tasks.get",
  "tasks.comment",
  "tasks.attach_artifact",
  "artifacts.write",
  "knowledge.upsert_doc",
  "email.send",
  "ask_human",
];

export const ALEX_ALLOWLIST = [
  "tasks.create",
  "tasks.list",
  "tasks.get",
  "tasks.move",
  "tasks.comment",
  "board.get",
  "projects.get",
  "projects.update",
  "knowledge.search",
  "methodology.get",
  "delegate",
  "ask_human",
];

export async function makeFixture(overrides: Partial<ApiOptions> = {}): Promise<TestFixture> {
  // El fake necesita la MISMA db que abre buildApi: referencia perezosa (los
  // runners no corren hasta que la API ya existe).
  let dbRef: AgentosDb | undefined;
  const getDb = (): AgentosDb => {
    if (!dbRef) throw new Error("db aún no inicializada");
    return dbRef;
  };
  const aiRunner = makeFakeRunner(getDb, "ai_sdk");
  const ccRunner = makeFakeRunner(getDb, "claude_code");

  const api = await buildApi({
    dbPath: ":memory:",
    seedOnBoot: false,
    autoStartLoops: false,
    sharedPassword: TEST_PASSWORD,
    runners: { ai_sdk: aiRunner.runner, claude_code: ccRunner.runner },
    logger: false,
    ...overrides,
  });
  const db = api.ctx.db;
  dbRef = db;

  const provider = await upsertProviderProfile(db, {
    slug: "test-provider",
    name: "Proveedor de prueba (mock)",
    kind: "openai_compatible",
    baseUrl: "https://mock.local/v1",
    apiKeyEnv: "TEST_FAKE_KEY",
    isDefault: true,
  });
  // Idempotente: reabrir la MISMA db (test de recuperación) reutiliza filas.
  const org =
    (await getOrganizationByName(db, "ACME S.A.")) ??
    (await createOrganization(db, { name: "ACME S.A.", kind: "client" }));
  const person =
    (await getPersonByFullName(db, "Ernesto")) ??
    (await createPerson(db, { orgId: org.id, fullName: "Ernesto", isInternal: true, role: "Operador" }));
  const project =
    (await getProjectByName(db, "Assessment ACME")) ??
    (await createProject(db, {
      orgId: org.id,
      name: "Assessment ACME",
      type: "assessment",
      stage: "ENTENDER",
      gateState: "pending",
    }));
  const alex =
    (await getAgentBySlug(db, "alex")) ??
    (await createAgent(db, {
      slug: "alex",
      name: "Alex",
      layer: "consultoria",
      runtime: "ai_sdk",
      providerProfileId: provider.id,
      model: "mock-model",
      toolsAllowlist: ALEX_ALLOWLIST,
    }));
  const sam =
    (await getAgentBySlug(db, "sam")) ??
    (await createAgent(db, {
      slug: "sam",
      name: "Sam",
      layer: "consultoria",
      runtime: "ai_sdk",
      providerProfileId: provider.id,
      model: "mock-model",
      toolsAllowlist: SAM_ALLOWLIST,
    }));

  // Login real por HTTP (ejercita la ruta).
  const login = await api.app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { password: TEST_PASSWORD, person_id: person.id },
  });
  if (login.statusCode !== 200) {
    throw new Error(`login del fixture falló: ${login.statusCode} ${login.body}`);
  }
  const token = (login.json() as { token: string }).token;

  return {
    api,
    db,
    token,
    person,
    org,
    project,
    alex,
    sam,
    provider,
    aiRunner,
    ccRunner,
    authHeaders: { authorization: `Bearer ${token}` },
    close: () => api.close(),
  };
}

/** Tarea READY lista para el despachador (DoD + agente asignado). */
export async function makeReadyTask(
  fx: Pick<TestFixture, "db" | "project">,
  agent: Agent,
  patch: Partial<Parameters<typeof createTask>[1]> = {},
): Promise<Task> {
  const task = await createTask(fx.db, {
    projectId: fx.project.id,
    title: "Tarea de prueba",
    definitionOfDone: "Artefacto adjunto y estado REVIEW",
    stage: "ENTENDER",
    status: "READY",
    priority: "normal",
    assigneeAgentId: agent.id,
    orderKey: "m",
    ...patch,
  });
  return (await getTask(fx.db, task.id))!;
}

// ── Utilidades ──────────────────────────────────────────────────────────────

export async function waitFor<T>(
  fn: () => T | undefined | false | null | Promise<T | undefined | false | null>,
  opts: { timeoutMs?: number; label?: string } = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 4_000;
  const start = Date.now();
  for (;;) {
    // `fn` puede ser async (repos @agentos/db ahora devuelven Promise): se
    // espera el valor real antes de decidir si ya cumple la condición. La
    // `undefined` viaja DENTRO de la Promise para que TS siga infiriendo T sin
    // el "| undefined" (igual que hacía con la versión síncrona).
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor agotó ${timeoutMs}ms${opts.label ? `: ${opts.label}` : ""}`);
    }
    await new Promise((r) => setTimeout(r, 15));
  }
}
