/**
 * `agentos.org_graph.*` (MCP admin): perfil ro rechaza toda mutación,
 * perfil rw crea/actualiza por nombre con auditoría e idempotencia.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createOrganization, queryAudit } from "@agentos/db";
import { adminFixture, type AdminFixture } from "./helpers.js";

let f: AdminFixture;
beforeEach(async () => {
  f = await adminFixture();
});

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
}
interface GraphView {
  units: UnitView[];
  roles: RoleView[];
}

async function freshOrg() {
  return await createOrganization(f.db, { name: "Grafo MCP S.A.", kind: "client" });
}

describe("perfil ro", () => {
  it("rechaza las mutaciones de org_graph con read_only_profile y permite la lectura", async () => {
    const org = await freshOrg();
    await expect(
      f.callRo("agentos.org_graph.upsert_unit", { org_id: org.id, name: "Producción" }),
    ).rejects.toMatchObject({ code: "read_only_profile" });
    await expect(
      f.callRo("agentos.org_graph.upsert_role", { org_id: org.id, name: "Jefe" }),
    ).rejects.toMatchObject({ code: "read_only_profile" });

    const graph = (await f.callRo("agentos.org_graph.get", { org_id: org.id })) as GraphView;
    expect(graph).toEqual({ units: [], roles: [] });
  });
});

describe("agentos.org_graph.upsert_unit", () => {
  it("crea, audita y es idempotente por idempotency_key", async () => {
    const org = await freshOrg();
    const res = (await f.call("agentos.org_graph.upsert_unit", {
      org_id: org.id,
      name: "Producción",
      description: "Planta",
      reason: "test",
      idempotency_key: "org-graph:unit:1",
    })) as { unit: { id: string; name: string } };
    expect(res.unit.name).toBe("Producción");

    const audit = await queryAudit(f.db, { entityType: "org_unit", entityId: res.unit.id });
    expect(audit.map((a) => a.action)).toEqual(["org_graph.upsert_unit"]);

    const again = (await f.call("agentos.org_graph.upsert_unit", {
      org_id: org.id,
      name: "Producción",
      idempotency_key: "org-graph:unit:1",
    })) as { unit: { id: string }; idempotent?: boolean };
    expect(again.unit.id).toBe(res.unit.id);
    expect(again.idempotent).toBe(true);
    // No duplicó auditoría ni el área.
    expect((await queryAudit(f.db, { entityType: "org_unit", entityId: res.unit.id })).length).toBe(1);
  });
});

describe("agentos.org_graph.upsert_role", () => {
  it("crea el rol (y su área/jefe si faltan), audita, y warnings por nombres desconocidos", async () => {
    const org = await freshOrg();
    const res = (await f.call("agentos.org_graph.upsert_role", {
      org_id: org.id,
      name: "Jefe de Producción",
      unit_name: "Producción",
      reports_to_name: "Gerente General",
      functions: ["Planificar la producción"],
      people_names: ["Persona Fantasma"],
      reason: "test",
      idempotency_key: "org-graph:role:1",
    })) as { role: { id: string; name: string }; warnings: string[] };

    expect(res.role.name).toBe("Jefe de Producción");
    expect(res.warnings).toEqual(['Persona no encontrada en la organización: "Persona Fantasma"']);

    const audit = await queryAudit(f.db, { entityType: "org_role", entityId: res.role.id });
    expect(audit.map((a) => a.action)).toEqual(["org_graph.upsert_role"]);

    const graph = (await f.callRo("agentos.org_graph.get", { org_id: org.id })) as GraphView;
    expect(graph.units.map((u) => u.name)).toEqual(["Producción"]);
    expect(graph.roles.map((r) => r.name).sort()).toEqual(["Gerente General", "Jefe de Producción"]);

    // Idempotencia: misma key devuelve el mismo rol sin duplicar auditoría.
    const again = (await f.call("agentos.org_graph.upsert_role", {
      org_id: org.id,
      name: "Jefe de Producción",
      idempotency_key: "org-graph:role:1",
    })) as { role: { id: string }; idempotent?: boolean };
    expect(again.role.id).toBe(res.role.id);
    expect(again.idempotent).toBe(true);
    expect((await queryAudit(f.db, { entityType: "org_role", entityId: res.role.id })).length).toBe(1);
  });
});
