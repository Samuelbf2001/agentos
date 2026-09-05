/**
 * Esquema AgentOS para **Postgres/Supabase** — espejo 1:1 de `src/schema.ts`
 * (las mismas 25 tablas, los mismos nombres de columna, índice e índice único).
 *
 * Reglas de traducción (ARCHITECTURE §5 — las convenciones se escribieron para
 * que esta tabla de equivalencias fuera mecánica):
 *
 *   SQLite                                   Postgres
 *   ─────────────────────────────────────    ──────────────────────────────────
 *   text("id").primaryKey()  (uuidv7)        text("id").primaryKey()   ← se mantiene TEXT
 *   integer("*_at")  (epoch ms)              bigint({mode:"number"})   ← ms cabe en Number
 *   integer(..., {mode:"boolean"})           boolean(...)
 *   text(..., {mode:"json"})                 jsonb(...)
 *   real(...)                                doublePrecision(...)
 *   integer(...)  (contadores/versiones)     integer(...)
 *
 * Lo que NO vive aquí (igual que FTS5 no vive en `schema.ts`): las columnas
 * `tsvector` generadas, la extensión `vector`, la columna `embedding` y sus
 * índices GIN/HNSW. Todo eso es específico del motor y se crea en
 * `search-pg.ts::ensurePgSearch()` — la misma frontera que impone §5.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
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
  ModuleBlueprint,
  ModuleStatus,
  OrgKind,
  ProcessStatus,
  ProcessStep,
  ProcessVariant,
  ProjectSourceExternalRef,
  ProjectSourceKind,
  ProjectSourceStatus,
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

/** Atajo: epoch ms (§5) — en Postgres bigint, nunca timestamptz. */
const epochMs = (name: string) => bigint(name, { mode: "number" });

// ── Organización ────────────────────────────────────────────────────────────

export const organizations = pgTable("organizations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  kind: text("kind").$type<OrgKind>().notNull(),
  industry: text("industry"),
  employeeCount: integer("employee_count"),
  notes: text("notes"),
  createdAt: epochMs("created_at").notNull(),
  updatedAt: epochMs("updated_at").notNull(),
});

export const people = pgTable(
  "people",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    fullName: text("full_name").notNull(),
    email: text("email"),
    role: text("role"),
    isInternal: boolean("is_internal").notNull().default(false),
    createdAt: epochMs("created_at").notNull(),
    updatedAt: epochMs("updated_at").notNull(),
  },
  (t) => [index("idx_people_org").on(t.orgId)],
);

export const projects = pgTable(
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
    createdAt: epochMs("created_at").notNull(),
    updatedAt: epochMs("updated_at").notNull(),
  },
  (t) => [index("idx_projects_org").on(t.orgId)],
);

// ── Proveedores y agentes ───────────────────────────────────────────────────

export const providerProfiles = pgTable("provider_profiles", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  kind: text("kind").$type<ProviderKind>().notNull(),
  baseUrl: text("base_url"),
  /** SOLO el NOMBRE de la variable de entorno; el valor jamás toca la DB. */
  apiKeyEnv: text("api_key_env"),
  costInputPerMtok: doublePrecision("cost_input_per_mtok"),
  costOutputPerMtok: doublePrecision("cost_output_per_mtok"),
  capabilities: jsonb("capabilities").$type<ProviderCapabilities>(),
  isDefault: boolean("is_default").notNull().default(false),
  createdAt: epochMs("created_at").notNull(),
  updatedAt: epochMs("updated_at").notNull(),
});

export const agents = pgTable("agents", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  layer: text("layer").$type<AgentLayer>().notNull(),
  runtime: text("runtime").$type<AgentRuntime>().notNull(),
  providerProfileId: text("provider_profile_id").references(() => providerProfiles.id),
  model: text("model"),
  reportsTo: text("reports_to").references((): AnyPgColumn => agents.id),
  /** Sin FK declarada para evitar el ciclo agents↔prompt_versions. */
  activePromptVersionId: text("active_prompt_version_id"),
  toolsAllowlist: jsonb("tools_allowlist").$type<string[]>().notNull().default([]),
  mcpAllowlist: jsonb("mcp_allowlist").$type<string[]>().notNull().default([]),
  limits: jsonb("limits").$type<Record<string, unknown>>(),
  autonomy: text("autonomy").$type<AgentAutonomy>().notNull().default("supervised"),
  status: text("status").$type<AgentStatus>().notNull().default("active"),
  seedFile: text("seed_file"),
  seedHash: text("seed_hash"),
  version: integer("version").notNull().default(1),
  createdAt: epochMs("created_at").notNull(),
  updatedAt: epochMs("updated_at").notNull(),
});

