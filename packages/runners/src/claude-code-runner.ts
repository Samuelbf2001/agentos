import fs from "node:fs";
import { nowMs } from "@agentos/shared";
import { addSpan, endSpan, listSpans, type AgentosDb } from "@agentos/db";
import { EMPTY_USAGE, type TokenUsage } from "@agentos/providers";
import type { AgUiEvent } from "@agentos/events";
import type { ModelMessage } from "ai";
import { buildClaudeCodeOptions, DEFAULT_WORKSPACE_ROOT } from "./claude-code-options.js";
import { ensureRunningRun, finishRunRow } from "./observability.js";
import {
  NO_ANSWER_CAME,
  type AgentRunner,
  type RunInput,
  type RunTraceContext,
  type RunnerDeps,
} from "./types.js";

/** Nombre del span interno que guarda el session id del CLI (continuidad). */
export const CLAUDE_SESSION_SPAN = "claude_code.session" as const;

// ── Formas estructurales mínimas de los mensajes del SDK ────────────────────
// (subset de SDKMessage; el runner solo lee estos campos)

interface SdkContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface SdkMessageLike {
  type: string;
  subtype?: string;
  session_id?: string;
  uuid?: string;
  model?: string;
  apiKeySource?: string;
  cwd?: string;
  is_error?: boolean;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  message?: {
    id?: string;
    content?: string | SdkContentBlock[];
  };
}

/** Firma de query() del claude-agent-sdk (inyectable: los tests pasan un fake). */
export type ClaudeQueryFn = (params: {
  prompt: string;
  options?: unknown;
}) => AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>;

export interface ClaudeCodeRunnerOptions extends RunnerDeps {
  /** Inyectable para tests; default: import dinámico de @anthropic-ai/claude-agent-sdk. */
  queryFn?: ClaudeQueryFn;
  baseEnv?: NodeJS.ProcessEnv;
  workspaceRoot?: string;
}

/** Deriva el prompt de usuario plano del historial (último mensaje user). */
export function extractPromptText(messages: ModelMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    if (message.role !== "user") continue;
    if (typeof message.content === "string") return message.content;
    return message.content
      .map((part) => (part.type === "text" ? part.text : ""))
      .filter((text) => text.length > 0)
      .join("\n");
  }
  return "";
}

function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as SdkContentBlock[])
      .map((b) => (b.type === "text" && typeof b.text === "string" ? b.text : ""))
      .filter((t) => t.length > 0)
      .join("\n");
  }
  if (content === undefined || content === null) return "";
  try {
    return JSON.stringify(content) ?? String(content);
  } catch {
    return String(content);
  }
}

/** Session id del CLI guardado en spans del run (para `resume` del siguiente run). */
export async function getClaudeSessionId(db: AgentosDb, runId: string): Promise<string | undefined> {
  const spans = await listSpans(db, runId);
  for (const span of spans) {
    if (span.name === CLAUDE_SESSION_SPAN) {
      const sessionId = (span.attrs as Record<string, unknown> | null)?.["session.id"];
      if (typeof sessionId === "string") return sessionId;
    }
  }
  return undefined;
}

/**
 * Runner de proceso hijo sobre `query()` del claude-agent-sdk (ARCHITECTURE §3):
 * higiene de entorno por perfil, persona vía systemPrompt append, workspace por
 * proyecto, tools built-in por allowlist, proyección de mensajes del SDK a
 * eventos AG-UI, continuidad por session id y cancelación limpia (abort mata
 * el proceso hijo).
 */
export class ClaudeCodeRunner implements AgentRunner {
  readonly runtime = "claude_code" as const;

  private readonly db: AgentosDb;
  private readonly queryFn: ClaudeQueryFn;
  private readonly baseEnv: NodeJS.ProcessEnv | undefined;
  private readonly workspaceRoot: string;
  private readonly active = new Map<string, AbortController>();

  constructor(options: ClaudeCodeRunnerOptions) {
    this.db = options.db;
    this.queryFn =
      options.queryFn ??
      (async function* defaultQuery(params: { prompt: string; options?: unknown }) {
        const sdk = await import("@anthropic-ai/claude-agent-sdk");
        yield* sdk.query({
          prompt: params.prompt,
          options: params.options as never,
        });
      } as unknown as ClaudeQueryFn);
    this.baseEnv = options.baseEnv;
    this.workspaceRoot = options.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT;
  }

