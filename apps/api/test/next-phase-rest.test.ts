/**
 * M6a — REST del encadenado (US-M3) y la cadencia consent-first (CA-M3.4):
 * GET /api/projects/:id/next-phase (cierre completo + gate aprobado → available
 * con prefill), launch de implementacion con previous_launch_id sobre el MISMO
 * proyecto, y preview/launch de operacion con cadence_proposals /
 * cadences_confirmed. Camino real de punta a punta por HTTP.
 */
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MODULES_DIR,
  attachArtifact,
  createAgent,
  createDoc,
  createProcess,
  getProject,
  listDocs,
  listTasks,
  loadMethodologySeeds,
  parseModuleSeed,
  updateTask,
  upsertMethodology,
  upsertPhaseModuleFromSeed,
} from "@agentos/db";
import { makeFixture, type TestFixture } from "./helpers.js";

let fx: TestFixture;

beforeEach(async () => {
  fx = await makeFixture();
  for (const m of loadMethodologySeeds()) {
    await upsertMethodology(fx.db, {
      slug: m.slug,
      version: m.version,
      bodyMd: m.bodyMd,
      changelog: `Seed de test desde ${m.file}`,
      seedFile: m.file,
      seedHash: m.hash,
    });
  }
  // Roster completo de los 3 módulos: alex y sam ya existen en el fixture.
  for (const [slug, layer] of [
    ["clara", "operacion"],
    ["sally", "operacion"],
    ["debbie", "implementacion"],
    ["vinnie", "implementacion"],
    ["quinn", "meta"],
  ] as const) {
    await createAgent(fx.db, {
      slug,
      name: slug[0]!.toUpperCase() + slug.slice(1),
      layer,
      runtime: "ai_sdk",
      providerProfileId: fx.provider.id,
      model: "mock-model",
      toolsAllowlist: [],
    });
  }
  // Los 3 módulos REALES por el mismo camino del seed (quedan activos).
  for (const file of ["consultoria.md", "implementacion.md", "operacion.md"]) {
    await upsertPhaseModuleFromSeed(fx.db, parseModuleSeed(path.join(MODULES_DIR, file)));
  }
});

afterEach(async () => {
  await fx.close();
});

const GLOBEX_INPUTS = {
  empresa: "Globex",
  industria: "Manufactura",
  empleados: 120,
  sponsor: "María Torres (CEO)",
  objetivo: "Diagnóstico integral de procesos y sistemas",
  areas: ["direccion", "operaciones"],
  fecha_objetivo: "2026-09-30",
};

