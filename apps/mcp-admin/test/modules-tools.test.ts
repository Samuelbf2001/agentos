/**
 * Tests de `agentos.modules.*` (M4a — ARCHITECTURE §13.7) sobre DB temporal
 * seedeada: el módulo `consultoria` REAL de modules/consultoria.md.
 *
 * Cubre: list/get/diff/validate, preview (dry-run CA-M2.1), update crea DRAFT
 * sin tocar la activa (CA-M1.2), publish momento B completo (reglas puras +
 * reglas con DB, lista completa de issues — CA-M1.3), rollback, launch humano
 * (recibo CA-M2.4, inputs sensibles redactados, idempotencia CA-M2.6),
 * phase_status (CA-M3.1), export roundtrip y perfil ro.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { ModuleBlueprint } from "@agentos/shared";
import { getActiveModule, getModuleVersion, listTasks, parseModuleSeed } from "@agentos/db";
import { adminFixture, type AdminFixture } from "./helpers.js";

let f: AdminFixture;
beforeEach(async () => {
  f = await adminFixture();
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

async function getBlueprint(version?: number): Promise<ModuleBlueprint> {
  const res = (await f.callRo("agentos.modules.get", {
    slug: "consultoria",
    ...(version !== undefined ? { version } : {}),
  })) as { blueprint: ModuleBlueprint };
  return structuredClone(res.blueprint);
}

// ── list / get / diff ───────────────────────────────────────────────────────

describe("modules.list y modules.get", () => {
  it("lista consultoria activa con nº de plantillas y hash", async () => {
    const res = (await f.callRo("agentos.modules.list", {})) as {
      modules: Array<Record<string, unknown>>;
    };
    const consultoria = res.modules.find(
      (m) => m["slug"] === "consultoria" && m["status"] === "active",
    );
    expect(consultoria).toBeDefined();
    expect(consultoria!["version"]).toBe(1);
    expect(consultoria!["phase"]).toBe("ENTENDER");
    expect(consultoria!["project_type"]).toBe("assessment");
    expect(consultoria!["templates_count"]).toBeGreaterThan(0);
    expect(consultoria!["blueprint_hash"]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("get devuelve blueprint + body_md + hash de la versión activa", async () => {
    const res = (await f.callRo("agentos.modules.get", { slug: "consultoria" })) as {
      module: Record<string, unknown>;
      blueprint: ModuleBlueprint;
      body_md: string;
      blueprint_hash: string;
      issues?: unknown[];
    };
    expect(res.blueprint.slug).toBe("consultoria");
    expect(res.blueprint.templates.length).toBe(res.module["templates_count"]);
    expect(res.body_md.length).toBeGreaterThan(0);
    expect(res.blueprint_hash).toMatch(/^[0-9a-f]{64}$/);
    // La activa no viaja con issues (solo los drafts los llevan).
    expect(res.issues).toBeUndefined();
  });

  it("diff entre dos versiones del mismo slug", async () => {
    await f.call("agentos.modules.update", {
      slug: "consultoria",
      expected_version: 1,
      body_md: "Cuerpo revisado para el diff",
      changelog: "test diff",
    });
    const res = (await f.callRo("agentos.modules.diff", {
      slug: "consultoria",
      from_version: 1,
      to_version: 2,
    })) as { identical: boolean; unified: string };
    expect(res.identical).toBe(false);
    expect(res.unified).toContain("+Cuerpo revisado para el diff");
  });
});

// ── validate (momento A/B en lectura, sin escribir) ─────────────────────────

describe("modules.validate", () => {
  it("acepta el blueprint real de consultoria (reglas puras + con DB)", async () => {
    const bp = await getBlueprint();
    const res = (await f.callRo("agentos.modules.validate", { blueprint: bp })) as {
      ok: boolean;
      issues: Array<{ code: string }>;
    };
    expect(res.ok).toBe(true);
    expect(res.issues).toEqual([]);
  });

  it("reporta unknown_role, unknown_agent_slug y unknown_methodology sin escribir", async () => {
    const bp = await getBlueprint();
    bp.templates[0]!.assign.role = "fantasma";
    bp.roster[0]!.agent = "nadie";
    bp.methodology.slug = "no-existe";
    const res = (await f.callRo("agentos.modules.validate", { blueprint: bp })) as {
      ok: boolean;
      issues: Array<{ code: string }>;
    };
    expect(res.ok).toBe(false);
    const codes = res.issues.map((i) => i.code);
    expect(codes).toContain("unknown_role");
    expect(codes).toContain("unknown_agent_slug");
    expect(codes).toContain("unknown_methodology");
    // Nada se escribió: sigue habiendo una sola versión, la activa v1.
    expect((await getActiveModule(f.db, "consultoria"))!.version).toBe(1);
  });
});

// ── preview (dry-run CA-M2.1) ───────────────────────────────────────────────

describe("modules.preview", () => {
  it("con inputs completos devuelve el plan con títulos renderizados, asignaciones y deps", async () => {
    const res = (await f.callRo("agentos.modules.preview", {
      slug: "consultoria",
      inputs: GLOBEX_INPUTS,
      toggles: { iso9001: true },
    })) as {
      ok: boolean;
      plan: {
        projectName: string;
        tasks: Array<{
          key: string;
          templateKey: string;
          title: string;
          assigneeAgentSlug: string;
          dependsOn: string[];
          status: string;
          dueAt: number | null;
        }>;
        deliverables: unknown[];
        gates: Array<{ name: string }>;
      };
    };
    expect(res.ok).toBe(true);
    expect(res.plan.projectName).toBe("Assessment Globex");
    // 2 áreas ⇒ 2 entrevistas + 2 mapas; iso9001 enciende matriz_iso.
    const kickoff = res.plan.tasks.find((t) => t.key === "kickoff")!;
    expect(kickoff.title).toBe("Kickoff con sponsor de Globex");
    expect(kickoff.status).toBe("READY");
    const entrevista = res.plan.tasks.find((t) => t.key === "entrevista:direccion")!;
    expect(entrevista.dependsOn).toEqual(["kickoff"]);
    expect(entrevista.status).toBe("BACKLOG");
    expect(res.plan.tasks.some((t) => t.templateKey === "matriz_iso")).toBe(true);
    // Asignación por rol RESUELTA contra el roster real, para todas las tareas.
    for (const t of res.plan.tasks) expect(t.assigneeAgentSlug).not.toBe("");
    expect(res.plan.tasks.some((t) => t.dueAt !== null)).toBe(true);
    expect(res.plan.gates.map((g) => g.name)).toContain("g1_plan");
    expect(res.plan.deliverables.length).toBeGreaterThan(0);
    // Y NADA se escribió (dry-run): cero tareas nuevas fuera del seed.
    expect((await listTasks(f.db)).every((t) => !t.title.includes("Globex"))).toBe(true);
  });

  it("con el toggle apagado poda matriz_iso (y la dep hacia ella)", async () => {
    const res = (await f.callRo("agentos.modules.preview", {
      slug: "consultoria",
      inputs: GLOBEX_INPUTS,
    })) as { ok: boolean; plan: { tasks: Array<{ templateKey: string }> } };
    expect(res.ok).toBe(true);
    expect(res.plan.tasks.some((t) => t.templateKey === "matriz_iso")).toBe(false);
  });

  it("con inputs incompletos devuelve ok:false + missing (el wizard deshabilita Disparar)", async () => {
    const res = (await f.callRo("agentos.modules.preview", {
      slug: "consultoria",
      inputs: { empresa: "Globex" },
    })) as { ok: boolean; missing: string[]; plan: unknown };
    expect(res.ok).toBe(false);
    expect(res.plan).toBeNull();
    for (const key of ["industria", "empleados", "sponsor", "objetivo", "areas", "fecha_objetivo"]) {
      expect(res.missing).toContain(key);
    }
  });
});

// ── create (momento A) ──────────────────────────────────────────────────────

describe("modules.create", () => {
  it("crea un módulo nuevo como draft (con issues se guarda igual) y rechaza slugs repetidos", async () => {
    const bp = await getBlueprint();
    bp.slug = "consultoria-lite";
    bp.version = 1;
    bp.project.name_tpl = "Lite {{cliente}}";
    bp.roster[0]!.agent = "nadie"; // issue con DB: el draft se guarda igual (momento A)
    const res = (await f.call("agentos.modules.create", {
      blueprint: bp,
      body_md: "Cuerpo lite",
    })) as { module: { slug: string; version: number; status: string }; issues: Array<{ code: string }> };
    expect(res.module).toMatchObject({ slug: "consultoria-lite", version: 1, status: "draft" });
    expect(res.issues.map((i) => i.code)).toContain("unknown_agent_slug");
    // El draft con issues queda INACTIVABLE hasta corregirse (fail-closed).
    await expect(
      f.call("agentos.modules.publish", { slug: "consultoria-lite", version: 1, expected_version: 0 }),
    ).rejects.toMatchObject({ code: "validation_error" });
    // Slug existente → conflict (la evolución va por update).
    await expect(
      f.call("agentos.modules.create", { blueprint: bp, body_md: "otro" }),
    ).rejects.toMatchObject({ code: "conflict" });
  });
});

// ── update / publish / rollback (CA-M1.2 / CA-M1.3) ─────────────────────────

describe("modules.update / publish / rollback", () => {
  it("update crea una versión DRAFT nueva y NO toca la activa", async () => {
    const res = (await f.call("agentos.modules.update", {
      slug: "consultoria",
      expected_version: 1,
      body_md: "Cuerpo nuevo",
      changelog: "solo body",
    })) as { module: { version: number; status: string }; issues: unknown[] };
    expect(res.module.version).toBe(2);
    expect(res.module.status).toBe("draft");
    expect(res.issues).toEqual([]);
    // La activa sigue siendo la v1 con su body original.
    const active = (await getActiveModule(f.db, "consultoria"))!;
    expect(active.version).toBe(1);
    expect(active.bodyMd).not.toBe("Cuerpo nuevo");
    expect((await getModuleVersion(f.db, "consultoria", 2))!.bodyMd).toBe("Cuerpo nuevo");
  });

  it("update con expected_version desfasada → version_conflict", async () => {
    await expect(
      f.call("agentos.modules.update", {
        slug: "consultoria",
        expected_version: 7,
        body_md: "x",
        changelog: "carrera",
      }),
    ).rejects.toMatchObject({ code: "version_conflict" });
  });

  it("update exige blueprint.version = siguiente (sin auto-bump)", async () => {
    const bp = await getBlueprint(); // version 1
    await expect(
      f.call("agentos.modules.update", {
        slug: "consultoria",
        expected_version: 1,
        blueprint: bp,
        changelog: "versión sin subir",
      }),
    ).rejects.toMatchObject({ code: "validation_error" });
  });

  it("publish rechaza un draft con rol/agente inexistentes con la LISTA COMPLETA; uno válido publica y archiva la anterior", async () => {
    // Draft v2 roto: rol no declarado en roster + agente fuera del roster real.
    const broken = await getBlueprint();
    broken.version = 2;
    broken.templates[0]!.assign.role = "fantasma";
    broken.roster[1]!.agent = "nadie";
    const upd = (await f.call("agentos.modules.update", {
      slug: "consultoria",
      expected_version: 1,
      blueprint: broken,
      changelog: "draft roto (momento A lo acepta)",
    })) as { module: { status: string }; issues: Array<{ code: string }> };
    expect(upd.module.status).toBe("draft"); // momento A: draft con issues se guarda
    expect(upd.issues.length).toBeGreaterThan(0);

    const err = (await f
      .call("agentos.modules.publish", { slug: "consultoria", version: 2, expected_version: 1 })
      .catch((e: unknown) => e)) as { code: string; details: Array<{ code: string }> };
    expect(err.code).toBe("validation_error");
    const codes = err.details.map((i) => i.code);
    expect(codes).toContain("unknown_role"); // regla pura
    expect(codes).toContain("unknown_agent_slug"); // regla con DB — momento B completo
    expect((await getActiveModule(f.db, "consultoria"))!.version).toBe(1); // fail-closed

    // Draft v3 válido → publica y archiva la v1.
    const good = await getBlueprint(1);
    good.version = 3;
    await f.call("agentos.modules.update", {
      slug: "consultoria",
      expected_version: 2,
      blueprint: good,
      changelog: "v3 válida",
    });
    const pub = (await f.call("agentos.modules.publish", {
      slug: "consultoria",
      version: 3,
      expected_version: 1,
    })) as { module: { version: number; status: string }; archived_version: number | null };
    expect(pub.module.status).toBe("active");
    expect(pub.archived_version).toBe(1);
    expect((await getActiveModule(f.db, "consultoria"))!.version).toBe(3);
    expect((await getModuleVersion(f.db, "consultoria", 1))!.status).toBe("archived");

    // Rollback re-activa la v1 (re-validada momento B) y archiva la v3.
    const rb = (await f.call("agentos.modules.rollback", {
      slug: "consultoria",
      target_version: 1,
      reason: "la v3 no aporta",
    })) as { module: { version: number }; archived_version: number | null };
    expect(rb.module.version).toBe(1);
    expect(rb.archived_version).toBe(3);
    expect((await getActiveModule(f.db, "consultoria"))!.version).toBe(1);
  });

  it("publish con expected_version (activa) desfasada → version_conflict", async () => {
    await f.call("agentos.modules.update", {
      slug: "consultoria",
      expected_version: 1,
      body_md: "v2",
      changelog: "draft",
    });
    await expect(
      f.call("agentos.modules.publish", { slug: "consultoria", version: 2, expected_version: 0 }),
    ).rejects.toMatchObject({ code: "version_conflict" });
  });
});

// ── launch (humano) + recibos + phase_status ────────────────────────────────

describe("modules.launch", () => {
  it("crea org+proyecto+backlog+recibo con actor person:<id> e inputs sensibles redactados", async () => {
    const res = (await f.call("agentos.modules.launch", {
      module_slug: "consultoria",
      person_id: f.person.id,
      org: { name: "Globex S.A.", industria: "Manufactura" },
      inputs: GLOBEX_INPUTS,
      toggles: { iso9001: true },
      idempotency_key: "test:globex:1",
    })) as {
      launch: {
        id: string;
        actor: string;
        inputs: Record<string, unknown>;
        taskCount: number;
        moduleSlug: string;
        moduleVersion: number;
      };
      project: { id: string; name: string };
      tasks_count: number;
      idempotent: boolean;
    };
    expect(res.idempotent).toBe(false);
    expect(res.project.name).toBe("Assessment Globex");
    expect(res.launch.actor).toBe(`person:${f.person.id}`);
    expect(res.launch.moduleSlug).toBe("consultoria");
    expect(res.launch.moduleVersion).toBe(1);
    // Recibo CA-M2.4: inputs literales pero con lo sensible REDACTADO.
    expect(res.launch.inputs["notas_comercial"]).toBe("[redacted]");
    expect(res.launch.inputs["empresa"]).toBe("Globex");
    // Backlog materializado de verdad.
    expect(res.tasks_count).toBeGreaterThan(0);
    expect((await listTasks(f.db, { projectId: res.project.id })).length).toBe(res.tasks_count);

    // Idempotencia (CA-M2.6): misma key + mismos inputs = lo ya creado.
    const again = (await f.call("agentos.modules.launch", {
      module_slug: "consultoria",
      person_id: f.person.id,
      org: { name: "Globex S.A." },
      inputs: GLOBEX_INPUTS,
      toggles: { iso9001: true },
      idempotency_key: "test:globex:1",
    })) as { launch: { id: string }; idempotent: boolean };
    expect(again.idempotent).toBe(true);
    expect(again.launch.id).toBe(res.launch.id);
    expect((await listTasks(f.db, { projectId: res.project.id })).length).toBe(res.tasks_count);

    // Misma key con inputs DISTINTOS → idempotency_conflict.
    await expect(
      f.call("agentos.modules.launch", {
        module_slug: "consultoria",
        person_id: f.person.id,
        org: { name: "Globex S.A." },
        inputs: { ...GLOBEX_INPUTS, empresa: "Otra" },
        idempotency_key: "test:globex:1",
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });

    // Recibos: launches_list por proyecto y launches_get con nombre resuelto.
    const list = (await f.callRo("agentos.modules.launches_list", {
      project_id: res.project.id,
    })) as { launches: Array<{ launch: { id: string }; actor_name: string; label: string }> };
    expect(list.launches).toHaveLength(1);
    expect(list.launches[0]!.actor_name).toBe("Ernesto");
    expect(list.launches[0]!.label).toMatch(/^Disparado desde .+ v1 por Ernesto$/);

    const receipt = (await f.callRo("agentos.modules.launches_get", {
      launch_id: res.launch.id,
    })) as { launch: { id: string; blueprintHash: string }; actor_name: string };
    expect(receipt.launch.id).toBe(res.launch.id);
    expect(receipt.launch.blueprintHash).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.actor_name).toBe("Ernesto");

    // phase_status (CA-M3.1): recién disparado, todo por entregar.
    const status = (await f.callRo("agentos.modules.phase_status", {
      project_id: res.project.id,
    })) as { launchId: string | null; complete: boolean; items: Array<{ missing: string | null }> };
    expect(status.launchId).toBe(res.launch.id);
    expect(status.complete).toBe(false);
    expect(status.items.length).toBeGreaterThan(0);
    expect(status.items.some((i) => i.missing !== null)).toBe(true);
  });

  it("person_id es obligatorio (disparar es siempre humano) y debe existir", async () => {
    await expect(
      f.call("agentos.modules.launch", {
        module_slug: "consultoria",
        org: { name: "Globex S.A." },
        inputs: GLOBEX_INPUTS,
        idempotency_key: "test:sin-persona",
      }),
    ).rejects.toMatchObject({ code: "validation_error" });
    await expect(
      f.call("agentos.modules.launch", {
        module_slug: "consultoria",
        person_id: "no-existe",
        org: { name: "Globex S.A." },
        inputs: GLOBEX_INPUTS,
        idempotency_key: "test:persona-fantasma",
      }),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});

// ── Perfil ro ───────────────────────────────────────────────────────────────

describe("perfil ro sobre agentos.modules.*", () => {
  it("bloquea TODAS las mutaciones con read_only_profile antes de validar argumentos", async () => {
    for (const tool of [
      "agentos.modules.create",
      "agentos.modules.update",
      "agentos.modules.publish",
      "agentos.modules.rollback",
      "agentos.modules.archive",
      "agentos.modules.export",
      "agentos.modules.launch",
    ]) {
      await expect(f.callRo(tool, {})).rejects.toMatchObject({ code: "read_only_profile" });
    }
    // Y nada mutó: consultoria sigue con una sola versión activa.
    expect((await getActiveModule(f.db, "consultoria"))!.version).toBe(1);
  });

  it("permite las lecturas (list/get/preview/phase_status)", async () => {
    const list = (await f.callRo("agentos.modules.list", {})) as { modules: unknown[] };
    expect(list.modules.length).toBeGreaterThan(0);
    const prev = (await f.callRo("agentos.modules.preview", {
      slug: "consultoria",
      inputs: GLOBEX_INPUTS,
    })) as { ok: boolean };
    expect(prev.ok).toBe(true);
  });
});

// ── export ──────────────────────────────────────────────────────────────────

describe("modules.export", () => {
  it("escribe <slug>.md con frontmatter+body y el roundtrip conserva el hash", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-modules-export-"));
    const res = (await f.call("agentos.modules.export", {
      slug: "consultoria",
      dir,
    })) as { file: string; version: number };
    expect(res.version).toBe(1);
    expect(fs.existsSync(res.file)).toBe(true);
    // Roundtrip por el MISMO parser del seed: mismo blueprint ⇒ mismo hash.
    const parsed = parseModuleSeed(res.file);
    expect(parsed.slug).toBe("consultoria");
    expect(parsed.version).toBe(1);
    expect(parsed.blueprintHash).toBe((await getActiveModule(f.db, "consultoria"))!.blueprintHash);
    expect(parsed.bodyMd).toBe((await getActiveModule(f.db, "consultoria"))!.bodyMd.trim());
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