  async cancel(runId: string): Promise<void> {
    this.active.get(runId)?.abort();
  }

  async *run(input: RunInput, ctx: RunTraceContext): AsyncIterable<AgUiEvent> {
    const db = this.db;
    await ensureRunningRun(db, input, ctx, this.runtime);

    const abortController = new AbortController();
    this.active.set(ctx.runId, abortController);

    const built = buildClaudeCodeOptions({
      input,
      ctx,
      ...(this.baseEnv ? { baseEnv: this.baseEnv } : {}),
      workspaceRoot: this.workspaceRoot,
      abortController,
    });
    // Workspace por proyecto: créalo si falta (ARCHITECTURE §3).
    fs.mkdirSync(built.cwd, { recursive: true });

    yield {
      type: "RUN_STARTED",
      timestamp: nowMs(),
      runId: ctx.runId,
      rootRunId: ctx.rootRunId,
      parentRunId: ctx.parentRunId ?? null,
      agentId: ctx.agentId ?? input.agent.slug,
      taskId: ctx.taskId ?? null,
      projectId: ctx.projectId ?? null,
    };

    let sessionId: string | undefined;
    let sessionSpanId: string | undefined;
    let usage: TokenUsage = { ...EMPTY_USAGE };
    let costUsd: number | null = null;
    let sawResult = false;
    let resultIsError = false;
    let resultErrorDetail: string | undefined;
    let streamError: unknown;
    const openToolCalls = new Map<string, { name: string; spanId?: string }>();

    const prompt = input.prompt ?? extractPromptText(input.messages);

    try {
      const stream = await this.queryFn({ prompt, options: built });
      for await (const raw of stream) {
        const message = raw as SdkMessageLike;
        if (message.type === "system" && message.subtype === "init") {
          sessionId = message.session_id ?? sessionId;
          sessionSpanId = (
            await addSpan(db, {
              runId: ctx.runId,
              name: CLAUDE_SESSION_SPAN,
              kind: "internal",
              attrs: {
                "session.id": sessionId ?? null,
                "gen_ai.request.model": message.model ?? null,
                "claude_code.api_key_source": message.apiKeySource ?? null,
                "claude_code.cwd": message.cwd ?? null,
              },
            })
          ).id;
          continue;
        }
        if (message.type === "assistant") {
          sessionId = message.session_id ?? sessionId;
          const msgId = message.message?.id ?? message.uuid ?? ctx.runId;
          const blocks =
            typeof message.message?.content === "string"
              ? [{ type: "text", text: message.message.content } satisfies SdkContentBlock]
              : (message.message?.content ?? []);
          let blockIndex = 0;
          for (const block of blocks) {
            const messageId = `${msgId}:${blockIndex}`;
            blockIndex += 1;
            if (block.type === "text" && typeof block.text === "string") {
              yield { type: "TEXT_MESSAGE_START", timestamp: nowMs(), runId: ctx.runId, messageId, role: "assistant" };
              yield { type: "TEXT_MESSAGE_CONTENT", timestamp: nowMs(), runId: ctx.runId, messageId, delta: block.text };
              yield { type: "TEXT_MESSAGE_END", timestamp: nowMs(), runId: ctx.runId, messageId };
              continue;
            }
            if (block.type === "tool_use" && typeof block.id === "string") {
              const toolName = block.name ?? "unknown_tool";
              yield {
                type: "TOOL_CALL_START",
                timestamp: nowMs(),
                runId: ctx.runId,
                toolCallId: block.id,
                toolCallName: toolName,
                parentMessageId: messageId,
              };
              yield {
                type: "TOOL_CALL_ARGS",
                timestamp: nowMs(),
                runId: ctx.runId,
                toolCallId: block.id,
                delta: JSON.stringify(block.input ?? {}),
              };
              yield { type: "TOOL_CALL_END", timestamp: nowMs(), runId: ctx.runId, toolCallId: block.id };
              const spanId = (
                await addSpan(db, {
                  runId: ctx.runId,
                  name: `gen_ai.execute_tool ${toolName}`,
                  kind: "tool",
                  attrs: {
                    "gen_ai.operation.name": "execute_tool",
                    "gen_ai.tool.name": toolName,
                    "gen_ai.tool.call.id": block.id,
                  },
                })
              ).id;
              openToolCalls.set(block.id, { name: toolName, spanId });
            }
          }
          continue;
        }
        if (message.type === "user") {
          const blocks = Array.isArray(message.message?.content) ? message.message.content : [];
          for (const block of blocks) {
            if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
              const info = openToolCalls.get(block.tool_use_id);
              if (info?.spanId) {
                await endSpan(db, info.spanId, { status: block.is_error ? "error" : "ok" });
              }
              openToolCalls.delete(block.tool_use_id);
              yield {
                type: "TOOL_CALL_RESULT",
                timestamp: nowMs(),
                runId: ctx.runId,
                toolCallId: block.tool_use_id,
                content: blockText(block.content),
                ...(block.is_error ? { isError: true } : {}),
              };
            }
          }
          continue;
        }
        if (message.type === "result") {
          sawResult = true;
          sessionId = message.session_id ?? sessionId;
          usage = {
            tokensIn: message.usage?.input_tokens ?? null,
            tokensOut: message.usage?.output_tokens ?? null,
            tokensCacheRead: message.usage?.cache_read_input_tokens ?? null,
            tokensCacheWrite: message.usage?.cache_creation_input_tokens ?? null,
          };
          costUsd = typeof message.total_cost_usd === "number" ? message.total_cost_usd : null;
          resultIsError = message.is_error === true || (message.subtype !== undefined && message.subtype !== "success");
          if (resultIsError) resultErrorDetail = message.subtype ?? "error";
          continue;
        }
        // Otros tipos de mensaje del SDK (status, hooks, partials, ...) se ignoran.
      }
    } catch (err) {
      if (abortController.signal.aborted) {
        // Cancelación limpia: abort → el SDK mata el proceso hijo.
      } else {
        streamError = err;
      }
    } finally {
      this.active.delete(ctx.runId);
    }

