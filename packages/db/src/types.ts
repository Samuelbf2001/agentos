/** Tipos inferidos del esquema — únicos tipos de fila que circulan fuera de packages/db. */
import type * as s from "./schema.js";

export type Organization = typeof s.organizations.$inferSelect;
export type NewOrganization = typeof s.organizations.$inferInsert;
export type Person = typeof s.people.$inferSelect;
export type NewPerson = typeof s.people.$inferInsert;
export type Project = typeof s.projects.$inferSelect;
export type NewProject = typeof s.projects.$inferInsert;
export type ProviderProfile = typeof s.providerProfiles.$inferSelect;
export type NewProviderProfile = typeof s.providerProfiles.$inferInsert;
export type Agent = typeof s.agents.$inferSelect;
export type NewAgent = typeof s.agents.$inferInsert;
export type PromptVersion = typeof s.promptVersions.$inferSelect;
export type NewPromptVersion = typeof s.promptVersions.$inferInsert;
export type Task = typeof s.tasks.$inferSelect;
export type NewTask = typeof s.tasks.$inferInsert;
/** Campos opcionales de la nueva escritura multi-responsable. */
export interface TaskAssigneeSelectionInput {
  assigneePersonIds?: readonly string[];
  primaryAssigneePersonId?: string | null;
  assignedBy?: string;
}
export type TaskCreateInput = Omit<NewTask, "id" | "createdAt" | "updatedAt" | "version"> &
  TaskAssigneeSelectionInput & { id?: string };
export type TaskAssignee = typeof s.taskAssignees.$inferSelect;
export type NewTaskAssignee = typeof s.taskAssignees.$inferInsert;
export type TaskLabel = typeof s.taskLabels.$inferSelect;
export type NewTaskLabel = typeof s.taskLabels.$inferInsert;
export type TaskNotificationKind = "assignment" | "due_24h";
export type TaskNotificationStatus = "pending" | "processing" | "delivered" | "failed" | "suppressed";
export type TaskNotificationLog = typeof s.taskNotificationLog.$inferSelect;
export type NewTaskNotificationLog = typeof s.taskNotificationLog.$inferInsert;
export type TaskEvent = typeof s.taskEvents.$inferSelect;
export type NewTaskEvent = typeof s.taskEvents.$inferInsert;
export type Artifact = typeof s.artifacts.$inferSelect;
export type NewArtifact = typeof s.artifacts.$inferInsert;
export type Thread = typeof s.threads.$inferSelect;
export type NewThread = typeof s.threads.$inferInsert;
export type Message = typeof s.messages.$inferSelect;
export type NewMessage = typeof s.messages.$inferInsert;
export type Run = typeof s.runs.$inferSelect;
export type NewRun = typeof s.runs.$inferInsert;
export type Span = typeof s.spans.$inferSelect;
export type NewSpan = typeof s.spans.$inferInsert;
export type PersistedEvent = typeof s.events.$inferSelect;
export type NewPersistedEvent = typeof s.events.$inferInsert;
export type Approval = typeof s.approvals.$inferSelect;
export type NewApproval = typeof s.approvals.$inferInsert;
export type AuditEntry = typeof s.auditLog.$inferSelect;
export type NewAuditEntry = typeof s.auditLog.$inferInsert;
export type AppConfigRow = typeof s.appConfig.$inferSelect;
export type KnowledgeDoc = typeof s.knowledgeDocs.$inferSelect;
export type NewKnowledgeDoc = typeof s.knowledgeDocs.$inferInsert;
export type ProjectSource = typeof s.projectSources.$inferSelect;
export type NewProjectSource = typeof s.projectSources.$inferInsert;
export type Process = typeof s.processes.$inferSelect;
export type NewProcess = typeof s.processes.$inferInsert;

// ── Grafo organizacional ─────────────────────────────────────────────────────
export type OrgUnit = typeof s.orgUnits.$inferSelect;
export type NewOrgUnit = typeof s.orgUnits.$inferInsert;
export type OrgRole = typeof s.orgRoles.$inferSelect;
export type NewOrgRole = typeof s.orgRoles.$inferInsert;
export type RoleFunction = typeof s.roleFunctions.$inferSelect;
export type NewRoleFunction = typeof s.roleFunctions.$inferInsert;
export type RolePerson = typeof s.rolePeople.$inferSelect;
export type NewRolePerson = typeof s.rolePeople.$inferInsert;
export type RoleProcess = typeof s.roleProcesses.$inferSelect;
export type NewRoleProcess = typeof s.roleProcesses.$inferInsert;

export type Methodology = typeof s.methodologies.$inferSelect;
export type NewMethodology = typeof s.methodologies.$inferInsert;
export type PhaseModule = typeof s.phaseModules.$inferSelect;
export type NewPhaseModule = typeof s.phaseModules.$inferInsert;
export type ModuleLaunch = typeof s.moduleLaunches.$inferSelect;
export type NewModuleLaunch = typeof s.moduleLaunches.$inferInsert;

// ── Linaje de la migración de Notion ────────────────────────────────────────
/** `task` y `project` son las dos fuentes canónicas capturadas de Notion. */
export type NotionSourceKind = "task" | "project";
export type NotionMigrationRun = typeof s.notionMigrationRuns.$inferSelect;
export type NewNotionMigrationRun = typeof s.notionMigrationRuns.$inferInsert;
export type NotionPageArchive = typeof s.notionPageArchives.$inferSelect;
export type NewNotionPageArchive = typeof s.notionPageArchives.$inferInsert;
export type NotionImportLink = typeof s.notionImportLinks.$inferSelect;
export type NewNotionImportLink = typeof s.notionImportLinks.$inferInsert;
export type NotionIdentityMapping = typeof s.notionIdentityMappings.$inferSelect;
export type NewNotionIdentityMapping = typeof s.notionIdentityMappings.$inferInsert;
export type NotionImportQuarantine = typeof s.notionImportQuarantine.$inferSelect;
export type NewNotionImportQuarantine = typeof s.notionImportQuarantine.$inferInsert;

// ── Notas manuscritas (lienzo Excalidraw) ────────────────────────────────────
export type CanvasNote = typeof s.canvasNotes.$inferSelect;
export type NewCanvasNote = typeof s.canvasNotes.$inferInsert;
