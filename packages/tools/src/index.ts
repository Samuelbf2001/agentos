// @agentos/tools — catálogo de tools (una definición), gateway único fail-closed
// (política → audit → handler) y dos adaptadores (Vercel AI SDK y MCP in-process).
export * from "./types.js";
export { buildCatalog, defineTool, wireName } from "./catalog.js";
export { createToolRuntime, type ToolRuntimeOptions } from "./gateway.js";
export { asAiSdkTools, type AsAiSdkToolsOptions } from "./adapters/ai-sdk.js";
export { asSdkMcpServer, MCP_SERVER_NAME, type AsSdkMcpServerOptions } from "./adapters/mcp.js";
