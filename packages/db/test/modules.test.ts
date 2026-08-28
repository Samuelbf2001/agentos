import { describe, expect, it } from "vitest";
import { isAgentosError } from "@agentos/shared";
import { openDb, type AgentosDb } from "../src/client.js";
import { runMigrations } from "../src/migrate.js";
import { seed } from "../src/seed.js";
import { loadModuleSeeds, parseModuleSeed, MODULES_DIR, type ParsedModuleSeed } from "../src/seed-sources.js";
import {
  activateModuleVersion,
  createModuleVersion,
  getActiveModule,
  getModuleVersion,
  listPhaseModules,
  upsertPhaseModuleFromSeed,
} from "../src/repositories/modules.js";
import path from "node:path";

function freshDb(): AgentosDb {
  const db = openDb(":memory:");
  runMigrations(db);
  return db;
}

describe("migración 0003_modulos_fase", () => {
  it("crea phase_modules y module_launches con sus índices únicos", () => {
    const db = freshDb();
    const tables = (
      db.$client
        .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(tables).toContain("phase_modules");
    expect(tables).toContain("module_launches");
    const indexes = (
      db.$client
        .prepare(`SELECT name, sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL`)
        .all() as { name: string; sql: string }[]
    );
    const names = indexes.map((i) => i.name);
    expect(names).toContain("uq_phase_modules_slug_version");
    expect(names).toContain("uq_phase_modules_slug_active");
    expect(names).toContain("uq_module_launches_idempotency");
    expect(names).toContain("uq_module_launches_project_phase");
    // El índice de "una sola activa por slug" es PARCIAL (WHERE status='active').
    const parcial = indexes.find((i) => i.name === "uq_phase_modules_slug_active")!;
    expect(parcial.sql).toContain("WHERE");
    expect(parcial.sql).toContain("active");
  });

  it("añade depends_on (JSON, default []) y due_at (nullable) a tasks", () => {
    const db = freshDb();
    const cols = db.$client.prepare(`PRAGMA table_info(tasks)`).all() as {
      name: string;
      notnull: number;
      dflt_value: string | null;
    }[];
    const dependsOn = cols.find((c) => c.name === "depends_on")!;
    expect(dependsOn.notnull).toBe(1);
    expect(dependsOn.dflt_value).toContain("[]");
    const dueAt = cols.find((c) => c.name === "due_at")!;
    expect(dueAt.notnull).toBe(0);
  });
});

describe("parseModuleSeed sobre modules/*.md reales", () => {
  it("los 3 módulos parsean, validan y traen blueprint canónico + hashes", () => {
    const seeds = loadModuleSeeds();
    expect(seeds.map((s) => s.slug).sort()).toEqual(["consultoria", "implementacion", "operacion"]);
    for (const s of seeds) {
      expect(s.version).toBe(1);
      expect(s.name).toBeTruthy();
      expect(s.bodyMd.length).toBeGreaterThan(100);
      expect(s.blueprintHash).toMatch(/^[0-9a-f]{64}$/);
      expect(s.seedHash).toMatch(/^[0-9a-f]{64}$/);
      expect(s.seedFile.startsWith("modules/")).toBe(true);
      // Canonicalizado: claves de primer nivel ordenadas alfabéticamente.
      const keys = Object.keys(s.blueprint);
      expect(keys).toEqual([...keys].sort());
    }
    const bySlug = new Map(seeds.map((s) => [s.slug, s]));
    expect(bySlug.get("consultoria")!.phase).toBe("ENTENDER");
    expect(bySlug.get("consultoria")!.projectType).toBe("assessment");
    expect(bySlug.get("consultoria")!.methodology).toEqual({ slug: "assessment-14d", version: null });
    expect(bySlug.get("implementacion")!.phase).toBe("CONSTRUIR");
    expect(bySlug.get("implementacion")!.projectType).toBe("transform");
    expect(bySlug.get("operacion")!.phase).toBe("OPERAR");
    expect(bySlug.get("operacion")!.projectType).toBe("ops");
    // US-M4: catálogo por pilar con activity_type propios + cadencia declarada.
    const ops = bySlug.get("operacion")!.blueprint;
    const activityTypes = ops.templates.map((t) => t.activity_type);
    for (const at of ["marketing_ops", "sales_ops", "service_ops", "reporting_ops"]) {
      expect(activityTypes, `falta pilar ${at}`).toContain(at);
    }
    expect(ops.templates.filter((t) => t.cadence === true).length).toBeGreaterThanOrEqual(3);
  });

  it("consultoria trae los 13 inputs, el toggle iso9001 y el gate g1_plan", () => {
    const consultoria = parseModuleSeed(path.join(MODULES_DIR, "consultoria.md"));
    expect(consultoria.blueprint.inputs).toHaveLength(13);
    expect(consultoria.blueprint.toggles?.map((t) => t.key)).toEqual(["iso9001"]);
    expect(consultoria.blueprint.gates?.[0]?.name).toBe("g1_plan");
    expect(consultoria.blueprint.gates?.[0]?.blocks_next_stage).toBe("CONSTRUIR");
    expect(consultoria.blueprint.templates).toHaveLength(9);
  });
});

describe("seed 5b: módulos de fase activos", () => {
  it("el seed deja los 3 módulos ACTIVOS y visibles (CA-M1.1)", () => {
    const db = freshDb();
    const counts = seed(db, { env: {} });
    expect(counts.phaseModules).toBe(3);
    for (const slug of ["consultoria", "implementacion", "operacion"]) {
      const active = getActiveModule(db, slug);
      expect(active, `módulo ${slug} activo`).toBeDefined();
      expect(active!.status).toBe("active");
      expect(active!.version).toBe(1);
      expect(active!.activatedAt).toBeTruthy();
      expect(active!.blueprintHash).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(listPhaseModules(db)).toHaveLength(3);
  });

  it("re-seed sin cambios = no-op (idempotencia por seed_hash)", () => {
    const db = freshDb();
    seed(db, { env: {} });
    const before = getActiveModule(db, "consultoria")!;
    const counts = seed(db, { env: {} });
    expect(counts.phaseModules).toBe(3);
    const after = getActiveModule(db, "consultoria")!;
    expect(after.id).toBe(before.id);
    expect(after.updatedAt).toBe(before.updatedAt);
  });
});

describe("upsertPhaseModuleFromSeed — versiones inmutables ([SÍNTESIS] Codex)", () => {
  function consultoriaSeed(): ParsedModuleSeed {
    return parseModuleSeed(path.join(MODULES_DIR, "consultoria.md"));
  }

  it("mismo (slug,version) con contenido DISTINTO → error module_version_immutable", () => {
    const db = freshDb();
    seed(db, { env: {} });
    const cambiado: ParsedModuleSeed = { ...consultoriaSeed(), seedHash: "0".repeat(64) };
    try {
      upsertPhaseModuleFromSeed(db, cambiado);
      expect.unreachable("debió lanzar module_version_immutable");
    } catch (err) {
      expect(isAgentosError(err, "module_version_immutable"), String(err)).toBe(true);
    }
    // Nada cambió: la v1 sigue activa con su hash original.
    expect(getActiveModule(db, "consultoria")!.version).toBe(1);
  });

  it("version+1 → fila nueva ACTIVA y la anterior ARCHIVADA (CA-M1.2)", () => {
    const db = freshDb();
    seed(db, { env: {} });
    const base = consultoriaSeed();
    const v2: ParsedModuleSeed = {
      ...base,
      version: 2,
      seedHash: "1".repeat(64),
      blueprint: { ...base.blueprint, version: 2 },
    };
    const { module, created } = upsertPhaseModuleFromSeed(db, v2);
    expect(created).toBe(true);
    expect(module.version).toBe(2);
    expect(module.status).toBe("active");
    expect(getActiveModule(db, "consultoria")!.version).toBe(2);
    expect(getModuleVersion(db, "consultoria", 1)!.status).toBe("archived");
    expect(listPhaseModules(db, { slug: "consultoria" })).toHaveLength(2);
  });
});

describe("activateModuleVersion — fail-closed (momento B, §13.5)", () => {
  it("un draft con blueprint inválido se guarda pero NO puede activarse (CA-M1.3)", () => {
    const db = freshDb();
    seed(db, { env: {} });
    const base = parseModuleSeed(path.join(MODULES_DIR, "consultoria.md")).blueprint;
    // Rompemos una regla estructural: entregable sin productor.
    const roto = JSON.parse(JSON.stringify(base));
    roto.version = 2;
    for (const t of roto.templates) t.produces = [];
    const draft = createModuleVersion(db, {
      slug: "consultoria",
      version: 2,
      name: "Consultoría rota",
      phase: "ENTENDER",
      projectType: "assessment",
      methodologySlug: "assessment-14d",
      methodologyVersion: null,
      blueprint: roto,
      bodyMd: "borrador",
      createdBy: "person:test",
    });
    expect(draft.status).toBe("draft"); // el draft con issues SÍ se guarda (momento A)
    try {
      activateModuleVersion(db, "consultoria", 2);
      expect.unreachable("debió rechazar la activación");
    } catch (err) {
      expect(isAgentosError(err, "validation_error"), String(err)).toBe(true);
    }
    // La activa sigue siendo la v1: fail-closed de verdad.
    expect(getActiveModule(db, "consultoria")!.version).toBe(1);
    expect(getModuleVersion(db, "consultoria", 2)!.status).toBe("draft");
  });
});
