/**
 * Repositorios: la superficie ASÍNCRONA dual de `@agentos/db`.
 *
 *   SQLite (default, cero fricción)  →  src/repositories/*      (síncronos)
 *   Postgres/Supabase (opt-in)       →  src/pg/repositories/*   (asíncronos)
 *
 * Cada export de aquí es la MISMA función de siempre —mismo nombre, mismos
 * argumentos, mismos tipos de fila (NFR-9)— pero devuelve una promesa, porque
 * no existe driver Postgres síncrono en Node (docs/POSTGRES.md §5). El despacho
 * por motor lo hace `facade.ts` mirando el handle recibido; ningún llamante
 * ramifica.
 *
 * Vive en un módulo aparte de `index.ts` para que el motor de launch y el seed
 * puedan importarlo sin ciclo.
 */
import {
  dual,
  isPgDb,
  requirePgBackend,
  type AnyDb,
  type PgBackend,
} from "./facade.js";
import type { AgentosSqliteDb } from "./client.js";
import type { KnowledgeSearchHit } from "./search.js";

import * as liteAgents from "./repositories/agents.js";
import * as liteApprovals from "./repositories/approvals.js";
import * as liteAudit from "./repositories/audit.js";
import * as liteConfig from "./repositories/config.js";
import * as liteEvents from "./repositories/events.js";
import * as liteKnowledge from "./repositories/knowledge.js";
import * as liteMethodologies from "./repositories/methodologies.js";
import * as liteModules from "./repositories/modules.js";
import * as liteOrgs from "./repositories/organizations-people.js";
import * as liteProcesses from "./repositories/processes.js";
import * as liteProjectSources from "./repositories/project-sources.js";
import * as liteProjects from "./repositories/projects.js";
import * as liteProviders from "./repositories/providers.js";
import * as liteRuns from "./repositories/runs.js";
import * as liteStats from "./repositories/stats.js";
import * as liteAssignees from "./repositories/task-assignees.js";
import * as liteLabels from "./repositories/task-labels.js";
import * as liteNotion from "./repositories/notion-migration.js";
import * as liteNotifications from "./repositories/task-notifications.js";
import * as liteTasks from "./repositories/tasks.js";
import * as liteThreads from "./repositories/threads.js";
import * as liteSearch from "./search.js";

// Tipos (no valores) de cada repositorio: interfaces de entrada/salida.
export type * from "./repositories/agents.js";
export type * from "./repositories/approvals.js";
export type * from "./repositories/audit.js";
export type * from "./repositories/config.js";
export type * from "./repositories/events.js";
export type * from "./repositories/knowledge.js";
export type * from "./repositories/methodologies.js";
export type * from "./repositories/modules.js";
export type * from "./repositories/organizations-people.js";
export type * from "./repositories/processes.js";
export type * from "./repositories/project-sources.js";
export type * from "./repositories/projects.js";
export type * from "./repositories/providers.js";
export type * from "./repositories/runs.js";
export type * from "./repositories/stats.js";
export type * from "./repositories/task-assignees.js";
export type * from "./repositories/task-labels.js";
export type * from "./repositories/notion-migration.js";
export type * from "./repositories/task-notifications.js";
export type * from "./repositories/tasks.js";
export type * from "./repositories/threads.js";

// ── Funciones PURAS (no tocan la DB): mismas en los dos motores ─────────────

export { digestPayload, verifyApprovalDigest } from "./repositories/approvals.js";
export { ConfigKeys } from "./repositories/config.js";
export { isProviderConfigured } from "./repositories/providers.js";
export { normalizeNewTaskAssignees } from "./repositories/task-assignees.js";
export {
  normalizeLabel,
  normalizeLabels,
  MAX_LABEL_LENGTH,
  MAX_LABELS_PER_TASK,
} from "./repositories/task-labels.js";
export { buildSessionKey } from "./repositories/threads.js";

// ── Agentes y prompts ───────────────────────────────────────────────────────

