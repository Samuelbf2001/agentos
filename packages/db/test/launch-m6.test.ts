/**
 * M6a — motor de launch: cadencia consent-first (CA-M3.4) y encadenado de
 * fases (US-M3 / CA-M3.3) sobre DB temporal :memory: (patrón del repo).
 *
 * - Launch de operacion con cadences_confirmed: solo la confirmada nace (READY,
 *   con due = now + periodo/offset); el recibo guarda cadences_confirmed y las
 *   excluidas; previewLaunch expone cadence_proposals.
 * - Encadenado: previousLaunchId apunta el launch al MISMO proyecto (stage
 *   avanza a la fase nueva, gate vuelve a pending, Context Hub intacto);
 *   la reutilización por (org, nombre) auto-completa previous_launch_id.
 */
import { describe, expect, it } from "vitest";
import { DAY_MS, isAgentosError, type ErrorCode } from "@agentos/shared";
import { openDb, type AgentosDb } from "../src/client.js";
import { runMigrations } from "../src/migrate.js";
import { seed } from "../src/seed.js";
import {
  launchModule,
  previewLaunch,
  type LaunchModuleInput,
  type LaunchModuleResult,
} from "../src/modules/launch.js";
import {
  activateModuleVersion,
  createModuleVersion,
  getLaunch,
} from "../src/repositories/modules.js";
import { queryAudit } from "../src/repositories/audit.js";
import { createDoc, listDocs } from "../src/repositories/knowledge.js";
import { getProject, setGateState } from "../src/repositories/projects.js";
import { getTask, listTaskEvents, listTasks } from "../src/repositories/tasks.js";

const NOW = Date.parse("2026-08-28T00:00:00.000Z");

function seededDb(): AgentosDb {
  const db = openDb(":memory:");
  runMigrations(db);
  seed(db, { env: {} });
  return db;
}

function catchError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error("la llamada debió lanzar y no lanzó");
}

function expectDomainError(err: unknown, code: ErrorCode): void {
  expect(isAgentosError(err, code), String(err)).toBe(true);
}

const OPS_INPUTS = { cliente: "Nova", objetivo: "Operar la promesa mes a mes." };

function launchOps(db: AgentosDb, over: Partial<LaunchModuleInput> = {}): LaunchModuleResult {
  return launchModule(db, {
    moduleSlug: "operacion",
    org: { name: "Nova Ops S.A." },
    inputs: OPS_INPUTS,
    actor: "person:ernesto",
    idempotencyKey: "launch:test:m6:operacion",
    now: NOW,
    ...over,
  });
}

function launchConsultoriaNova(db: AgentosDb): LaunchModuleResult {
  return launchModule(db, {
    moduleSlug: "consultoria",
    org: { name: "Nova Manufactura S.A.", kind: "client", industria: "manufactura" },
    inputs: {
      empresa: "Nova Manufactura S.A.",
      alias: "Nova",
      industria: "manufactura",
      empleados: 40,
      sponsor: "Gerente General",
      objetivo: "Diagnóstico Entender.",
      areas: ["direccion", "operaciones"],
      fecha_objetivo: "2026-09-15",
    },
    actor: "person:ernesto",
    idempotencyKey: "launch:test:m6:consultoria",
    now: NOW,
  });
}

// ── Cadencia (CA-M3.4) ──────────────────────────────────────────────────────

