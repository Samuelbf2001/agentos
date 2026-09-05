/**
 * M6a — encadenado US-M3 (CA-M3.2/CA-M3.3) por el CAMINO REAL:
 * launch de consultoría → deliverables mínimos creados → gate aprobado →
 * next-phase disponible con prefill (empresa/industria/palancas del roadmap) →
 * disparo de implementación sobre el MISMO proyecto (stage CONSTRUIR, backlog
 * nuevo, previous_launch_id, Context Hub intacto).
 */
import { describe, expect, it } from "vitest";
import {
  attachArtifact,
  createDoc,
  createProcess,
  getPersonByFullName,
  launchModule,
  listDocs,
  listTasks,
  openDb,
  runMigrations,
  seed,
  type AgentosSqliteDb,
  type LaunchModuleResult,
} from "@agentos/db";
import {
  createBoardEngine,
  nextPhaseStatus,
  parseRoadmapLevers,
  prefillNextPhaseInputs,
} from "../src/index.js";

const ROADMAP_MD = "## Palancas priorizadas\n\n- Automatizar facturación\n- Pipeline CRM\n";

async function launchedDb(): Promise<{ db: AgentosSqliteDb; r: LaunchModuleResult }> {
  const db = openDb(":memory:");
  runMigrations(db);
  await seed(db, { env: {} });
  const r = await launchModule(db, {
    moduleSlug: "consultoria",
    org: { name: "Nova Manufactura S.A.", kind: "client" },
    inputs: {
      empresa: "Nova Manufactura S.A.",
      alias: "Nova",
      industria: "manufactura",
      empleados: 40,
      sponsor: "Gerente General",
      objetivo: "Diagnóstico Entender.",
      areas: ["direccion", "operaciones"],
      procesos_core: ["Producción"],
      fecha_objetivo: "2026-09-15",
      notas_comercial: "Presupuesto pre-aprobado (confidencial).",
    },
    actor: "person:ernesto",
    idempotencyKey: "launch:test:next-phase:consultoria",
  });
  return { db, r };
}

/** Cierra la fase por el camino real: deliverables mínimos + roadmap aprobado. */
async function completePhase(db: AgentosSqliteDb, r: LaunchModuleResult): Promise<void> {
  const doc = (kind: string, title: string) =>
    createDoc(db, {
      orgId: r.organization.id,
      projectId: r.project.id,
      kind: kind as never,
      title,
      bodyMd: "Contenido con fuente.",
    });
  await doc("org_profile", "Perfil organizacional Nova");
  await doc("interview", "Entrevista dirección");
  await doc("interview", "Entrevista operaciones");
  await doc("finding", "Fugas de valor");
  await createProcess(db, { orgId: r.organization.id, name: "Producción", variant: "as_is" });

  const byKey = new Map(
    (r.launch.result as { tasks: { key: string; taskId: string }[] }).tasks.map(
      (t) => [t.key, t.taskId] as const,
    ),
  );
  await attachArtifact(db, { taskId: byKey.get("informe")!, kind: "report", title: "Informe final" });
  await attachArtifact(db, {
    taskId: byKey.get("roadmap")!,
    kind: "roadmap",
    title: "Roadmap",
    content: ROADMAP_MD,
  });
  // Roadmap APROBADO = su tarea cerrada en DONE (de ahí salen las palancas).
  db.$client
    .prepare(`UPDATE tasks SET status = 'DONE', version = version + 1 WHERE id = ?`)
    .run(byKey.get("roadmap")!);
}

