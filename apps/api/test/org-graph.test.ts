/**
 * Grafo organizacional (REST): área → dos roles → reporta → funciones →
 * personas → procesos → graph, más los casos de error (ciclo, versión,
 * persona/proceso de otra org) y el rastro de auditoría.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPerson, createProcess, createOrganization, queryAudit } from "@agentos/db";
import { makeFixture, type TestFixture } from "./helpers.js";

let fx: TestFixture;

beforeAll(async () => {
  fx = await makeFixture();
});
afterAll(async () => {
  await fx.close();
});

describe("grafo organizacional (REST)", () => {
  it("flujo completo: área → dos roles → reporta → funciones → personas → procesos → graph", async () => {
    const unitRes = await fx.api.app.inject({
      method: "POST",
      url: `/api/orgs/${fx.org.id}/units`,
      headers: fx.authHeaders,
      payload: { name: "Producción", description: "Planta" },
    });
    expect(unitRes.statusCode).toBe(200);
    const { unit } = unitRes.json() as { unit: { id: string; name: string } };
    expect(unit.name).toBe("Producción");

    const patchUnit = await fx.api.app.inject({
      method: "PATCH",
      url: `/api/units/${unit.id}`,
      headers: fx.authHeaders,
      payload: { description: "Planta textil" },
    });
    expect(patchUnit.statusCode).toBe(200);
    expect((patchUnit.json() as { unit: { description: string } }).unit.description).toBe(
      "Planta textil",
    );

    const managerRes = await fx.api.app.inject({
      method: "POST",
      url: `/api/orgs/${fx.org.id}/roles`,
      headers: fx.authHeaders,
      payload: { name: "Gerente General", canvas_x: 400, canvas_y: 40 },
    });
    expect(managerRes.statusCode).toBe(200);
    const { role: manager } = managerRes.json() as {
      role: { id: string; functions: unknown[]; people: unknown[]; processes: unknown[]; version: number };
    };
    expect(manager.functions).toEqual([]);
    expect(manager.people).toEqual([]);
    expect(manager.processes).toEqual([]);

    const subRes = await fx.api.app.inject({
      method: "POST",
      url: `/api/orgs/${fx.org.id}/roles`,
      headers: fx.authHeaders,
      payload: { name: "Jefe de Producción", unit_id: unit.id, reports_to_role_id: manager.id },
    });
    expect(subRes.statusCode).toBe(200);
    const { role: jefe } = subRes.json() as { role: { id: string; reportsToRoleId: string | null; version: number } };
    expect(jefe.reportsToRoleId).toBe(manager.id);

    const fnRes = await fx.api.app.inject({
      method: "PUT",
      url: `/api/roles/${jefe.id}/functions`,
      headers: fx.authHeaders,
      payload: {
        functions: [
          { name: "Planificar la producción semanal" },
          { name: "Controlar calidad y mermas" },
        ],
      },
    });
    expect(fnRes.statusCode).toBe(200);
    const { functions } = fnRes.json() as { functions: { name: string }[] };
    expect(functions.map((f) => f.name)).toEqual([
      "Planificar la producción semanal",
      "Controlar calidad y mermas",
    ]);

    const carlos = await createPerson(fx.db, { orgId: fx.org.id, fullName: "Carlos Pérez" });
    const peopleRes = await fx.api.app.inject({
      method: "PUT",
      url: `/api/roles/${jefe.id}/people`,
      headers: fx.authHeaders,
      payload: { people: [{ person_id: carlos.id, dedication_pct: 100 }] },
    });
    expect(peopleRes.statusCode).toBe(200);
    const { people } = peopleRes.json() as { people: { personId: string }[] };
    expect(people.map((p) => p.personId)).toEqual([carlos.id]);

    const proceso = await createProcess(fx.db, { orgId: fx.org.id, name: "Control de calidad" });
    const processesRes = await fx.api.app.inject({
      method: "PUT",
      url: `/api/roles/${jefe.id}/processes`,
      headers: fx.authHeaders,
      payload: { processes: [{ process_id: proceso.id, relation: "owner" }] },
    });
    expect(processesRes.statusCode).toBe(200);
    const { processes } = processesRes.json() as { processes: { processId: string; relation: string }[] };
    expect(processes).toEqual([expect.objectContaining({ processId: proceso.id, relation: "owner" })]);

    const graphRes = await fx.api.app.inject({
      method: "GET",
      url: `/api/orgs/${fx.org.id}/graph`,
      headers: fx.authHeaders,
    });
    expect(graphRes.statusCode).toBe(200);
    const graph = graphRes.json() as {
      units: { id: string }[];
      roles: { id: string; functions: unknown[]; people: unknown[]; processes: unknown[] }[];
      processes: { id: string }[];
      people: { id: string }[];
    };
    expect(graph.units.map((u) => u.id)).toContain(unit.id);
    const jefeInGraph = graph.roles.find((r) => r.id === jefe.id)!;
    expect(jefeInGraph.functions).toHaveLength(2);
    expect(jefeInGraph.people).toHaveLength(1);
    expect(jefeInGraph.processes).toHaveLength(1);
    expect(graph.processes.map((p) => p.id)).toContain(proceso.id);
    expect(graph.people.map((p) => p.id)).toContain(carlos.id);

    // Borrar el área deja al rol sin área (no rompe el grafo).
    const delUnit = await fx.api.app.inject({
      method: "DELETE",
      url: `/api/units/${unit.id}`,
      headers: fx.authHeaders,
    });
    expect(delUnit.statusCode).toBe(200);

    // Borrar el rol subordinado limpia sus uniones.
    const delRole = await fx.api.app.inject({
      method: "DELETE",
      url: `/api/roles/${jefe.id}`,
      headers: fx.authHeaders,
    });
    expect(delRole.statusCode).toBe(200);
    const graphAfter = (
      await fx.api.app.inject({
        method: "GET",
        url: `/api/orgs/${fx.org.id}/graph`,
        headers: fx.authHeaders,
      })
    ).json() as { roles: { id: string }[] };
    expect(graphAfter.roles.map((r) => r.id)).not.toContain(jefe.id);

    // Auditoría: quedó rastro de cada mutación.
    const audits = await queryAudit(fx.db, { entityType: "org_role", entityId: jefe.id });
    expect(audits.map((a) => a.action)).toEqual(
      expect.arrayContaining(["org_role.create", "org_role.functions", "org_role.people", "org_role.processes", "org_role.delete"]),
    );
    const unitAudits = await queryAudit(fx.db, { entityType: "org_unit", entityId: unit.id });
    expect(unitAudits.map((a) => a.action)).toEqual(
      expect.arrayContaining(["org_unit.create", "org_unit.update", "org_unit.delete"]),
    );
  });

  it("ciclo de reporte → 400 validation_error", async () => {
    const a = (
      await fx.api.app.inject({
        method: "POST",
        url: `/api/orgs/${fx.org.id}/roles`,
        headers: fx.authHeaders,
        payload: { name: "Rol A ciclo" },
      })
    ).json() as { role: { id: string } };
    const b = (
      await fx.api.app.inject({
        method: "POST",
        url: `/api/orgs/${fx.org.id}/roles`,
        headers: fx.authHeaders,
        payload: { name: "Rol B ciclo", reports_to_role_id: a.role.id },
      })
    ).json() as { role: { id: string } };

    const res = await fx.api.app.inject({
      method: "PATCH",
      url: `/api/roles/${a.role.id}`,
      headers: fx.authHeaders,
      payload: { reports_to_role_id: b.role.id, expected_version: 1 },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe("validation_error");
  });

  it("expected_version desalineada → 409 version_conflict", async () => {
    const created = (
      await fx.api.app.inject({
        method: "POST",
        url: `/api/orgs/${fx.org.id}/roles`,
        headers: fx.authHeaders,
        payload: { name: "Rol versión" },
      })
    ).json() as { role: { id: string; version: number } };

    const res = await fx.api.app.inject({
      method: "PATCH",
      url: `/api/roles/${created.role.id}`,
      headers: fx.authHeaders,
      payload: { purpose: "Definir norte", expected_version: 99 },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe("version_conflict");
  });

  it("persona de otra organización → 400 validation_error", async () => {
    const role = (
      await fx.api.app.inject({
        method: "POST",
        url: `/api/orgs/${fx.org.id}/roles`,
        headers: fx.authHeaders,
        payload: { name: "Rol persona ajena" },
      })
    ).json() as { role: { id: string } };

    const otherOrg = await createOrganization(fx.db, { name: "Otra Org S.A.", kind: "client" });
    const ajena = await createPerson(fx.db, { orgId: otherOrg.id, fullName: "Persona Ajena" });

    const res = await fx.api.app.inject({
      method: "PUT",
      url: `/api/roles/${role.role.id}/people`,
      headers: fx.authHeaders,
      payload: { people: [{ person_id: ajena.id }] },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe("validation_error");
  });

  it("proceso de otra organización → 400 validation_error", async () => {
    const role = (
      await fx.api.app.inject({
        method: "POST",
        url: `/api/orgs/${fx.org.id}/roles`,
        headers: fx.authHeaders,
        payload: { name: "Rol proceso ajeno" },
      })
    ).json() as { role: { id: string } };

    const otherOrg = await createOrganization(fx.db, { name: "Otra Org Procesos S.A.", kind: "client" });
    const ajeno = await createProcess(fx.db, { orgId: otherOrg.id, name: "Proceso ajeno" });

    const res = await fx.api.app.inject({
      method: "PUT",
      url: `/api/roles/${role.role.id}/processes`,
      headers: fx.authHeaders,
      payload: { processes: [{ process_id: ajeno.id, relation: "participant" }] },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe("validation_error");
  });
});
