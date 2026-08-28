import { nowMs, type AgentRuntime } from "@agentos/shared";
import {
  createRun,
  getRun,
  updateRun,
  type AgentosDb,
  type Run,
} from "@agentos/db";
import type { TokenUsage } from "@agentos/providers";
import type { RunInput, RunTraceContext } from "./types.js";

/**
 * Garantiza la fila `runs` de un run en curso (ARCHITECTURE §10).
 * - Si el RunnerPool ya la creó (status 'queued'), la pasa a 'running'.
 * - Si el runner corre standalone, la crea directamente en 'running'.
 */
export function ensureRunningRun(
  db: AgentosDb,
  input: RunInput,
  ctx: RunTraceContext,
  runtime: AgentRuntime,
): Run {
  const existing = getRun(db, ctx.runId);
  const startedAt = nowMs();
  if (existing) {
    return updateRun(db, ctx.runId, { status: "running", startedAt });
  }
  return createRun(db, {
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
    status: "running",
    startedAt,
  });
}

export interface RunOutcome {
  status: "succeeded" | "failed" | "cancelled" | "interrupted";
  usage: TokenUsage;
  costUsd: number | null;
  error?: string;
}

/** Cierra la fila `runs` con el resultado final (tokens/coste null-explicitos). */
export function finishRunRow(db: AgentosDb, runId: string, outcome: RunOutcome): Run {
  return updateRun(db, runId, {
    status: outcome.status,
    tokensIn: outcome.usage.tokensIn,
    tokensOut: outcome.usage.tokensOut,
    tokensCacheRead: outcome.usage.tokensCacheRead,
    tokensCacheWrite: outcome.usage.tokensCacheWrite,
    costUsd: outcome.costUsd,
    error: outcome.error ?? null,
    finishedAt: nowMs(),
  });
}
