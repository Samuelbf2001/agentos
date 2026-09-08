/**
 * Esquema AgentOS — 25 tablas: las tablas de ARCHITECTURE.md §5 y §8b
 * + `project_sources` (Fuentes del proyecto, Fase 2), responsables humanos
 * y el log durable de avisos del módulo de Proyectos y Tareas.
 *
 * Convenciones no opcionales (portabilidad a Postgres):
 * - id TEXT uuidv7 (generado en los repositorios, nunca en SQL)
 * - *_at INTEGER epoch ms
 * - JSON en TEXT mode:'json'
 * - columna `version` para optimistic locking donde ARCHITECTURE lo indica
 * - sin triggers de negocio en SQL (los espejos FTS viven aislados en search.ts)
 */
import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
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
  ModuleBlueprint,
  ModuleStatus,
  OrgKind,
  OrgRoleStatus,
  ProcessStatus,
  ProcessStep,
  ProcessVariant,
  ProjectSourceExternalRef,
  ProjectSourceKind,
  ProjectSourceStatus,
  ProjectType,
  ProviderCapabilities,
  ProviderKind,
  RoleProcessRelation,
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
    /**
     * Dependencias como propiedad de la tarjeta (§13.1, patrón
     * `processes.source_doc_ids` — sin tabla puente): ids de las tareas de las
     * que depende. El promotor filtra en JS (≤40 tareas/proyecto).
     */
    dependsOn: text("depends_on", { mode: "json" }).$type<string[]>().notNull().default([]),
    /** SLA / fecha objetivo (CA-M4.2): epoch ms, null = sin vencimiento. */
    dueAt: integer("due_at"),
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

// ── Responsables humanos y avisos ──────────────────────────────────────────

/**
 * Responsables humanos de una tarea. Esta tabla es la fuente de verdad de la
 * asignación humana; `tasks.assignee_person_id` se conserva como proyección
 * singular para los consumidores históricos.
 */
export const taskAssignees = sqliteTable(
  "task_assignees",
  {
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id),
    personId: text("person_id")
      .notNull()
      .references(() => people.id),
    isPrimary: integer("is_primary", { mode: "boolean" }).notNull().default(false),
    /** ActorRef que realizó la asignación; el backfill usa un actor de migración. */
    assignedBy: text("assigned_by").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.taskId, t.personId], name: "pk_task_assignees" }),
    uniqueIndex("uq_task_assignees_task_person").on(t.taskId, t.personId),
    /** Como máximo una persona principal por tarea. */
    uniqueIndex("uq_task_assignees_task_primary")
      .on(t.taskId)
      .where(sql`is_primary = 1`),
    index("idx_task_assignees_task").on(t.taskId),
    index("idx_task_assignees_person").on(t.personId),
  ],
);

/**
 * Etiquetas de una tarea. Tabla de unión (no un JSON en `tasks`) porque el
 * tablero filtra por etiqueta y ambos motores necesitan poder indexar esa
 * consulta; `label` se guarda ya normalizada (minúsculas, sin espacios extra).
 */
export const taskLabels = sqliteTable(
  "task_labels",
  {
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id),
    label: text("label").notNull(),
    /** ActorRef que la puso; auditable igual que el resto de mutaciones. */
    createdBy: text("created_by"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.taskId, t.label], name: "pk_task_labels" }),
    index("idx_task_labels_label").on(t.label),
    index("idx_task_labels_task").on(t.taskId),
  ],
);

/**
 * Registro durable de avisos de responsables. `dedupe_key` es la identidad
 * idempotente que sobrevive a reintentos y reinicios del worker.
 */
