import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ErrorCodes, isAgentosError } from "@agentos/shared";
import { getRun } from "@agentos/db";
import type { AgUiEvent } from "@agentos/events";
import {
  buildClaudeCodeOptions,
  resolveWorkspacePath,
} from "../src/claude-code-options.js";
import {
  ClaudeCodeRunner,
  extractPromptText,
  getClaudeSessionId,
  type ClaudeQueryFn,
} from "../src/claude-code-runner.js";
import { NO_ANSWER_CAME, type DomainTools, type RunInput } from "../src/types.js";
import { makeCtx, makeDb, makeProfile, tick } from "./helpers.js";

const tmpWorkspaces = () => fs.mkdtempSync(path.join(os.tmpdir(), "agentos-ws-"));

function baseInput(profileOverrides = {}, overrides: Partial<RunInput> = {}): RunInput {
  return {
    agent: { slug: "debbie", toolsAllowlist: ["Bash", "Read", "Edit"] },
    systemPrompt: "Eres Debbie, implementadora de Sixteam.",
    messages: [{ role: "user", content: "lista los archivos" }],
    provider: profileOverrides as RunInput["provider"],
    budget: { maxSteps: 5 },
    ...overrides,
  };
}

describe("buildClaudeCodeOptions (higiene de entorno, sin lanzar CLI)", () => {
  it("claude_subscription: ELIMINA ANTHROPIC_API_KEY del env del hijo (no facturar API por accidente)", async () => {
    const db = makeDb();
    const profile = await makeProfile(db, { slug: "claude-sub", kind: "claude_subscription", apiKeyEnv: null });
    const baseEnv = { ANTHROPIC_API_KEY: "sk-ant-peligro", PATH: "/usr/bin" } as NodeJS.ProcessEnv;
    const built = buildClaudeCodeOptions({ input: baseInput(profile), ctx: makeCtx(), baseEnv });

    expect("ANTHROPIC_API_KEY" in built.env).toBe(false);
    expect(built.env.PATH).toBe("/usr/bin");
    // El env base NO se muta.
    expect(baseEnv.ANTHROPIC_API_KEY).toBe("sk-ant-peligro");
  });

  it("anthropic_api: inyecta ANTHROPIC_API_KEY desde process.env[api_key_env]", async () => {
    const db = makeDb();
    const profile = await makeProfile(db, { slug: "anthropic-api", kind: "anthropic_api", apiKeyEnv: "MI_KEY_ANTH" });
    const built = buildClaudeCodeOptions({
      input: baseInput(profile),
      ctx: makeCtx(),
      baseEnv: { MI_KEY_ANTH: "sk-ant-real" } as NodeJS.ProcessEnv,
    });
    expect(built.env.ANTHROPIC_API_KEY).toBe("sk-ant-real");
  });

  it("anthropic_api sin la variable en el entorno → provider_not_configured", async () => {
    const db = makeDb();
    const profile = await makeProfile(db, { slug: "anthropic-api2", kind: "anthropic_api", apiKeyEnv: "NO_EXISTE" });
    try {
      buildClaudeCodeOptions({ input: baseInput(profile), ctx: makeCtx(), baseEnv: {} as NodeJS.ProcessEnv });
      expect.unreachable();
    } catch (err) {
      expect(isAgentosError(err, ErrorCodes.PROVIDER_NOT_CONFIGURED)).toBe(true);
    }
  });

  it("kinds no-Anthropic → runner_unavailable (fail-closed)", async () => {
    const db = makeDb();
    const profile = await makeProfile(db); // openai_compatible
    expect(() =>
      buildClaudeCodeOptions({ input: baseInput(profile), ctx: makeCtx(), baseEnv: {} as NodeJS.ProcessEnv }),
    ).toThrow();
  });

  it("persona vía systemPrompt append, allowlist, maxTurns, resume, permissionMode fail-closed", async () => {
    const db = makeDb();
    const profile = await makeProfile(db, { slug: "claude-sub2", kind: "claude_subscription", apiKeyEnv: null });
    const domainTools: DomainTools = {
      asAiSdkTools: () => ({}),
      asSdkMcpServer: () => ({ type: "sdk", name: "agentos" }),
    };
    const built = buildClaudeCodeOptions({
      input: baseInput(profile, { resumeSessionId: "sess-previa", domainTools, model: "claude-opus-4-6" }),
      ctx: makeCtx(),
      baseEnv: {} as NodeJS.ProcessEnv,
    });
    expect(built.systemPrompt).toEqual({
      type: "preset",
      preset: "claude_code",
      append: "Eres Debbie, implementadora de Sixteam.",
    });
    expect(built.allowedTools).toEqual(["Bash", "Read", "Edit"]);
    expect(built.maxTurns).toBe(5);
    expect(built.resume).toBe("sess-previa");
    expect(built.model).toBe("claude-opus-4-6");
    expect(built.permissionMode).toBe("dontAsk");
    expect(built.mcpServers).toEqual({ agentos: { type: "sdk", name: "agentos" } });
  });

  it("workspace por proyecto: workspace_path del proyecto o data/workspaces/<project_id>", () => {
    const root = "C:\\tmp\\ws";
    expect(resolveWorkspacePath({ workspacePath: "C:\\proyectos\\acme" }, { projectId: "p1" }, root)).toBe(
      path.resolve("C:\\proyectos\\acme"),
    );
    expect(resolveWorkspacePath({}, { projectId: "p1" }, root)).toBe(path.join(root, "p1"));
    expect(resolveWorkspacePath({}, {}, root)).toBe(path.join(root, "_sin-proyecto"));
  });
});

