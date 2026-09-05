/**
 * M6a — MCP: `agentos.modules.next_phase` (ro, misma lógica del REST) y el
 * passthrough de `cadences_confirmed` en preview/launch (CA-M3.4).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { getLaunch, listTasks } from "@agentos/db";
import { adminFixture, type AdminFixture } from "./helpers.js";

let f: AdminFixture;
beforeEach(async () => {
  f = await adminFixture();
});

const OPS_INPUTS = { cliente: "ACME", objetivo: "Operación mensual de la promesa." };

describe("agentos.modules.next_phase (CA-M3.2)", () => {
  it("es de solo lectura (perfil ro) y reporta phase_incomplete en el demo recién seedeado", async () => {
    const res = (await f.callRo("agentos.modules.next_phase", {
      project_id: f.project.id,
    })) as { available: boolean; reason?: string; next_phase?: string };
    expect(res.available).toBe(false);
    expect(res.reason).toBe("phase_incomplete"); // el seed dispara consultoria sin deliverables
    expect(res.next_phase).toBe("CONSTRUIR");
  });

  it("proyecto inexistente → not_found", async () => {
    await expect(
      f.callRo("agentos.modules.next_phase", { project_id: "no-existe" }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("fase OPERAR → no_next_phase (fin de la cadena)", async () => {
    const launch = (await f.call("agentos.modules.launch", {
      module_slug: "operacion",
      person_id: f.person.id,
      org: { name: "ACME Ops S.A." },
      inputs: OPS_INPUTS,
      idempotency_key: "test:m6:ops-chain",
    })) as { project: { id: string } };
    const res = (await f.callRo("agentos.modules.next_phase", {
      project_id: launch.project.id,
    })) as { available: boolean; reason?: string };
    expect(res).toMatchObject({ available: false, reason: "no_next_phase" });
  });
});

describe("cadencias por MCP (CA-M3.4)", () => {
  it("preview expone cadence_proposals y respeta cadences_confirmed", async () => {
    const preview = (await f.callRo("agentos.modules.preview", {
      slug: "operacion",
      inputs: OPS_INPUTS,
      cadences_confirmed: ["reporte_semanal"],
    })) as {
      ok: boolean;
      plan: {
        tasks: Array<{ key: string }>;
        cadenceProposals: Array<{ key: string; periodDays: number | null; title: string }>;
        cadencesConfirmed: string[];
        cadenceExcluded: string[];
      };
    };
    expect(preview.ok).toBe(true);
    expect(preview.plan.cadenceProposals.map((p) => p.key).sort()).toEqual([
      "checkin_cliente",
      "reporte_semanal",
      "sprint_semanal",
    ]);
    expect(preview.plan.cadencesConfirmed).toEqual(["reporte_semanal"]);
    expect(preview.plan.tasks.some((t) => t.key === "reporte_semanal")).toBe(true);
    expect(preview.plan.cadenceExcluded.sort()).toEqual(["checkin_cliente", "sprint_semanal"]);
  });

  it("launch con cadences_confirmed crea la instancia y el recibo la registra", async () => {
    const res = (await f.call("agentos.modules.launch", {
      module_slug: "operacion",
      person_id: f.person.id,
      org: { name: "ACME Ops S.A." },
      inputs: OPS_INPUTS,
      cadences_confirmed: ["reporte_semanal"],
      idempotency_key: "test:m6:ops-cadence",
    })) as { launch: { id: string }; project: { id: string }; tasks_count: number };

    expect(res.tasks_count).toBe(6); // 5 del catálogo + 1 cadencia confirmada
    const receipt = (await getLaunch(f.db, res.launch.id))!;
    expect((receipt.result as { cadences_confirmed?: string[] }).cadences_confirmed).toEqual([
      "reporte_semanal",
    ]);
    const tasks = await listTasks(f.db, { projectId: res.project.id });
    const reporte = tasks.find((t) => t.title.startsWith("Reporte semanal"))!;
    expect(reporte.status).toBe("READY");
    expect(tasks.some((t) => t.title.startsWith("Sprint semanal"))).toBe(false);
  });
});
