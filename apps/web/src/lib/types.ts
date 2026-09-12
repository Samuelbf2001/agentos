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
  | "REVIEW"
  | "BLOCKED"
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
  "REVIEW",
  "BLOCKED",
  "DONE",
  "CANCELLED",
];

/** Estados de los que ya no se sale (espeja TERMINAL en packages/core/src/board/state-machine.ts). */
const TERMINAL_STATUSES: readonly TaskStatus[] = ["DONE", "CANCELLED"];

export function isTerminalStatus(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/**
 * Destinos válidos para el actor humano por estado de origen. Espeja
 * `MATRIX.human` + la regla "cualquiera no-terminal → CANCELLED sólo humano"
 * de packages/core/src/board/state-machine.ts (isTransitionAllowed). apps/web
 * no depende de @agentos/*, así que esto se mantiene a mano en paralelo.
 */
export const HUMAN_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  BACKLOG: ["READY", "CANCELLED"],
  READY: ["BACKLOG", "IN_PROGRESS", "CANCELLED"],
  IN_PROGRESS: ["BLOCKED", "REVIEW", "DONE", "CANCELLED"],
  BLOCKED: ["READY", "CANCELLED"],
  REVIEW: ["DONE", "IN_PROGRESS", "CANCELLED"],
  DONE: [],
  CANCELLED: [],
};
export const STAGES: Stage[] = ["ENTENDER", "CONSTRUIR", "OPERAR"];

export interface Person {
  id: string;
  full_name: string;
  /** Alias camelCase usado por algunas respuestas enriquecidas del API. */
  fullName?: string;
  role: string | null;
  /** Campos opcionales que pueden venir en el roster administrativo. */
  org_id?: string | null;
  email?: string | null;
}

/** Responsable humano de una tarea (tabla canónica task_assignees). */
export interface TaskAssigneePerson {
  id: string;
  full_name?: string;
  fullName?: string;
  role?: string | null;
  email?: string | null;
}

export interface TaskAssignee {
  /** Forma normalizada usada por la UI. */
  personId?: string;
  isPrimary?: boolean;
  assignedBy?: string | null;
  createdAt?: number;
  /** Alias del wire REST si el proveedor devuelve snake_case. */
  person_id?: string;
  is_primary?: boolean;
  assigned_by?: string | null;
  created_at?: number;
  /** Algunas respuestas incluyen el roster embebido para evitar otra consulta. */
  person?: TaskAssigneePerson | null;
}