export const promptVersions = pgTable(
  "prompt_versions",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    version: integer("version").notNull(),
    stable: text("stable").notNull(),
    context: text("context"),
    volatileTpl: text("volatile_tpl"),
    changelog: text("changelog"),
    createdBy: text("created_by"),
    createdAt: epochMs("created_at").notNull(),
  },
  (t) => [uniqueIndex("uq_prompt_versions_agent_version").on(t.agentId, t.version)],
);

// ── Tablero ─────────────────────────────────────────────────────────────────

export const tasks = pgTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    parentTaskId: text("parent_task_id").references((): AnyPgColumn => tasks.id),
    title: text("title").notNull(),
    description: text("description"),
    definitionOfDone: text("definition_of_done"),
    stage: text("stage").$type<Stage>().notNull(),
    status: text("status").$type<TaskStatus>().notNull().default("BACKLOG"),
    activityType: text("activity_type"),
    priority: text("priority").$type<TaskPriority>().notNull().default("normal"),
    assigneeAgentId: text("assignee_agent_id").references(() => agents.id),
    assigneePersonId: text("assignee_person_id").references(() => people.id),
    requiresApproval: boolean("requires_approval").notNull().default(false),
    externalEffect: boolean("external_effect").notNull().default(false),
    leaseUntil: epochMs("lease_until"),
    attempts: integer("attempts").notNull().default(0),
    blockedReason: text("blocked_reason").$type<BlockedReason>(),
    dependsOn: jsonb("depends_on").$type<string[]>().notNull().default([]),
    dueAt: epochMs("due_at"),
    orderKey: text("order_key").notNull(),
    version: integer("version").notNull().default(1),
    createdAt: epochMs("created_at").notNull(),
    updatedAt: epochMs("updated_at").notNull(),
  },
  (t) => [
    index("idx_tasks_board").on(t.projectId, t.status, t.orderKey),
    index("idx_tasks_lease").on(t.status, t.leaseUntil),
  ],
);

// ── Responsables humanos y avisos ──────────────────────────────────────────

/** Fuente de verdad de responsables humanos; tasks.assignee_person_id es una proyección. */
export const taskAssignees = pgTable(
  "task_assignees",
  {
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id),
    personId: text("person_id")
      .notNull()
      .references(() => people.id),
    isPrimary: boolean("is_primary").notNull().default(false),
    assignedBy: text("assigned_by").notNull(),
    createdAt: epochMs("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.taskId, t.personId], name: "pk_task_assignees" }),
    uniqueIndex("uq_task_assignees_task_person").on(t.taskId, t.personId),
    uniqueIndex("uq_task_assignees_task_primary")
      .on(t.taskId)
      .where(sql`is_primary = true`),
    index("idx_task_assignees_task").on(t.taskId),
    index("idx_task_assignees_person").on(t.personId),
  ],
);

/** Log durable e idempotente de avisos assignment/due_24h. */
export const taskNotificationLog = pgTable(
  "task_notification_log",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id),
    personId: text("person_id")
      .notNull()
      .references(() => people.id),
    kind: text("kind").$type<"assignment" | "due_24h">().notNull(),
    scheduledAt: epochMs("scheduled_at").notNull(),
    deliveredAt: epochMs("delivered_at"),
    status: text("status")
      .$type<"pending" | "processing" | "delivered" | "failed" | "suppressed">()
      .notNull()
      .default("pending"),
    dedupeKey: text("dedupe_key").notNull(),
    lastError: text("last_error"),
    createdAt: epochMs("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("uq_task_notification_log_dedupe").on(t.dedupeKey),
    index("idx_task_notification_log_pending").on(t.status, t.scheduledAt),
    index("idx_task_notification_log_task").on(t.taskId, t.personId),
  ],
);

// ── Observabilidad ──────────────────────────────────────────────────────────