export const createAgent = dual(liteAgents.createAgent, "createAgent");
export const getAgent = dual(liteAgents.getAgent, "getAgent");
export const getAgentBySlug = dual(liteAgents.getAgentBySlug, "getAgentBySlug");
export const listAgents = dual(liteAgents.listAgents, "listAgents");
export const updateAgent = dual(liteAgents.updateAgent, "updateAgent");
export const upsertAgentFromSeed = dual(liteAgents.upsertAgentFromSeed, "upsertAgentFromSeed");
export const createPromptVersion = dual(liteAgents.createPromptVersion, "createPromptVersion");
export const getPromptVersion = dual(liteAgents.getPromptVersion, "getPromptVersion");
export const getActivePrompt = dual(liteAgents.getActivePrompt, "getActivePrompt");
export const listPromptVersions = dual(liteAgents.listPromptVersions, "listPromptVersions");
export const activatePromptVersion = dual(
  liteAgents.activatePromptVersion,
  "activatePromptVersion",
);

// ── Aprobaciones (Gate 2) ───────────────────────────────────────────────────

export const createApproval = dual(liteApprovals.createApproval, "createApproval");
export const getApproval = dual(liteApprovals.getApproval, "getApproval");
export const listPendingApprovals = dual(liteApprovals.listPendingApprovals, "listPendingApprovals");
export const decideApproval = dual(liteApprovals.decideApproval, "decideApproval");
export const listReconcilableApprovals = dual(
  liteApprovals.listReconcilableApprovals,
  "listReconcilableApprovals",
);
export const claimApprovalReconciliation = dual(
  liteApprovals.claimApprovalReconciliation,
  "claimApprovalReconciliation",
);

// ── Auditoría ───────────────────────────────────────────────────────────────

export const appendAudit = dual(liteAudit.appendAudit, "appendAudit");
export const queryAudit = dual(liteAudit.queryAudit, "queryAudit");
export const getAuditEntry = dual(liteAudit.getAuditEntry, "getAuditEntry");
export const findAuditByIdempotencyKey = dual(
  liteAudit.findAuditByIdempotencyKey,
  "findAuditByIdempotencyKey",
);

// ── Config (kill switch, presupuestos) ──────────────────────────────────────

/** Genérica a mano: `dual` no puede propagar el parámetro de tipo `T`. */
export async function getConfig<T = unknown>(db: AnyDb, key: string): Promise<T | undefined> {
  if (isPgDb(db)) return (await requirePgBackend()).getConfig<T>(db, key);
  return liteConfig.getConfig<T>(db as AgentosSqliteDb, key);
}
export const setConfig = dual(liteConfig.setConfig, "setConfig");
export const listConfig = dual(liteConfig.listConfig, "listConfig");

// ── Eventos persistidos (stream AG-UI) ──────────────────────────────────────

export const appendEvent = dual(liteEvents.appendEvent, "appendEvent");
export const listEventsSince = dual(liteEvents.listEventsSince, "listEventsSince");
export const lastSeq = dual(liteEvents.lastSeq, "lastSeq");

// ── Context Hub ─────────────────────────────────────────────────────────────

export const createDoc = dual(liteKnowledge.createDoc, "createDoc");
export const upsertDoc = dual(liteKnowledge.upsertDoc, "upsertDoc");
export const getDoc = dual(liteKnowledge.getDoc, "getDoc");
export const listDocs = dual(liteKnowledge.listDocs, "listDocs");
export const countDocs = dual(liteKnowledge.countDocs, "countDocs");
/** Palabras: FTS5 en SQLite, tsvector en Postgres. Mismo contrato de `rank`. */
export const searchDocs = dual(liteKnowledge.searchDocs, "searchDocs");

export type KnowledgeSemanticHit = KnowledgeSearchHit & { distance: number; score: number };
export interface KnowledgeSemanticResult {
  mode: "vector" | "keyword";
  hits: KnowledgeSemanticHit[];
  degradedReason?: string;
}

