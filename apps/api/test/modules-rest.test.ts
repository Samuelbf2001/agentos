/**
 * Tests del REST de Módulos de Fase (M4a — wizard "Nuevo proyecto"):
 * GET /api/modules[/:slug], POST preview (CA-M2.1), POST launch (CA-M2.2,
 * actor = persona de la sesión; idempotencia CA-M2.6; eventos al bus/WS),
 * GET /api/projects/:id/launches (CA-M2.4) y /phase-status (CA-M3.1).
 * Login/guard: sin sesión, 401 en TODO el prefijo /api.
 */
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MODULES_DIR,
  createAgent,
  listTasks,
  loadMethodologySeeds,
  parseModuleSeed,
  upsertMethodology,
  upsertPhaseModuleFromSeed,
} from "@agentos/db";
import { makeFixture, type TestFixture } from "./helpers.js";

let fx: TestFixture;

beforeEach(async () => {
  fx = await makeFixture();
  // Metodologías reales (el momento B de la activación del módulo las exige).
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
  // Roster de consultoria: alex y sam ya existen en el fixture; faltan clara
  // (capa operacion) y quinn (capa meta) para que el roster resuelva completo.
  await createAgent(fx.db, {
    slug: "clara",
    name: "Clara",
    layer: "operacion",
    runtime: "ai_sdk",
    providerProfileId: fx.provider.id,
    model: "mock-model",
    toolsAllowlist: [],
  });
  await createAgent(fx.db, {
    slug: "quinn",
    name: "Quinn",
    layer: "meta",
    runtime: "ai_sdk",
    providerProfileId: fx.provider.id,
    model: "mock-model",
    toolsAllowlist: [],
  });
  // El módulo consultoria REAL, por el mismo camino del seed (queda activo).
  await upsertPhaseModuleFromSeed(fx.db, parseModuleSeed(path.join(MODULES_DIR, "consultoria.md")));
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
  notas_comercial: "presupuesto interno confidencial",
};

describe("GET /api/modules", () => {
  it("sin sesión → 401 (mismo guard que el resto de /api)", async () => {
    const res = await fx.api.app.inject({ method: "GET", url: "/api/modules" });
    expect(res.statusCode).toBe(401);
    expect((res.json() as { error: { code: string } }).error.code).toBe("unauthorized");
  });

  it("lista los módulos ACTIVOS con lo que el wizard necesita", async () => {
    const res = await fx.api.app.inject({
      method: "GET",
      url: "/api/modules",
      headers: fx.authHeaders,
    });
    expect(res.statusCode).toBe(200);
    const { modules } = res.json() as { modules: Array<Record<string, unknown>> };
    const consultoria = modules.find((m) => m["slug"] === "consultoria")!;
    expect(consultoria).toMatchObject({
      version: 1,
      status: "active",
      phase: "ENTENDER",
      project_type: "assessment",
    });
    expect(consultoria["templates_count"]).toBeGreaterThan(0);
  });

  it("GET /api/modules/:slug devuelve inputs y toggles para el formulario", async () => {
    const res = await fx.api.app.inject({
      method: "GET",
      url: "/api/modules/consultoria",
      headers: fx.authHeaders,
    });
    expect(res.statusCode).toBe(200);
    const { module } = res.json() as {
      module: { inputs: Array<{ key: string; required?: boolean }>; toggles: Array<{ key: string }> };
    };
    const keys = module.inputs.map((i) => i.key);
    expect(keys).toContain("empresa");
    expect(keys).toContain("areas");
    expect(module.toggles.map((t) => t.key)).toContain("iso9001");
    // Módulo inexistente → 404 con código estable.
    const missing = await fx.api.app.inject({
      method: "GET",
      url: "/api/modules/no-existe",
      headers: fx.authHeaders,
    });
    expect(missing.statusCode).toBe(404);
  });
});

describe("POST /api/modules/:slug/preview (CA-M2.1)", () => {
  it("con inputs incompletos responde ok:false + missing (Disparar deshabilitado)", async () => {
    const res = await fx.api.app.inject({
      method: "POST",
      url: "/api/modules/consultoria/preview",
      headers: fx.authHeaders,
      payload: { inputs: { empresa: "Globex" } },
    });
    expect(res.statusCode).toBe(200); // no es un error HTTP: es el estado del wizard
    const body = res.json() as { ok: boolean; missing: string[]; plan: unknown };
    expect(body.ok).toBe(false);
    expect(body.plan).toBeNull();
    for (const key of ["industria", "empleados", "sponsor", "objetivo", "areas", "fecha_objetivo"]) {
      expect(body.missing).toContain(key);
    }
  });

  it("con inputs completos devuelve el plan con asignaciones resueltas", async () => {
    const res = await fx.api.app.inject({
      method: "POST",
      url: "/api/modules/consultoria/preview",
      headers: fx.authHeaders,
      payload: { inputs: GLOBEX_INPUTS, toggles: { iso9001: true } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      ok: boolean;
      plan: { projectName: string; tasks: Array<{ title: string; assigneeAgentSlug: string }> };
    };
    expect(body.ok).toBe(true);
    expect(body.plan.projectName).toBe("Assessment Globex");
    expect(body.plan.tasks.length).toBeGreaterThan(0);
    for (const t of body.plan.tasks) expect(t.assigneeAgentSlug).not.toBe("");
  });
});

describe("POST /api/modules/:slug/launch (CA-M2.2 / CA-M2.6)", () => {
  it("sin sesión → 401 y no crea nada", async () => {
    const res = await fx.api.app.inject({
      method: "POST",
      url: "/api/modules/consultoria/launch",
      payload: { inputs: GLOBEX_INPUTS, idempotency_key: "wizard:anon" },
    });
    expect(res.statusCode).toBe(401);
    expect((await listTasks(fx.db)).some((t) => t.title.includes("Globex"))).toBe(false);
  });

  it("feliz: crea proyecto+tareas+recibo con actor de la sesión; repetir la key es idempotente", async () => {
    // El nº esperado de tareas sale del PREVIEW (mismo dry-run del wizard).
    const prevRes = await fx.api.app.inject({
      method: "POST",
      url: "/api/modules/consultoria/preview",
      headers: fx.authHeaders,
      payload: { inputs: GLOBEX_INPUTS, toggles: { iso9001: true } },
    });
    const planned = (prevRes.json() as { plan: { tasks: unknown[] } }).plan.tasks.length;

    const res = await fx.api.app.inject({
      method: "POST",
      url: "/api/modules/consultoria/launch",
      headers: fx.authHeaders,
      payload: { inputs: GLOBEX_INPUTS, toggles: { iso9001: true }, idempotency_key: "wizard:globex:1" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      launch: { id: string; actor: string; inputs: Record<string, unknown> };
      project: { id: string; name: string };
      tasks_count: number;
      idempotent: boolean;
    };
    expect(body.idempotent).toBe(false);
    expect(body.project.name).toBe("Assessment Globex"); // org derivada del input `empresa`
    expect(body.tasks_count).toBe(planned);
    expect(body.launch.actor).toBe(`person:${fx.person.id}`);
    expect(body.launch.inputs["notas_comercial"]).toBe("[redacted]"); // CA-M2.4
    expect((await listTasks(fx.db, { projectId: body.project.id })).length).toBe(planned);

    // Lo que emitió launchModuleWithEvents está en el bus (lo que sirve el WS).
    const events = await fx.api.ctx.bus.getSince(`board:${body.project.id}`, 0);
    expect(events.some((e) => e.type === "module.launched")).toBe(true);
    expect(events.filter((e) => e.type === "task.created").length).toBe(planned);

    // Segundo launch con la MISMA key → idempotente (200, mismo recibo, cero duplicados).
    const again = await fx.api.app.inject({
      method: "POST",
      url: "/api/modules/consultoria/launch",
      headers: fx.authHeaders,
      payload: { inputs: GLOBEX_INPUTS, toggles: { iso9001: true }, idempotency_key: "wizard:globex:1" },
    });
    expect(again.statusCode).toBe(200);
    const againBody = again.json() as { launch: { id: string }; idempotent: boolean };
    expect(againBody.idempotent).toBe(true);
    expect(againBody.launch.id).toBe(body.launch.id);
    expect((await listTasks(fx.db, { projectId: body.project.id })).length).toBe(planned);

    // Key distinta sobre el MISMO proyecto/fase → error de dominio 409 con código.
    const conflict = await fx.api.app.inject({
      method: "POST",
      url: "/api/modules/consultoria/launch",
      headers: fx.authHeaders,
      payload: { inputs: GLOBEX_INPUTS, toggles: { iso9001: true }, idempotency_key: "wizard:globex:2" },
    });
    expect(conflict.statusCode).toBe(409);
    expect((conflict.json() as { error: { code: string } }).error.code).toBe("conflict");
  });

  it("recibos y cierre de fase del proyecto (CA-M2.4 / CA-M3.1)", async () => {
    const launchRes = await fx.api.app.inject({
      method: "POST",
      url: "/api/modules/consultoria/launch",
      headers: fx.authHeaders,
      payload: { inputs: GLOBEX_INPUTS, idempotency_key: "wizard:globex:recibo" },
    });
    expect(launchRes.statusCode).toBe(201);
    const { launch, project } = launchRes.json() as {
      launch: { id: string };
      project: { id: string };
    };

    const list = await fx.api.app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/launches`,
      headers: fx.authHeaders,
    });
    expect(list.statusCode).toBe(200);
    const { launches } = list.json() as {
      launches: Array<{ id: string; actor_name: string; label: string; module_version: number }>;
    };
    expect(launches).toHaveLength(1);
    expect(launches[0]!.id).toBe(launch.id);
    // "Disparado desde Consultoría v1 por Ernesto" (CA-M2.4).
    expect(launches[0]!.actor_name).toBe("Ernesto");
    expect(launches[0]!.module_version).toBe(1);
    expect(launches[0]!.label).toMatch(/ v1 por Ernesto$/);

    const status = await fx.api.app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/phase-status`,
      headers: fx.authHeaders,
    });
    expect(status.statusCode).toBe(200);
    const body = status.json() as {
      status: { launchId: string | null; complete: boolean; items: Array<{ missing: string | null }> };
    };
    expect(body.status.launchId).toBe(launch.id);
    expect(body.status.complete).toBe(false); // recién disparado: todo por entregar
    expect(body.status.items.length).toBeGreaterThan(0);

    // Proyecto inexistente → 404 estable en ambas rutas.
    const missing = await fx.api.app.inject({
      method: "GET",
      url: "/api/projects/no-existe/launches",
      headers: fx.authHeaders,
    });
    expect(missing.statusCode).toBe(404);
  });
});
