/**
 * Tipos de dominio tal como los sirve apps/api (filas Drizzle en camelCase).
 * La UI NO importa de packages/* (habla solo con la API): estos tipos espejan
 * el contrato REST/WS observado en apps/api.
 */

export type Stage = "ENTENDER" | "CONSTRUIR" | "OPERAR";
export type TaskStatus =
  | "BACKLOG"
  | "READY"
  | "IN_PROGRESS"
  | "BLOCKED"
  | "REVIEW"
  | "DONE"
  | "CANCELLED";
export type TaskPriority = "low" | "normal" | "high" | "urgent";
export type BlockedReason = "approval" | "stuck" | "manual" | "dependency";
export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted";
export type AgentStatus = "active" | "paused" | "disabled";
export type AgentLayer = "consultoria" | "implementacion" | "operacion" | "meta";
export type KnowledgeKind =
  | "org_profile"
  | "process_map"
  | "interview"
  | "finding"
  | "decision"
  | "iso_clause"
  | "evidence"
  | "template"
  | "note";

export const TASK_STATUSES: TaskStatus[] = [
  "BACKLOG",
  "READY",
  "IN_PROGRESS",
  "BLOCKED",
  "REVIEW",
  "DONE",
  "CANCELLED",
];
export const STAGES: Stage[] = ["ENTENDER", "CONSTRUIR", "OPERAR"];

export interface Person {
  id: string;
  full_name: string;
  role: string | null;
}

export interface Project {
  id: string;
  orgId: string;
  name: string;
  type: "assessment" | "transform" | "ops";
  stage: Stage;
  gateState: "pending" | "approved" | "rejected";
  workspacePath: string | null;
  version: number;
  createdAt: number;
  updatedAt: number;
}

export interface Task {
  id: string;
  projectId: string;
  parentTaskId: string | null;
  title: string;
  description: string | null;
  definitionOfDone: string | null;
  stage: Stage;
  status: TaskStatus;
  activityType: string | null;
  priority: TaskPriority;
  assigneeAgentId: string | null;
  assigneePersonId: string | null;
  requiresApproval: boolean;
  externalEffect: boolean;
  leaseUntil: number | null;
  attempts: number;
  blockedReason: BlockedReason | null;
  orderKey: string;
  version: number;
  createdAt: number;
  updatedAt: number;
}

export interface TaskEvent {
  id: string;
  taskId: string;
  runId: string | null;
  kind: string;
  fromStatus: TaskStatus | null;
  toStatus: TaskStatus | null;
  actor: string;
  payload: Record<string, unknown> | null;
  createdAt: number;
}

export interface Artifact {
  id: string;
  taskId: string;
  runId: string | null;
  kind: string;
  title: string;
  content: string | null;
  path: string | null;
  meta: Record<string, unknown> | null;
  createdBy: string | null;
  createdAt: number;
}

export interface Agent {
  id: string;
  slug: string;
  name: string;
  layer: AgentLayer;
  runtime: "claude_code" | "ai_sdk";
  providerProfileId: string | null;
  model: string | null;
  activePromptVersionId: string | null;
  toolsAllowlist: string[];
  mcpAllowlist: string[];
  limits: Record<string, unknown> | null;
  autonomy: "manual" | "supervised" | "auto";
  status: AgentStatus;
  version: number;
}

export interface Run {
  id: string;
  parentRunId: string | null;
  rootRunId: string;
  agentId: string | null;
  taskId: string | null;
  projectId: string | null;
  trigger: string;
  runtime: string;
  providerProfileId: string | null;
  model: string | null;
  status: RunStatus;
  tokensIn: number | null;
  tokensOut: number | null;
  tokensCacheRead: number | null;
  tokensCacheWrite: number | null;
  costUsd: number | null;
  error: string | null;
  resumeOfRunId: string | null;
  replayOfRunId: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  createdAt: number;
}

export interface Span {
  id: string;
  runId: string;
  parentSpanId: string | null;
  name: string;
  kind: "llm" | "tool" | "subrun" | "internal";
  attrs: Record<string, unknown> | null;
  status: string | null;
  startedAt: number;
  endedAt: number | null;
}

export interface Approval {
  id: string;
  kind: "tool_call" | "deliverable" | "gate";
  runId: string | null;
  taskId: string | null;
  projectId: string | null;
  payload: Record<string, unknown>;
  actionDigest: string;
  status: "pending" | "approved" | "rejected";
  requestedBy: string | null;
  decidedByPersonId: string | null;
  decidedAt: number | null;
  note: string | null;
  createdAt: number;
}

export interface Thread {
  id: string;
  channel: string;
  sessionKey: string;
  projectId: string | null;
  agentId: string | null;
  title: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface Message {
  id: string;
  threadId: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  idempotencyKey: string | null;
  runId: string | null;
  actor: string | null;
  meta: Record<string, unknown> | null;
  createdAt: number;
}

export interface KnowledgeDoc {
  id: string;
  orgId: string | null;
  projectId: string | null;
  kind: KnowledgeKind;
  title: string;
  bodyMd: string;
  sourceRefs: Record<string, unknown>[] | null;
  tags: string[] | null;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
}

// ── Fuentes del proyecto (Fase 2) ───────────────────────────────────────────

export type ProjectSourceKind = "meeting" | "whatsapp_thread";
export type ProjectSourceStatus = "linked" | "ingested" | "error";

export interface ProjectSourceExternalRef {
  system: "whatsapphub";
  meetingId?: string;
  contactId?: string;
  title: string;
  url?: string;
}

export interface ProjectSource {
  id: string;
  projectId: string;
  kind: ProjectSourceKind;
  externalRef: ProjectSourceExternalRef;
  status: ProjectSourceStatus;
  knowledgeDocId: string | null;
  lastError: string | null;
  lastIngestedAt: number | null;
  createdBy: string | null;
  createdAt: number;
}

/** Item normalizado de GET /api/sources/browse (picker). */
export interface SourceBrowseItem {
  id: string;
  title: string;
  subtitle: string | null;
  url: string | null;
  is_internal: boolean | null;
}

export interface ProcessStep {
  step: string;
  responsible?: string;
  system?: string;
  input?: string;
  output?: string;
}

export interface ProcessEntity {
  id: string;
  orgId: string;
  name: string;
  ownerPerson: string | null;
  variant: "as_is" | "to_be";
  steps: ProcessStep[] | null;
  systems: string[] | null;
  painPoints: string[] | null;
  isoRefs: string[] | null;
  sourceDocIds: string[] | null;
  status: "draft" | "validated";
  createdAt: number;
  updatedAt: number;
}

export interface Methodology {
  id: string;
  slug: string;
  version: number;
  bodyMd: string;
  changelog: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface AppConfigRow {
  key: string;
  value: unknown;
  updatedAt: number;
}

/** Evento tal como llega por el WS: sobre {topic, seq, event}. */
export interface TopicEvent {
  topic: string;
  seq: number;
  /** Tipo del evento (AG-UI o de dominio: task.moved, message.final, ...). */
  type: string;
  /** Payload persistido. Para eventos de dominio trae {type, timestamp, payload}. */
  payload: Record<string, unknown>;
  runId: string | null;
  createdAt: number;
}

/** Extrae el payload de dominio (busSink envuelve en {type, timestamp, payload}). */
export function domainPayload(ev: TopicEvent): Record<string, unknown> {
  const inner = (ev.payload as { payload?: unknown }).payload;
  if (inner && typeof inner === "object") return inner as Record<string, unknown>;
  return ev.payload;
}
