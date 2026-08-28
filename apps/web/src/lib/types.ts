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

// ── Módulos de Fase (M4 — wizard "Nuevo proyecto") ──────────────────────────
// Espejo del contrato REST de apps/api/src/routes/modules.ts (snake_case en
// los recibos; camelCase en el plan del preview, tal cual lo sirve la API).

export type ModuleInputType =
  | "text"
  | "textarea"
  | "number"
  | "date"
  | "multi_select"
  | "list_text"
  | "source_refs";

export interface ModuleInputDef {
  key: string;
  label: string;
  type: ModuleInputType;
  required?: boolean;
  min?: number;
  min_items?: number;
  max_items?: number;
  max_len?: number;
  options?: string[];
  default_from?: string;
  sensitive?: boolean;
}

export interface ModuleToggleDef {
  key: string;
  label: string;
  default?: boolean;
  enables_templates?: string[];
  enables_deliverables?: string[];
  methodology_add?: string;
}

export interface ModuleSummary {
  slug: string;
  version: number;
  name: string;
  phase: Stage;
  project_type: string;
  status: string;
  methodology: { slug: string; version: number | null };
  templates_count: number;
  blueprint_hash: string;
}

export interface ModuleDetail extends ModuleSummary {
  inputs: ModuleInputDef[];
  toggles: ModuleToggleDef[];
  budget: { phase_usd: number; per_run_usd: number; warning_thresholds_pct?: number[] };
  project: { name_tpl: string; workspace_tpl: string };
  body_md: string;
}

export interface PreviewIssue {
  code: string;
  path: string;
  details?: Record<string, unknown>;
}

export interface PreviewTask {
  key: string;
  templateKey: string;
  fanOutValue: string | null;
  title: string;
  description: string | null;
  definitionOfDone: string | null;
  stage: string;
  activityType: string;
  priority: string;
  role: string;
  assigneeAgentSlug: string;
  assigneeAgentId: string;
  dependsOn: string[];
  produces: string[];
  gate: string | null;
  requiresApproval: boolean;
  status: "READY" | "BACKLOG";
  dueAt: number | null;
}

/** Propuesta de cadencia para el wizard (CA-M3.4, consent-first — M6a). */
export interface CadenceProposal {
  key: string;
  title: string;
  description: string | null;
  activityType: string;
  role: string;
  /** Días entre instancias; null = sin periodo declarado (inconfirmable). */
  periodDays: number | null;
}

export interface PreviewPlan {
  projectName: string;
  workspacePath: string;
  tasks: PreviewTask[];
  gates: {
    name: string;
    when: "phase_close" | "deliverable";
    fedBy: string[];
    blocksNextStage: Stage | null;
  }[];
  deliverables: {
    kind: string;
    source: "knowledge_doc" | "process" | "artifact";
    min: number;
    producedBy: string | null;
  }[];
  methodology: { slug: string; version: number | null; adds: string[] };
  budget: { phaseUsd: number; perRunUsd: number; warningThresholdsPct: number[] };
  toggles: Record<string, boolean>;
  /** Plantillas de cadencia EXCLUIDAS del plan (activas pero no confirmadas, M6). */
  cadenceExcluded: string[];
  /** Claves cadence CONFIRMADAS por el humano que SÍ entraron al plan (M6a). */
  cadencesConfirmed: string[];
  /** Todas las plantillas cadence activas, para los checkboxes del resumen (M6a). */
  cadenceProposals: CadenceProposal[];
}

/** Respuesta de POST /api/modules/:slug/preview — {ok:false} NO es error HTTP. */
export interface PreviewResult {
  ok: boolean;
  module: {
    id: string;
    slug: string;
    version: number;
    name: string;
    phase: string;
    projectType: string;
    status: string;
  };
  missing: string[];
  issues: PreviewIssue[];
  plan: PreviewPlan | null;
}

/** Recibo de un launch (GET /api/projects/:id/launches — CA-M2.4). */
export interface LaunchReceipt {
  id: string;
  module_slug: string;
  module_version: number;
  module_name: string;
  phase: Stage;
  org_id: string;
  project_id: string;
  /** Inputs literales YA redactados en el servidor (§13.1). */
  inputs: Record<string, unknown>;
  toggles: Record<string, boolean>;
  task_count: number;
  budget_phase_usd: number;
  budget_per_run_usd: number;
  previous_launch_id: string | null;
  actor: string;
  actor_name: string | null;
  label: string;
  created_at: number;
}

/** Respuesta de POST /api/modules/:slug/launch. */
export interface LaunchResponse {
  launch: { id: string; projectId: string } & Record<string, unknown>;
  project: Project;
  organization: { id: string; name: string } & Record<string, unknown>;
  tasks_count: number;
  idempotent: boolean;
}

/** GET /api/projects/:id/phase-status (CA-M3.1). */
export interface PhaseClosureItem {
  kind: string;
  source: "knowledge_doc" | "process" | "artifact";
  required: number;
  found: number;
  /** Texto legible es-ES; null cuando el mínimo está cubierto. */
  missing: string | null;
}

export interface PhaseClosureStatus {
  launchId: string | null;
  complete: boolean;
  items: PhaseClosureItem[];
  reason?: "no_launch";
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
