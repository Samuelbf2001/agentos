import { stepCountIs, streamText, type LanguageModel } from "ai";
import { ErrorCodes, nowMs } from "@agentos/shared";
import { addSpan, endSpan, type AgentosDb } from "@agentos/db";
import {
  EMPTY_USAGE,
  ProviderRegistry,
  addUsage,
  classifyProviderError,
  computeCostUsd,
  normalizeUsage,
  type TokenUsage,
} from "@agentos/providers";
import type { AgUiEvent } from "@agentos/events";
import { ensureRunningRun, finishRunRow } from "./observability.js";
import {
  NO_ANSWER_CAME,
  type AgentRunner,
  type RunInput,
  type RunTraceContext,
  type RunnerDeps,
} from "./types.js";

/** Pasos máximos del loop si el presupuesto no dice otra cosa. */
export const DEFAULT_MAX_STEPS = 8;

interface ActiveRun {
  abortController: AbortController;
  cancelled: boolean;
}

interface OpenToolCall {
  name: string;
  argsStreamed: boolean;
  started: boolean;
  spanId?: string;
}

export interface AiSdkRunnerOptions extends RunnerDeps {
  registry?: ProviderRegistry;
  /** Inyectable para tests: resuelve el LanguageModel (default: registry por perfil). */
  resolveModel?: (input: RunInput, modelId: string) => LanguageModel;
}

function toText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "AbortError" || err.name === "TimeoutError" || err.message.toLowerCase().includes("abort"))
  );
}

/**
 * Runner in-process sobre Vercel AI SDK (ARCHITECTURE §3):
 * loop propio con `streamText` + `stopWhen: stepCountIs(n)` + tools; emite
 * eventos AG-UI; escribe runs y spans (atributos estilo OTel GenAI); respeta
 * presupuesto con corte duro `budget_exceeded`; cierra tool-calls huérfanos
 * con NO_ANSWER_CAME para no romper el turno siguiente.
 */
export class AiSdkRunner implements AgentRunner {
  readonly runtime = "ai_sdk" as const;

  private readonly db: AgentosDb;
  private readonly registry: ProviderRegistry;
  private readonly resolveModel: (input: RunInput, modelId: string) => LanguageModel;
  private readonly active = new Map<string, ActiveRun>();

  constructor(options: AiSdkRunnerOptions) {
    this.db = options.db;
    this.registry = options.registry ?? new ProviderRegistry();
    this.resolveModel =
      options.resolveModel ?? ((input, modelId) => this.registry.getModel(input.provider, modelId));
  }

  async cancel(runId: string): Promise<void> {
    const state = this.active.get(runId);
    if (!state) return;
    state.cancelled = true;
    state.abortController.abort();
  }