export interface Project {
  id: string;
  orgId: string;
  /** Nombre real del cliente (tabla orgs), cuando la API lo enriquece. */
  orgName?: string | null;
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
  /** Lista autoritativa de personas; el campo singular es solo proyección. */
  assignees?: TaskAssignee[];
  /** Fecha epoch-ms; null significa sin vencimiento. */
  dueAt?: number | null;
  /** Alias de entrada/compatibilidad para respuestas snake_case. */
  due_at?: number | null;
  /** Etiquetas normalizadas de la tarjeta (tabla puente `task_labels`). */
  labels?: string[];
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

export type BoardFilter = "all" | "mine" | "unassigned" | "due";

/** Etiquetas de una tarjeta, tolerando que aún no se hayan cargado. */
export function getTaskLabels(task: Pick<Task, "labels">): string[] {
  return task.labels ?? [];
}

export interface LabelUsage {
  label: string;
  count: number;
}

/** Resultado de `GET /api/tasks/search`: lo mínimo para abrir la ficha. */
export interface TaskSearchHit {
  id: string;
  projectId: string;
  title: string;
  status: TaskStatus;
  stage: Stage;
  dueAt: number | null;
  snippet: string;
  /** `comment` = el match está en un comentario, no en la ficha. */
  source: "task" | "comment";
  rank: number;
  project_name?: string | null;
  labels?: string[];
}

/** Agrupación de "Mis tareas" por urgencia; el orden es el de esta lista. */
export type DueBucket = "overdue" | "today" | "week" | "later" | "none";

export const DUE_BUCKETS: DueBucket[] = ["overdue", "today", "week", "later", "none"];

export const DUE_BUCKET_LABELS: Record<DueBucket, string> = {
  overdue: "Vencidas",
  today: "Hoy",
  week: "Esta semana",
  later: "Después",
  none: "Sin fecha",
};

export type TaskDueState = "none" | "overdue" | "today" | "upcoming" | "later" | "complete";

/** Devuelve la lista canónica y conserva compatibilidad con la proyección antigua. */
export function getTaskAssignees(task: Pick<Task, "assignees" | "assigneePersonId">): TaskAssignee[] {
  if (task.assignees && task.assignees.length > 0) return task.assignees;
  return task.assigneePersonId
    ? [{ personId: task.assigneePersonId, isPrimary: true }]
    : [];
}

export function taskAssigneePersonId(assignee: TaskAssignee): string | null {
  return assignee.personId ?? assignee.person_id ?? assignee.person?.id ?? null;
}

export function taskAssigneeIsPrimary(assignee: TaskAssignee): boolean {
  return assignee.isPrimary ?? assignee.is_primary ?? false;
}

export function taskDueTimestamp(task: Pick<Task, "dueAt" | "due_at">): number | null {
  return task.dueAt ?? task.due_at ?? null;
}

/** Clasificación visual estable; tareas terminales no generan alerta de vencimiento. */
export function taskDueState(
  task: Pick<Task, "status" | "dueAt" | "due_at">,
  now = Date.now(),
): TaskDueState {
  const dueAt = taskDueTimestamp(task);
  if (task.status === "DONE" || task.status === "CANCELLED") return dueAt === null ? "none" : "complete";
  if (dueAt === null) return "none";
  if (dueAt < now) return "overdue";
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const sevenDays = now + 7 * 86_400_000;
  if (dueAt < startOfToday.getTime() + 86_400_000) return "today";
  if (dueAt <= sevenDays) return "upcoming";
  return "later";
}

/**
 * Agrupa por vencimiento con EXACTAMENTE los mismos cortes que
 * `taskDueState` (vencida < ahora; hoy = resto del día natural; esta semana =
 * 7 días). Duplicar los cortes haría que la píldora de la tarjeta y el grupo
 * de "Mis tareas" se contradijeran.
 */
export function dueBucket(task: Pick<Task, "dueAt" | "due_at">, now = Date.now()): DueBucket {
  const dueAt = taskDueTimestamp(task);
  if (dueAt === null) return "none";
  if (dueAt < now) return "overdue";
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  if (dueAt < startOfToday.getTime() + 86_400_000) return "today";
  if (dueAt <= now + 7 * 86_400_000) return "week";
  return "later";
}

export interface TaskProjectContext {
  project?: Project | null;
  sources?: ProjectSource[];
  documents?: KnowledgeDoc[];
  /** Aliases que pueden aparecer mientras se despliega la Oleada 2. */
  project_sources?: ProjectSource[];
  knowledge_docs?: KnowledgeDoc[];
}

export interface TaskDetailResponse {
  task: Task;
  assignees?: TaskAssignee[];
  events: TaskEvent[];
  artifacts: Artifact[];
  runs: Run[];
  project?: Project | null;
  projectContext?: TaskProjectContext | null;
  project_context?: TaskProjectContext | null;
  /** Forma compacta aceptada para el contrato REST durante la transición. */
  context?: TaskProjectContext | null;
  sources?: ProjectSource[];
  documents?: KnowledgeDoc[];
  knowledge_docs?: KnowledgeDoc[];
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
  /** Relación opcional expuesta por el inventario del cerebro. */
  reports_to?: string | null;
  reportsTo?: string | null;
}

// ── Cerebro / inventario unificado de integraciones ────────────────────────

export type BrainSourceStatus = "connected" | "degraded" | "not_configured" | "offline";
export type BrainModuleStatus = "available" | "partial" | "offline";

export interface BrainCounts {
  [key: string]: number;
}

export interface BrainPerson {
  id: string;
  full_name: string;
  role: string | null;
  is_internal: boolean;
}

export interface BrainAgentHealth {
  id: string;
  slug: string;
  status: string;
  reports_to: string | null;
  chain: unknown;
}

export interface BrainAgent {
  id: string;
  slug: string;
  name: string;
  layer: AgentLayer;
  runtime: Agent["runtime"];
  model: string | null;
  autonomy: Agent["autonomy"];
  status: AgentStatus;
  reports_to?: string | null;
  reportsTo?: string | null;
}

export interface BrainSource {
  id: "agentos" | "whatsapphub" | "llm_wiki" | "notion";
  label: string;
  status: BrainSourceStatus;
  mode: string;
  last_checked_at: string | null;
  last_snapshot_at?: string | null;
  counts: BrainCounts;
  detail: string;
  stages?: {
    tasks?: string[];
    projects?: string[];
  };
}

export interface BrainModule {
  id: string;
  label: string;
  description: string;
  source_id: BrainSource["id"];
  status: BrainModuleStatus;
}

export interface BrainOverview {
  generated_at: string;
  core: {
    counts: BrainCounts;
    people: BrainPerson[];
  };
  agents: {
    items: BrainAgent[];
    tree: unknown;
    health: BrainAgentHealth[];
  };
  sources: BrainSource[];
  modules: BrainModule[];
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

// ── Procesamiento de reuniones (espejo read-only de WhatsAppHub) ───────────

export type MeetingProcessingFilter = "all" | "pending" | "error" | "ok";

export interface MeetingProcessingItem {
  id: string;
  title: string;
  source: string | null;
  meeting_date: string | null;
  created_at: string | null;
  extracted_at: string | null;
  extract_attempts: number | null;
  association_status: string;
  task_status: string;
  notion_synced_at: string | null;
  wiki_exported: boolean;
  wiki_synced_at: string | null;
  processing_error: string | null;
}

export interface MeetingProcessingOverview {
  source: "2brain / WhatsAppHub";
  mode: "remote_read_only";
  page: number;
  page_size: number;
  status: MeetingProcessingFilter;
  total: number | null;
  has_more: boolean;
  queue: {
    pending: number | null;
    errors: number | null;
    complete: number | null;
  };
  agentos_context: {
    linked: number;
    ingested: number;
    errors: number;
  };
  meetings: MeetingProcessingItem[];
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

// ── Organigrama del cliente ─────────────────────────────────────────────────
// Espejo del contrato REST de apps/orgs/roles (camelCase como el resto de la
// API). El rol es el centro: pertenece a un área, reporta a otro rol, lo
// ocupan personas, tiene funciones y participa en procesos.

export interface OrgUnit {
  id: string;
  orgId: string;
  name: string;
  parentUnitId: string | null;
  description: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface RoleFunction {
  id: string;
  roleId: string;
  name: string;
  description: string | null;
  position: number;
  createdAt: number;
  updatedAt: number;
}

/** Persona asignada a un rol (tabla puente): dedicación opcional. */
export interface OrgRolePerson {
  personId: string;
  dedicationPct: number | null;
}

/** Proceso vinculado a un rol: dueño o solo participante. */
export interface OrgRoleProcessLink {
  processId: string;
  relation: "owner" | "participant";
}

export interface OrgRole {
  id: string;
  orgId: string;
  unitId: string | null;
  name: string;
  purpose: string | null;
  reportsToRoleId: string | null;
  canvasX: number | null;
  canvasY: number | null;
  status: "draft" | "validated";
  version: number;
  createdAt: number;
  updatedAt: number;
  /** null si el rol todavía no se convirtió en agente. */
  agentId: string | null;
}

/** Rol con sus relaciones cargadas, tal como lo sirve el grafo y el detalle. */
export interface OrgRoleFull extends OrgRole {
  functions: RoleFunction[];
  people: OrgRolePerson[];
  processes: OrgRoleProcessLink[];
}

/** Proyección mínima de proceso usada en el grafo (no el ProcessEntity completo). */
export interface OrgGraphProcess {
  id: string;
  name: string;
  variant: "as_is" | "to_be";
  status: "draft" | "validated";
  ownerPerson: string | null;
}

/** Proyección mínima de persona usada en el grafo del organigrama. */
export interface OrgGraphPerson {
  id: string;
  fullName: string;
  role: string | null;
  isInternal: boolean;
}

/** Respuesta de GET /api/orgs/:orgId/graph: todo lo que pinta el canvas. */
export interface OrgGraph {
  units: OrgUnit[];
  roles: OrgRoleFull[];
  processes: OrgGraphProcess[];
  people: OrgGraphPerson[];
}

// ── Convertir un rol en agente ──────────────────────────────────────────────

/** Espejo camelCase de GET /api/tools/catalog (el wire llega en snake_case). */
export interface ToolCatalogEntry {
  name: string;
  description: string;
  readOnly: boolean;
  externalEffect: boolean;
  requiresApproval: boolean;
}

/** Lo mínimo del agente que devuelve POST /api/roles/:id/agent. */
export interface RoleAgentSummary {
  id: string;
  slug: string;
  name: string;
  status: AgentStatus;
  autonomy: "manual" | "supervised" | "auto";
}

export interface ConvertRoleToAgentResponse {
  agent: RoleAgentSummary;
  role: OrgRoleFull;
  prompt_version: unknown;
}

// ── Notas manuscritas (lienzo Excalidraw) ───────────────────────────────────

export type CanvasNoteStatus = "draft" | "captured" | "transcribed" | "converted";

export type NoteProposalConfidence = "alta" | "media" | "baja";

/**
 * Tarea PROPUESTA desde la transcripción (fase 3). Vive en la nota hasta que
 * el humano pulsa "Crear": `created_task_id` sólo lo fija el servidor.
 * `project_guess`/`assignee_guess` = el nombre tal cual lo escribió el autor.
 */
export interface NoteTaskProposal {
  id: string;
  include: boolean;
  title: string;
  description?: string;
  project_id: string | null;
  project_guess: string | null;
  assignee_person_id: string | null;
  assignee_guess: string | null;
  /** ISO 8601 o null. */
  due_at: string | null;
  priority: TaskPriority;
  source_excerpt: string;
  confidence: NoteProposalConfidence;
  created_task_id: string | null;
}

/** Escena de Excalidraw: opaca para la app, la entiende solo el lienzo. */
export interface CanvasScene {
  elements: readonly unknown[];
  appState?: Record<string, unknown>;
  files?: Record<string, unknown>;
}

/** `interim`: transcribe y la nota sigue como está; `final`: «Terminar nota» (pasa a `transcribed`). */
export type NoteTranscribeMode = "interim" | "final";

/** Texto leído de una región del lienzo, con la caja (en coordenadas de escena) de sus trazos. */
export interface TranscripcionBloque {
  bloque: number;
  caja: { x: number; y: number; w: number; h: number };
  texto: string;
}

/** Respuesta de POST /api/notes/:id/transcribe. */
export interface NoteTranscribeResponse {
  note: CanvasNote;
  bloques: TranscripcionBloque[];
  dudas: string[];
  /** Altura típica del trazo (mediana), para dimensionar el texto que se pinta. */
  alturaTipica: number;
}

/** Espejo de la fila `canvas_notes` que sirve /api/notes. */
export interface CanvasNote {
  id: string;
  orgId: string | null;
  projectId: string | null;
  title: string;
  scene: CanvasScene;
  status: CanvasNoteStatus;
  imageArtifactId: string | null;
  imagePath: string | null;
  imageBytes: number | null;
  capturedAt: number | null;
  transcription: string | null;
  /** Propuestas de la fase 3 (vacío hasta pulsar «Proponer tareas»). */
  proposals: NoteTaskProposal[];
  createdByPersonId: string | null;
  version: number;
  createdAt: number;
  updatedAt: number;
}

// ── Imágenes incrustadas y asistencia de IA por campo ───────────────────────

/** Respuesta de `POST /api/uploads/images`. */
export interface UploadedImage {
  id: string;
  /** Ruta servida por la API; `api.uploadImage` la devuelve ya absoluta. */
  url: string;
  name: string;
  mime: string;
  bytes: number;
}

/** Los dos campos de texto largo más el título aceptan asistencia. */
export type TaskAssistField = "title" | "description" | "definition_of_done";

/** Lo que la IA necesita saber del borrador, esté guardado o no. */
export interface TaskAssistDraft {
  title?: string;
  description?: string;
  definition_of_done?: string;
  project_id?: string;
  priority?: TaskPriority;
  due_at?: number | null;
  labels?: string[];
  assignee_person_ids?: string[];
}

export interface TaskAssistRequest {
  /** `enrich` reescribe el campo; `execution_prompt` devuelve el prompt entero. */
  mode: "enrich" | "execution_prompt";
  field?: TaskAssistField;
  task_id?: string;
  draft: TaskAssistDraft;
  instructions?: string;
}

/** El contexto consultado se enseña: "Consultó N documentos de <cliente>". */
export interface TaskAssistContext {
  org_name: string;
  project_name: string;
  docs: number;
  images: number;
  sibling_tasks: number;
  model: string;
}

export interface TaskAssistResponse {
  text: string;
  context: TaskAssistContext;
}

/** Extrae el payload de dominio (busSink envuelve en {type, timestamp, payload}). */
export function domainPayload(ev: TopicEvent): Record<string, unknown> {
  const inner = (ev.payload as { payload?: unknown }).payload;
  if (inner && typeof inner === "object") return inner as Record<string, unknown>;
  return ev.payload;
}
