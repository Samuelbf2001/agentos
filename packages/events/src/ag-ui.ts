import { z } from "zod";

/**
 * Vocabulario de eventos AG-UI (ARCHITECTURE §2) con Zod.
 * Nombres de tipo y campos siguen el protocolo AG-UI (camelCase en payload).
 * `timestamp` es epoch ms (convención del repo) y siempre lo pone el emisor.
 */

// ── Tipos de evento ─────────────────────────────────────────────────────────

export const AgUiEventType = z.enum([
  "RUN_STARTED",
  "TEXT_MESSAGE_START",
  "TEXT_MESSAGE_CONTENT",
  "TEXT_MESSAGE_END",
  "TOOL_CALL_START",
  "TOOL_CALL_ARGS",
  "TOOL_CALL_END",
  "TOOL_CALL_RESULT",
  "STATE_SNAPSHOT",
  "STATE_DELTA",
  "RUN_FINISHED",
  "RUN_ERROR",
]);
export type AgUiEventType = z.infer<typeof AgUiEventType>;

const base = {
  timestamp: z.number().int().nonnegative(),
  /** Trazabilidad: todo evento emitido por un runner lleva su runId. */
  runId: z.string().optional(),
};

export const RunStartedEvent = z.object({
  type: z.literal("RUN_STARTED"),
  ...base,
  runId: z.string(),
  threadId: z.string().optional(),
  agentId: z.string().nullish(),
  taskId: z.string().nullish(),
  projectId: z.string().nullish(),
  parentRunId: z.string().nullish(),
  rootRunId: z.string().optional(),
});
export type RunStartedEvent = z.infer<typeof RunStartedEvent>;

export const TextMessageStartEvent = z.object({
  type: z.literal("TEXT_MESSAGE_START"),
  ...base,
  messageId: z.string(),
  role: z.literal("assistant").default("assistant"),
});
export type TextMessageStartEvent = z.infer<typeof TextMessageStartEvent>;

export const TextMessageContentEvent = z.object({
  type: z.literal("TEXT_MESSAGE_CONTENT"),
  ...base,
  messageId: z.string(),
  delta: z.string(),
});
export type TextMessageContentEvent = z.infer<typeof TextMessageContentEvent>;

export const TextMessageEndEvent = z.object({
  type: z.literal("TEXT_MESSAGE_END"),
  ...base,
  messageId: z.string(),
});
export type TextMessageEndEvent = z.infer<typeof TextMessageEndEvent>;

export const ToolCallStartEvent = z.object({
  type: z.literal("TOOL_CALL_START"),
  ...base,
  toolCallId: z.string(),
  toolCallName: z.string(),
  parentMessageId: z.string().optional(),
});
export type ToolCallStartEvent = z.infer<typeof ToolCallStartEvent>;

export const ToolCallArgsEvent = z.object({
  type: z.literal("TOOL_CALL_ARGS"),
  ...base,
  toolCallId: z.string(),
  /** Delta del JSON de argumentos (streaming) o el JSON completo en un solo evento. */
  delta: z.string(),
});
export type ToolCallArgsEvent = z.infer<typeof ToolCallArgsEvent>;

export const ToolCallEndEvent = z.object({
  type: z.literal("TOOL_CALL_END"),
  ...base,
  toolCallId: z.string(),
});
export type ToolCallEndEvent = z.infer<typeof ToolCallEndEvent>;

export const ToolCallResultEvent = z.object({
  type: z.literal("TOOL_CALL_RESULT"),
  ...base,
  toolCallId: z.string(),
  messageId: z.string().optional(),
  content: z.string(),
  isError: z.boolean().optional(),
  /**
   * true cuando el resultado es el cierre sintético NO_ANSWER_CAME de un
   * tool-call huérfano (presupuesto/cancelación) — nunca salió del proveedor.
   */
  synthetic: z.boolean().optional(),
});
export type ToolCallResultEvent = z.infer<typeof ToolCallResultEvent>;