/**
 * Búsqueda SEMÁNTICA del Context Hub. En Postgres usa pgvector (y degrada a
 * tsvector sin embedder); en SQLite **no hay semántica** y se degrada a FTS5
 * diciéndolo — el llamante no ramifica por motor, solo mira `mode`.
 */
export async function semanticSearchDocs(
  db: AnyDb,
  query: string,
  k = 10,
  opts: Parameters<PgBackend["semanticSearchDocs"]>[3] = {},
): Promise<KnowledgeSemanticResult> {
  if (isPgDb(db)) {
    return (await requirePgBackend()).semanticSearchDocs(db, query, k, opts);
  }
  const hits = liteSearch.searchKnowledge(db as AgentosSqliteDb, query, k);
  return {
    mode: "keyword",
    hits: hits.map((h) => ({ ...h, distance: Number.NaN, score: Number.NaN })),
    degradedReason:
      "El backend SQLite no tiene búsqueda vectorial: se usó FTS5 (palabras). " +
      "Para semántica hay que arrancar con AGENTOS_DB_DRIVER=postgres + pgvector.",
  };
}

// ── Metodologías ────────────────────────────────────────────────────────────

export const upsertMethodology = dual(liteMethodologies.upsertMethodology, "upsertMethodology");
export const getMethodology = dual(liteMethodologies.getMethodology, "getMethodology");
export const listMethodologies = dual(liteMethodologies.listMethodologies, "listMethodologies");

// ── Módulos de Fase y sus recibos ───────────────────────────────────────────

export const getPhaseModuleById = dual(liteModules.getPhaseModuleById, "getPhaseModuleById");
export const getActiveModule = dual(liteModules.getActiveModule, "getActiveModule");
export const getModuleVersion = dual(liteModules.getModuleVersion, "getModuleVersion");
export const listPhaseModules = dual(liteModules.listPhaseModules, "listPhaseModules");
export const createModuleVersion = dual(liteModules.createModuleVersion, "createModuleVersion");
export const moduleBlueprintDbIssues = dual(
  liteModules.moduleBlueprintDbIssues,
  "moduleBlueprintDbIssues",
);
export const activateModuleVersion = dual(
  liteModules.activateModuleVersion,
  "activateModuleVersion",
);
export const archiveModuleVersion = dual(liteModules.archiveModuleVersion, "archiveModuleVersion");
export const upsertPhaseModuleFromSeed = dual(
  liteModules.upsertPhaseModuleFromSeed,
  "upsertPhaseModuleFromSeed",
);
export const getLaunch = dual(liteModules.getLaunch, "getLaunch");
export const insertModuleLaunch = dual(liteModules.insertModuleLaunch, "insertModuleLaunch");
export const findLaunchByProjectAndPhase = dual(
  liteModules.findLaunchByProjectAndPhase,
  "findLaunchByProjectAndPhase",
);
export const findLaunchByIdempotencyKey = dual(
  liteModules.findLaunchByIdempotencyKey,
  "findLaunchByIdempotencyKey",
);
export const getLatestLaunchForProject = dual(
  liteModules.getLatestLaunchForProject,
  "getLatestLaunchForProject",
);
export const listLaunches = dual(liteModules.listLaunches, "listLaunches");

// ── Organizaciones y personas ───────────────────────────────────────────────

export const createOrganization = dual(liteOrgs.createOrganization, "createOrganization");
export const getOrganization = dual(liteOrgs.getOrganization, "getOrganization");
export const getOrganizationByName = dual(liteOrgs.getOrganizationByName, "getOrganizationByName");
export const listOrganizations = dual(liteOrgs.listOrganizations, "listOrganizations");
export const updateOrganization = dual(liteOrgs.updateOrganization, "updateOrganization");
export const createPerson = dual(liteOrgs.createPerson, "createPerson");
export const getPerson = dual(liteOrgs.getPerson, "getPerson");
export const getPersonByFullName = dual(liteOrgs.getPersonByFullName, "getPersonByFullName");
export const listPeople = dual(liteOrgs.listPeople, "listPeople");
export const updatePerson = dual(liteOrgs.updatePerson, "updatePerson");
export const listInternalPeople = dual(liteOrgs.listInternalPeople, "listInternalPeople");
/** Asignables a un proyecto: la org del proyecto MÁS el equipo interno (I3). */
export const listAssignablePeople = dual(liteOrgs.listAssignablePeople, "listAssignablePeople");

