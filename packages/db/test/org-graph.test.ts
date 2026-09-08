import { describe, expect, it } from "vitest";
import { isAgentosError } from "@agentos/shared";
import { openDb, type AgentosSqliteDb } from "../src/client.js";
import { runMigrations } from "../src/migrate.js";
import { createAgent } from "../src/repositories/agents.js";
import { createOrganization, createPerson } from "../src/repositories/organizations-people.js";
import { createProcess } from "../src/repositories/processes.js";
import { upsertProviderProfile } from "../src/repositories/providers.js";
import {
  createOrgRole,
  createOrgUnit,
  deleteOrgRole,
  deleteOrgUnit,
  getOrgGraph,
  getOrgRole,
  getOrgRoleByName,
  getOrgUnitByName,
  listOrgRoles,
  listOrgUnits,
  listRoleFunctions,
  listRolePeople,
  listRoleProcesses,
  replaceRoleFunctions,
  replaceRolePeople,
  replaceRoleProcesses,
  updateOrgRole,
  updateOrgUnit,
} from "../src/repositories/org-graph.js";

function freshDb(): AgentosSqliteDb {
  const db = openDb(":memory:");
  runMigrations(db);
  return db;
}

function fixture(db: AgentosSqliteDb) {
  const org = createOrganization(db, { name: "ACME Grafo S.A.", kind: "client" });
  return { org };
}

describe("grafo organizacional — áreas", () => {
  it("crea, actualiza y borra un área; sus roles y sub-áreas quedan huérfanos", () => {
    const db = freshDb();
    const { org } = fixture(db);
    const direccion = createOrgUnit(db, { orgId: org.id, name: "Dirección" });
    const produccion = createOrgUnit(db, {
      orgId: org.id,
      name: "Producción",
      parentUnitId: direccion.id,
      description: "Planta",
    });
    expect(listOrgUnits(db, org.id).map((u) => u.name)).toEqual(["Dirección", "Producción"]);
    expect(getOrgUnitByName(db, org.id, "Producción")!.id).toBe(produccion.id);

    const renamed = updateOrgUnit(db, produccion.id, { description: "Planta textil" });
    expect(renamed.description).toBe("Planta textil");

    const role = createOrgRole(db, { orgId: org.id, name: "Jefe de Producción", unitId: produccion.id });

    deleteOrgUnit(db, produccion.id);
    expect(listOrgUnits(db, org.id).map((u) => u.name)).toEqual(["Dirección"]);
    expect(getOrgRole(db, role.id)!.unitId).toBeNull();
  });
});