export const runs = pgTable(
  "runs",
  {
    id: text("id").primaryKey(),
    parentRunId: text("parent_run_id").references((): AnyPgColumn => runs.id),
    rootRunId: text("root_run_id").notNull(),
    agentId: text("agent_id").references(() => agents.id),
    taskId: text("task_id").references(() => tasks.id),
    projectId: text("project_id").references(() => projects.id),
    trigger: text("trigger").$type<RunTrigger>().notNull(),
    runtime: text("runtime").$type<AgentRuntime>().notNull(),
    providerProfileId: text("provider_profile_id").references(() => providerProfiles.id),
    model: text("model"),
    status: text("status").$type<RunStatus>().notNull().default("queued"),
    tokensIn: integer("tokens_in"),
    tokensOut: integer("tokens_out"),
    tokensCacheRead: integer("tokens_cache_read"),
    tokensCacheWrite: integer("tokens_cache_write"),
    costUsd: doublePrecision("cost_usd"),
    error: text("error"),
    resumeOfRunId: text("resume_of_run_id"),
    replayOfRunId: text("replay_of_run_id"),
    startedAt: epochMs("started_at"),
    finishedAt: epochMs("finished_at"),
    createdAt: epochMs("created_at").notNull(),
  },
  (t) => [index("idx_runs_root").on(t.rootRunId), index("idx_runs_task").on(t.taskId)],
);

export const spans = pgTable(
  "spans",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    parentSpanId: text("parent_span_id"),
    name: text("name").notNull(),
    kind: text("kind").$type<SpanKind>().notNull(),
    attrs: jsonb("attrs").$type<Record<string, unknown>>(),
    status: text("status"),
    startedAt: epochMs("started_at").notNull(),
    endedAt: epochMs("ended_at"),
  },
  (t) => [index("idx_spans_run").on(t.runId)],
);

export const events = pgTable(
  "events",
  {
    id: text("id").primaryKey(),
    topic: text("topic").notNull(),
    seq: integer("seq").notNull(),
    type: text("type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    runId: text("run_id"),
    createdAt: epochMs("created_at").notNull(),
  },
  (t) => [uniqueIndex("uq_events_topic_seq").on(t.topic, t.seq)],
);

// ── Timeline y artefactos del tablero ───────────────────────────────────────

export const taskEvents = pgTable(
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
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    createdAt: epochMs("created_at").notNull(),
  },
  (t) => [index("idx_task_events_task").on(t.taskId, t.createdAt)],
);

export const artifacts = pgTable(
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
    meta: jsonb("meta").$type<Record<string, unknown>>(),
    createdBy: text("created_by"),
    createdAt: epochMs("created_at").notNull(),
  },
  (t) => [index("idx_artifacts_task").on(t.taskId)],
);

// ── Conversación ────────────────────────────────────────────────────────────

export const threads = pgTable(
  "threads",
  {
    id: text("id").primaryKey(),
    channel: text("channel").notNull(),
    sessionKey: text("session_key").notNull(),
    projectId: text("project_id").references(() => projects.id),
    agentId: text("agent_id").references(() => agents.id),
    title: text("title"),
    createdAt: epochMs("created_at").notNull(),
    updatedAt: epochMs("updated_at").notNull(),
  },
  (t) => [uniqueIndex("uq_threads_session_key").on(t.sessionKey)],
);

export const messages = pgTable(
  "messages",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id),
    role: text("role").$type<MessageRole>().notNull(),
    content: text("content").notNull(),
    idempotencyKey: text("idempotency_key"),
    runId: text("run_id").references(() => runs.id),
    actor: text("actor"),
    meta: jsonb("meta").$type<Record<string, unknown>>(),
    createdAt: epochMs("created_at").notNull(),
  },
  (t) => [
    /**
     * NULLs DISTINTOS igual que en SQLite: sin `idempotency_key` se pueden
     * insertar N mensajes en el mismo hilo. Postgres se comporta idéntico por
     * defecto (no usamos NULLS NOT DISTINCT).
     */
    uniqueIndex("uq_messages_idempotency").on(t.threadId, t.idempotencyKey),
    index("idx_messages_thread_created").on(t.threadId, t.createdAt),
  ],
);

// ── Gobierno ────────────────────────────────────────────────────────────────