// ── Procesos ────────────────────────────────────────────────────────────────

export const createProcess = dual(liteProcesses.createProcess, "createProcess");
export const upsertProcess = dual(liteProcesses.upsertProcess, "upsertProcess");
export const getProcess = dual(liteProcesses.getProcess, "getProcess");
export const listProcesses = dual(liteProcesses.listProcesses, "listProcesses");
export const countProcesses = dual(liteProcesses.countProcesses, "countProcesses");
export const linkSource = dual(liteProcesses.linkSource, "linkSource");

// ── Fuentes del proyecto ────────────────────────────────────────────────────

export const createProjectSource = dual(
  liteProjectSources.createProjectSource,
  "createProjectSource",
);
export const getProjectSource = dual(liteProjectSources.getProjectSource, "getProjectSource");
export const listProjectSources = dual(liteProjectSources.listProjectSources, "listProjectSources");
export const findProjectSourceByExternalRef = dual(
  liteProjectSources.findProjectSourceByExternalRef,
  "findProjectSourceByExternalRef",
);
export const updateProjectSource = dual(
  liteProjectSources.updateProjectSource,
  "updateProjectSource",
);

// ── Proyectos ───────────────────────────────────────────────────────────────

export const createProject = dual(liteProjects.createProject, "createProject");
export const getProject = dual(liteProjects.getProject, "getProject");
export const getProjectByName = dual(liteProjects.getProjectByName, "getProjectByName");
export const getProjectByOrgAndName = dual(
  liteProjects.getProjectByOrgAndName,
  "getProjectByOrgAndName",
);
export const listProjects = dual(liteProjects.listProjects, "listProjects");
export const updateProject = dual(liteProjects.updateProject, "updateProject");
export const setGateState = dual(liteProjects.setGateState, "setGateState");

// ── Perfiles de proveedor ───────────────────────────────────────────────────

export const upsertProviderProfile = dual(
  liteProviders.upsertProviderProfile,
  "upsertProviderProfile",
);
export const getProviderProfile = dual(liteProviders.getProviderProfile, "getProviderProfile");
export const getProviderProfileBySlug = dual(
  liteProviders.getProviderProfileBySlug,
  "getProviderProfileBySlug",
);
export const listProviderProfiles = dual(liteProviders.listProviderProfiles, "listProviderProfiles");
export const getDefaultProviderProfile = dual(
  liteProviders.getDefaultProviderProfile,
  "getDefaultProviderProfile",
);

// ── Runs y spans ────────────────────────────────────────────────────────────

export const createRun = dual(liteRuns.createRun, "createRun");
export const getRun = dual(liteRuns.getRun, "getRun");
export const updateRun = dual(liteRuns.updateRun, "updateRun");
export const listRunsByRoot = dual(liteRuns.listRunsByRoot, "listRunsByRoot");
export const listRunsForTask = dual(liteRuns.listRunsForTask, "listRunsForTask");
export const listRunsByStatus = dual(liteRuns.listRunsByStatus, "listRunsByStatus");
export const sumRunCostBetween = dual(liteRuns.sumRunCostBetween, "sumRunCostBetween");
export const sumRunCostForProject = dual(liteRuns.sumRunCostForProject, "sumRunCostForProject");
export const listRuns = dual(liteRuns.listRuns, "listRuns");
export const addSpan = dual(liteRuns.addSpan, "addSpan");
export const endSpan = dual(liteRuns.endSpan, "endSpan");
export const listSpans = dual(liteRuns.listSpans, "listSpans");

// ── Contadores de dominio (salud + seed) ────────────────────────────────────

export const domainCounts = dual(liteStats.domainCounts, "domainCounts");
export const countDomainTables = dual(liteStats.countDomainTables, "countDomainTables");