describe("launchModule — cadencia consent-first (M6a)", () => {
  it("cadences_confirmed=['reporte_semanal']: nace SOLO esa, READY y con due", () => {
    const db = seededDb();
    const r = launchOps(db, { cadencesConfirmed: ["reporte_semanal"] });

    // 5 plantillas normales + 1 cadencia confirmada; sprint y check-in fuera.
    const result = r.launch.result as Record<string, any>;
    const keys = (result["tasks"] as { key: string }[]).map((t) => t.key);
    expect(keys).toContain("reporte_semanal");
    expect(keys).not.toContain("sprint_semanal");
    expect(keys).not.toContain("checkin_cliente");
    expect(result["cadences_confirmed"]).toEqual(["reporte_semanal"]);
    expect((result["cadence_excluded"] as string[]).sort()).toEqual([
      "checkin_cliente",
      "sprint_semanal",
    ]);

    const byKey = new Map(
      (result["tasks"] as { key: string; taskId: string }[]).map((t) => [t.key, t.taskId]),
    );
    const instancia = getTask(db, byKey.get("reporte_semanal")!)!;
    expect(instancia.status).toBe("READY"); // cadencias sin deps por validación
    expect(instancia.dueAt).toBe(NOW + 7 * DAY_MS); // due_offset_days: 7
    // Mapeo tarea→plantilla para la re-creación: task_event created con template_key.
    const created = listTaskEvents(db, instancia.id).find((e) => e.kind === "created")!;
    expect(created.payload?.["template_key"]).toBe("reporte_semanal");
    expect(created.payload?.["launch_id"]).toBe(r.launch.id);
  });

  it("sin confirmar: comportamiento actual (ninguna cadencia nace) y el recibo lo dice", () => {
    const db = seededDb();
    const r = launchOps(db);
    const result = r.launch.result as Record<string, any>;
    expect(result["cadences_confirmed"]).toEqual([]);
    expect((result["cadence_excluded"] as string[]).sort()).toEqual([
      "checkin_cliente",
      "reporte_semanal",
      "sprint_semanal",
    ]);
    expect(r.tasks).toHaveLength(5);
  });

  it("previewLaunch expone cadence_proposals con título renderizado y periodo", () => {
    const db = seededDb();
    const preview = previewLaunch(db, {
      moduleSlug: "operacion",
      inputs: OPS_INPUTS,
      now: NOW,
    });
    expect(preview.ok).toBe(true);
    const proposals = preview.plan!.cadenceProposals;
    expect(proposals.map((p) => p.key).sort()).toEqual([
      "checkin_cliente",
      "reporte_semanal",
      "sprint_semanal",
    ]);
    const byKey = new Map(proposals.map((p) => [p.key, p]));
    expect(byKey.get("reporte_semanal")!.periodDays).toBe(7);
    expect(byKey.get("sprint_semanal")!.periodDays).toBe(7);
    expect(byKey.get("checkin_cliente")!.periodDays).toBe(14);
    expect(byKey.get("checkin_cliente")!.title).toBe("Check-in con Nova");
    // Confirmando en el preview, la instancia aparece en el plan del dry-run.
    const confirmed = previewLaunch(db, {
      moduleSlug: "operacion",
      inputs: OPS_INPUTS,
      cadencesConfirmed: ["reporte_semanal"],
      now: NOW,
    });
    expect(confirmed.plan!.tasks.some((t) => t.key === "reporte_semanal")).toBe(true);
    expect(confirmed.plan!.cadencesConfirmed).toEqual(["reporte_semanal"]);
  });

  it("clave confirmada desconocida → launch rechazado fail-closed", () => {
    const db = seededDb();
    const err = catchError(() => launchOps(db, { cadencesConfirmed: ["no_existe"] }));
    expectDomainError(err, "validation_error");
  });
});

// ── Encadenado (US-M3 / CA-M3.3) ────────────────────────────────────────────