describe("nextPhaseStatus (CA-M3.2)", () => {
  it("recién disparado: phase_incomplete con el detalle del cierre", async () => {
    const { db, r } = await launchedDb();
    const status = await nextPhaseStatus(db, r.project.id);
    expect(status.available).toBe(false);
    if (status.available) throw new Error("unreachable");
    expect(status.reason).toBe("phase_incomplete");
    expect(status.next_phase).toBe("CONSTRUIR");
    expect(status.closure?.complete).toBe(false);
  });

  it("deliverables completos pero gate sin aprobar: gate_pending", async () => {
    const { db, r } = await launchedDb();
    await completePhase(db, r);
    const status = await nextPhaseStatus(db, r.project.id);
    expect(status.available).toBe(false);
    if (status.available) throw new Error("unreachable");
    expect(status.reason).toBe("gate_pending");
  });

  it("cierre completo + gate aprobado: available con implementacion y prefill", async () => {
    const { db, r } = await launchedDb();
    await completePhase(db, r);
    const engine = createBoardEngine({ db });
    await engine.approveGate(r.project.id, "g1_plan", (await getPersonByFullName(db, "Ernesto"))!.id);

    const status = await nextPhaseStatus(db, r.project.id);
    expect(status.available).toBe(true);
    if (!status.available) throw new Error("unreachable");
    expect(status.next_phase).toBe("CONSTRUIR");
    expect(status.next_module.slug).toBe("implementacion"); // el activo de esa fase
    expect(status.previous_launch_id).toBe(r.launch.id);

    // Prefill CA-M3.2: identidad desde org + recibo (no redactados), palancas
    // desde el roadmap aprobado; la fecha objetivo es decisión nueva.
    const inputs = status.prefilled.inputs;
    expect(inputs["empresa"]).toBe("Nova Manufactura S.A.");
    expect(inputs["industria"]).toBe("manufactura");
    expect(inputs["cliente"]).toBe("Nova"); // alias ?? empresa
    expect(inputs["proyecto_origen"]).toBe("Assessment Nova");
    expect(inputs["palancas"]).toEqual(["Automatizar facturación", "Pipeline CRM"]);
    expect(inputs["notas_comercial"]).toBeUndefined(); // redactado: jamás se arrastra
    expect(inputs["fecha_objetivo"]).toBeUndefined();
    expect(status.prefilled.missing_required).toEqual(["fecha_objetivo"]);
  });

  it("disparo de implementacion sobre el MISMO proyecto con el prefill (CA-M3.3)", async () => {
    const { db, r } = await launchedDb();
    await completePhase(db, r);
    const engine = createBoardEngine({ db });
    await engine.approveGate(r.project.id, "g1_plan", (await getPersonByFullName(db, "Ernesto"))!.id);
    const status = await nextPhaseStatus(db, r.project.id);
    if (!status.available) throw new Error(`no disponible: ${JSON.stringify(status)}`);

    const docsBefore = (await listDocs(db, { projectId: r.project.id })).length;
    const tasksBefore = (await listTasks(db, { projectId: r.project.id })).length;

    const impl = await launchModule(db, {
      moduleSlug: status.next_module.slug,
      org: { orgId: r.organization.id },
      inputs: { ...status.prefilled.inputs, fecha_objetivo: "2026-10-30" },
      actor: "person:ernesto",
      idempotencyKey: "launch:test:next-phase:impl",
      previousLaunchId: status.previous_launch_id,
    });

    expect(impl.project.id).toBe(r.project.id); // mismo proyecto
    expect(impl.project.stage).toBe("CONSTRUIR"); // stage avanzado
    expect(impl.project.gateState).toBe("pending"); // gate de la fase nueva
    expect(impl.launch.previousLaunchId).toBe(r.launch.id);
    // Backlog nuevo: kickoff + 2 diseños + 2 construcciones + integración + UAT + handoff.
    expect(impl.tasks).toHaveLength(8);
    expect(await listTasks(db, { projectId: r.project.id })).toHaveLength(tasksBefore + 8);
    // Context Hub intacto: mismos docs de la fase anterior.
    expect(await listDocs(db, { projectId: r.project.id })).toHaveLength(docsBefore);
  });

  it("fase OPERAR: no hay siguiente (no_next_phase); proyecto sin launch: no_launch", async () => {
    const db = openDb(":memory:");
    runMigrations(db);
    await seed(db, { env: {} });
    const ops = await launchModule(db, {
      moduleSlug: "operacion",
      org: { name: "Nova Ops S.A." },
      inputs: { cliente: "Nova", objetivo: "Operar." },
      actor: "person:ernesto",
      idempotencyKey: "launch:test:next-phase:ops",
    });
    const status = await nextPhaseStatus(db, ops.project.id);
    expect(status).toMatchObject({ available: false, reason: "no_next_phase" });
  });
});

describe("prefillNextPhaseInputs — roadmap no parseable (no inventar)", () => {
  it("contenido sin lista → palancas fuera del prefill y en missing_required", async () => {
    const { db, r } = await launchedDb();
    await completePhase(db, r);
    // Pisar el roadmap con prosa sin lista (más reciente gana en el prefill).
    const byKey = new Map(
      (r.launch.result as { tasks: { key: string; taskId: string }[] }).tasks.map(
        (t) => [t.key, t.taskId] as const,
      ),
    );
    await attachArtifact(db, {
      taskId: byKey.get("roadmap")!,
      kind: "roadmap",
      title: "Roadmap narrativo",
      content: "Primero ordenar la facturación y luego el CRM, sin prioridades claras.",
    });
    const prefill = await prefillNextPhaseInputs(db, r.project.id, "implementacion");
    expect(prefill.inputs["palancas"]).toBeUndefined(); // el humano las pega
    expect(prefill.missing_required.sort()).toEqual(["fecha_objetivo", "palancas"]);
  });
});

describe("parseRoadmapLevers", () => {
  it("JSON array, lista markdown (-, *, 1.) y prosa", () => {
    expect(parseRoadmapLevers('["a", "b"]')).toEqual(["a", "b"]);
    expect(parseRoadmapLevers("- uno\n* dos\n3. tres\n")).toEqual(["uno", "dos", "tres"]);
    expect(parseRoadmapLevers("prosa sin listas")).toEqual([]);
    expect(parseRoadmapLevers(null)).toEqual([]);
    expect(parseRoadmapLevers("")).toEqual([]);
  });
});