describe("extractPromptText", () => {
  it("toma el último mensaje user (string o partes de texto)", () => {
    expect(
      extractPromptText([
        { role: "user", content: "primero" },
        { role: "assistant", content: "ok" },
        { role: "user", content: [{ type: "text", text: "segundo" }] },
      ]),
    ).toBe("segundo");
    expect(extractPromptText([])).toBe("");
  });
});

describe("ClaudeCodeRunner.run (queryFn inyectado, sin CLI real)", () => {
  function fakeSession(sessionId: string): unknown[] {
    return [
      { type: "system", subtype: "init", session_id: sessionId, model: "claude-sonnet-4-5", apiKeySource: "none", cwd: "x" },
      {
        type: "assistant",
        session_id: sessionId,
        message: {
          id: "msg-1",
          content: [
            { type: "text", text: "Voy a listar el directorio" },
            { type: "tool_use", id: "tu-1", name: "Bash", input: { command: "ls" } },
          ],
        },
      },
      {
        type: "user",
        session_id: sessionId,
        message: { content: [{ type: "tool_result", tool_use_id: "tu-1", content: [{ type: "text", text: "archivo.txt" }] }] },
      },
      { type: "assistant", session_id: sessionId, message: { id: "msg-2", content: [{ type: "text", text: "Listo" }] } },
      {
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: sessionId,
        total_cost_usd: 0.1234,
        usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 50, cache_creation_input_tokens: 10 },
      },
    ];
  }

  it("proyecta los mensajes del SDK a AG-UI, guarda session id y cierra el run con tokens/coste", async () => {
    const db = makeDb();
    const profile = await makeProfile(db, { slug: "claude-sub3", kind: "claude_subscription", apiKeyEnv: null });
    const captured: { prompt: string; options?: unknown }[] = [];
    const queryFn: ClaudeQueryFn = async function* (params) {
      captured.push(params);
      yield* fakeSession("sess-1");
    };
    const workspaceRoot = tmpWorkspaces();
    const runner = new ClaudeCodeRunner({
      db,
      queryFn,
      workspaceRoot,
      baseEnv: { ANTHROPIC_API_KEY: "sk-fuera", FOO: "bar" } as NodeJS.ProcessEnv,
    });
    const ctx = makeCtx();

    const events: AgUiEvent[] = [];
    for await (const event of runner.run(baseInput(profile), ctx)) events.push(event);
    const types = events.map((e) => e.type);

    // Prompt plano derivado del último mensaje user + higiene de env aplicada.
    expect(captured[0]!.prompt).toBe("lista los archivos");
    const optionsEnv = (captured[0]!.options as { env: Record<string, string | undefined> }).env;
    expect("ANTHROPIC_API_KEY" in optionsEnv).toBe(false);
    expect(optionsEnv.FOO).toBe("bar");

    // Workspace creado bajo la raíz configurada.
    expect(fs.existsSync(path.join(workspaceRoot, "_sin-proyecto"))).toBe(true);

    // Proyección AG-UI en orden.
    expect(types[0]).toBe("RUN_STARTED");
    expect(types[types.length - 1]).toBe("RUN_FINISHED");
    expect(types).toContain("TEXT_MESSAGE_CONTENT");
    const iToolStart = types.indexOf("TOOL_CALL_START");
    const iToolResult = types.indexOf("TOOL_CALL_RESULT");
    expect(iToolStart).toBeGreaterThan(0);
    expect(iToolResult).toBeGreaterThan(iToolStart);
    const toolResult = events[iToolResult]!;
    expect(toolResult.type === "TOOL_CALL_RESULT" && toolResult.content).toBe("archivo.txt");

    // RUN_FINISHED lleva el session id para continuidad.
    const finished = events[events.length - 1]!;
    expect(finished.type === "RUN_FINISHED" && finished.sessionId).toBe("sess-1");

    // Fila runs + span de sesión.
    const run = (await getRun(db, ctx.runId))!;
    expect(run.status).toBe("succeeded");
    expect(run.tokensIn).toBe(1000);
    expect(run.tokensOut).toBe(200);
    expect(run.tokensCacheRead).toBe(50);
    expect(run.tokensCacheWrite).toBe(10);
    expect(run.costUsd).toBeCloseTo(0.1234, 10);
    expect((await getClaudeSessionId(db, ctx.runId))).toBe("sess-1");
  });

  it("cierra tool_use huérfanos con NO_ANSWER_CAME", async () => {
    const db = makeDb();
    const profile = await makeProfile(db, { slug: "claude-sub4", kind: "claude_subscription", apiKeyEnv: null });
    const queryFn: ClaudeQueryFn = async function* () {
      yield { type: "system", subtype: "init", session_id: "sess-2", model: "m" };
      yield {
        type: "assistant",
        session_id: "sess-2",
        message: { id: "msg-1", content: [{ type: "tool_use", id: "tu-9", name: "Bash", input: {} }] },
      };
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: "sess-2",
        total_cost_usd: 0.01,
        usage: { input_tokens: 10, output_tokens: 2 },
      };
    };
    const runner = new ClaudeCodeRunner({ db, queryFn, workspaceRoot: tmpWorkspaces(), baseEnv: {} as NodeJS.ProcessEnv });
    const ctx = makeCtx();
    const events: AgUiEvent[] = [];
    for await (const event of runner.run(baseInput(profile), ctx)) events.push(event);

    const synthetic = events.find((e) => e.type === "TOOL_CALL_RESULT");
    expect(synthetic).toBeDefined();
    expect(synthetic!.type === "TOOL_CALL_RESULT" && synthetic!.content).toBe(NO_ANSWER_CAME);
    expect(synthetic!.type === "TOOL_CALL_RESULT" && synthetic!.synthetic).toBe(true);
  });

  it("result de error del CLI → run failed + RUN_ERROR", async () => {
    const db = makeDb();
    const profile = await makeProfile(db, { slug: "claude-sub5", kind: "claude_subscription", apiKeyEnv: null });
    const queryFn: ClaudeQueryFn = async function* () {
      yield { type: "system", subtype: "init", session_id: "sess-3", model: "m" };
      yield {
        type: "result",
        subtype: "error_max_turns",
        is_error: true,
        session_id: "sess-3",
        total_cost_usd: 0.2,
        usage: { input_tokens: 5, output_tokens: 1 },
      };
    };
    const runner = new ClaudeCodeRunner({ db, queryFn, workspaceRoot: tmpWorkspaces(), baseEnv: {} as NodeJS.ProcessEnv });
    const ctx = makeCtx();
    const events: AgUiEvent[] = [];
    for await (const event of runner.run(baseInput(profile), ctx)) events.push(event);

    const last = events[events.length - 1]!;
    expect(last.type).toBe("RUN_ERROR");
    const run = (await getRun(db, ctx.runId))!;
    expect(run.status).toBe("failed");
    expect(run.error).toBe("error_max_turns");
  });

  it("cancel(): abort → proceso hijo muere → run cancelled", async () => {
    const db = makeDb();
    const profile = await makeProfile(db, { slug: "claude-sub6", kind: "claude_subscription", apiKeyEnv: null });
    const queryFn: ClaudeQueryFn = async function* (params) {
      yield { type: "system", subtype: "init", session_id: "sess-4", model: "m" };
      const signal = (params.options as { abortController?: AbortController }).abortController?.signal;
      await new Promise<void>((_resolve, reject) => {
        const err = new Error("The operation was aborted");
        err.name = "AbortError";
        if (signal?.aborted) reject(err);
        signal?.addEventListener("abort", () => reject(err));
      });
    };
    const runner = new ClaudeCodeRunner({ db, queryFn, workspaceRoot: tmpWorkspaces(), baseEnv: {} as NodeJS.ProcessEnv });
    const ctx = makeCtx();

    const events: AgUiEvent[] = [];
    const consuming = (async () => {
      for await (const event of runner.run(baseInput(profile), ctx)) events.push(event);
    })();
    await tick();
    await runner.cancel(ctx.runId);
    await consuming;

    const last = events[events.length - 1]!;
    expect(last.type === "RUN_ERROR" && last.code).toBe("cancelled");
    expect((await getRun(db, ctx.runId))!.status).toBe("cancelled");
  });

  // Smoke real opcional: exige CLI logueado (suscripción) y red. Ejecutar a mano
  // quitando el .skip cuando se quiera validar el wiring de verdad.
  it.skip("smoke real: query() contra el CLI local (manual)", async () => {
    const db = makeDb();
    const profile = await makeProfile(db, { slug: "claude-sub-real", kind: "claude_subscription", apiKeyEnv: null });
    const runner = new ClaudeCodeRunner({ db, workspaceRoot: tmpWorkspaces() });
    const ctx = makeCtx();
    const events: AgUiEvent[] = [];
    for await (const event of runner.run(
      baseInput(profile, {
        systemPrompt: "Responde en una sola palabra.",
        messages: [{ role: "user", content: "Di 'hola' y nada más." }],
        budget: { maxSteps: 1 },
      }),
      ctx,
    )) {
      events.push(event);
    }
    expect(events.at(-1)?.type).toBe("RUN_FINISHED");
  });
});
