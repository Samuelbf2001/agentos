/**
 * Tools `org_graph.*` (grafo organizacional para agentes): lectura con
 * nombres resueltos y escritura por nombre (crea lo que falte, avisa lo que
 * no encuentra, nunca falla por un nombre desconocido).
 */
import { describe, expect, it } from "vitest";
import { createAgent, createPerson, createProcess } from "@agentos/db";
import { toolsFixture, type ToolsFixture } from "./helpers.js";

function okResult<T>(res: unknown): T {
  expect(res).toMatchObject({ status: "ok" });
  return (res as { status: "ok"; result: T }).result;
}

async function agentWith(f: ToolsFixture, allowlist: string[]) {
  return await createAgent(f.db, {
    slug: "sam",
    name: "Sam",
    layer: "consultoria",
    runtime: "ai_sdk",
    toolsAllowlist: allowlist,
  });
}

const ALL = ["org_graph.get", "org_graph.upsert_unit", "org_graph.upsert_role"];

interface UnitView {
  id: string;
  name: string;
  parent_name: string | null;
}
interface RoleView {
  id: string;
  name: string;
  unit_name: string | null;
  reports_to_name: string | null;
  functions: string[];
  people: string[];
  processes: { name: string; relation: string }[];
}
interface GraphView {
  units: UnitView[];
  roles: RoleView[];
}

describe("org_graph.get", () => {
  it("organización sin datos → grafo vacío", async () => {
    const f = await toolsFixture();
    const agent = await agentWith(f, ALL);
    const graph = okResult<GraphView>(
      await f.runtime.execute(f.ctxFor(agent), "org_graph.get", { org_id: f.project.orgId }),
    );
    expect(graph).toEqual({ units: [], roles: [] });
  });
});

describe("org_graph.upsert_unit", () => {
  it("crea por nombre y es idempotente (segunda llamada actualiza, no duplica)", async () => {
    const f = await toolsFixture();
    const agent = await agentWith(f, ALL);
    const orgId = f.project.orgId;

    const first = okResult<{ unit: UnitView }>(
      await f.runtime.execute(f.ctxFor(agent), "org_graph.upsert_unit", {
        org_id: orgId,
        name: "Producción",
      }),
    );

    const second = okResult<{ unit: UnitView }>(
      await f.runtime.execute(f.ctxFor(agent), "org_graph.upsert_unit", {
        org_id: orgId,
        name: "Producción",
        description: "Planta textil",
      }),
    );
    expect(second.unit.id).toBe(first.unit.id);

    const graph = okResult<GraphView>(
      await f.runtime.execute(f.ctxFor(agent), "org_graph.get", { org_id: orgId }),
    );
    expect(graph.units).toHaveLength(1);
  });

  it("crea el área padre por nombre si no existe", async () => {
    const f = await toolsFixture();
    const agent = await agentWith(f, ALL);
    const orgId = f.project.orgId;

    okResult(
      await f.runtime.execute(f.ctxFor(agent), "org_graph.upsert_unit", {
        org_id: orgId,
        name: "Planta 1",
        parent_name: "Operaciones",
      }),
    );

    const graph = okResult<GraphView>(
      await f.runtime.execute(f.ctxFor(agent), "org_graph.get", { org_id: orgId }),
    );
    expect(graph.units.map((u) => u.name).sort()).toEqual(["Operaciones", "Planta 1"]);
    const planta = graph.units.find((u) => u.name === "Planta 1")!;
    expect(planta.parent_name).toBe("Operaciones");
  });
});

describe("org_graph.upsert_role", () => {
  it("crea el área y el rol jefe si no existen; resuelve personas y procesos por nombre", async () => {
    const f = await toolsFixture();
    const agent = await agentWith(f, ALL);
    const orgId = f.project.orgId;
    await createPerson(f.db, { orgId, fullName: "Andrés Mora", isInternal: false });
    await createProcess(f.db, { orgId, name: "Facturación" });

    const result = okResult<{ role: RoleView & { status: string }; warnings: string[] }>(
      await f.runtime.execute(f.ctxFor(agent), "org_graph.upsert_role", {
        org_id: orgId,
        name: "Jefe de Producción",
        unit_name: "Producción",
        reports_to_name: "Gerente General",
        purpose: "Coordinar la planta",
        functions: ["Planificar la producción", "Controlar calidad"],
        people_names: ["andrés mora", "Persona Fantasma"],
        processes: [
          { name: "Facturación", relation: "owner" },
          { name: "Proceso Fantasma", relation: "participant" },
        ],
      }),
    );

    expect(result.role.status).toBe("draft");
    expect(result.warnings).toEqual([
      'Persona no encontrada en la organización: "Persona Fantasma"',
      'Proceso no encontrado en la organización: "Proceso Fantasma"',
    ]);

    const graph = okResult<GraphView>(
      await f.runtime.execute(f.ctxFor(agent), "org_graph.get", { org_id: orgId }),
    );
    expect(graph.units.map((u) => u.name)).toEqual(["Producción"]);
    const jefe = graph.roles.find((r) => r.name === "Jefe de Producción")!;
    expect(jefe.unit_name).toBe("Producción");
    expect(jefe.reports_to_name).toBe("Gerente General");
    expect(jefe.functions).toEqual(["Planificar la producción", "Controlar calidad"]);
    expect(jefe.people).toEqual(["Andrés Mora"]);
    expect(jefe.processes).toEqual([{ name: "Facturación", relation: "owner" }]);
    expect(graph.roles.map((r) => r.name).sort()).toEqual(["Gerente General", "Jefe de Producción"]);
  });

  it("segunda llamada actualiza el mismo rol sin duplicar área ni jefe", async () => {
    const f = await toolsFixture();
    const agent = await agentWith(f, ALL);
    const orgId = f.project.orgId;

    const first = okResult<{ role: RoleView }>(
      await f.runtime.execute(f.ctxFor(agent), "org_graph.upsert_role", {
        org_id: orgId,
        name: "Jefe de Producción",
        unit_name: "Producción",
        reports_to_name: "Gerente General",
        functions: ["Planificar"],
      }),
    );

    const second = okResult<{ role: RoleView }>(
      await f.runtime.execute(f.ctxFor(agent), "org_graph.upsert_role", {
        org_id: orgId,
        name: "Jefe de Producción",
        unit_name: "Producción",
        reports_to_name: "Gerente General",
        purpose: "Coordinar la planta",
        functions: ["Planificar", "Controlar calidad"],
      }),
    );
    expect(second.role.id).toBe(first.role.id);

    const graph = okResult<GraphView>(
      await f.runtime.execute(f.ctxFor(agent), "org_graph.get", { org_id: orgId }),
    );
    expect(graph.units).toHaveLength(1);
    expect(graph.roles).toHaveLength(2); // Jefe de Producción + Gerente General
    const jefe = graph.roles.find((r) => r.name === "Jefe de Producción")!;
    expect(jefe.functions).toEqual(["Planificar", "Controlar calidad"]);
  });
});
