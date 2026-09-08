/**
 * Procesos mapeados (REST): crear → editar pasos → vincular a un rol →
 * borrar deja al rol sin ese proceso. Auditoría process.create|update|delete.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { queryAudit } from "@agentos/db";
import { makeFixture, type TestFixture } from "./helpers.js";

let fx: TestFixture;

beforeAll(async () => {
  fx = await makeFixture();
});
afterAll(async () => {
  await fx.close();
});

describe("procesos del cliente (REST)", () => {
  it("crea, edita pasos, vincula a un rol y al borrar deja al rol sin ese proceso", async () => {
    const createRes = await fx.api.app.inject({
      method: "POST",
      url: `/api/orgs/${fx.org.id}/processes`,
      headers: fx.authHeaders,
      payload: {
        name: "Facturación",
        variant: "as_is",
        steps: [{ step: "Emitir factura", responsible: "Contabilidad" }],
      },
    });
    expect(createRes.statusCode).toBe(200);
    const { process } = createRes.json() as {
      process: { id: string; name: string; steps: unknown[]; status: string };
    };
    expect(process.name).toBe("Facturación");
    expect(process.steps).toEqual([{ step: "Emitir factura", responsible: "Contabilidad" }]);

    const patchRes = await fx.api.app.inject({
      method: "PATCH",
      url: `/api/processes/${process.id}`,
      headers: fx.authHeaders,
      payload: {
        steps: [
          { step: "Emitir factura", responsible: "Contabilidad" },
          { step: "Enviar al cliente", responsible: "Ventas" },
        ],
      },
    });
    expect(patchRes.statusCode).toBe(200);
    const { process: updated } = patchRes.json() as { process: { steps: unknown[] } };
    expect(updated.steps).toHaveLength(2);

    const roleRes = await fx.api.app.inject({
      method: "POST",
      url: `/api/orgs/${fx.org.id}/roles`,
      headers: fx.authHeaders,
      payload: { name: "Jefe de Contabilidad" },
    });
    expect(roleRes.statusCode).toBe(200);
    const { role } = roleRes.json() as { role: { id: string } };

    const linkRes = await fx.api.app.inject({
      method: "PUT",
      url: `/api/roles/${role.id}/processes`,
      headers: fx.authHeaders,
      payload: { processes: [{ process_id: process.id, relation: "owner" }] },
    });
    expect(linkRes.statusCode).toBe(200);
    const { processes: linked } = linkRes.json() as { processes: { processId: string }[] };
    expect(linked.map((p) => p.processId)).toEqual([process.id]);

    const delRes = await fx.api.app.inject({
      method: "DELETE",
      url: `/api/processes/${process.id}`,
      headers: fx.authHeaders,
    });
    expect(delRes.statusCode).toBe(200);
    expect(delRes.json()).toEqual({ ok: true });

    const graphRes = await fx.api.app.inject({
      method: "GET",
      url: `/api/orgs/${fx.org.id}/graph`,
      headers: fx.authHeaders,
    });
    const graph = graphRes.json() as { roles: { id: string; processes: unknown[] }[] };
    const jefe = graph.roles.find((r) => r.id === role.id)!;
    expect(jefe.processes).toEqual([]);

    const audit = await queryAudit(fx.db, { entityType: "process", entityId: process.id });
    expect(audit.map((a) => a.action).sort()).toEqual(["process.create", "process.delete", "process.update"]);
  });

  it("404 si la organización o el proceso no existen", async () => {
    const missingOrg = await fx.api.app.inject({
      method: "POST",
      url: "/api/orgs/no-existe/processes",
      headers: fx.authHeaders,
      payload: { name: "X" },
    });
    expect(missingOrg.statusCode).toBe(404);

    const missingProcessPatch = await fx.api.app.inject({
      method: "PATCH",
      url: "/api/processes/no-existe",
      headers: fx.authHeaders,
      payload: { name: "X" },
    });
    expect(missingProcessPatch.statusCode).toBe(404);

    const missingProcessDelete = await fx.api.app.inject({
      method: "DELETE",
      url: "/api/processes/no-existe",
      headers: fx.authHeaders,
    });
    expect(missingProcessDelete.statusCode).toBe(404);
  });
});