export const approvals = pgTable(
  "approvals",
  {
    id: text("id").primaryKey(),
    kind: text("kind").$type<ApprovalKind>().notNull(),
    runId: text("run_id").references(() => runs.id),
    taskId: text("task_id").references(() => tasks.id),
    projectId: text("project_id").references(() => projects.id),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    actionDigest: text("action_digest").notNull(),
    status: text("status").$type<ApprovalStatus>().notNull().default("pending"),
    requestedBy: text("requested_by"),
    decidedByPersonId: text("decided_by_person_id").references(() => people.id),
    decidedAt: epochMs("decided_at"),
    note: text("note"),
    reconciledAt: epochMs("reconciled_at"),
    createdAt: epochMs("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("uq_approvals_digest_run").on(t.actionDigest, t.runId),
    index("idx_approvals_status").on(t.status),
  ],
);

export const auditLog = pgTable(
  "audit_log",
  {
    id: text("id").primaryKey(),
    actor: text("actor").notNull(),
    source: text("source").$type<AuditSource>().notNull(),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    before: jsonb("before").$type<Record<string, unknown>>(),
    after: jsonb("after").$type<Record<string, unknown>>(),
    reason: text("reason"),
    runId: text("run_id"),
    createdAt: epochMs("created_at").notNull(),
  },
  (t) => [index("idx_audit_entity").on(t.entityType, t.entityId)],
);

export const appConfig = pgTable("app_config", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<unknown>(),
  updatedAt: epochMs("updated_at").notNull(),
});

// ── Contexto y metodología (§8b — el activo) ────────────────────────────────

export const knowledgeDocs = pgTable(
  "knowledge_docs",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").references(() => organizations.id),
    projectId: text("project_id").references(() => projects.id),
    kind: text("kind").$type<KnowledgeKind>().notNull(),
    title: text("title").notNull(),
    bodyMd: text("body_md").notNull(),
    sourceRefs: jsonb("source_refs").$type<Record<string, unknown>[]>(),
    tags: jsonb("tags").$type<string[]>(),
    createdBy: text("created_by"),
    createdAt: epochMs("created_at").notNull(),
    updatedAt: epochMs("updated_at").notNull(),
  },
  (t) => [index("idx_knowledge_org_kind").on(t.orgId, t.kind)],
);

export const projectSources = pgTable(
  "project_sources",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    kind: text("kind").$type<ProjectSourceKind>().notNull(),
    externalRef: jsonb("external_ref").$type<ProjectSourceExternalRef>().notNull(),
    status: text("status").$type<ProjectSourceStatus>().notNull().default("linked"),
    knowledgeDocId: text("knowledge_doc_id").references(() => knowledgeDocs.id),
    lastError: text("last_error"),
    lastIngestedAt: epochMs("last_ingested_at"),
    createdBy: text("created_by"),
    createdAt: epochMs("created_at").notNull(),
  },
  (t) => [index("idx_project_sources_project").on(t.projectId, t.kind)],
);

export const processes = pgTable(
  "processes",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    name: text("name").notNull(),
    ownerPerson: text("owner_person"),
    variant: text("variant").$type<ProcessVariant>().notNull().default("as_is"),
    steps: jsonb("steps").$type<ProcessStep[]>(),
    systems: jsonb("systems").$type<string[]>(),
    painPoints: jsonb("pain_points").$type<string[]>(),
    isoRefs: jsonb("iso_refs").$type<string[]>(),
    sourceDocIds: jsonb("source_doc_ids").$type<string[]>(),
    status: text("status").$type<ProcessStatus>().notNull().default("draft"),
    createdAt: epochMs("created_at").notNull(),
    updatedAt: epochMs("updated_at").notNull(),
  },
  (t) => [index("idx_processes_org").on(t.orgId)],
);

export const methodologies = pgTable(
  "methodologies",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull(),
    version: integer("version").notNull(),
    bodyMd: text("body_md").notNull(),
    changelog: text("changelog"),
    seedFile: text("seed_file"),
    seedHash: text("seed_hash"),
    createdAt: epochMs("created_at").notNull(),
    updatedAt: epochMs("updated_at").notNull(),
  },
  (t) => [uniqueIndex("uq_methodologies_slug_version").on(t.slug, t.version)],
);

// ── Módulos de Fase (§13) ───────────────────────────────────────────────────

