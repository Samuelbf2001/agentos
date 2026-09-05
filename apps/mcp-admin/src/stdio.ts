/**
 * Entrada stdio: `pnpm --filter @agentos/mcp-admin start:stdio`.
 * Este transporte es el que se registra en Claude Code (ver README.md).
 * REGLA: stdout es el canal JSON-RPC — todo log va a stderr.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolveDbPath } from "@agentos/db";
import { createAdminContext, parseProfile } from "./context.js";
import { createAdminServer } from "./server.js";

async function main(): Promise<void> {
  const profile = parseProfile(process.env.AGENTOS_MCP_PROFILE);
  const ctx = await createAdminContext({
    profile,
    personId: process.env.AGENTOS_MCP_PERSON_ID ?? null,
  });
  const server = createAdminServer(ctx);
  await server.connect(new StdioServerTransport());
  process.stderr.write(
    `[mcp-admin] stdio listo — perfil ${profile}, actor ${ctx.actor}, db ${resolveDbPath()}\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`[mcp-admin] error fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