    const cancelled = abortController.signal.aborted;

    // Cierre de tool-calls huérfanos (NO_ANSWER_CAME) para el turno siguiente.
    for (const [toolCallId, info] of openToolCalls) {
      if (info.spanId) await endSpan(db, info.spanId, { status: "cancelled" });
      yield {
        type: "TOOL_CALL_RESULT",
        timestamp: nowMs(),
        runId: ctx.runId,
        toolCallId,
        content: NO_ANSWER_CAME,
        synthetic: true,
      };
    }
    openToolCalls.clear();

    if (sessionSpanId) {
      await endSpan(db, sessionSpanId, {
        status: cancelled ? "cancelled" : streamError || resultIsError ? "error" : "ok",
        attrs: {
          "session.id": sessionId ?? null,
          "gen_ai.usage.input_tokens": usage.tokensIn,
          "gen_ai.usage.output_tokens": usage.tokensOut,
        },
      });
    }

    if (cancelled) {
      await finishRunRow(db, ctx.runId, { status: "cancelled", usage, costUsd, error: "cancelled" });
      yield {
        type: "RUN_ERROR",
        timestamp: nowMs(),
        runId: ctx.runId,
        code: "cancelled",
        message: "Run cancelado (proceso hijo abortado)",
      };
      return;
    }
    if (streamError !== undefined) {
      const message = streamError instanceof Error ? streamError.message : String(streamError);
      await finishRunRow(db, ctx.runId, { status: "failed", usage, costUsd, error: message });
      yield { type: "RUN_ERROR", timestamp: nowMs(), runId: ctx.runId, code: "provider_error", message };
      return;
    }
    if (!sawResult || resultIsError) {
      const message = resultErrorDetail ?? "el CLI terminó sin mensaje result";
      await finishRunRow(db, ctx.runId, { status: "failed", usage, costUsd, error: message });
      yield { type: "RUN_ERROR", timestamp: nowMs(), runId: ctx.runId, code: "provider_error", message };
      return;
    }

    await finishRunRow(db, ctx.runId, { status: "succeeded", usage, costUsd });
    yield {
      type: "RUN_FINISHED",
      timestamp: nowMs(),
      runId: ctx.runId,
      usage: {
        tokensIn: usage.tokensIn,
        tokensOut: usage.tokensOut,
        tokensCacheRead: usage.tokensCacheRead,
        tokensCacheWrite: usage.tokensCacheWrite,
      },
      costUsd,
      ...(sessionId ? { sessionId } : {}),
    };
  }
}