export const phaseModules = pgTable(
  "phase_modules",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull(),
    version: integer("version").notNull(),
    name: text("name").notNull(),
    phase: text("phase").$type<Stage>().notNull(),
    projectType: text("project_type").$type<ProjectType>().notNull(),
    status: text("status").$type<ModuleStatus>().notNull().default("draft"),
    methodologySlug: text("methodology_slug").notNull(),
    methodologyVersion: integer("methodology_version"),
    blueprint: jsonb("blueprint").$type<ModuleBlueprint>().notNull(),
    blueprintHash: text("blueprint_hash").notNull(),
    bodyMd: text("body_md").notNull(),
    changelog: text("changelog"),
    seedFile: text("seed_file"),
    seedHash: text("seed_hash"),
    createdBy: text("created_by"),
    activatedAt: epochMs("activated_at"),
    createdAt: epochMs("created_at").notNull(),
    updatedAt: epochMs("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("uq_phase_modules_slug_version").on(t.slug, t.version),
    /** Índice único PARCIAL: Postgres lo soporta nativo igual que SQLite (§13.1). */
    uniqueIndex("uq_phase_modules_slug_active")
      .on(t.slug)
      .where(sql`status = 'active'`),
    index("idx_phase_modules_phase_status").on(t.phase, t.status),
  ],
);

