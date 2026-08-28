// @agentos/mcp-admin — servidor MCP de administración "editar casi todo"
// (ARCHITECTURE §7): doble transporte (stdio + streamable HTTP 127.0.0.1),
// dos perfiles (rw/ro) sobre la misma base de código, capa fina sobre
// @agentos/core y los repositorios de @agentos/db.
export {
  createAdminContext,
  parseProfile,
  persistentEventSink,
  auditMutation,
  findIdempotentMutation,
  mustGetPerson,
  type AdminContext,
  type AdminProfile,
  type CreateAdminContextOptions,
} from "./context.js";
export {
  buildAdminCatalog,
  defineAdminTool,
  dispatchAdminTool,
  type AdminToolDefinition,
} from "./registry.js";
export { AdminErrorCodes, McpAdminError, toErrorPayload, type ErrorPayload } from "./errors.js";
export {
  buildAdminToolCatalog,
  createAdminServer,
  SERVER_NAME,
  SERVER_VERSION,
} from "./server.js";
export { createHttpServer, DEFAULT_HTTP_PORT, HTTP_HOST } from "./http.js";
export { unifiedDiff } from "./diff.js";
export { looksLikeSecret } from "./tools/providers.js";
export { ALLOWED_CONFIG_KEYS } from "./tools/system.js";
