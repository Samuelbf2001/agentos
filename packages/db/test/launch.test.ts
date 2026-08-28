/**
 * Motor de launch (M2 — ARCHITECTURE §13.3): NM-1..NM-4, CA-M2.5/CA-M2.6,
 * uq(project_id, phase), redacción de inputs sensibles y resolución de
 * asignaciones por capa/rol. Todo sobre DB temporal :memory: (patrón del repo).
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DAY_MS,
  canonicalizeBlueprint,
  isAgentosError,
  type ErrorCode,
} from "@agentos/shared";
import { openDb, type AgentosDb } from "../src/client.js";
import { runMigrations } from "../src/migrate.js";
import { seed } from "../src/seed.js";
import {
  REDACTED,
  launchModule,
  launchOrderKey,
  type LaunchModuleInput,
  type LaunchModuleResult,
} from "../src/modules/launch.js";
import {
  activateModuleVersion,
  createModuleVersion,
  getActiveModule,
  getLaunch,
  getModuleVersion,
} from "../src/repositories/modules.js";
import { getAgentBySlug, updateAgent } from "../src/repositories/agents.js";
import { queryAudit } from "../src/repositories/audit.js";
import { getConfig } from "../src/repositories/config.js";
import { getTask, listTaskEvents } from "../src/repositories/tasks.js";
import { buildSessionKey, getOrCreateThread, getThread } from "../src/repositories/threads.js";

// ── Fixtures ────────────────────────────────────────────────────────────────

const NOW = Date.parse("2026-08-28T00:00:00.000Z");

/**
 * Inputs demo con la forma del §13.6 (areas ×3, procesos_core ×2, fecha
 * objetivo, ISO on ⇒ 12 tareas, 3 READY + 9 BACKLOG). Cliente "Nova" en vez de
 * ACME: el seed aún crea el proyecto demo "Assessment ACME" hardcodeado (lo
 * reemplaza M4) y reutilizarlo contaminaría la aritmética del test.
 */
const DEMO_INPUTS: Record<string, unknown> = {
  empresa: "Nova Manufactura S.A.",
  alias: "Nova",
  industria: "manufactura",
  empleados: 40,
  sponsor: "Gerente General",
  objetivo: "Diagnóstico del ciclo Entender con miras a ISO 9001.",
  areas: ["direccion", "operaciones", "ventas"],
  procesos_core: ["Producción", "Ventas → Facturación"],
  fecha_objetivo: "2026-09-15",
  notas_comercial: "Presupuesto pre-aprobado por gerencia (confidencial).",
};

function seededDb(): AgentosDb {
  const db = openDb(":memory:");
  runMigrations(db);
  seed(db, { env: {} });
  return db;
}

function launchNova(db: AgentosDb, over: Partial<LaunchModuleInput> = {}): LaunchModuleResult {
  return launchModule(db, {
    moduleSlug: "consultoria",
    org: { name: "Nova Manufactura S.A.", kind: "client", industria: "manufactura", employeeCount: 40 },
    inputs: DEMO_INPUTS,
    toggles: { iso9001: true },
    actor: "person:ernesto",
    idempotencyKey: "launch:test:consultoria:nova",
    now: NOW,
    ...over,
  });
}

const COUNTED_TABLES = [
  "organizations",
  "projects",
  "tasks",
  "task_events",
  "module_launches",
  "audit_log",
  "app_config",
  "threads",
] as const;