describe("grafo organizacional — roles, funciones, personas y procesos", () => {
  it("crea rol, reporta a otro, funciones, personas y procesos; getOrgGraph los junta", () => {
    const db = freshDb();
    const { org } = fixture(db);
    const maria = createPerson(db, { orgId: org.id, fullName: "María Restrepo" });
    const carlos = createPerson(db, { orgId: org.id, fullName: "Carlos Pérez" });
    const proceso = createProcess(db, { orgId: org.id, name: "Control de calidad" });

    const gerente = createOrgRole(db, { orgId: org.id, name: "Gerente General", canvasX: 400, canvasY: 40 });
    const jefeProduccion = createOrgRole(db, {
      orgId: org.id,
      name: "Jefe de Producción",
      reportsToRoleId: gerente.id,
    });
    expect(getOrgRoleByName(db, org.id, "Jefe de Producción")!.id).toBe(jefeProduccion.id);
    expect(listOrgRoles(db, org.id)).toHaveLength(2);

    replaceRoleFunctions(db, jefeProduccion.id, [
      { name: "Planificar la producción semanal" },
      { name: "Controlar calidad y mermas" },
    ]);
    replaceRolePeople(db, jefeProduccion.id, [{ personId: carlos.id, dedicationPct: 100 }]);
    replaceRoleProcesses(db, jefeProduccion.id, [{ processId: proceso.id, relation: "owner" }]);
    replaceRolePeople(db, gerente.id, [{ personId: maria.id }]);

    expect(listRoleFunctions(db, jefeProduccion.id).map((f) => f.name)).toEqual([
      "Planificar la producción semanal",
      "Controlar calidad y mermas",
    ]);
    expect(listRolePeople(db, jefeProduccion.id)).toEqual([
      expect.objectContaining({ roleId: jefeProduccion.id, personId: carlos.id, dedicationPct: 100 }),
    ]);
    expect(listRoleProcesses(db, jefeProduccion.id)).toEqual([
      expect.objectContaining({ roleId: jefeProduccion.id, processId: proceso.id, relation: "owner" }),
    ]);

    const graph = getOrgGraph(db, org.id);
    expect(graph.units).toEqual([]);
    const jefeInGraph = graph.roles.find((r) => r.id === jefeProduccion.id)!;
    expect(jefeInGraph.functions).toHaveLength(2);
    expect(jefeInGraph.people).toEqual([{ personId: carlos.id, dedicationPct: 100 }]);
    expect(jefeInGraph.processes).toEqual([{ processId: proceso.id, relation: "owner" }]);
    const gerenteInGraph = graph.roles.find((r) => r.id === gerente.id)!;
    expect(gerenteInGraph.people).toEqual([{ personId: maria.id, dedicationPct: null }]);
  });

  it("rechaza un ciclo de reporte (self y a través de un subordinado)", () => {
    const db = freshDb();
    const { org } = fixture(db);
    const gerente = createOrgRole(db, { orgId: org.id, name: "Gerente General" });
    const jefe = createOrgRole(db, { orgId: org.id, name: "Jefe", reportsToRoleId: gerente.id });
    const supervisor = createOrgRole(db, { orgId: org.id, name: "Supervisor", reportsToRoleId: jefe.id });

    expect(() => updateOrgRole(db, gerente.id, { reportsToRoleId: gerente.id })).toThrow();
    try {
      updateOrgRole(db, gerente.id, { reportsToRoleId: gerente.id });
      expect.unreachable("debió lanzar validation_error");
    } catch (err) {
      expect(isAgentosError(err, "validation_error")).toBe(true);
    }

    // Gerente reportando a su propio subordinado (supervisor) cerraría un ciclo.
    try {
      updateOrgRole(db, gerente.id, { reportsToRoleId: supervisor.id });
      expect.unreachable("debió lanzar validation_error");
    } catch (err) {
      expect(isAgentosError(err, "validation_error")).toBe(true);
    }
  });

  it("optimistic locking: expected_version desalineada es conflicto; canvasX/Y no sube versión ni la exige", () => {
    const db = freshDb();
    const { org } = fixture(db);
    const role = createOrgRole(db, { orgId: org.id, name: "Vendedor" });
    expect(role.version).toBe(1);

    const moved = updateOrgRole(db, role.id, { canvasX: 10, canvasY: 20 });
    expect(moved.version).toBe(1);
    expect(moved.canvasX).toBe(10);

    const renamed = updateOrgRole(db, role.id, { purpose: "Vender" }, 1);
    expect(renamed.version).toBe(2);

    try {
      updateOrgRole(db, role.id, { purpose: "Otra cosa" }, 1);
      expect.unreachable("debió lanzar version_conflict");
    } catch (err) {
      expect(isAgentosError(err, "version_conflict")).toBe(true);
    }
  });

  it("borrar un rol limpia subordinados y sus uniones (funciones/personas/procesos)", () => {
    const db = freshDb();
    const { org } = fixture(db);
    const persona = createPerson(db, { orgId: org.id, fullName: "Andrés Mora" });
    const proceso = createProcess(db, { orgId: org.id, name: "Facturación" });
    const gerente = createOrgRole(db, { orgId: org.id, name: "Gerente General" });
    const jefe = createOrgRole(db, { orgId: org.id, name: "Jefe", reportsToRoleId: gerente.id });
    replaceRoleFunctions(db, jefe.id, [{ name: "Coordinar" }]);
    replaceRolePeople(db, jefe.id, [{ personId: persona.id }]);
    replaceRoleProcesses(db, jefe.id, [{ processId: proceso.id, relation: "participant" }]);

    deleteOrgRole(db, jefe.id);

    expect(getOrgRole(db, jefe.id)).toBeUndefined();
    expect(listRoleFunctions(db, jefe.id)).toEqual([]);
    expect(listRolePeople(db, jefe.id)).toEqual([]);
    expect(listRoleProcesses(db, jefe.id)).toEqual([]);

    deleteOrgRole(db, gerente.id);
    // No queda ningún rol huérfano apuntando al gerente borrado.
    expect(listOrgRoles(db, org.id)).toEqual([]);
  });

  it("enlaza el rol con su agente sin exigir expected_version (igual que canvasX/canvasY)", () => {
    const db = freshDb();
    const { org } = fixture(db);
    const provider = upsertProviderProfile(db, {
      slug: "test_provider_org_graph",
      name: "Test",
      kind: "openai_compatible",
      apiKeyEnv: "TEST_KEY",
    });
    const agent = createAgent(db, {
      slug: "agente-del-rol",
      name: "Agente del rol",
      layer: "operacion",
      runtime: "ai_sdk",
      providerProfileId: provider.id,
      model: "test-1",
      toolsAllowlist: [],
      mcpAllowlist: [],
    });
    const role = createOrgRole(db, { orgId: org.id, name: "Jefe de Compras" });
    expect(role.agentId).toBeNull();

    const linked = updateOrgRole(db, role.id, { agentId: agent.id });
    expect(linked.agentId).toBe(agent.id);
    expect(linked.version).toBe(1); // no sube versión: no es una transición de dominio

    expect(getOrgGraph(db, org.id).roles.find((r) => r.id === role.id)?.agentId).toBe(agent.id);
  });

  it("replaceRoleFunctions conserva los ids dados, crea los nuevos y borra los ausentes", () => {
    const db = freshDb();
    const { org } = fixture(db);
    const role = createOrgRole(db, { orgId: org.id, name: "Administrador" });
    const first = replaceRoleFunctions(db, role.id, [
      { name: "Facturación y cobranza" },
      { name: "Nómina y proveedores" },
    ]);
    expect(first).toHaveLength(2);
    const [a, b] = first;

    const second = replaceRoleFunctions(db, role.id, [
      { id: a!.id, name: "Facturación y cobranza (actualizada)" },
      { name: "Compras" },
    ]);
    expect(second.map((f) => f.id)).toEqual([a!.id, expect.any(String)]);
    expect(second[0]!.name).toBe("Facturación y cobranza (actualizada)");
    expect(second.map((f) => f.position)).toEqual([0, 1]);

    const remaining = listRoleFunctions(db, role.id);
    expect(remaining.map((f) => f.id)).not.toContain(b!.id);
    expect(remaining).toHaveLength(2);
  });
});
