/**
 * phaseClosureStatus (M3, CA-M3.1 — §13.8): compara los deliverables EFECTIVOS
 * del último launch (recibo con min_from_input resuelto) contra la realidad:
 * knowledge_docs por kind, processes as_is y artifacts por kind en tareas del
 * proyecto. Sin launch → no_launch. Con los mínimos creados → complete.
 */
import { describe, expect, it } from "vitest";
import {
  attachArtifact,
  createDoc,
  createProcess,
  launchModule,
  openDb,
  runMigrations,
  seed,
  type AgentosDb,
  type LaunchModuleResult,
} from "@agentos/db";
import { phaseClosureStatus } from "../src/index.js";
import { fixture } from "./helpers.js";

async function launchedDb(): Promise<{ db: AgentosDb; r: LaunchModuleResult }> {
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
      areas: ["direccion", "operaciones", "ventas"],
      procesos_core: ["Producción", "Ventas → Facturación"],
      fecha_objetivo: "2026-09-15",
    },
    toggles: { iso9001: true },
    actor: "person:ernesto",
    idempotencyKey: "launch:test:closure:consultoria",
  });
  return { db, r };
}

describe("phaseClosureStatus (CA-M3.1)", () => {
  it("proyecto sin launch → {complete:false, items:[], reason:'no_launch'}", async () => {
    const f = await fixture(); // proyecto creado a mano, sin module_launches
    expect(await phaseClosureStatus(f.db, f.project.id)).toEqual({
      launchId: null,
      complete: false,
      items: [],
      reason: "no_launch",
    });
  });

  it("recién disparado: incompleto, con required de min_from_input y missing legible", async () => {
    const { db, r } = await launchedDb();
    const status = await phaseClosureStatus(db, r.project.id);

    expect(status.launchId).toBe(r.launch.id);
    expect(status.complete).toBe(false);
    // 7 entregables efectivos (ISO on): org_profile, interview, process_map,
    // finding, iso_clause, report, roadmap.
    expect(status.items.map((i) => i.kind)).toEqual([
      "org_profile",
      "interview",
      "process_map",
      "finding",
      "iso_clause",
      "report",
      "roadmap",
    ]);
    const byKind = new Map(status.items.map((i) => [i.kind, i]));
    expect(byKind.get("interview")).toMatchObject({ source: "knowledge_doc", required: 3, found: 0 });
    expect(byKind.get("process_map")).toMatchObject({ source: "process", required: 2, found: 0 });
    expect(byKind.get("report")).toMatchObject({ source: "artifact", required: 1, found: 0 });
    // missing legible: cuánto falta, de qué kind, de qué fuente y quién lo produce.
    expect(byKind.get("interview")!.missing).toContain('Falta(n) 3 de 3 "interview"');
    expect(byKind.get("interview")!.missing).toContain("Context Hub");
    expect(byKind.get("interview")!.missing).toContain('plantilla "entrevista"');
    expect(byKind.get("process_map")!.missing).toContain("as-is");
  });

  it("progreso parcial: found sube y el missing dice cuánto queda", async () => {
    const { db, r } = await launchedDb();
    for (let i = 0; i < 2; i += 1) {
      await createDoc(db, {
        orgId: r.organization.id,
        projectId: r.project.id,
        kind: "interview",
        title: `Entrevista ${i + 1}`,
        bodyMd: "Hallazgos con citas.",
      });
    }
    const item = (await phaseClosureStatus(db, r.project.id)).items.find((i) => i.kind === "interview")!;
    expect(item.found).toBe(2);
    expect(item.missing).toContain('Falta(n) 1 de 3 "interview"');
  });

  it("con los mínimos reales creados → complete:true y todos los missing en null", async () => {
    const { db, r } = await launchedDb();
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
    await doc("interview", "Entrevista ventas");
    await doc("finding", "Fugas de valor");
    await doc("iso_clause", "Matriz ISO 9001");
    await createProcess(db, { orgId: r.organization.id, name: "Producción", variant: "as_is" });
    await createProcess(db, { orgId: r.organization.id, name: "Ventas → Facturación", variant: "as_is" });

    const byKey = new Map(
      (r.launch.result as { tasks: { key: string; taskId: string }[] }).tasks.map(
        (t) => [t.key, t.taskId] as const,
      ),
    );
    await attachArtifact(db, { taskId: byKey.get("informe")!, kind: "report", title: "Informe final" });
    await attachArtifact(db, { taskId: byKey.get("roadmap")!, kind: "roadmap", title: "Roadmap" });

    const status = await phaseClosureStatus(db, r.project.id);
    expect(status.complete).toBe(true);
    expect(status.items.every((i) => i.missing === null)).toBe(true);
    expect(status.items.every((i) => i.found >= i.required)).toBe(true);
  });

  it("docs de OTRO proyecto y procesos to_be no cuentan", async () => {
    const { db, r } = await launchedDb();
    // Doc del kind correcto pero sin projectId (org-level): no cierra la fase.
    await createDoc(db, {
      orgId: r.organization.id,
      projectId: null,
      kind: "org_profile",
      title: "Perfil suelto",
      bodyMd: "x",
    });
    await createProcess(db, { orgId: r.organization.id, name: "Futuro", variant: "to_be" });
    const status = await phaseClosureStatus(db, r.project.id);
    expect(status.items.find((i) => i.kind === "org_profile")!.found).toBe(0);
    expect(status.items.find((i) => i.kind === "process_map")!.found).toBe(0);
  });
});