function tableCounts(db: AgentosDb): Record<string, number> {
  const out: Record<string, number> = {};
  for (const table of COUNTED_TABLES) {
    out[table] = (db.$client.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n;
  }
  return out;
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

/** Módulo sintético mínimo válido (assign por rol, fan_out opcional). */
function syntheticBlueprint(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    slug: "sintetico",
    version: 1,
    name: "Módulo sintético",
    phase: "ENTENDER",
    project_type: "assessment",
    project: { name_tpl: "Sintético {{empresa}}", workspace_tpl: "workspaces/sintetico" },
    methodology: { slug: "assessment-14d", version: null },
    budget: { phase_usd: 10, per_run_usd: 1 },
    roster: [{ role: "worker", agent: "sam", layer: "consultoria" }],
    inputs: [{ key: "empresa", label: "Empresa", type: "text", required: true }],
    templates: [
      {
        key: "kickoff",
        title: "Kickoff {{empresa}}",
        dod: "Acta registrada.",
        stage: "ENTENDER",
        activity_type: "kickoff",
        assign: { role: "worker" },
      },
    ],
    ...over,
  };
}

function activateSynthetic(db: AgentosDb, bp: Record<string, unknown>): void {
  createModuleVersion(db, {
    slug: bp["slug"] as string,
    version: bp["version"] as number,
    name: bp["name"] as string,
    phase: bp["phase"] as "ENTENDER" | "CONSTRUIR" | "OPERAR",
    projectType: bp["project_type"] as "assessment" | "transform" | "ops",
    methodologySlug: (bp["methodology"] as { slug: string }).slug,
    methodologyVersion: (bp["methodology"] as { version: number | null }).version,
    blueprint: bp,
    bodyMd: "Módulo sintético de test.",
    createdBy: "person:test",
  });
  activateModuleVersion(db, bp["slug"] as string, bp["version"] as number);
}

// ── NM-1: atomicidad ────────────────────────────────────────────────────────

describe("launchModule — NM-1 atomicidad (CA-M2.2)", () => {
  it("launch feliz: org + proyecto + 12 tareas + deps + presupuesto + recibo + audit", () => {
    const db = seededDb();
    const r = launchNova(db);

    // Organización get-or-create y proyecto con type/stage/gate del módulo.
    expect(r.organization.name).toBe("Nova Manufactura S.A.");
    expect(r.organization.kind).toBe("client");
    expect(r.project.name).toBe("Assessment Nova");
    expect(r.project.type).toBe("assessment");
    expect(r.project.stage).toBe("ENTENDER");
    expect(r.project.gateState).toBe("pending");
    expect(r.project.workspacePath).toBe("workspaces/assessment-Nova");

    // Aritmética del §13.6: 12 tareas, 3 READY + 9 BACKLOG, en orden estable.
    expect(r.tasks).toHaveLength(12);
    const resultTasks = (r.launch.result as { tasks: { key: string; taskId: string; status: string }[] }).tasks;
    expect(resultTasks.map((t) => t.key)).toEqual([
      "kickoff",
      "perfil_org",
      "inventario_sistemas",
      "entrevista:direccion",
      "entrevista:operaciones",
      "entrevista:ventas",
      "mapa_proceso:produccion",
      "mapa_proceso:ventas_facturacion",
      "fugas",
      "matriz_iso",
      "informe",
      "roadmap",
    ]);
    const byKey = new Map(resultTasks.map((t) => [t.key, getTask(db, t.taskId)!]));
    const ready = [...byKey.entries()].filter(([, t]) => t.status === "READY").map(([k]) => k);
    expect(ready.sort()).toEqual(["inventario_sistemas", "kickoff", "perfil_org"]);
    expect([...byKey.values()].filter((t) => t.status === "BACKLOG")).toHaveLength(9);

    // Variables sustituidas y asignaciones por rol → roster real.
    const agentId = (slug: string) => getAgentBySlug(db, slug)!.id;
    expect(byKey.get("kickoff")!.title).toBe("Kickoff con sponsor de Nova");
    expect(byKey.get("kickoff")!.assigneeAgentId).toBe(agentId("alex"));
    expect(byKey.get("perfil_org")!.assigneeAgentId).toBe(agentId("sam"));
    expect(byKey.get("inventario_sistemas")!.assigneeAgentId).toBe(agentId("clara"));
    expect(byKey.get("entrevista:direccion")!.title).toBe("Entrevista: direccion");
    expect(byKey.get("roadmap")!.assigneeAgentId).toBe(agentId("alex"));

    // Política de aprobación que SOLO sube (NM-5): 7 entregables auditados.
    expect([...byKey.values()].filter((t) => t.requiresApproval)).toHaveLength(7);

    // Dependencias: claves de instancia → ids reales (CA-M2.3).
    const id = (key: string) => byKey.get(key)!.id;
    expect(byKey.get("entrevista:direccion")!.dependsOn).toEqual([id("kickoff")]);
    expect(byKey.get("fugas")!.dependsOn).toEqual([
      id("entrevista:direccion"),
      id("entrevista:operaciones"),
      id("entrevista:ventas"),
      id("mapa_proceso:produccion"),
      id("mapa_proceso:ventas_facturacion"),
    ]);
    expect(byKey.get("informe")!.dependsOn).toEqual([id("fugas"), id("matriz_iso")]);
    expect(byKey.get("roadmap")!.dependsOn).toEqual([id("informe")]);

    // due_at determinista con now inyectado (offset y due_from_input).
    expect(byKey.get("kickoff")!.dueAt).toBe(NOW + 2 * DAY_MS);
    expect(byKey.get("informe")!.dueAt).toBe(Date.parse("2026-09-14T00:00:00.000Z"));
    expect(byKey.get("roadmap")!.dueAt).toBe(Date.parse("2026-09-15T00:00:00.000Z"));

    // orderKey fraccionario secuencial (patrón del seed: a0…b1).
    expect(r.tasks.map((t) => t.orderKey)).toEqual(
      Array.from({ length: 12 }, (_, i) => launchOrderKey(i)),
    );

    // Timeline: un task_event 'created' por tarea con {launch_id, template_key}.
    for (const t of resultTasks) {
      const events = listTaskEvents(db, t.taskId).filter((e) => e.kind === "created");
      expect(events).toHaveLength(1);
      expect(events[0]!.actor).toBe("person:ernesto");
      expect(events[0]!.payload?.["launch_id"]).toBe(r.launch.id);
      expect(events[0]!.payload?.["template_key"]).toBeTruthy();
    }

    // Presupuesto de fase en app_config (§13.4).
    expect(getConfig(db, `budget:project:${r.project.id}`)).toEqual({
      phase_usd: 15,
      per_run_usd: 2,
      warning_thresholds_pct: [70, 90, 100],
      launch_id: r.launch.id,
    });

    // Recibo inmutable: snapshot + hash del módulo activo + metadatos.
    const module = getActiveModule(db, "consultoria")!;
    expect(r.launch.moduleSlug).toBe("consultoria");
    expect(r.launch.moduleVersion).toBe(1);
    expect(r.launch.phase).toBe("ENTENDER");
    expect(r.launch.blueprintHash).toBe(module.blueprintHash);
    expect(r.launch.taskCount).toBe(12);
    expect(r.launch.actor).toBe("person:ernesto");
    expect(r.launch.methodologyId).toBeTruthy();
    const resultMeta = r.launch.result as Record<string, any>;
    expect(resultMeta["gate"]).toEqual({ name: "g1_plan", blocks_next_stage: "CONSTRUIR", state: "pending" });
    expect(resultMeta["methodology"]["slug"]).toBe("assessment-14d");
    expect(resultMeta["methodology"]["adds"].map((m: { slug: string }) => m.slug)).toEqual(["iso9001-prep"]);
    // min_from_input resuelto: una entrevista por área, un mapa por proceso.
    const deliverables = resultMeta["deliverables"] as { kind: string; min: number }[];
    expect(deliverables.find((d) => d.kind === "interview")!.min).toBe(3);
    expect(deliverables.find((d) => d.kind === "process_map")!.min).toBe(2);

    // Auditoría (NM-5) con inputs redactados.
    const audits = queryAudit(db, { action: "modules.launch" });
    expect(audits).toHaveLength(1);
    expect(audits[0]!.actor).toBe("person:ernesto");
    expect(audits[0]!.entityId).toBe(r.launch.id);
    expect((audits[0]!.after?.["inputs"] as Record<string, unknown>)["notas_comercial"]).toBe(REDACTED);

    // Eventos pendientes POST-commit: 12 task.created + 1 module.launched.
    expect(r.pendingEvents).toHaveLength(13);
    expect(new Set(r.pendingEvents.map((e) => e.topic))).toEqual(new Set([`board:${r.project.id}`]));
    expect(r.pendingEvents.slice(0, 12).every((e) => e.event.type === "task.created")).toBe(true);
    expect(r.pendingEvents[12]!.event.type).toBe("module.launched");
    expect(r.pendingEvents[12]!.event.payload["launchId"]).toBe(r.launch.id);
    expect(r.idempotent).toBe(false);
  });

  it("fallo inyectado a mitad de transacción → CERO filas huérfanas", () => {
    const db = seededDb();
    // Hilo pre-existente que el launch intentaría asociar al proyecto.
    const thread = getOrCreateThread(db, {
      channel: "whatsapp",
      sessionKey: buildSessionKey("whatsapp", "nova-sponsor"),
      title: "Sponsor Nova",
    });
    const before = tableCounts(db);

    // previous_launch_id con FK rota: el INSERT del recibo (último paso, tras
    // org+proyecto+12 tareas+eventos+presupuesto+hilos) revienta dentro de la
    // transacción → rollback COMPLETO.
    expect(() =>
      launchNova(db, {
        previousLaunchId: "launch-inexistente",
        inputs: { ...DEMO_INPUTS, fuentes: [thread.sessionKey] },
        idempotencyKey: "launch:test:rollback",
      }),
    ).toThrow();

    // Ni recibo ni proyecto a medias: conteos idénticos tabla a tabla (NM-1),
    // y el hilo que se habría re-asociado sigue sin proyecto.
    expect(tableCounts(db)).toEqual(before);
    expect(getThread(db, thread.id)!.projectId).toBeNull();
  });
});

// ── NM-2: duración ≤ 60 s ──────────────────────────────────────────────────

describe("launchModule — NM-2 duración", () => {
  it("consultoria (12 tareas) dispara en <60s (local: ms)", () => {
    const db = seededDb();
    const t0 = Date.now();
    const r = launchNova(db);
    const elapsed = Date.now() - t0;
    console.info(`NM-2 consultoria (12 tareas): ${elapsed}ms medidos, durationMs=${r.durationMs}`);
    expect(elapsed).toBeLessThan(60_000);
    expect(r.launch.durationMs).toBeLessThan(60_000);
  });

  it("blueprint sintético de 40 instancias (tope MAX_LAUNCH_TASKS) en <60s", () => {
    const db = seededDb();
    activateSynthetic(db, {
      ...syntheticBlueprint({ slug: "sintetico40" }),
      inputs: [
        { key: "empresa", label: "Empresa", type: "text", required: true },
        { key: "items", label: "Items", type: "list_text", required: true, min_items: 1 },
      ],
      templates: [
        {
          key: "kickoff",
          title: "Kickoff {{empresa}}",
          dod: "Acta registrada.",
          stage: "ENTENDER",
          activity_type: "kickoff",
          assign: { role: "worker" },
        },
        {
          key: "item",
          title: "Trabajo: {{item}}",
          dod: "Cerrado {{item}}.",
          stage: "ENTENDER",
          activity_type: "analysis",
          assign: { role: "worker" },
          depends_on: ["kickoff"],
          fan_out: { over: "items", as: "item" },
        },
      ],
    });
    const items = Array.from({ length: 39 }, (_, i) => `item ${i + 1}`);
    const t0 = Date.now();
    const r = launchModule(db, {
      moduleSlug: "sintetico40",
      org: { name: "Perf S.A." },
      inputs: { empresa: "Perf S.A.", items },
      actor: "person:ernesto",
      idempotencyKey: "launch:test:sintetico40",
      now: NOW,
    });
    const elapsed = Date.now() - t0;
    console.info(`NM-2 sintético (40 instancias): ${elapsed}ms medidos, durationMs=${r.durationMs}`);
    expect(r.tasks).toHaveLength(40);
    expect(elapsed).toBeLessThan(60_000);
    expect(r.launch.durationMs).toBeLessThan(60_000);
  });
});

// ── NM-3: inmutabilidad del recibo ─────────────────────────────────────────

describe("launchModule — NM-3 inmutabilidad", () => {
  it("editar el módulo (v2 activa) NO toca el proyecto disparado ni el recibo v1", () => {
    const db = seededDb();
    const r = launchNova(db);
    const v1 = getModuleVersion(db, "consultoria", 1)!;
    const titlesBefore = r.tasks.map((t) => getTask(db, t.id)!.title);

    // v2 con blueprint DISTINTO (kickoff renombrado) y activada.
    const v2bp = JSON.parse(JSON.stringify(v1.blueprint));
    v2bp.version = 2;
    v2bp.templates[0].title = "Kickoff RENOMBRADO con {{cliente}}";
    createModuleVersion(db, {
      slug: "consultoria",
      version: 2,
      name: "Consultoría v2",
      phase: "ENTENDER",
      projectType: "assessment",
      methodologySlug: "assessment-14d",
      methodologyVersion: null,
      blueprint: v2bp,
      bodyMd: v1.bodyMd,
      createdBy: "person:test",
    });
    activateModuleVersion(db, "consultoria", 2);
    expect(getActiveModule(db, "consultoria")!.version).toBe(2);

    // El proyecto disparado no cambió.
    const titlesAfter = r.tasks.map((t) => getTask(db, t.id)!.title);
    expect(titlesAfter).toEqual(titlesBefore);

    // El recibo conserva snapshot + hash de la v1 (triple candado).
    const launch = getLaunch(db, r.launch.id)!;
    expect(launch.moduleVersion).toBe(1);
    expect(launch.blueprintHash).toBe(v1.blueprintHash);
    expect((launch.blueprintSnapshot as { templates: { title: string }[] }).templates[0]!.title).toBe(
      "Kickoff con sponsor de {{cliente}}",
    );
  });
});

// ── NM-4: solo módulos activos disparan ─────────────────────────────────────

describe("launchModule — NM-4 fail-closed por estado del módulo", () => {
  it("módulo en draft → module_not_active", () => {
    const db = seededDb();
    const bp = syntheticBlueprint({ slug: "borrador" });
    createModuleVersion(db, {
      slug: "borrador",
      version: 1,
      name: "Borrador",
      phase: "ENTENDER",
      projectType: "assessment",
      methodologySlug: "assessment-14d",
      methodologyVersion: null,
      blueprint: bp,
      bodyMd: "draft",
      createdBy: "person:test",
    }); // sin activar
    const err = catchError(() =>
      launchModule(db, {
        moduleSlug: "borrador",
        org: { name: "X S.A." },
        inputs: { empresa: "X S.A." },
        actor: "person:ernesto",
        idempotencyKey: "launch:test:borrador",
      }),
    );
    expectDomainError(err, "module_not_active");
  });

  it("versión archivada → module_not_active (aunque exista una activa más nueva)", () => {
    const db = seededDb();
    const v1 = getModuleVersion(db, "consultoria", 1)!;
    const v2bp = JSON.parse(JSON.stringify(v1.blueprint));
    v2bp.version = 2;
    createModuleVersion(db, {
      slug: "consultoria",
      version: 2,
      name: "Consultoría v2",
      phase: "ENTENDER",
      projectType: "assessment",
      methodologySlug: "assessment-14d",
      methodologyVersion: null,
      blueprint: v2bp,
      bodyMd: v1.bodyMd,
    });
    activateModuleVersion(db, "consultoria", 2); // archiva la v1
    const err = catchError(() => launchNova(db, { moduleVersion: 1 }));
    expectDomainError(err, "module_not_active");
  });

  it("slug inexistente → not_found", () => {
    const db = seededDb();
    const err = catchError(() =>
      launchModule(db, {
        moduleSlug: "no-existe",
        org: { name: "X S.A." },
        inputs: {},
        actor: "person:ernesto",
        idempotencyKey: "launch:test:no-existe",
      }),
    );
    expectDomainError(err, "not_found");
  });
});

// ── CA-M2.6: idempotencia ───────────────────────────────────────────────────

describe("launchModule — CA-M2.6 idempotencia", () => {
  it("misma key + mismos inputs → mismo launch, sin duplicar nada", () => {
    const db = seededDb();
    const first = launchNova(db);
    const after = tableCounts(db);

    const second = launchNova(db);
    expect(second.idempotent).toBe(true);
    expect(second.launch.id).toBe(first.launch.id);
    expect(second.project.id).toBe(first.project.id);
    expect(second.tasks.map((t) => t.id).sort()).toEqual(first.tasks.map((t) => t.id).sort());
    expect(second.pendingEvents).toEqual([]); // nada nuevo → nada que publicar
    expect(tableCounts(db)).toEqual(after); // cero filas nuevas
  });

  it("misma key + inputs DISTINTOS → idempotency_conflict", () => {
    const db = seededDb();
    launchNova(db);
    const err = catchError(() =>
      launchNova(db, { inputs: { ...DEMO_INPUTS, objetivo: "Otro objetivo distinto." } }),
    );
    expectDomainError(err, "idempotency_conflict");
  });
});

// ── uq(project_id, phase): una fase por proyecto ────────────────────────────

describe("launchModule — uq(project_id, phase)", () => {
  it("segundo launch de la misma fase sobre el mismo proyecto → error de dominio limpio", () => {
    const db = seededDb();
    launchNova(db);
    const after = tableCounts(db);
    // Otra idempotency_key, mismos inputs → mismo proyecto (get-or-create por
    // nombre) → la fase ENTENDER ya está disparada.
    const err = catchError(() => launchNova(db, { idempotencyKey: "launch:test:consultoria:nova-2" }));
    expectDomainError(err, "conflict");
    expect((err as { details?: { code?: string } }).details?.code).toBe("phase_already_launched");
    expect(tableCounts(db)).toEqual(after); // el rechazo no dejó nada a medias
  });
});

// ── Redacción de inputs sensibles ───────────────────────────────────────────

describe("launchModule — redacción (§13.1 + NM-5)", () => {
  it("recibo con notas_comercial=[redacted]; digest sobre el ORIGINAL; audit sin el valor", () => {
    const db = seededDb();
    const r = launchNova(db);

    const stored = r.launch.inputs as Record<string, unknown>;
    expect(stored["notas_comercial"]).toBe(REDACTED);
    expect(stored["empresa"]).toBe("Nova Manufactura S.A."); // el resto, literal

    // inputs_digest = sha256 del JSON canónico SIN redactar.
    const expectedDigest = createHash("sha256")
      .update(canonicalizeBlueprint(DEMO_INPUTS))
      .digest("hex");
    expect(r.launch.inputsDigest).toBe(expectedDigest);

    // La auditoría no contiene el valor sensible por ningún lado.
    const audit = queryAudit(db, { action: "modules.launch" })[0]!;
    expect(JSON.stringify(audit)).not.toContain("pre-aprobado por gerencia");
    expect((audit.after?.["inputs"] as Record<string, unknown>)["notas_comercial"]).toBe(REDACTED);
  });
});

// ── CA-M2.5: toggle ISO off ─────────────────────────────────────────────────

describe("launchModule — CA-M2.5 toggle ISO", () => {
  it("sin iso9001: ni matriz_iso, ni entregable iso_clause, ni metodología add", () => {
    const db = seededDb();
    const r = launchNova(db, { toggles: { iso9001: false } });

    expect(r.tasks).toHaveLength(11);
    const result = r.launch.result as Record<string, any>;
    const keys = (result["tasks"] as { key: string }[]).map((t) => t.key);
    expect(keys).not.toContain("matriz_iso");

    // Snapshot efectivo del plan: el entregable iso_clause quedó fuera.
    const kinds = (result["deliverables"] as { kind: string }[]).map((d) => d.kind);
    expect(kinds).not.toContain("iso_clause");
    expect(result["methodology"]["adds"]).toEqual([]);

    // La dep de informe hacia matriz_iso se PODÓ (no es error — §13.5).
    const byKey = new Map(
      (result["tasks"] as { key: string; taskId: string }[]).map((t) => [t.key, t.taskId]),
    );
    expect(getTask(db, byKey.get("informe")!)!.dependsOn).toEqual([byKey.get("fugas")!]);
    expect(r.launch.taskCount).toBe(11);
  });
});

// ── Resolución de asignaciones (capa/rol → roster real) ────────────────────

describe("launchModule — asignación por capa/rol (§13.5)", () => {
  it("agente preferido pausado → cae a la capa (agente asignable restante)", () => {
    const db = seededDb();
    const sam = getAgentBySlug(db, "sam")!;
    updateAgent(db, sam.id, { status: "paused" }, sam.version);

    const r = launchNova(db);
    const alex = getAgentBySlug(db, "alex")!;
    const result = r.launch.result as { tasks: { key: string; taskId: string; assigneeSlug: string }[] };
    const perfil = result.tasks.find((t) => t.key === "perfil_org")!;
    // El rol diagnostico (preferido sam, capa consultoria) cayó en alex.
    expect(perfil.assigneeSlug).toBe("alex");
    expect(getTask(db, perfil.taskId)!.assigneeAgentId).toBe(alex.id);
    expect(result.tasks.find((t) => t.key === "entrevista:direccion")!.assigneeSlug).toBe("alex");
  });

  it("fallback por capa: MENOS tareas abiertas, desempate determinista por slug", () => {
    const db = seededDb();
    // Preferida sally (pausada) → capa implementacion: debbie y vinnie, ambos
    // con 0 abiertas. t1 → debbie (desempate por slug); la carga en memoria
    // sube y t2 → vinnie (menos abiertas).
    const sally = getAgentBySlug(db, "sally")!;
    updateAgent(db, sally.id, { status: "paused" }, sally.version);
    activateSynthetic(db, {
      ...syntheticBlueprint({ slug: "balanceo", phase: "CONSTRUIR", project_type: "transform" }),
      project: { name_tpl: "Balanceo {{empresa}}", workspace_tpl: "workspaces/balanceo" },
      methodology: { slug: "transform", version: null },
      roster: [{ role: "builder", agent: "sally", layer: "implementacion" }],
      templates: [
        {
          key: "t1",
          title: "Uno {{empresa}}",
          dod: "Hecho.",
          stage: "CONSTRUIR",
          activity_type: "analysis",
          assign: { role: "builder" },
        },
        {
          key: "t2",
          title: "Dos {{empresa}}",
          dod: "Hecho.",
          stage: "CONSTRUIR",
          activity_type: "analysis",
          assign: { role: "builder" },
        },
      ],
    });
    const r = launchModule(db, {
      moduleSlug: "balanceo",
      org: { name: "Balanceo S.A." },
      inputs: { empresa: "Balanceo S.A." },
      actor: "person:ernesto",
      idempotencyKey: "launch:test:balanceo",
      now: NOW,
    });
    const result = r.launch.result as { tasks: { key: string; assigneeSlug: string }[] };
    expect(result.tasks.find((t) => t.key === "t1")!.assigneeSlug).toBe("debbie");
    expect(result.tasks.find((t) => t.key === "t2")!.assigneeSlug).toBe("vinnie");
  });

  it("capa entera inasignable (manager pausado rompe la cadena) → agent_not_assignable", () => {
    const db = seededDb();
    // Pausar a alex: él mismo queda fuera y TODO su subárbol (sam, clara, …)
    // pierde la cadena de mando sana → ningún rol de consultoria resuelve.
    const alex = getAgentBySlug(db, "alex")!;
    updateAgent(db, alex.id, { status: "paused" }, alex.version);
    const before = tableCounts(db);
    const err = catchError(() => launchNova(db));
    expectDomainError(err, "agent_not_assignable");
    expect(tableCounts(db)).toEqual(before); // el launch entero se rechazó
  });
});

// ── Fuentes: session_key → thread.projectId ────────────────────────────────

describe("launchModule — fuentes (source_refs → threads)", () => {
  it("asocia hilos existentes al proyecto y anota los enlazados en el recibo", () => {
    const db = seededDb();
    const thread = getOrCreateThread(db, {
      channel: "whatsapp",
      sessionKey: buildSessionKey("whatsapp", "nova-sponsor"),
      title: "Sponsor Nova",
    });
    const r = launchNova(db, {
      inputs: {
        ...DEMO_INPUTS,
        fuentes: [thread.sessionKey, "whatsapp:desconocido:main", { session_key: thread.sessionKey }],
      },
      idempotencyKey: "launch:test:fuentes",
    });
    expect(getThread(db, thread.id)!.projectId).toBe(r.project.id);
    const linked = (r.launch.result as { linked_threads: string[] }).linked_threads;
    expect(linked).toEqual([thread.id]); // la session_key desconocida se ignora
  });
});