// ── Responsables de tarea ───────────────────────────────────────────────────

export const listTaskAssignees = dual(liteAssignees.listTaskAssignees, "listTaskAssignees");
export const getPrimaryTaskAssignee = dual(
  liteAssignees.getPrimaryTaskAssignee,
  "getPrimaryTaskAssignee",
);
export const getTaskWithAssignees = dual(liteAssignees.getTaskWithAssignees, "getTaskWithAssignees");
export const listTasksWithAssignees = dual(
  liteAssignees.listTasksWithAssignees,
  "listTasksWithAssignees",
);
export const boardTasksWithAssignees = dual(
  liteAssignees.boardTasksWithAssignees,
  "boardTasksWithAssignees",
);
export const validateTaskAssigneeOrganization = dual(
  liteAssignees.validateTaskAssigneeOrganization,
  "validateTaskAssigneeOrganization",
);
export const insertTaskAssigneeRows = dual(
  liteAssignees.insertTaskAssigneeRows,
  "insertTaskAssigneeRows",
);
export const synchronizeTaskAssignees = dual(
  liteAssignees.synchronizeTaskAssignees,
  "synchronizeTaskAssignees",
);
export const backfillTaskAssignees = dual(
  liteAssignees.backfillTaskAssignees,
  "backfillTaskAssignees",
);

/** Reemplazo atómico de responsables. Mismas dos formas de llamada de siempre. */
export function replaceTaskAssignees(
  db: AnyDb,
  taskId: string,
  input: liteAssignees.ReplaceTaskAssigneesInput | liteAssignees.ReplaceTaskAssigneesObjectInput,
  expectedVersion: number,
): Promise<liteAssignees.TaskWithAssignees>;
export function replaceTaskAssignees(
  db: AnyDb,
  taskId: string,
  personIds: readonly string[],
  primaryPersonId: string | null | undefined,
  expectedVersion: number,
  assignedBy?: string,
): Promise<liteAssignees.TaskWithAssignees>;
export async function replaceTaskAssignees(
  db: AnyDb,
  ...args: unknown[]
): Promise<liteAssignees.TaskWithAssignees> {
  if (isPgDb(db)) {
    const pg = await requirePgBackend();
    return (pg.replaceTaskAssignees as unknown as (...a: unknown[]) => Promise<unknown>)(
      db,
      ...args,
    ) as Promise<liteAssignees.TaskWithAssignees>;
  }
  return (liteAssignees.replaceTaskAssignees as unknown as (...a: unknown[]) => unknown)(
    db,
    ...args,
  ) as liteAssignees.TaskWithAssignees;
}
/** Alias de dominio para callers que prefieren el verbo `assign`. */
export const assignTaskPeople = replaceTaskAssignees;

// ── Avisos de tarea ─────────────────────────────────────────────────────────

export const getTaskNotificationLog = dual(
  liteNotifications.getTaskNotificationLog,
  "getTaskNotificationLog",
);
export const getTaskNotificationLogByDedupeKey = dual(
  liteNotifications.getTaskNotificationLogByDedupeKey,
  "getTaskNotificationLogByDedupeKey",
);
export const listTaskNotificationLogs = dual(
  liteNotifications.listTaskNotificationLogs,
  "listTaskNotificationLogs",
);
export const listPendingTaskNotifications = dual(
  liteNotifications.listPendingTaskNotifications,
  "listPendingTaskNotifications",
);
export const createTaskNotificationLog = dual(
  liteNotifications.createTaskNotificationLog,
  "createTaskNotificationLog",
);
export const claimTaskNotificationLog = dual(
  liteNotifications.claimTaskNotificationLog,
  "claimTaskNotificationLog",
);
export const claimTaskNotificationLogByDedupeKey = dual(
  liteNotifications.claimTaskNotificationLogByDedupeKey,
  "claimTaskNotificationLogByDedupeKey",
);
export const markTaskNotificationDelivered = dual(
  liteNotifications.markTaskNotificationDelivered,
  "markTaskNotificationDelivered",
);
export const updateTaskNotificationLog = dual(
  liteNotifications.updateTaskNotificationLog,
  "updateTaskNotificationLog",
);
export const markTaskNotificationFailed = dual(
  liteNotifications.markTaskNotificationFailed,
  "markTaskNotificationFailed",
);
export const suppressTaskNotification = dual(
  liteNotifications.suppressTaskNotification,
  "suppressTaskNotification",
);
// Alias históricos (los usan rutas y tests): mismos objetos, otro nombre.
export const getNotificationLogByDedupeKey = getTaskNotificationLogByDedupeKey;
export const getNotificationLog = getTaskNotificationLog;
export const listNotificationLogs = listTaskNotificationLogs;
export const listDueTaskNotificationLogs = listPendingTaskNotifications;
export const createNotificationLog = createTaskNotificationLog;
export const createTaskNotification = createTaskNotificationLog;
export const claimNotificationLog = claimTaskNotificationLog;
export const claimTaskNotification = claimTaskNotificationLog;