describe("launchModule — encadenado de fases (M6a)", () => {
  it("previousLaunchId: la fase nueva cae sobre el MISMO proyecto — stage avanza, gate a pending, Context Hub intacto", () => {
    const db = seededDb();
    const first = launchConsultoriaNova(db);
    expect(first.project.stage).toBe("ENTENDER");

    // Cierre humano de la fase: gate aprobado (habilita disparar la siguiente).
    setGateState(db, first.project.id, "approved", getProject(db, first.project.id)!.version);
    // Un doc del Context Hub que DEBE sobrevivir el encadenado.
    createDoc(db, {
      orgId: first.organization.id,
      projectId: first.project.id,
      kind: "org_profile",
      title: "Perfil Nova",
      bodyMd: "Perfil con fuentes.",
    });
    const docsBefore = listDocs(db, { projectId: first.project.id }).length;
    const tasksBefore = listTasks(db, { projectId: first.project.id }).length;

    const impl = launchModule(db, {
      moduleSlug: "implementacion",
      org: { orgId: first.organization.id },
      inputs: {
        cliente: "Nova",
        proyecto_origen: first.project.name,
        palancas: ["Automatizar facturación", "Pipeline CRM"],
        fecha_objetivo: "2026-10-15",
      },
      actor: "person:ernesto",
      idempotencyKey: "launch:test:m6:impl",
      previousLaunchId: first.launch.id,
      now: NOW,
    });

    // CA-M3.3: mismo proyecto (id y nombre), solo cambian stage y backlog activo.
    expect(impl.project.id).toBe(first.project.id);
    expect(impl.project.name).toBe(first.project.name);
    expect(impl.project.stage).toBe("CONSTRUIR");
    expect(impl.project.gateState).toBe("pending"); // el gate vigente es el de CONSTRUIR
    expect(impl.launch.phase).toBe("CONSTRUIR");
    expect(impl.launch.previousLaunchId).toBe(first.launch.id);

    // Backlog nuevo encima del anterior: kickoff + 2 diseños + 2 construcciones
    // + integración + UAT + handoff = 8 tareas nuevas.
    expect(impl.tasks).toHaveLength(8);
    expect(listTasks(db, { projectId: first.project.id })).toHaveLength(tasksBefore + 8);

    // Context Hub intacto (docs count igual) y recibo anterior intocado.
    expect(listDocs(db, { projectId: first.project.id })).toHaveLength(docsBefore);
    expect(getLaunch(db, first.launch.id)!.phase).toBe("ENTENDER");

    // El avance de fase queda auditado y anunciado post-commit.
    const audit = queryAudit(db, {
      action: "modules.phase_advanced",
      entityId: first.project.id,
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.before).toMatchObject({ stage: "ENTENDER", gateState: "approved" });
    expect(audit[0]!.after).toMatchObject({ stage: "CONSTRUIR", gateState: "pending" });
    expect(
      impl.pendingEvents.some(
        (e) =>
          e.event.type === "project.stage_changed" &&
          e.event.payload["from"] === "ENTENDER" &&
          e.event.payload["to"] === "CONSTRUIR",
      ),
    ).toBe(true);
  });

  it("previousLaunchId inexistente → not_found (y nada se escribe)", () => {
    const db = seededDb();
    const err = catchError(() =>
      launchOps(db, { previousLaunchId: "launch-fantasma", idempotencyKey: "launch:test:m6:x" }),
    );
    expectDomainError(err, "not_found");
  });

  it("previousLaunchId de OTRA organización → validation_error (el encadenado no cruza clientes)", () => {
    const db = seededDb();
    const first = launchConsultoriaNova(db);
    const err = catchError(() =>
      launchModule(db, {
        moduleSlug: "implementacion",
        org: { name: "Otra Empresa S.A." },
        inputs: {
          cliente: "Otra",
          proyecto_origen: "X",
          palancas: ["a"],
          fecha_objetivo: "2026-10-15",
        },
        actor: "person:ernesto",
        idempotencyKey: "launch:test:m6:cruce",
        previousLaunchId: first.launch.id,
        now: NOW,
      }),
    );
    expectDomainError(err, "validation_error");
  });

  it("misma fase vía previousLaunchId → conflict phase_already_launched", () => {
    const db = seededDb();
    const first = launchConsultoriaNova(db);
    const err = catchError(() =>
      launchModule(db, {
        moduleSlug: "consultoria",
        org: { orgId: first.organization.id },
        inputs: {
          empresa: "Nova Manufactura S.A.",
          industria: "manufactura",
          empleados: 40,
          sponsor: "GG",
          objetivo: "Repetir.",
          areas: ["direccion", "ventas"],
          fecha_objetivo: "2026-09-15",
        },
        actor: "person:ernesto",
        idempotencyKey: "launch:test:m6:refase",
        previousLaunchId: first.launch.id,
        now: NOW,
      }),
    );
    expectDomainError(err, "conflict");
    expect((err as { details?: { code?: string } }).details?.code).toBe("phase_already_launched");
  });

  it("reutilización por (org, nombre igual): stage avanza y previous_launch_id se auto-completa", () => {
    const db = seededDb();
    // Dos módulos sintéticos con el MISMO name_tpl: fase ENTENDER y CONSTRUIR.
    const base = {
      schema_version: 1,
      name: "Sintético",
      project: { name_tpl: "Sintético {{empresa}}", workspace_tpl: "workspaces/sintetico" },
      budget: { phase_usd: 10, per_run_usd: 1 },
      roster: [{ role: "worker", agent: "sam", layer: "consultoria" }],
      inputs: [{ key: "empresa", label: "Empresa", type: "text", required: true }],
    };
    const mkTemplate = (stage: string) => [
      {
        key: "kickoff",
        title: "Kickoff {{empresa}}",
        dod: "Acta registrada.",
        stage,
        activity_type: "kickoff",
        assign: { role: "worker" },
      },
    ];
    const activate = (bp: Record<string, unknown>) => {
      createModuleVersion(db, {
        slug: bp["slug"] as string,
        version: 1,
        name: "Sintético",
        phase: bp["phase"] as "ENTENDER" | "CONSTRUIR" | "OPERAR",
        projectType: bp["project_type"] as "assessment" | "transform" | "ops",
        methodologySlug: (bp["methodology"] as { slug: string }).slug,
        methodologyVersion: null,
        blueprint: bp,
        bodyMd: "sintético",
        createdBy: "person:test",
      });
      activateModuleVersion(db, bp["slug"] as string, 1);
    };
    activate({
      ...base,
      slug: "sintetico-a",
      version: 1,
      phase: "ENTENDER",
      project_type: "assessment",
      methodology: { slug: "assessment-14d", version: null },
      templates: mkTemplate("ENTENDER"),
    });
    activate({
      ...base,
      slug: "sintetico-b",
      version: 1,
      phase: "CONSTRUIR",
      project_type: "transform",
      methodology: { slug: "transform", version: null },
      templates: mkTemplate("CONSTRUIR"),
    });

    const a = launchModule(db, {
      moduleSlug: "sintetico-a",
      org: { name: "Encadenada S.A." },
      inputs: { empresa: "Encadenada S.A." },
      actor: "person:ernesto",
      idempotencyKey: "launch:test:m6:sint-a",
      now: NOW,
    });
    const b = launchModule(db, {
      moduleSlug: "sintetico-b",
      org: { name: "Encadenada S.A." },
      inputs: { empresa: "Encadenada S.A." },
      actor: "person:ernesto",
      idempotencyKey: "launch:test:m6:sint-b",
      now: NOW,
    });
    expect(b.project.id).toBe(a.project.id); // (org, nombre) igual → mismo proyecto
    expect(b.project.stage).toBe("CONSTRUIR");
    expect(b.project.gateState).toBe("pending");
    expect(b.launch.previousLaunchId).toBe(a.launch.id); // auto-completado
  });
});
