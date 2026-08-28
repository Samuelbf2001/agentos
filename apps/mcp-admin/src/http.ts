/**
 * Entrada HTTP: streamable HTTP SOLO en 127.0.0.1 (puerto 4310 por defecto),
 * Bearer token obligatorio via AGENTOS_MCP_TOKEN (fail-closed: sin token no
 * arranca). Stateless: una instancia de servidor/transporte por request.
 */
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { resolveDbPath } from "@agentos/db";
import { createAdminContext, parseProfile, type AdminContext } from "./context.js";
import { buildAdminToolCatalog, createAdminServer } from "./server.js";

export const DEFAULT_HTTP_PORT = 4310;
export const HTTP_HOST = "127.0.0.1";

function bearerOk(header: string | undefined, token: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const presented = header.slice("Bearer ".length).trim();
  // Comparación en tiempo constante sobre digests (longitudes distintas incluidas).
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(token).digest();
  return timingSafeEqual(a, b);
}

export function createHttpServer(ctx: AdminContext, token: string): http.Server {
  const catalog = buildAdminToolCatalog();
  return http.createServer(async (req, res) => {
    try {
      if (!bearerOk(req.headers.authorization, token)) {
        res.writeHead(401, { "content-type": "application/json" }).end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32001, message: "No autorizado: falta o no coincide el Bearer token" },
            id: null,
          }),
        );
        return;
      }
      const server = createAdminServer(ctx, catalog);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless
        enableJsonResponse: true,
      });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      process.stderr.write(`[mcp-admin] error HTTP: ${String(err)}\n`);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" }).end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Error interno" },
            id: null,
          }),
        );
      }
    }
  });
}

function main(): void {
  const token = process.env.AGENTOS_MCP_TOKEN;
  if (!token || token.trim().length === 0) {
    process.stderr.write(
      "[mcp-admin] AGENTOS_MCP_TOKEN no definido: el transporte HTTP no arranca sin token (fail-closed)\n",
    );
    process.exit(1);
  }
  const profile = parseProfile(process.env.AGENTOS_MCP_PROFILE);
  const port = Number(process.env.AGENTOS_MCP_PORT ?? DEFAULT_HTTP_PORT);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    process.stderr.write(`[mcp-admin] AGENTOS_MCP_PORT inválido: ${process.env.AGENTOS_MCP_PORT}\n`);
    process.exit(1);
  }
  const ctx = createAdminContext({
    profile,
    personId: process.env.AGENTOS_MCP_PERSON_ID ?? null,
  });
  const server = createHttpServer(ctx, token);
  server.listen(port, HTTP_HOST, () => {
    process.stderr.write(
      `[mcp-admin] HTTP listo en http://${HTTP_HOST}:${port} — perfil ${profile}, actor ${ctx.actor}, db ${resolveDbPath()}\n`,
    );
  });
}

const isMain =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) main();