// ── Tareas, timeline y artefactos ───────────────────────────────────────────

export const createTask = dual(liteTasks.createTask, "createTask");
export const getTask = dual(liteTasks.getTask, "getTask");
export const listTasks = dual(liteTasks.listTasks, "listTasks");
export const boardTasks = dual(liteTasks.boardTasks, "boardTasks");
export const updateTask = dual(liteTasks.updateTask, "updateTask");
export const claimTask = dual(liteTasks.claimTask, "claimTask");
export const renewLease = dual(liteTasks.renewLease, "renewLease");
export const reapExpiredLeases = dual(liteTasks.reapExpiredLeases, "reapExpiredLeases");
export const listDispatchableTasks = dual(liteTasks.listDispatchableTasks, "listDispatchableTasks");
export const countOpenTasksByAgent = dual(liteTasks.countOpenTasksByAgent, "countOpenTasksByAgent");
export const appendTaskEvent = dual(liteTasks.appendTaskEvent, "appendTaskEvent");
export const listTaskEvents = dual(liteTasks.listTaskEvents, "listTaskEvents");
export const attachArtifact = dual(liteTasks.attachArtifact, "attachArtifact");
export const getArtifact = dual(liteTasks.getArtifact, "getArtifact");
export const listArtifacts = dual(liteTasks.listArtifacts, "listArtifacts");
export const countArtifacts = dual(liteTasks.countArtifacts, "countArtifacts");
export const maxOrderKey = dual(liteTasks.maxOrderKey, "maxOrderKey");
export const transitionTaskStatus = dual(liteTasks.transitionTaskStatus, "transitionTaskStatus");
export const countDelegations = dual(liteTasks.countDelegations, "countDelegations");
export const countOpenTasksByTemplateKey = dual(
  liteTasks.countOpenTasksByTemplateKey,
  "countOpenTasksByTemplateKey",
);
export const countProjectArtifactsByKind = dual(
  liteTasks.countProjectArtifactsByKind,
  "countProjectArtifactsByKind",
);
export const findLatestProjectArtifact = dual(
  liteTasks.findLatestProjectArtifact,
  "findLatestProjectArtifact",
);

// ── Hilos y mensajes ────────────────────────────────────────────────────────

export const getThreadBySessionKey = dual(liteThreads.getThreadBySessionKey, "getThreadBySessionKey");
export const getThread = dual(liteThreads.getThread, "getThread");
export const getOrCreateThread = dual(liteThreads.getOrCreateThread, "getOrCreateThread");
export const setThreadProject = dual(liteThreads.setThreadProject, "setThreadProject");
export const listThreads = dual(liteThreads.listThreads, "listThreads");
export const appendMessage = dual(liteThreads.appendMessage, "appendMessage");
export const findChannelMessage = dual(liteThreads.findChannelMessage, "findChannelMessage");
export const getMessage = dual(liteThreads.getMessage, "getMessage");
export const listMessages = dual(liteThreads.listMessages, "listMessages");

// ── Búsqueda de texto ───────────────────────────────────────────────────────

