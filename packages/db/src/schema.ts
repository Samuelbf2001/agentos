/**
 * Esquema AgentOS — 20 tablas de ARCHITECTURE.md §5 y §8b.
 *
 * Convenciones no opcionales (portabilidad a Postgres):
 * - id TEXT uuidv7 (generado en los repositorios, nunca en SQL)
 * - *_at INTEGER epoch ms
 * - JSON en TEXT mode:'json'
 * - columna `version` para optimistic locking donde ARCHITECTURE lo indica
 * - sin triggers de negocio en SQL (los espejos FTS viven aislados en search.ts)
 */
import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";
import type {
  AgentAutonomy,
  AgentLayer,
  AgentRuntime,
  AgentStatus,
  ApprovalKind,
  ApprovalStatus,
  AuditSource,
  BlockedReason,
  GateState,
  KnowledgeKind,
  MessageRole,
  OrgKind,
  ProcessStatus,
  ProcessStep,
  ProcessVariant,
  ProjectType,
  ProviderCapabilities,
  ProviderKind,
  RunStatus,
  RunTrigger,
  SpanKind,
  Stage,
  TaskPriority,
  TaskStatus,
} from "@agentos/shared";

// ── Organización ────────────────────────────────────────────────────────────

export const organizations = sqliteTable("organizations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  kind: text("kind").$type<OrgKind>().notNull(),
  industry: text("industry"),
  employeeCount: integer("employee_count"),
  notes: text("notes"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const people = sqliteTable(
  "people",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    fullName: text("full_name").notNull(),
    email: text("email"),
    role: text("role"),
    isInternal: integer("is_internal", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [index("idx_people_org").on(t.orgId)],
);

export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    name: text("name").notNull(),
    type: text("type").$type<ProjectType>().notNull(),
    stage: text("stage").$type<Stage>().notNull().default("ENTENDER"),
    gateState: text("gate_state").$type<GateState>().notNull().default("pending"),
    workspacePath: text("workspace_path"),
    version: integer("version").notNull().default(1),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [index("idx_projects_org").on(t.orgId)],
);

// ── Proveedores y agentes ───────────────────────────────────────────────────

export const providerProfiles = sqliteTable("provider_profiles", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  kind: text("kind").$type<ProviderKind>().notNull(),
  baseUrl: text("base_url"),
  /** SOLO el NOMBRE de la variable de entorno; el valor jamás toca la DB. */
  apiKeyEnv: text("api_key_env"),
  costInputPerMtok: real("cost_input_per_mtok"),
  costOutputPerMtok: real("cost_output_per_mtok"),
  capabilities: text("capabilities", { mode: "json" }).$type<ProviderCapabilities>(),
  isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const agents = sqliteTable("agents", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  layer: text("layer").$type<AgentLayer>().notNull(),
  runtime: text("runtime").$type<AgentRuntime>().notNull(),
  providerProfileId: text("provider_profile_id").references(() => providerProfiles.id),
  model: text("model"),
  /**
   * Jerarquía de mando (Fase 2, inspirada en Paperclip §modelo de empresa):
   * self-FK nullable al manager. `null` = raíz (Alex orquestador operacional,
   * Quinn raíz meta/QA). La SALUD de esta cadena gobierna la asignabilidad
   * (ver packages/core/org.ts): un agente con ancestro terminado/faltante o en
   * ciclo no puede recibir ni ejecutar trabajo aunque él mismo esté activo.
   */
  reportsTo: text("reports_to").references((): AnySQLiteColumn => agents.id),
  /** Sin FK declarada para evitar el ciclo agents↔prompt_versions; la integridad la garantiza el repositorio. */
  activePromptVersionId: text("active_prompt_version_id"),
  toolsAllowlist: text("tools_allowlist", { mode: "json" }).$type<string[]>().notNull().default([]),
  mcpAllowlist: text("mcp_allowlist", { mode: "json" }).$type<string[]>().notNull().default([]),
  limits: text("limits", { mode: "json" }).$type<Record<string, unknown>>(),
  autonomy: text("autonomy").$type<AgentAutonomy>().notNull().default("supervised"),
  status: text("status").$type<AgentStatus>().notNull().default("active"),
  seedFile: text("seed_file"),
  seedHash: text("seed_hash"),
  version: integer("version").notNull().default(1),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const promptVersions = sqliteTable(
  "prompt_versions",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    version: integer("version").notNull(),
    /** 3 capas en orden deliberado para prefix cache (patrón Hermes). */
    stable: text("stable").notNull(),
    context: text("context"),
    volatileTpl: text("volatile_tpl"),
    changelog: text("changelog"),
    createdBy: text("created_by"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [uniqueIndex("uq_prompt_versions_agent_version").on(t.agentId, t.version)],
);

// ── Tablero ─────────────────────────────────────────────────────────────────

export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    parentTaskId: text("parent_task_id").references((): AnySQLiteColumn => tasks.id),
    title: text("title").notNull(),
    description: text("description"),
    definitionOfDone: text("definition_of_done"),
    stage: text("stage").$type<Stage>().notNull(),
    status: text("status").$type<TaskStatus>().notNull().default("BACKLOG"),
    activityType: text("activity_type"),
    priority: text("priority").$type<TaskPriority>().notNull().default("normal"),
    assigneeAgentId: text("assignee_agent_id").references(() => agents.id),
    assigneePersonId: text("assignee_person_id").references(() => people.id),
    requiresApproval: integer("requires_approval", { mode: "boolean" }).notNull().default(false),
    externalEffect: integer("external_effect", { mode: "boolean" }).notNull().default(false),
    leaseUntil: integer("lease_until"),
    attempts: integer("attempts").notNull().default(0),
    blockedReason: text("blocked_reason").$type<BlockedReason>(),
    /** Clave de orden fraccionaria (orden lexicográfico dentro de la columna). */
    orderKey: text("order_key").notNull(),
    version: integer("version").notNull().default(1),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    index("idx_tasks_board").on(t.projectId, t.status, t.orderKey),
    index("idx_tasks_lease").on(t.status, t.leaseUntil),
  ],
);

// ── Observabilidad ──────────────────────────────────────────────────────────

export const runs = sqliteTable(
  "runs",
  {
    id: text("id").primaryKey(),
    parentRunId: text("parent_run_id").references((): AnySQLiteColumn => runs.id),
    /** Desnormalizado: árboles de runs sin recursión (para un run raíz es su propio id). */
    rootRunId: text("root_run_id").notNull(),
    agentId: text("agent_id").references(() => agents.id),
    taskId: text("task_id").references(() => tasks.id),
    projectId: text("project_id").references(() => projects.id),
    trigger: text("trigger").$type<RunTrigger>().notNull(),
    runtime: text("runtime").$type<AgentRuntime>().notNull(),
    providerProfileId: text("provider_profile_id").references(() => providerProfiles.id),
    model: text("model"),
    status: text("status").$type<RunStatus>().notNull().default("queued"),
    /** null = no reportado por el proveedor; nunca cero inferido (PRD CA-7.2). */
    tokensIn: integer("tokens_in"),
    tokensOut: integer("tokens_out"),
    tokensCacheRead: integer("tokens_cache_read"),
    tokensCacheWrite: integer("tokens_cache_write"),
    costUsd: real("cost_usd"),
    error: text("error"),
    resumeOfRunId: text("resume_of_run_id"),
    replayOfRunId: text("replay_of_run_id"),
    startedAt: integer("started_at"),
    finishedAt: integer("finished_at"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("idx_runs_root").on(t.rootRunId), index("idx_runs_task").on(t.taskId)],
);

export const spans = sqliteTable(
  "spans",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    parentSpanId: text("parent_span_id"),
    name: text("name").notNull(),
    kind: text("kind").$type<SpanKind>().notNull(),
    /** Atributos con nombres de la convención OTel GenAI (sin adoptar el SDK). */
    attrs: text("attrs", { mode: "json" }).$type<Record<string, unknown>>(),
    status: text("status"),
    startedAt: integer("started_at").notNull(),
    endedAt: integer("ended_at"),
  },
  (t) => [index("idx_spans_run").on(t.runId)],
);

export const events = sqliteTable(
  "events",
  {
    id: text("id").primaryKey(),
    /** run:<id> | board:<project_id> | thread:<id> | swarm | approvals | channel:<name> */
    topic: text("topic").notNull(),
    seq: integer("seq").notNull(),
    type: text("type").notNull(),
    payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>(),
    runId: text("run_id"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [uniqueIndex("uq_events_topic_seq").on(t.topic, t.seq)],
);

// ── Timeline y artefactos del tablero ───────────────────────────────────────

export const taskEvents = sqliteTable(
  "task_events",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id),
    runId: text("run_id").references(() => runs.id),
    kind: text("kind").notNull(),
    fromStatus: text("from_status").$type<TaskStatus>(),
    toStatus: text("to_status").$type<TaskStatus>(),
    actor: text("actor").notNull(),
    payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("idx_task_events_task").on(t.taskId, t.createdAt)],
);

export const artifacts = sqliteTable(
  "artifacts",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id),
    runId: text("run_id").references(() => runs.id),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    content: text("content"),
    path: text("path"),
    meta: text("meta", { mode: "json" }).$type<Record<string, unknown>>(),
    createdBy: text("created_by"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("idx_artifacts_task").on(t.taskId)],
);

// ── Conversación ────────────────────────────────────────────────────────────

export const threads = sqliteTable(
  "threads",
  {
    id: text("id").primaryKey(),
    channel: text("channel").notNull(),
    /** `channel:chat_id:thread_id` — identidad estable del hilo por canal. */
    sessionKey: text("session_key").notNull(),
    projectId: text("project_id").references(() => projects.id),
    agentId: text("agent_id").references(() => agents.id),
    title: text("title"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [uniqueIndex("uq_threads_session_key").on(t.sessionKey)],
);

export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id),
    role: text("role").$type<MessageRole>().notNull(),
    content: text("content").notNull(),
    /** Idempotencia de entrada (ARCHITECTURE §9): mismo mensaje reintentado no duplica. */
    idempotencyKey: text("idempotency_key"),
    runId: text("run_id").references(() => runs.id),
    actor: text("actor"),
    meta: text("meta", { mode: "json" }).$type<Record<string, unknown>>(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("uq_messages_idempotency").on(t.threadId, t.idempotencyKey),
    index("idx_messages_thread_created").on(t.threadId, t.createdAt),
  ],
);

// ── Gobierno ────────────────────────────────────────────────────────────────

export const approvals = sqliteTable(
  "approvals",
  {
    id: text("id").primaryKey(),
    kind: text("kind").$type<ApprovalKind>().notNull(),
    runId: text("run_id").references(() => runs.id),
    taskId: text("task_id").references(() => tasks.id),
    projectId: text("project_id").references(() => projects.id),
    /** Payload LITERAL de la acción; cambiar argumentos invalida la aprobación (digest). */
    payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    actionDigest: text("action_digest").notNull(),
    status: text("status").$type<ApprovalStatus>().notNull().default("pending"),
    requestedBy: text("requested_by"),
    decidedByPersonId: text("decided_by_person_id").references(() => people.id),
    decidedAt: integer("decided_at"),
    note: text("note"),
    /**
     * Reconciliación del efecto de una decisión (Gate 2, fix Q2): epoch ms en que
     * la plataforma ya ejecutó el efecto del tool_call aprobado y/o desbloqueó la
     * tarea. Decidir (por REST o por MCP) SOLO fija el estado; la reconciliación es
     * un paso aparte. Si es NULL con status != 'pending', la decisión está pendiente
     * de reconciliar y el despachador de apps/api la drena — nada queda huérfano
     * aunque la aprobación se decida por el MCP admin (otro proceso, sin runtime).
     */
    reconciledAt: integer("reconciled_at"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("uq_approvals_digest_run").on(t.actionDigest, t.runId),
    index("idx_approvals_status").on(t.status),
  ],
);

export const auditLog = sqliteTable(
  "audit_log",
  {
    id: text("id").primaryKey(),
    actor: text("actor").notNull(),
    source: text("source").$type<AuditSource>().notNull(),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    before: text("before", { mode: "json" }).$type<Record<string, unknown>>(),
    after: text("after", { mode: "json" }).$type<Record<string, unknown>>(),
    reason: text("reason"),
    runId: text("run_id"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("idx_audit_entity").on(t.entityType, t.entityId)],
);

export const appConfig = sqliteTable("app_config", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).$type<unknown>(),
  updatedAt: integer("updated_at").notNull(),
});

// ── Contexto y metodología (§8b — el activo) ────────────────────────────────

export const knowledgeDocs = sqliteTable(
  "knowledge_docs",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").references(() => organizations.id),
    projectId: text("project_id").references(() => projects.id),
    kind: text("kind").$type<KnowledgeKind>().notNull(),
    title: text("title").notNull(),
    bodyMd: text("body_md").notNull(),
    /** De dónde salió: entrevista, documento, run — provenance obligatoria. */
    sourceRefs: text("source_refs", { mode: "json" }).$type<Record<string, unknown>[]>(),
    tags: text("tags", { mode: "json" }).$type<string[]>(),
    createdBy: text("created_by"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [index("idx_knowledge_org_kind").on(t.orgId, t.kind)],
);

export const processes = sqliteTable(
  "processes",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    name: text("name").notNull(),
    ownerPerson: text("owner_person"),
    variant: text("variant").$type<ProcessVariant>().notNull().default("as_is"),
    /** Pasos SIPOC: paso, responsable, sistema, entrada/salida. */
    steps: text("steps", { mode: "json" }).$type<ProcessStep[]>(),
    systems: text("systems", { mode: "json" }).$type<string[]>(),
    painPoints: text("pain_points", { mode: "json" }).$type<string[]>(),
    isoRefs: text("iso_refs", { mode: "json" }).$type<string[]>(),
    /** Qué entrevistas/documentos lo sustentan (ids de knowledge_docs). */
    sourceDocIds: text("source_doc_ids", { mode: "json" }).$type<string[]>(),
    status: text("status").$type<ProcessStatus>().notNull().default("draft"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [index("idx_processes_org").on(t.orgId)],
);

export const methodologies = sqliteTable(
  "methodologies",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull(),
    version: integer("version").notNull(),
    bodyMd: text("body_md").notNull(),
    changelog: text("changelog"),
    seedFile: text("seed_file"),
    seedHash: text("seed_hash"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [uniqueIndex("uq_methodologies_slug_version").on(t.slug, t.version)],
);