export const moduleLaunches = pgTable(
  "module_launches",
  {
    id: text("id").primaryKey(),
    moduleId: text("module_id")
      .notNull()
      .references(() => phaseModules.id),
    moduleSlug: text("module_slug").notNull(),
    moduleVersion: integer("module_version").notNull(),
    phase: text("phase").$type<Stage>().notNull(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    blueprintSnapshot: jsonb("blueprint_snapshot").$type<ModuleBlueprint>().notNull(),
    blueprintHash: text("blueprint_hash").notNull(),
    inputs: jsonb("inputs").$type<Record<string, unknown>>().notNull(),
    inputsDigest: text("inputs_digest").notNull(),
    toggles: jsonb("toggles").$type<Record<string, boolean>>().notNull(),
    methodologyId: text("methodology_id")
      .notNull()
      .references(() => methodologies.id),
    result: jsonb("result").$type<Record<string, unknown>>().notNull(),
    taskCount: integer("task_count").notNull(),
    budgetPhaseUsd: doublePrecision("budget_phase_usd").notNull(),
    budgetPerRunUsd: doublePrecision("budget_per_run_usd").notNull(),
    previousLaunchId: text("previous_launch_id").references((): AnyPgColumn => moduleLaunches.id),
    idempotencyKey: text("idempotency_key").notNull(),
    actor: text("actor").notNull(),
    durationMs: integer("duration_ms").notNull(),
    createdAt: epochMs("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("uq_module_launches_idempotency").on(t.idempotencyKey),
    uniqueIndex("uq_module_launches_project_phase").on(t.projectId, t.phase),
    index("idx_module_launches_module").on(t.moduleId),
  ],
);

// ── Linaje de la migración de Notion — espejo de `schema.ts` ────────────────

export const notionMigrationRuns = pgTable(
  "notion_migration_runs",
  {
    id: text("id").primaryKey(),
    sourceSchemaVersion: text("source_schema_version").notNull(),
    capturedAt: epochMs("captured_at").notNull(),
    manifestHash: text("manifest_hash").notNull(),
    snapshotRunId: text("snapshot_run_id").notNull(),
    mode: text("mode").$type<"dry_run" | "pilot" | "full">().notNull(),
    status: text("status")
      .$type<"running" | "completed" | "completed_with_exceptions" | "failed">()
      .notNull()
      .default("running"),
    report: jsonb("report").$type<Record<string, unknown>>(),
    immutable: boolean("immutable").notNull().default(true),
    startedAt: epochMs("started_at").notNull(),
    finishedAt: epochMs("finished_at"),
    createdAt: epochMs("created_at").notNull(),
  },
  (t) => [index("idx_notion_migration_runs_snapshot").on(t.snapshotRunId)],
);

export const notionPageArchives = pgTable(
  "notion_page_archives",
  {
    id: text("id").primaryKey(),
    migrationRunId: text("migration_run_id")
      .notNull()
      .references(() => notionMigrationRuns.id),
    sourceKind: text("source_kind").$type<"task" | "project">().notNull(),
    notionPageId: text("notion_page_id").notNull(),
    originalUrl: text("original_url"),
    rawPageUri: text("raw_page_uri"),
    rawBlocksUri: text("raw_blocks_uri"),
    rawCommentsUri: text("raw_comments_uri"),
    rawFilesUri: text("raw_files_uri"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    payloadHash: text("payload_hash").notNull(),
    capturedAt: epochMs("captured_at").notNull(),
    createdAt: epochMs("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("uq_notion_page_archives_run_page").on(t.migrationRunId, t.sourceKind, t.notionPageId),
    index("idx_notion_page_archives_page").on(t.sourceKind, t.notionPageId),
  ],
);

export const notionImportLinks = pgTable(
  "notion_import_links",
  {
    id: text("id").primaryKey(),
    migrationRunId: text("migration_run_id")
      .notNull()
      .references(() => notionMigrationRuns.id),
    sourceKind: text("source_kind").$type<"task" | "project" | "inbox">().notNull(),
    notionPageId: text("notion_page_id").notNull(),
    agentosObjectKind: text("agentos_object_kind").$type<"task" | "project">().notNull(),
    agentosObjectId: text("agentos_object_id").notNull(),
    archiveId: text("archive_id").references(() => notionPageArchives.id),
    importStatus: text("import_status")
      .$type<"imported" | "updated" | "inbox_container" | "skipped">()
      .notNull(),
    sourceLastEditedAt: epochMs("source_last_edited_at"),
    importedAt: epochMs("imported_at").notNull(),
    createdAt: epochMs("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("uq_notion_import_links_source").on(t.sourceKind, t.notionPageId),
    index("idx_notion_import_links_object").on(t.agentosObjectKind, t.agentosObjectId),
    index("idx_notion_import_links_run").on(t.migrationRunId),
  ],
);

export const notionIdentityMappings = pgTable(
  "notion_identity_mappings",
  {
    id: text("id").primaryKey(),
    migrationRunId: text("migration_run_id")
      .notNull()
      .references(() => notionMigrationRuns.id),
    notionPersonId: text("notion_person_id").notNull(),
    notionEmail: text("notion_email"),
    agentosPersonId: text("agentos_person_id").references(() => people.id),
    matchMethod: text("match_method")
      .$type<"confirmed_email" | "admin_decision" | "unresolved">()
      .notNull(),
    validationState: text("validation_state")
      .$type<"confirmed" | "pending_review">()
      .notNull()
      .default("pending_review"),
    reviewedBy: text("reviewed_by"),
    reviewedAt: epochMs("reviewed_at"),
    createdAt: epochMs("created_at").notNull(),
  },
  (t) => [uniqueIndex("uq_notion_identity_mappings_person").on(t.notionPersonId)],
);

export const notionImportQuarantine = pgTable(
  "notion_import_quarantine",
  {
    id: text("id").primaryKey(),
    migrationRunId: text("migration_run_id")
      .notNull()
      .references(() => notionMigrationRuns.id),
    sourceKind: text("source_kind").$type<"task" | "project" | "identity">().notNull(),
    notionPageId: text("notion_page_id").notNull(),
    fieldName: text("field_name").notNull(),
    reason: text("reason").notNull(),
    rawReference: text("raw_reference"),
    resolutionState: text("resolution_state")
      .$type<"open" | "resolved" | "accepted">()
      .notNull()
      .default("open"),
    resolvedBy: text("resolved_by"),
    resolvedAt: epochMs("resolved_at"),
    createdAt: epochMs("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("uq_notion_import_quarantine_entry").on(
      t.migrationRunId,
      t.sourceKind,
      t.notionPageId,
      t.fieldName,
      t.rawReference,
    ),
    index("idx_notion_import_quarantine_state").on(t.resolutionState, t.reason),
  ],
);

/**
 * Orden TOPOLÓGICO de inserción (FKs satisfechas) — lo consume la herramienta
 * de migración de datos `migrate-to-pg.ts` y la limpieza de los tests PG.
 * Las auto-FKs (tasks.parent_task_id, runs.parent_run_id, agents.reports_to,
 * module_launches.previous_launch_id) se resuelven dentro de cada tabla
 * insertando en orden de `created_at` (el padre siempre es anterior).
 */
export const PG_TABLE_ORDER = [
  "organizations",
  "people",
  "projects",
  "provider_profiles",
  "agents",
  "prompt_versions",
  "knowledge_docs",
  "project_sources",
  "processes",
  "methodologies",
  "phase_modules",
  "tasks",
  "task_assignees",
  "task_notification_log",
  "runs",
  "spans",
  "events",
  "task_events",
  "artifacts",
  "threads",
  "messages",
  "approvals",
  "audit_log",
  "app_config",
  "module_launches",
  "notion_migration_runs",
  "notion_page_archives",
  "notion_import_links",
  "notion_identity_mappings",
  "notion_import_quarantine",
] as const;

export type PgTableName = (typeof PG_TABLE_ORDER)[number];