export const searchMessages = dual(liteSearch.searchMessages, "searchMessagesPg");
export const searchKnowledge = dual(liteSearch.searchKnowledge, "searchKnowledgePg");

// ── Etiquetas de tarea (tabla puente `task_labels`) ─────────────────────────

export const listTaskLabels = dual(liteLabels.listTaskLabels, "listTaskLabels");
export const listLabelsForTasks = dual(liteLabels.listLabelsForTasks, "listLabelsForTasks");
export const replaceTaskLabels = dual(liteLabels.replaceTaskLabels, "replaceTaskLabels");
export const addTaskLabels = dual(liteLabels.addTaskLabels, "addTaskLabels");
export const removeTaskLabel = dual(liteLabels.removeTaskLabel, "removeTaskLabel");
export const listLabelCatalog = dual(liteLabels.listLabelCatalog, "listLabelCatalog");
export const listTaskLabelRows = dual(liteLabels.listTaskLabelRows, "listTaskLabelRows");

// ── Linaje de la migración de Notion (5 tablas) ─────────────────────────────

export const createNotionMigrationRun = dual(
  liteNotion.createNotionMigrationRun,
  "createNotionMigrationRun",
);
export const getNotionMigrationRun = dual(liteNotion.getNotionMigrationRun, "getNotionMigrationRun");
export const listNotionMigrationRuns = dual(
  liteNotion.listNotionMigrationRuns,
  "listNotionMigrationRuns",
);
export const finishNotionMigrationRun = dual(
  liteNotion.finishNotionMigrationRun,
  "finishNotionMigrationRun",
);
export const createNotionPageArchive = dual(
  liteNotion.createNotionPageArchive,
  "createNotionPageArchive",
);
export const getNotionPageArchive = dual(liteNotion.getNotionPageArchive, "getNotionPageArchive");
export const getLatestNotionPageArchive = dual(
  liteNotion.getLatestNotionPageArchive,
  "getLatestNotionPageArchive",
);
export const findNotionImportLink = dual(liteNotion.findNotionImportLink, "findNotionImportLink");
export const findNotionImportLinkByObject = dual(
  liteNotion.findNotionImportLinkByObject,
  "findNotionImportLinkByObject",
);
export const upsertNotionImportLink = dual(
  liteNotion.upsertNotionImportLink,
  "upsertNotionImportLink",
);
export const listNotionImportLinks = dual(liteNotion.listNotionImportLinks, "listNotionImportLinks");
export const listNotionImportLinksByPages = dual(
  liteNotion.listNotionImportLinksByPages,
  "listNotionImportLinksByPages",
);
export const findNotionIdentityMapping = dual(
  liteNotion.findNotionIdentityMapping,
  "findNotionIdentityMapping",
);
export const upsertNotionIdentityMapping = dual(
  liteNotion.upsertNotionIdentityMapping,
  "upsertNotionIdentityMapping",
);
export const listNotionIdentityMappings = dual(
  liteNotion.listNotionIdentityMappings,
  "listNotionIdentityMappings",
);
export const recordNotionQuarantine = dual(
  liteNotion.recordNotionQuarantine,
  "recordNotionQuarantine",
);
export const listNotionQuarantine = dual(liteNotion.listNotionQuarantine, "listNotionQuarantine");
export const getNotionOrigin = dual(liteNotion.getNotionOrigin, "getNotionOrigin");

// ── Búsqueda de tareas ──────────────────────────────────────────────────────

/**
 * Tarjetas y comentarios: FTS5 en SQLite, columnas `tsvector` generadas en
 * Postgres (`ensurePgSearch`, que corre en cada `applyMigrations`). Misma
 * forma de `TaskSearchHit` y mismo criterio de rank (menor = mejor); si en PG
 * las columnas todavía no existen, `searchTasksPg` degrada a ILIKE en vez de
 * dejar el motor sin búsqueda.
 */
export const searchTasks = dual(liteSearch.searchTasks, "searchTasksPg");
export type { TaskSearchHit, TaskSearchOptions } from "./search.js";
