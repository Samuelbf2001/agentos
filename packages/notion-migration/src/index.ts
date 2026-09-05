export { parseEnvText, resolveSnapshotSettings, SnapshotConfigError, type SnapshotSettings } from "./config.js";
export {
  NotionApiReader,
  NotionReadError,
  type DownloadedFile,
  type JsonObject,
  type NotionReader,
  type QueryDatabaseOptions,
} from "./notion-client.js";
export { createNotionSnapshot, type SnapshotManifest, type SnapshotOptions, type SnapshotSource } from "./snapshot.js";

// Mapa de campos: la única fuente de las decisiones de traducción Notion → AgentOS.
export {
  bindProjectSchema,
  bindTaskSchema,
  DEPENDENCY_RELATION_NAMES,
  IMPORT_DEFAULTS,
  INBOX_PROJECT_NAME,
  INVERSE_DEPENDENCY_RELATION_NAMES,
  mapDueDate,
  mapProjectPage,
  mapTaskPage,
  mapTaskPriority,
  mapTaskStatus,
  nextOrderKey,
  normalizeNotionId,
  NOTION_PRIORITY_TO_TASK_PRIORITY,
  NOTION_STATUS_TO_TASK_STATUS,
  plainText,
  PROJECT_FIELDS_WITHOUT_TARGET,
  readPeople,
  readRelationIds,
  resolveIdentity,
  TASK_FIELDS_WITHOUT_TARGET,
  type FieldException,
  type MappedProject,
  type MappedTask,
  type NotionPerson,
  type ProjectSchemaBinding,
  type TaskSchemaBinding,
} from "./field-map.js";

export {
  SnapshotReader,
  SnapshotReadError,
  sha256,
  sourceSchemaVersion,
  type SnapshotManifestFile,
  type SnapshotPage,
  type SnapshotSourceKey,
} from "./snapshot-reader.js";

export {
  featuresOf,
  readPilotCandidates,
  selectPilot,
  type PilotCandidate,
  type PilotFeature,
  type PilotSelection,
} from "./pilot-selection.js";

export { importNotionSnapshot, type ImportOptions, type ImportReport, type PilotLimits } from "./importer.js";
