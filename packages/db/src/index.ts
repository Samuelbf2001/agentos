// @agentos/db — persistencia AgentOS (SQLite + Drizzle).
// Regla dura (ARCHITECTURE §5): NINGUNA consulta fuera de src/repositories/
// (search.ts es la única otra puerta, y solo para FTS).
export { openDb, closeDb, resolveDbPath, REPO_ROOT, schema, type AgentosDb } from "./client.js";
export { runMigrations } from "./migrate.js";
export * from "./types.js";
export * from "./search.js";
export * from "./seed-sources.js";
export { seed, countDomainTables, type SeedCounts } from "./seed.js";

export * from "./repositories/organizations-people.js";
export * from "./repositories/projects.js";
export * from "./repositories/providers.js";
export * from "./repositories/agents.js";
export * from "./repositories/tasks.js";
export * from "./repositories/runs.js";
export * from "./repositories/events.js";
export * from "./repositories/threads.js";
export * from "./repositories/approvals.js";
export * from "./repositories/audit.js";
export * from "./repositories/knowledge.js";
export * from "./repositories/project-sources.js";
export * from "./repositories/processes.js";
export * from "./repositories/methodologies.js";
export * from "./repositories/config.js";
