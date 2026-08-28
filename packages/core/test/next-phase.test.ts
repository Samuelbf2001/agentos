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
  type AgentosDb,
  type LaunchModuleResult,
} from "@agentos/db";
import {
  createBoardEngine,
  nextPhaseStatus,
  parseRoadmapLevers,
  prefillNextPhaseInputs,
} from "../src/index.js";

const ROADMAP_MD = "## Palancas priorizadas\n\n- Automatizar facturación\n- Pipeline CRM\n";

function launchedDb(): { db: AgentosDb; r: LaunchModuleResult } {
  const db = openDb(":memory:");
  runMigrations(db);
  seed(db, { env: {} });
  const r = launchModule(db, {
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
function completePhase(db: AgentosDb, r: LaunchModuleResult): void {
  const doc = (kind: string, title: string) =>
    createDoc(db, {
      orgId: r.organization.id,
      projectId: r.project.id,
      kind: kind as never,
      title,
      bodyMd: "Contenido con fuente.",
    });
  doc("org_profile", "Perfil organizacional Nova");
  doc("interview", "Entrevista dirección");
  doc("interview", "Entrevista operaciones");
  doc("finding", "Fugas de valor");
  createProcess(db, { orgId: r.organization.id, name: "Producción", variant: "as_is" });

  const byKey = new Map(
    (r.launch.result as { tasks: { key: string; taskId: string }[] }).tasks.map(
      (t) => [t.key, t.taskId] as const,
    ),
  );
  attachArtifact(db, { taskId: byKey.get("informe")!, kind: "report", title: "Informe final" });
  attachArtifact(db, {
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
  it("recién disparado: phase_incomplete con el detalle del cierre", () => {
    const { db, r } = launchedDb();
    const status = nextPhaseStatus(db, r.project.id);
    expect(status.available).toBe(false);
    if (status.available) throw new Error("unreachable");
    expect(status.reason).toBe("phase_incomplete");
    expect(status.next_phase).toBe("CONSTRUIR");
    expect(status.closure?.complete).toBe(false);
  });

  it("deliverables completos pero gate sin aprobar: gate_pending", () => {
    const { db, r } = launchedDb();
    completePhase(db, r);
    const status = nextPhaseStatus(db, r.project.id);
    expect(status.available).toBe(false);
    if (status.available) throw new Error("unreachable");
    expect(status.reason).toBe("gate_pending");
  });

  it("cierre completo + gate aprobado: available con implementacion y prefill", () => {
    const { db, r } = launchedDb();
    completePhase(db, r);
    const engine = createBoardEngine({ db });
    engine.approveGate(r.project.id, "g1_plan", getPersonByFullName(db, "Ernesto")!.id);

    const status = nextPhaseStatus(db, r.project.id);
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

  it("disparo de implementacion sobre el MISMO proyecto con el prefill (CA-M3.3)", () => {
    const { db, r } = launchedDb();
    completePhase(db, r);
    const engine = createBoardEngine({ db });
    engine.approveGate(r.project.id, "g1_plan", getPersonByFullName(db, "Ernesto")!.id);
    const status = nextPhaseStatus(db, r.project.id);
    if (!status.available) throw new Error(`no disponible: ${JSON.stringify(status)}`);

    const docsBefore = listDocs(db, { projectId: r.project.id }).length;
    const tasksBefore = listTasks(db, { projectId: r.project.id }).length;

    const impl = launchModule(db, {
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
    expect(listTasks(db, { projectId: r.project.id })).toHaveLength(tasksBefore + 8);
    // Context Hub intacto: mismos docs de la fase anterior.
    expect(listDocs(db, { projectId: r.project.id })).toHaveLength(docsBefore);
  });

  it("fase OPERAR: no hay siguiente (no_next_phase); proyecto sin launch: no_launch", () => {
    const db = openDb(":memory:");
    runMigrations(db);
    seed(db, { env: {} });
    const ops = launchModule(db, {
      moduleSlug: "operacion",
      org: { name: "Nova Ops S.A." },
      inputs: { cliente: "Nova", objetivo: "Operar." },
      actor: "person:ernesto",
      idempotencyKey: "launch:test:next-phase:ops",
    });
    const status = nextPhaseStatus(db, ops.project.id);
    expect(status).toMatchObject({ available: false, reason: "no_next_phase" });
  });
});

describe("prefillNextPhaseInputs — roadmap no parseable (no inventar)", () => {
  it("contenido sin lista → palancas fuera del prefill y en missing_required", () => {
    const { db, r } = launchedDb();
    completePhase(db, r);
    // Pisar el roadmap con prosa sin lista (más reciente gana en el prefill).
    const byKey = new Map(
      (r.launch.result as { tasks: { key: string; taskId: string }[] }).tasks.map(
        (t) => [t.key, t.taskId] as const,
      ),
    );
    attachArtifact(db, {
      taskId: byKey.get("roadmap")!,
      kind: "roadmap",
      title: "Roadmap narrativo",
      content: "Primero ordenar la facturación y luego el CRM, sin prioridades claras.",
    });
    const prefill = prefillNextPhaseInputs(db, r.project.id, "implementacion");
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