  async *run(input: RunInput, ctx: RunTraceContext): AsyncIterable<AgUiEvent> {
    const db = this.db;
    const modelId = input.model ?? input.agent.model ?? "";
    const model = this.resolveModel(input, modelId);
    const providerName = input.provider.slug;

    await ensureRunningRun(db, input, ctx, this.runtime);

    const state: ActiveRun = { abortController: new AbortController(), cancelled: false };
    this.active.set(ctx.runId, state);

    const budget = input.budget ?? {};
    let budgetExceeded = false;
    let total: TokenUsage = { ...EMPTY_USAGE };
    let streamError: unknown;
    let currentLlmSpanId: string | undefined;
    const openToolCalls = new Map<string, OpenToolCall>();

    let timer: ReturnType<typeof setTimeout> | undefined;
    if (budget.maxMs !== undefined && budget.maxMs > 0) {
      timer = setTimeout(() => {
        budgetExceeded = true;
        state.abortController.abort();
      }, budget.maxMs);
    }

    const checkBudget = () => {
      if (budgetExceeded) return;
      if (budget.maxTokens !== undefined) {
        const used = (total.tokensIn ?? 0) + (total.tokensOut ?? 0);
        if (used > budget.maxTokens) {
          budgetExceeded = true;
        }
      }
      if (!budgetExceeded && budget.maxUsd !== undefined) {
        const cost = computeCostUsd(total, input.provider);
        if (cost !== null && cost > budget.maxUsd) {
          budgetExceeded = true;
        }
      }
      if (budgetExceeded) state.abortController.abort();
    };

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

    try {
      const result = streamText({
        model,
        ...(input.systemPrompt ? { system: input.systemPrompt } : {}),
        messages: input.messages,
        ...(input.tools ? { tools: input.tools } : {}),
        stopWhen: stepCountIs(budget.maxSteps ?? DEFAULT_MAX_STEPS),
        abortSignal: state.abortController.signal,
        // Los errores también llegan como parte 'error' del fullStream;
        // el callback evita unhandled rejections del lado del SDK.
        onError: () => {},
      });

      for await (const part of result.fullStream) {
        switch (part.type) {
          case "start-step": {
            currentLlmSpanId = (
              await addSpan(db, {
                runId: ctx.runId,
                name: "gen_ai.chat",
                kind: "llm",
                attrs: {
                  "gen_ai.operation.name": "chat",
                  "gen_ai.system": providerName,
                  "gen_ai.request.model": modelId,
                },
              })
            ).id;
            break;
          }
          case "finish-step": {
            const stepUsage = normalizeUsage(part.usage);
            total = addUsage(total, stepUsage);
            if (currentLlmSpanId) {
              await endSpan(db, currentLlmSpanId, {
                status: "ok",
                attrs: {
                  "gen_ai.operation.name": "chat",
                  "gen_ai.system": providerName,
                  "gen_ai.request.model": modelId,
                  "gen_ai.usage.input_tokens": stepUsage.tokensIn,
                  "gen_ai.usage.output_tokens": stepUsage.tokensOut,
                  "gen_ai.response.finish_reasons": [part.finishReason],
                },
              });
              currentLlmSpanId = undefined;
            }
            checkBudget();
            break;
          }
          case "text-start": {
            yield { type: "TEXT_MESSAGE_START", timestamp: nowMs(), runId: ctx.runId, messageId: part.id, role: "assistant" };
            break;
          }
          case "text-delta": {
            yield { type: "TEXT_MESSAGE_CONTENT", timestamp: nowMs(), runId: ctx.runId, messageId: part.id, delta: part.text };
            break;
          }
          case "text-end": {
            yield { type: "TEXT_MESSAGE_END", timestamp: nowMs(), runId: ctx.runId, messageId: part.id };
            break;
          }
          case "tool-input-start": {
            openToolCalls.set(part.id, { name: part.toolName, argsStreamed: false, started: true });
            yield {
              type: "TOOL_CALL_START",
              timestamp: nowMs(),
              runId: ctx.runId,
              toolCallId: part.id,
              toolCallName: part.toolName,
            };
            break;
          }
          case "tool-input-delta": {
            const info = openToolCalls.get(part.id);
            if (info) info.argsStreamed = true;
            yield { type: "TOOL_CALL_ARGS", timestamp: nowMs(), runId: ctx.runId, toolCallId: part.id, delta: part.delta };
            break;
          }
          case "tool-call": {
            let info = openToolCalls.get(part.toolCallId);
            if (!info) {
              info = { name: part.toolName, argsStreamed: false, started: false };
              openToolCalls.set(part.toolCallId, info);
            }
            if (!info.started) {
              info.started = true;
              yield {
                type: "TOOL_CALL_START",
                timestamp: nowMs(),
                runId: ctx.runId,
                toolCallId: part.toolCallId,
                toolCallName: part.toolName,
              };
            }
            if (!info.argsStreamed) {
              yield {
                type: "TOOL_CALL_ARGS",
                timestamp: nowMs(),
                runId: ctx.runId,
                toolCallId: part.toolCallId,
                delta: toText(part.input),
              };
            }
            yield { type: "TOOL_CALL_END", timestamp: nowMs(), runId: ctx.runId, toolCallId: part.toolCallId };
            info.spanId = (
              await addSpan(db, {
                runId: ctx.runId,
                name: `gen_ai.execute_tool ${part.toolName}`,
                kind: "tool",
                attrs: {
                  "gen_ai.operation.name": "execute_tool",
                  "gen_ai.tool.name": part.toolName,
                  "gen_ai.tool.call.id": part.toolCallId,
                },
              })
            ).id;
            break;
          }
          case "tool-result": {
            const info = openToolCalls.get(part.toolCallId);
            if (info?.spanId) await endSpan(db, info.spanId, { status: "ok" });
            openToolCalls.delete(part.toolCallId);
            yield {
              type: "TOOL_CALL_RESULT",
              timestamp: nowMs(),
              runId: ctx.runId,
              toolCallId: part.toolCallId,
              content: toText(part.output),
            };
            break;
          }
          case "tool-error": {
            const info = openToolCalls.get(part.toolCallId);
            if (info?.spanId) await endSpan(db, info.spanId, { status: "error" });
            openToolCalls.delete(part.toolCallId);
            yield {
              type: "TOOL_CALL_RESULT",
              timestamp: nowMs(),
              runId: ctx.runId,
              toolCallId: part.toolCallId,
              content: toText(part.error),
              isError: true,
            };
            break;
          }
          case "finish": {
            const t = normalizeUsage(part.totalUsage);
            total = {
              tokensIn: t.tokensIn ?? total.tokensIn,
              tokensOut: t.tokensOut ?? total.tokensOut,
              tokensCacheRead: t.tokensCacheRead ?? total.tokensCacheRead,
              tokensCacheWrite: t.tokensCacheWrite ?? total.tokensCacheWrite,
            };
            checkBudget();
            break;
          }
          case "error": {
            streamError = part.error;
            break;
          }
          case "abort":
          default:
            break;
        }
      }
    } catch (err) {
      streamError = err;
    } finally {
      if (timer) clearTimeout(timer);
      this.active.delete(ctx.runId);
    }

    // Span LLM colgado por corte/cancelación.
    if (currentLlmSpanId) {
      await endSpan(db, currentLlmSpanId, { status: "cancelled" });
      currentLlmSpanId = undefined;
    }

    // Cierre de tool-calls huérfanos: el turno siguiente necesita UN resultado
    // por cada tool_use o el proveedor rechaza la conversación.
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

    const costUsd = computeCostUsd(total, input.provider);
    const abortish = streamError !== undefined && isAbortError(streamError);

    if (state.cancelled) {
      await finishRunRow(db, ctx.runId, { status: "cancelled", usage: total, costUsd, error: "cancelled" });
      yield {
        type: "RUN_ERROR",
        timestamp: nowMs(),
        runId: ctx.runId,
        code: "cancelled",
        message: "Run cancelado",
      };
      return;
    }
    if (budgetExceeded) {
      await finishRunRow(db, ctx.runId, {
        status: "failed",
        usage: total,
        costUsd,
        error: ErrorCodes.BUDGET_EXCEEDED,
      });
      yield {
        type: "RUN_ERROR",
        timestamp: nowMs(),
        runId: ctx.runId,
        code: ErrorCodes.BUDGET_EXCEEDED,
        message: "Presupuesto del run excedido: corte duro",
      };
      return;
    }
    if (streamError !== undefined && !abortish) {
      const kind = classifyProviderError(streamError);
      const message = streamError instanceof Error ? streamError.message : String(streamError);
      await finishRunRow(db, ctx.runId, { status: "failed", usage: total, costUsd, error: `${kind}: ${message}` });
      yield {
        type: "RUN_ERROR",
        timestamp: nowMs(),
        runId: ctx.runId,
        code: ErrorCodes.PROVIDER_ERROR,
        message: `${kind}: ${message}`,
      };
      return;
    }

    await finishRunRow(db, ctx.runId, { status: "succeeded", usage: total, costUsd });
    yield {
      type: "RUN_FINISHED",
      timestamp: nowMs(),
      runId: ctx.runId,
      usage: {
        tokensIn: total.tokensIn,
        tokensOut: total.tokensOut,
        tokensCacheRead: total.tokensCacheRead,
        tokensCacheWrite: total.tokensCacheWrite,
      },
      costUsd,
    };
  }
}