export const StateSnapshotEvent = z.object({
  type: z.literal("STATE_SNAPSHOT"),
  ...base,
  snapshot: z.unknown(),
});
export type StateSnapshotEvent = z.infer<typeof StateSnapshotEvent>;

/** Operación JSON Patch (RFC 6902) para STATE_DELTA. */
export const JsonPatchOp = z.object({
  op: z.enum(["add", "remove", "replace", "move", "copy", "test"]),
  path: z.string(),
  from: z.string().optional(),
  value: z.unknown().optional(),
});
export type JsonPatchOp = z.infer<typeof JsonPatchOp>;

export const StateDeltaEvent = z.object({
  type: z.literal("STATE_DELTA"),
  ...base,
  delta: z.array(JsonPatchOp),
});
export type StateDeltaEvent = z.infer<typeof StateDeltaEvent>;

export const RunFinishedEvent = z.object({
  type: z.literal("RUN_FINISHED"),
  ...base,
  runId: z.string(),
  /** null = el proveedor no lo reportó (nunca cero inferido). */
  usage: z
    .object({
      tokensIn: z.number().int().nullable(),
      tokensOut: z.number().int().nullable(),
      tokensCacheRead: z.number().int().nullable().optional(),
      tokensCacheWrite: z.number().int().nullable().optional(),
    })
    .optional(),
  costUsd: z.number().nullable().optional(),
  /** Continuidad claude_code: session id del CLI para `resume`. */
  sessionId: z.string().optional(),
  result: z.unknown().optional(),
});
export type RunFinishedEvent = z.infer<typeof RunFinishedEvent>;

export const RunErrorEvent = z.object({
  type: z.literal("RUN_ERROR"),
  ...base,
  runId: z.string().optional(),
  message: z.string(),
  /** Código estable (`budget_exceeded`, `cancelled`, `provider_error`, ...). */
  code: z.string().optional(),
});
export type RunErrorEvent = z.infer<typeof RunErrorEvent>;

export const AgUiEvent = z.discriminatedUnion("type", [
  RunStartedEvent,
  TextMessageStartEvent,
  TextMessageContentEvent,
  TextMessageEndEvent,
  ToolCallStartEvent,
  ToolCallArgsEvent,
  ToolCallEndEvent,
  ToolCallResultEvent,
  StateSnapshotEvent,
  StateDeltaEvent,
  RunFinishedEvent,
  RunErrorEvent,
]);
export type AgUiEvent = z.infer<typeof AgUiEvent>;

// ── Eventos de plataforma (extra a AG-UI: cola visible del RunnerPool) ──────

export const RunQueuedEvent = z.object({
  type: z.literal("RUN_QUEUED"),
  ...base,
  runId: z.string(),
  runtime: z.string(),
  position: z.number().int().nonnegative(),
});
export type RunQueuedEvent = z.infer<typeof RunQueuedEvent>;

export const RunDequeuedEvent = z.object({
  type: z.literal("RUN_DEQUEUED"),
  ...base,
  runId: z.string(),
  runtime: z.string(),
});
export type RunDequeuedEvent = z.infer<typeof RunDequeuedEvent>;

export const RunCancelledEvent = z.object({
  type: z.literal("RUN_CANCELLED"),
  ...base,
  runId: z.string(),
  reason: z.string().optional(),
});
export type RunCancelledEvent = z.infer<typeof RunCancelledEvent>;

export const PlatformEvent = z.discriminatedUnion("type", [
  RunQueuedEvent,
  RunDequeuedEvent,
  RunCancelledEvent,
]);
export type PlatformEvent = z.infer<typeof PlatformEvent>;

/** Cualquier evento publicable en el bus. */
export const BusPayload = z.union([AgUiEvent, PlatformEvent]);
export type BusPayload = z.infer<typeof BusPayload>;
