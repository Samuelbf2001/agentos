/**
 * "Convertir en agente": el rol nace agente heredando funciones elegidas,
 * cadena de mando (reports_to) y allowlist filtrada por el catálogo real.
 * `GET /api/tools/catalog` es lo que alimenta el picker de esa allowlist.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeFixture, type TestFixture } from "./helpers.js";

let fx: TestFixture;

beforeAll(async () => {
  // El proveedor por defecto del fixture (test-provider) necesita "credencial"
  // configurada para que resolveAgentProvider no tenga que caer a
  // claude_subscription (que este DB de test, sin seedCatalog, no tiene).
  process.env.TEST_FAKE_KEY = "fake-test-key-role-agent";
  fx = await makeFixture();
});
afterAll(async () => {
  await fx.close();
  delete process.env.TEST_FAKE_KEY;
});

interface RoleFunctionRes {
  id: string;
  name: string;
}
interface AgentRes {
  id: string;
  slug: string;
  name: string;
  status: string;
  autonomy: string;
  toolsAllowlist: string[];
  reportsTo: string | null;
}
interface RoleAgentResponse {
  agent: AgentRes;
  role: { id: string; agentId: string | null };
  prompt_version: { stable: string; context: string | null };
}

async function createRole(
  payload: Record<string, unknown>,
): Promise<{ id: string; reportsToRoleId: string | null; agentId: string | null }> {
  const res = await fx.api.app.inject({
    method: "POST",
    url: `/api/orgs/${fx.org.id}/roles`,
    headers: fx.authHeaders,
    payload,
  });
  expect(res.statusCode).toBe(200);
  return (res.json() as { role: { id: string; reportsToRoleId: string | null; agentId: string | null } }).role;
}

async function setFunctions(roleId: string, names: string[]): Promise<RoleFunctionRes[]> {
  const res = await fx.api.app.inject({
    method: "PUT",
    url: `/api/roles/${roleId}/functions`,
    headers: fx.authHeaders,
    payload: { functions: names.map((name) => ({ name })) },
  });
  expect(res.statusCode).toBe(200);
  return (res.json() as { functions: RoleFunctionRes[] }).functions;
}

async function convertToAgent(
  roleId: string,
  payload: Record<string, unknown>,
): Promise<{ statusCode: number; body: unknown }> {
  const res = await fx.api.app.inject({
    method: "POST",
    url: `/api/roles/${roleId}/agent`,
    headers: fx.authHeaders,
    payload,
  });
  return { statusCode: res.statusCode, body: res.json() };
}

describe("POST /api/roles/:id/agent (convertir en agente)", () => {
  it("crea el agente: slug, allowlist filtrada, status paused, prompt con las funciones elegidas y role.agentId fijado", async () => {
    const role = await createRole({ name: "Jefe de Producción", purpose: "Coordinar la planta" });
    const functions = await setFunctions(role.id, ["Planificar la producción", "Controlar calidad"]);

    const { statusCode, body } = await convertToAgent(role.id, {
      function_ids: [functions[0]!.id],
      autonomy: "supervised",
      activate: false,
      tools_allowlist: ["tasks.claim", "no.existe.en.el.catalogo"],
    });
    expect(statusCode).toBe(200);
    const res = body as RoleAgentResponse;

    expect(res.agent.slug).toBe("jefe-de-produccion");
    expect(res.agent.status).toBe("paused");
    expect(res.agent.autonomy).toBe("supervised");
    expect(res.agent.toolsAllowlist).toEqual(["tasks.claim"]);
    expect(res.role.agentId).toBe(res.agent.id);
    expect(res.prompt_version.stable).toContain("Planificar la producción");
    expect(res.prompt_version.stable).not.toContain("Controlar calidad");
    expect(res.prompt_version.stable).toContain("Jefe de Producción");
  });

  it("activate:true deja el agente activo", async () => {
    const role = await createRole({ name: "Jefe Comercial" });
    const { statusCode, body } = await convertToAgent(role.id, {
      function_ids: [],
      autonomy: "manual",
      activate: true,
      tools_allowlist: [],
    });
    expect(statusCode).toBe(200);
    expect((body as RoleAgentResponse).agent.status).toBe("active");
  });

  it("segunda llamada sobre el mismo rol responde 409", async () => {
    const role = await createRole({ name: "Jefe de Bodega" });
    const first = await convertToAgent(role.id, {
      function_ids: [],
      autonomy: "supervised",
      activate: false,
      tools_allowlist: [],
    });
    expect(first.statusCode).toBe(200);

    const second = await convertToAgent(role.id, {
      function_ids: [],
      autonomy: "supervised",
      activate: false,
      tools_allowlist: [],
    });
    expect(second.statusCode).toBe(409);
  });

  it("404 si el rol no existe", async () => {
    const { statusCode } = await convertToAgent("no-existe", {
      function_ids: [],
      autonomy: "manual",
      activate: false,
      tools_allowlist: [],
    });
    expect(statusCode).toBe(404);
  });

  it("slug único: dos roles con el mismo nombre generan agentes con slugs -2, -3...", async () => {
    const first = await createRole({ name: "Jefe de Compras" });
    const firstConversion = await convertToAgent(first.id, {
      function_ids: [],
      autonomy: "manual",
      activate: false,
      tools_allowlist: [],
    });
    expect(firstConversion.statusCode).toBe(200);
    expect((firstConversion.body as RoleAgentResponse).agent.slug).toBe("jefe-de-compras");

    const second = await createRole({ name: "Jefe de Compras" });
    const secondConversion = await convertToAgent(second.id, {
      function_ids: [],
      autonomy: "manual",
      activate: false,
      tools_allowlist: [],
    });
    expect(secondConversion.statusCode).toBe(200);
    expect((secondConversion.body as RoleAgentResponse).agent.slug).toBe("jefe-de-compras-2");
  });

  it("reports_to se resuelve al agente del rol jefe cuando ya existe", async () => {
    const boss = await createRole({ name: "Gerente de Operaciones" });
    const bossConversion = await convertToAgent(boss.id, {
      function_ids: [],
      autonomy: "supervised",
      activate: false,
      tools_allowlist: [],
    });
    expect(bossConversion.statusCode).toBe(200);
    const bossAgent = (bossConversion.body as RoleAgentResponse).agent;

    const sub = await createRole({ name: "Jefe de Turno", reports_to_role_id: boss.id });
    const subConversion = await convertToAgent(sub.id, {
      function_ids: [],
      autonomy: "supervised",
      activate: false,
      tools_allowlist: [],
    });
    expect(subConversion.statusCode).toBe(200);
    expect((subConversion.body as RoleAgentResponse).agent.reportsTo).toBe(bossAgent.id);
  });
});

describe("GET /api/tools/catalog", () => {
  it("lista org_graph.get como tool de solo lectura", async () => {
    const res = await fx.api.app.inject({
      method: "GET",
      url: "/api/tools/catalog",
      headers: fx.authHeaders,
    });
    expect(res.statusCode).toBe(200);
    const { tools } = res.json() as {
      tools: { name: string; read_only: boolean; external_effect: boolean; requires_approval: boolean }[];
    };
    const orgGraphGet = tools.find((t) => t.name === "org_graph.get");
    expect(orgGraphGet?.read_only).toBe(true);
  });
});
