/**
 * Smoke test REAL del transporte stdio: lanza `node --import tsx src/stdio.ts`
 * como proceso hijo contra una DB temporal seedeada y le habla con el cliente
 * oficial MCP: initialize → tools/list → tools/call agentos.agents.list.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { closeDb, openDb, runMigrations, seed } from "@agentos/db";

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let tmpDir: string;
let dbPath: string;
let client: Client;

function cleanEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  return { ...env, ...extra };
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-mcp-smoke-"));
  dbPath = path.join(tmpDir, "agentos.db");
  const db = openDb(dbPath);
  runMigrations(db);
  seed(db, { env: {} });
  closeDb(db);

  client = new Client({ name: "smoke-client", version: "0.0.1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/stdio.ts"],
    cwd: APP_DIR,
    env: cleanEnv({
      AGENTOS_DB_PATH: dbPath,
      AGENTOS_MCP_PROFILE: "rw",
    }),
  });
  await client.connect(transport);
});

afterAll(async () => {
  await client?.close();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* en Windows el fichero WAL puede tardar en soltarse; no es un fallo */
  }
});

describe("stdio smoke", () => {
  it("tools/list expone el catálogo agentos.*", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("agentos.agents.list");
    expect(names).toContain("agentos.system.health");
    expect(names).toContain("agentos.approvals.decide");
    expect(names.length).toBeGreaterThanOrEqual(50);
    expect(names.every((n) => n.startsWith("agentos."))).toBe(true);
  });

  it("tools/call agentos.agents.list devuelve los agentes seed", async () => {
    const result = (await client.callTool({
      name: "agentos.agents.list",
      arguments: {},
    })) as { isError?: boolean; content: { type: string; text: string }[] };
    expect(result.isError ?? false).toBe(false);
    const agents = JSON.parse(result.content[0]!.text) as { slug: string }[];
    expect(agents.length).toBeGreaterThanOrEqual(7);
    expect(agents.map((a) => a.slug)).toContain("alex");
  });

  it("tools/call agentos.system.health responde ok", async () => {
    const result = (await client.callTool({
      name: "agentos.system.health",
      arguments: {},
    })) as { content: { text: string }[] };
    const health = JSON.parse(result.content[0]!.text) as { status: string; db_ok: boolean };
    expect(health.status).toBe("ok");
    expect(health.db_ok).toBe(true);
  });
});