async function launchConsultoria(): Promise<{ launchId: string; projectId: string }> {
  const res = await fx.api.app.inject({
    method: "POST",
    url: "/api/modules/consultoria/launch",
    headers: fx.authHeaders,
    payload: { inputs: GLOBEX_INPUTS, idempotency_key: "wizard:m6:globex" },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json() as { launch: { id: string }; project: { id: string } };
  return { launchId: body.launch.id, projectId: body.project.id };
}

/** Deliverables mínimos (ISO off) + roadmap aprobado, como CA-M3.1 exige. */
async function completePhase(projectId: string): Promise<void> {
  // La org del proyecto es la creada por el launch (Globex), no la del fixture:
  // los procesos as-is cuentan por org_id del proyecto (phaseClosureStatus).
  const orgId = (await getProject(fx.db, projectId))!.orgId;
  const doc = (kind: string, title: string) =>
    createDoc(fx.db, {
      orgId,
      projectId,
      kind: kind as never,
      title,
      bodyMd: "Contenido con fuente.",
    });
  await doc("org_profile", "Perfil Globex");
  await doc("interview", "Entrevista dirección");
  await doc("interview", "Entrevista operaciones");
  await doc("finding", "Fugas de valor");
  await createProcess(fx.db, { orgId, name: "direccion", variant: "as_is" });
  await createProcess(fx.db, { orgId, name: "operaciones", variant: "as_is" });

  const tasks = await listTasks(fx.db, { projectId });
  const informe = tasks.find((t) => t.title.includes("Informe"))!;
  const roadmap = tasks.find((t) => t.title.includes("Roadmap"))!;
  await attachArtifact(fx.db, { taskId: informe.id, kind: "report", title: "Informe final" });
  await attachArtifact(fx.db, {
    taskId: roadmap.id,
    kind: "roadmap",
    title: "Roadmap",
    content: "- Automatizar facturación\n- Pipeline CRM\n",
  });
  // Sustituye el UPDATE crudo de SQLite por la función de repositorio: vale
  // igual para el motor SQLite y para Postgres (docs/POSTGRES.md §5).
  await updateTask(fx.db, roadmap.id, { status: "DONE" }, roadmap.version);
}

describe("GET /api/projects/:id/next-phase (CA-M3.2)", () => {
  it("flujo completo: incompleto → gate_pending → available → launch encadenado sobre el MISMO proyecto", async () => {
    const { launchId, projectId } = await launchConsultoria();

    // 1) Recién disparado: la fase no está cerrada.
    let res = await fx.api.app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/next-phase`,
      headers: fx.authHeaders,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ available: false, reason: "phase_incomplete" });

    // 2) Deliverables completos pero gate sin aprobar.
    await completePhase(projectId);
    res = await fx.api.app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/next-phase`,
      headers: fx.authHeaders,
    });
    expect(res.json()).toMatchObject({ available: false, reason: "gate_pending" });

    // 3) Gate aprobado por REST → disponible con prefill de empresa/industria.
    const gate = await fx.api.app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/gate`,
      headers: fx.authHeaders,
      payload: { decision: "approve", note: "diagnóstico validado" },
    });
    expect(gate.statusCode).toBe(200);

    res = await fx.api.app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/next-phase`,
      headers: fx.authHeaders,
    });
    const status = res.json() as {
      available: boolean;
      next_module: { slug: string };
      prefilled: { inputs: Record<string, unknown>; missing_required: string[] };
      previous_launch_id: string;
    };
    expect(status.available).toBe(true);
    expect(status.next_module.slug).toBe("implementacion");
    expect(status.previous_launch_id).toBe(launchId);
    expect(status.prefilled.inputs["empresa"]).toBe("Globex");
    expect(status.prefilled.inputs["industria"]).toBe("Manufactura");
    expect(status.prefilled.inputs["cliente"]).toBe("Globex");
    expect(status.prefilled.inputs["palancas"]).toEqual([
      "Automatizar facturación",
      "Pipeline CRM",
    ]);
    expect(status.prefilled.missing_required).toEqual(["fecha_objetivo"]);

    // 4) Disparo de implementacion con el prefill + previous_launch_id.
    const docsBefore = (await listDocs(fx.db, { projectId })).length;
    const launch = await fx.api.app.inject({
      method: "POST",
      url: "/api/modules/implementacion/launch",
      headers: fx.authHeaders,
      payload: {
        inputs: { ...status.prefilled.inputs, fecha_objetivo: "2026-11-15" },
        idempotency_key: "wizard:m6:globex:impl",
        previous_launch_id: status.previous_launch_id,
      },
    });
    expect(launch.statusCode).toBe(201);
    const body = launch.json() as {
      launch: { previousLaunchId: string; phase: string };
      project: { id: string; stage: string; gateState: string };
    };
    expect(body.project.id).toBe(projectId); // MISMO proyecto (CA-M3.3)
    expect(body.project.stage).toBe("CONSTRUIR");
    expect(body.project.gateState).toBe("pending"); // gate de la fase nueva
    expect(body.launch.previousLaunchId).toBe(launchId);
    expect(await listDocs(fx.db, { projectId })).toHaveLength(docsBefore); // Context Hub intacto
  });

  it("proyecto inexistente → 404; sin sesión → 401", async () => {
    const missing = await fx.api.app.inject({
      method: "GET",
      url: "/api/projects/no-existe/next-phase",
      headers: fx.authHeaders,
    });
    expect(missing.statusCode).toBe(404);
    const anon = await fx.api.app.inject({
      method: "GET",
      url: `/api/projects/${fx.project.id}/next-phase`,
    });
    expect(anon.statusCode).toBe(401);
  });
});

describe("cadencia consent-first por REST (CA-M3.4)", () => {
  const OPS_INPUTS = { cliente: "Globex", objetivo: "Operación mensual de la promesa." };

  it("preview trae cadence_proposals; launch con cadences_confirmed crea SOLO la confirmada", async () => {
    const preview = await fx.api.app.inject({
      method: "POST",
      url: "/api/modules/operacion/preview",
      headers: fx.authHeaders,
      payload: { inputs: OPS_INPUTS },
    });
    expect(preview.statusCode).toBe(200);
    const plan = (preview.json() as { ok: boolean; plan: { cadenceProposals: Array<{ key: string; periodDays: number | null }> } }).plan;
    expect(plan.cadenceProposals.map((p) => p.key).sort()).toEqual([
      "checkin_cliente",
      "reporte_semanal",
      "sprint_semanal",
    ]);
    expect(plan.cadenceProposals.every((p) => p.periodDays !== null)).toBe(true);

    const launch = await fx.api.app.inject({
      method: "POST",
      url: "/api/modules/operacion/launch",
      headers: fx.authHeaders,
      payload: {
        inputs: OPS_INPUTS,
        org: { name: "Globex Ops" },
        cadences_confirmed: ["reporte_semanal"],
        idempotency_key: "wizard:m6:globex:ops",
      },
    });
    expect(launch.statusCode).toBe(201);
    const body = launch.json() as { project: { id: string } };
    const tasks = await listTasks(fx.db, { projectId: body.project.id });
    const reporte = tasks.find((t) => t.title.startsWith("Reporte semanal"))!;
    expect(reporte.status).toBe("READY");
    expect(reporte.dueAt).not.toBeNull();
    expect(tasks.some((t) => t.title.startsWith("Sprint semanal"))).toBe(false); // no confirmada
    expect(tasks.some((t) => t.title.startsWith("Check-in"))).toBe(false);
  });
});