export const taskNotificationLog = sqliteTable(
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
    scheduledAt: integer("scheduled_at").notNull(),
    deliveredAt: integer("delivered_at"),
    status: text("status")
      .$type<"pending" | "processing" | "delivered" | "failed" | "suppressed">()
      .notNull()
      .default("pending"),
    dedupeKey: text("dedupe_key").notNull(),
    lastError: text("last_error"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("uq_task_notification_log_dedupe").on(t.dedupeKey),
    index("idx_task_notification_log_pending").on(t.status, t.scheduledAt),
    index("idx_task_notification_log_task").on(t.taskId, t.personId),
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

/**
 * Fuentes del proyecto (Fase 2): reuniones y hilos de WhatsApp de 2brain
 * asociados a un proyecto. Al ingerir, el markdown del conector se registra
 * como knowledge_doc TIPADO (interview/evidence) y `knowledge_doc_id` enlaza
 * el doc — re-ingerir actualiza el MISMO doc, nunca duplica.
 */
export const projectSources = sqliteTable(
  "project_sources",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    kind: text("kind").$type<ProjectSourceKind>().notNull(),
    /** {system:'whatsapphub', meetingId?|contactId?, title, url?} */
    externalRef: text("external_ref", { mode: "json" }).$type<ProjectSourceExternalRef>().notNull(),
    status: text("status").$type<ProjectSourceStatus>().notNull().default("linked"),
    knowledgeDocId: text("knowledge_doc_id").references(() => knowledgeDocs.id),
    /** Último error legible del conector (status='error'); null si sano. */
    lastError: text("last_error"),
    lastIngestedAt: integer("last_ingested_at"),
    createdBy: text("created_by"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("idx_project_sources_project").on(t.projectId, t.kind)],
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

// ── Grafo organizacional (el rol es el centro: PRD v1.1 §3.1 y Parte II §5.3) ─

export const orgUnits = sqliteTable(
  "org_units",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    name: text("name").notNull(),
    parentUnitId: text("parent_unit_id").references((): AnySQLiteColumn => orgUnits.id),
    description: text("description"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [index("idx_org_units_org").on(t.orgId)],
);

export const orgRoles = sqliteTable(
  "org_roles",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    unitId: text("unit_id").references(() => orgUnits.id),
    name: text("name").notNull(),
    purpose: text("purpose"),
    reportsToRoleId: text("reports_to_role_id").references((): AnySQLiteColumn => orgRoles.id),
    canvasX: real("canvas_x"),
    canvasY: real("canvas_y"),
    status: text("status").$type<OrgRoleStatus>().notNull().default("draft"),
    version: integer("version").notNull().default(1),
    /** Agente que ejecuta este rol ("convertir en rol en agente"), o null si aún lo ocupa solo una persona. */
    agentId: text("agent_id").references(() => agents.id),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [index("idx_org_roles_org").on(t.orgId), index("idx_org_roles_unit").on(t.unitId)],
);

export const roleFunctions = sqliteTable(
  "role_functions",
  {
    id: text("id").primaryKey(),
    roleId: text("role_id")
      .notNull()
      .references(() => orgRoles.id),
    name: text("name").notNull(),
    description: text("description"),
    position: integer("position").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [index("idx_role_functions_role").on(t.roleId)],
);

export const rolePeople = sqliteTable(
  "role_people",
  {
    roleId: text("role_id")
      .notNull()
      .references(() => orgRoles.id),
    personId: text("person_id")
      .notNull()
      .references(() => people.id),
    dedicationPct: integer("dedication_pct"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.roleId, t.personId], name: "pk_role_people" })],
);

export const roleProcesses = sqliteTable(
  "role_processes",
  {
    roleId: text("role_id")
      .notNull()
      .references(() => orgRoles.id),
    processId: text("process_id")
      .notNull()
      .references(() => processes.id),
    relation: text("relation").$type<RoleProcessRelation>().notNull().default("participant"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.roleId, t.processId], name: "pk_role_processes" })],
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

// ── Módulos de Fase (§13 — el producto que vende Sixteam) ───────────────────

/**
 * Versión INMUTABLE de un módulo de fase (§13.1): editar = insertar version+1
 * (patrón `prompt_versions`); nada se sobrescribe (CA-M1.2). `version` es
 * semántica Y token de `expected_version`. Una sola versión activa por slug
 * (índice único parcial).
 */
export const phaseModules = sqliteTable(
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
    /** null = la versión más alta al momento de disparar (§13.1). */
    methodologyVersion: integer("methodology_version"),
    /** Frontmatter completo CANONICALIZADO (claves ordenadas) — ES el blueprint. */
    blueprint: text("blueprint", { mode: "json" }).$type<ModuleBlueprint>().notNull(),
    /** sha256 hex del JSON canónico del blueprint. */
    blueprintHash: text("blueprint_hash").notNull(),
    bodyMd: text("body_md").notNull(),
    changelog: text("changelog"),
    seedFile: text("seed_file"),
    seedHash: text("seed_hash"),
    createdBy: text("created_by"),
    activatedAt: integer("activated_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("uq_phase_modules_slug_version").on(t.slug, t.version),
    /** Parcial: UNA sola versión activa por slug (§13.1). */
    uniqueIndex("uq_phase_modules_slug_active")
      .on(t.slug)
      .where(sql`status = 'active'`),
    index("idx_phase_modules_phase_status").on(t.phase, t.status),
  ],
);

/**
 * Recibo INMUTABLE append-only de un disparo (§13.1): FK a la fila de versión
 * concreta + slug/version desnormalizados + snapshot literal del blueprint +
 * hash — triple candado NM-3: editar el módulo después no toca proyectos
 * disparados. `uq(project_id, phase)`: una fase se dispara UNA vez por
 * proyecto (el retry idéntico lo cubre la idempotencia CA-M2.6).
 */
export const moduleLaunches = sqliteTable(
  "module_launches",
  {
    id: text("id").primaryKey(),
    moduleId: text("module_id")
      .notNull()
      .references(() => phaseModules.id),
    moduleSlug: text("module_slug").notNull(),
    moduleVersion: integer("module_version").notNull(),
    /** Desnormalizada del módulo ([SÍNTESIS] Codex) para el índice único de fase. */
    phase: text("phase").$type<Stage>().notNull(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    /** Copia LITERAL del blueprint al momento de disparar. */
    blueprintSnapshot: text("blueprint_snapshot", { mode: "json" })
      .$type<ModuleBlueprint>()
      .notNull(),
    blueprintHash: text("blueprint_hash").notNull(),
    /** Inputs literales, con los campos `sensitive` REDACTADOS (§13.1). */
    inputs: text("inputs", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    /** sha256 de los inputs SIN redactar (idempotencia CA-M2.6). */
    inputsDigest: text("inputs_digest").notNull(),
    toggles: text("toggles", { mode: "json" }).$type<Record<string, boolean>>().notNull(),
    /** Metodología PINNEADA del launch (la capa context la lee — wiring M3/M4). */
    methodologyId: text("methodology_id")
      .notNull()
      .references(() => methodologies.id),
    /** Qué se materializó: tasks con key→taskId, gate, budget. */
    result: text("result", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    taskCount: integer("task_count").notNull(),
    budgetPhaseUsd: real("budget_phase_usd").notNull(),
    budgetPerRunUsd: real("budget_per_run_usd").notNull(),
    /** Encadenado de fases (US-M3): launch de la fase anterior. */
    previousLaunchId: text("previous_launch_id").references(
      (): AnySQLiteColumn => moduleLaunches.id,
    ),
    idempotencyKey: text("idempotency_key").notNull(),
    actor: text("actor").notNull(),
    durationMs: integer("duration_ms").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("uq_module_launches_idempotency").on(t.idempotencyKey),
    /** Una fase solo se dispara una vez por proyecto ([SÍNTESIS] Codex). */
    uniqueIndex("uq_module_launches_project_phase").on(t.projectId, t.phase),
    index("idx_module_launches_module").on(t.moduleId),
  ],
);

// ── Linaje de la migración de Notion (docs/MIGRACION-NOTION-TASKS-PROJECTS.md §4) ──
//
// Cinco tablas de SOLO ANEXADO: conservan de dónde vino cada objeto nativo, el
// payload íntegro del origen (propiedades, bloques, comentarios y adjuntos), el
// enlace idempotente `(source_kind, notion_page_id)` y las excepciones. Nada de
// lo que Notion tenía y AgentOS no modela se pierde ni se inventa: o tiene
// columna nativa, o queda en el archivo, o queda en cuarentena con motivo.

/** Una corrida del importador. `manifest_hash` ata el destino al snapshot exacto. */
export const notionMigrationRuns = sqliteTable(
  "notion_migration_runs",
  {
    id: text("id").primaryKey(),
    /** Versión del esquema de Notion capturado (hash de las dos schema.json). */
    sourceSchemaVersion: text("source_schema_version").notNull(),
    capturedAt: integer("captured_at").notNull(),
    /** sha256 del manifiesto del snapshot importado. */
    manifestHash: text("manifest_hash").notNull(),
    /** Identificador de la carpeta del snapshot (no una ruta absoluta). */
    snapshotRunId: text("snapshot_run_id").notNull(),
    mode: text("mode").$type<"dry_run" | "pilot" | "full">().notNull(),
    status: text("status")
      .$type<"running" | "completed" | "completed_with_exceptions" | "failed">()
      .notNull()
      .default("running"),
    /** Informe de conciliación: conteos origen/destino y cuarentena por motivo. */
    report: text("report", { mode: "json" }).$type<Record<string, unknown>>(),
    /** Las corridas nunca se editan para corregir: se abre otra. */
    immutable: integer("immutable", { mode: "boolean" }).notNull().default(true),
    startedAt: integer("started_at").notNull(),
    finishedAt: integer("finished_at"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("idx_notion_migration_runs_snapshot").on(t.snapshotRunId)],
);

/**
 * Archivo histórico inmutable de una página de Notion. `payload` guarda el
 * origen íntegro para que la ficha "Historial de Notion" no dependa del volumen
 * del snapshot; los `raw_*_uri` conservan la ruta relativa dentro del snapshot.
 */
export const notionPageArchives = sqliteTable(
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
    /** {page, properties, blocks, comments, files} tal como los devolvió Notion. */
    payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    payloadHash: text("payload_hash").notNull(),
    capturedAt: integer("captured_at").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("uq_notion_page_archives_run_page").on(t.migrationRunId, t.sourceKind, t.notionPageId),
    index("idx_notion_page_archives_page").on(t.sourceKind, t.notionPageId),
  ],
);

/**
 * Enlace idempotente origen→destino. El índice único `(source_kind,
 * notion_page_id)` es LA clave de idempotencia: reintentar el importador
 * encuentra el enlace y actualiza, nunca crea un segundo objeto.
 */
export const notionImportLinks = sqliteTable(
  "notion_import_links",
  {
    id: text("id").primaryKey(),
    migrationRunId: text("migration_run_id")
      .notNull()
      .references(() => notionMigrationRuns.id),
    /** `inbox` marca el proyecto contenedor "Bandeja de Notion" de una organización. */
    sourceKind: text("source_kind").$type<"task" | "project" | "inbox">().notNull(),
    notionPageId: text("notion_page_id").notNull(),
    agentosObjectKind: text("agentos_object_kind").$type<"task" | "project">().notNull(),
    agentosObjectId: text("agentos_object_id").notNull(),
    archiveId: text("archive_id").references(() => notionPageArchives.id),
    importStatus: text("import_status")
      .$type<"imported" | "updated" | "inbox_container" | "skipped">()
      .notNull(),
    sourceLastEditedAt: integer("source_last_edited_at"),
    importedAt: integer("imported_at").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("uq_notion_import_links_source").on(t.sourceKind, t.notionPageId),
    index("idx_notion_import_links_object").on(t.agentosObjectKind, t.agentosObjectId),
    index("idx_notion_import_links_run").on(t.migrationRunId),
  ],
);

/**
 * Mapa `notion_person_id → people.id`. `match_method` NUNCA vale "name":
 * solo correo confirmado (`confirmed_email`) o decisión explícita del
 * administrador (`admin_decision`). Lo demás va a cuarentena.
 */
export const notionIdentityMappings = sqliteTable(
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
    reviewedAt: integer("reviewed_at"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [uniqueIndex("uq_notion_identity_mappings_person").on(t.notionPersonId)],
);

/** Excepción explícita: nada se silencia ni se adivina. */
export const notionImportQuarantine = sqliteTable(
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
    /** Referencia técnica (id de Notion, valor crudo); nunca contenido sensible. */
    rawReference: text("raw_reference"),
    resolutionState: text("resolution_state")
      .$type<"open" | "resolved" | "accepted">()
      .notNull()
      .default("open"),
    resolvedBy: text("resolved_by"),
    resolvedAt: integer("resolved_at"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    /**
     * `raw_reference` entra en la clave: dos responsables sin resolver en la
     * MISMA tarea son dos excepciones distintas, no una fila que se traga la
     * segunda. Nada se colapsa en silencio.
     */
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
