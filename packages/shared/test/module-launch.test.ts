import { describe, expect, it } from "vitest";
import {
  DAY_MS,
  planLaunch,
  sanitizeWorkspacePath,
  slugifyFanOutValue,
  validateBlueprint,
  validateLaunchInputs,
  type ModuleBlueprint,
} from "../src/index.js";
import { makeBlueprint, mutateBlueprint } from "./fixtures.js";

/** `now` fijo para due_at determinista (planLaunch recibe el reloj como parámetro). */
const NOW = Date.parse("2026-08-28T12:00:00.000Z");

function bp(raw: Record<string, unknown> = makeBlueprint()): ModuleBlueprint {
  const res = validateBlueprint(raw);
  if (!res.ok || !res.blueprint) throw new Error(`fixture inválido: ${JSON.stringify(res.issues)}`);
  return res.blueprint;
}

const GOOD_INPUTS = {
  empresa: "ACME S.A.",
  alias: "ACME",
  areas: ["direccion", "ventas", "operaciones"],
  fecha_objetivo: "2026-09-15",
};

describe("validateLaunchInputs", () => {
  it("acepta inputs completos y devuelve valores resueltos + toggles efectivos", () => {
    const res = validateLaunchInputs(bp(), GOOD_INPUTS, { iso9001: true });
    expect(res.ok).toBe(true);
    expect(res.missing).toEqual([]);
    expect(res.values["empresa"]).toBe("ACME S.A.");
    expect(res.toggles).toEqual({ iso9001: true });
  });

  it("input_required_missing: lista faltantes para el wizard (CA-M2.1)", () => {
    const res = validateLaunchInputs(bp(), { empresa: "ACME S.A." });
    expect(res.ok).toBe(false);
    expect(res.missing.sort()).toEqual(["areas", "fecha_objetivo"]);
    expect(res.issues.every((i) => i.code === "input_required_missing")).toBe(true);
  });

  it("default_from: alias ← empresa cuando falta el alias", () => {
    const { alias: _omitido, ...sinAlias } = GOOD_INPUTS;
    const res = validateLaunchInputs(bp(), sinAlias);
    expect(res.ok).toBe(true);
    expect(res.values["alias"]).toBe("ACME S.A.");
  });

  it("default_from de listas: procesos_core ← areas (patrón del demo §13.6)", () => {
    const raw = mutateBlueprint((b) => {
      b.inputs.push({ key: "procesos_core", label: "Procesos", type: "list_text", min_items: 1, default_from: "areas" });
    });
    const res = validateLaunchInputs(bp(raw), GOOD_INPUTS);
    expect(res.ok).toBe(true);
    expect(res.values["procesos_core"]).toEqual(["direccion", "ventas", "operaciones"]);
  });

  it("defaults de toggles: sin override se usa el default del blueprint", () => {
    const res = validateLaunchInputs(bp(), GOOD_INPUTS);
    expect(res.toggles).toEqual({ iso9001: false });
  });

  it("toggle no declarado → unknown_toggle_ref (fail-closed)", () => {
    const res = validateLaunchInputs(bp(), GOOD_INPUTS, { inventado: true });
    expect(res.ok).toBe(false);
    expect(res.issues[0]?.code).toBe("unknown_toggle_ref");
  });

  it("input_type_invalid: number, date y max_len", () => {
    const raw = mutateBlueprint((b) => {
      b.inputs.push({ key: "empleados", label: "Empleados", type: "number", min: 1 });
    });
    const numRes = validateLaunchInputs(bp(raw), { ...GOOD_INPUTS, empleados: "cuarenta" });
    expect(numRes.issues.map((i) => i.code)).toContain("input_type_invalid");
    const minRes = validateLaunchInputs(bp(raw), { ...GOOD_INPUTS, empleados: 0 });
    expect(minRes.issues.map((i) => i.code)).toContain("input_type_invalid");
    const dateRes = validateLaunchInputs(bp(), { ...GOOD_INPUTS, fecha_objetivo: "15/09/2026" });
    expect(dateRes.issues.map((i) => i.code)).toContain("input_type_invalid");
  });

  it("números como string del formulario se coercionan", () => {
    const raw = mutateBlueprint((b) => {
      b.inputs.push({ key: "empleados", label: "Empleados", type: "number", min: 1 });
    });
    const res = validateLaunchInputs(bp(raw), { ...GOOD_INPUTS, empleados: "40" });
    expect(res.ok).toBe(true);
    expect(res.values["empleados"]).toBe(40);
  });

  it("input_option_not_allowed en multi_select", () => {
    const res = validateLaunchInputs(bp(), { ...GOOD_INPUTS, areas: ["direccion", "marte"] });
    expect(res.ok).toBe(false);
    expect(res.issues[0]?.code).toBe("input_option_not_allowed");
  });

  it("input_min_items en multi_select", () => {
    const res = validateLaunchInputs(bp(), { ...GOOD_INPUTS, areas: ["direccion"] });
    expect(res.ok).toBe(false);
    expect(res.issues[0]?.code).toBe("input_min_items");
  });

  it("inputs NO declarados se ignoran (no llegan a values ni al render)", () => {
    const res = validateLaunchInputs(bp(), { ...GOOD_INPUTS, colado: "x" });
    expect(res.ok).toBe(true);
    expect(res.values).not.toHaveProperty("colado");
  });
});

describe("planLaunch", () => {
  function goodPlan(toggles: Record<string, boolean> = { iso9001: true }) {
    const blueprint = bp();
    const inputs = validateLaunchInputs(blueprint, GOOD_INPUTS, toggles);
    expect(inputs.ok).toBe(true);
    return planLaunch(blueprint, inputs.values, inputs.toggles, NOW);
  }

  it("fan_out con 3 áreas → 3 instancias con claves `entrevista:<area>`", () => {
    const plan = goodPlan();
    const keys = plan.tasks.filter((t) => t.templateKey === "entrevista").map((t) => t.key);
    expect(keys).toEqual(["entrevista:direccion", "entrevista:ventas", "entrevista:operaciones"]);
    expect(plan.ok).toBe(true);
    expect(plan.tasks).toHaveLength(6); // kickoff + 3 entrevistas + matriz_iso + informe
  });

  it("deps por clave → claves de INSTANCIA (dep a fan_out = todas sus instancias)", () => {
    const plan = goodPlan();
    const matriz = plan.tasks.find((t) => t.key === "matriz_iso")!;
    expect(matriz.dependsOn.sort()).toEqual([
      "entrevista:direccion",
      "entrevista:operaciones",
      "entrevista:ventas",
    ]);
  });

  it("toggle apagado: matriz_iso podada, dep de informe podada SIN error, deliverable fuera", () => {
    const plan = goodPlan({ iso9001: false });
    expect(plan.ok).toBe(true);
    expect(plan.tasks.map((t) => t.key)).not.toContain("matriz_iso");
    const informe = plan.tasks.find((t) => t.key === "informe")!;
    expect(informe.dependsOn).not.toContain("matriz_iso");
    expect(informe.dependsOn).toHaveLength(3); // solo las 3 entrevistas
    expect(plan.deliverables.map((d) => d.kind)).not.toContain("iso_clause");
    expect(plan.methodology.adds).toEqual([]);
  });

  it("toggle encendido añade methodology_add y el deliverable", () => {
    const plan = goodPlan({ iso9001: true });
    expect(plan.methodology.adds).toEqual(["iso9001-prep"]);
    expect(plan.deliverables.map((d) => d.kind)).toContain("iso_clause");
    // min_from_input: una entrevista por área elegida
    expect(plan.deliverables.find((d) => d.kind === "interview")?.min).toBe(3);
  });

  it("READY sin deps, BACKLOG con deps (CA-M2.3), en orden topológico estable", () => {
    const plan = goodPlan();
    expect(plan.tasks.filter((t) => t.status === "READY").map((t) => t.key)).toEqual(["kickoff"]);
    expect(plan.tasks.filter((t) => t.status === "BACKLOG")).toHaveLength(5);
    const pos = new Map(plan.tasks.map((t, i) => [t.key, i]));
    for (const t of plan.tasks) {
      for (const dep of t.dependsOn) {
        expect(pos.get(dep)!, `${dep} debe ir antes de ${t.key}`).toBeLessThan(pos.get(t.key)!);
      }
    }
  });

  it("requires_approval SOLO sube: política determinista O gate", () => {
    const raw = mutateBlueprint((b) => {
      // Plantilla neutra (sin gate, actividad no sensible) + neutra con gate.
      b.templates.push({
        key: "nota",
        title: "Nota interna",
        dod: "Nota registrada.",
        stage: "ENTENDER",
        activity_type: "research",
        assign: { role: "diagnostico" },
      });
      b.templates.push({
        key: "cierre",
        title: "Cierre con gate",
        dod: "Cierre registrado.",
        stage: "ENTENDER",
        activity_type: "research",
        assign: { role: "orquestador" },
        produces: ["report"],
        gate: "g1",
      });
      b.gates[0].fed_by.push("cierre");
    });
    const blueprint = bp(raw);
    const inputs = validateLaunchInputs(blueprint, GOOD_INPUTS, { iso9001: true });
    const plan = planLaunch(blueprint, inputs.values, inputs.toggles, NOW);
    const by = (k: string) => plan.tasks.find((t) => t.key === k)!;
    expect(by("nota").requiresApproval).toBe(false); // nada la sube
    expect(by("cierre").requiresApproval).toBe(true); // el gate la sube
    expect(by("informe").requiresApproval).toBe(true); // report: política determinista
    expect(by("entrevista:direccion").requiresApproval).toBe(false);
  });

  it("due_at determinista con now fijo: offset desde hoy y due_from_input", () => {
    const plan = goodPlan();
    expect(plan.tasks.find((t) => t.key === "kickoff")!.dueAt).toBe(NOW + 2 * DAY_MS);
    expect(plan.tasks.find((t) => t.key === "informe")!.dueAt).toBe(
      Date.parse("2026-09-15T00:00:00.000Z"),
    );
    expect(plan.tasks.find((t) => t.key === "matriz_iso")!.dueAt).toBeNull();
  });

  it("due_from_input + due_offset_days: offset relativo a la fecha del input", () => {
    const raw = mutateBlueprint((b) => {
      b.templates[3].due_offset_days = -1;
    });
    const blueprint = bp(raw);
    const inputs = validateLaunchInputs(blueprint, GOOD_INPUTS, { iso9001: true });
    const plan = planLaunch(blueprint, inputs.values, inputs.toggles, NOW);
    expect(plan.tasks.find((t) => t.key === "informe")!.dueAt).toBe(
      Date.parse("2026-09-15T00:00:00.000Z") - DAY_MS,
    );
  });

  it("cadence: true queda EXCLUIDA del plan v1 (consent-first M6)", () => {
    const raw = mutateBlueprint((b) => {
      b.templates.push({
        key: "reporte_semanal",
        title: "Reporte semanal",
        dod: "Reporte enviado.",
        stage: "ENTENDER",
        activity_type: "research",
        assign: { role: "diagnostico" },
        cadence: true,
      });
    });
    const blueprint = bp(raw);
    const inputs = validateLaunchInputs(blueprint, GOOD_INPUTS, {});
    const plan = planLaunch(blueprint, inputs.values, inputs.toggles, NOW);
    expect(plan.tasks.map((t) => t.key)).not.toContain("reporte_semanal");
    expect(plan.cadenceExcluded).toEqual(["reporte_semanal"]);
  });

  it("too_many_tasks: >40 instancias tras fan-out → fail-closed (NM-2)", () => {
    const raw = mutateBlueprint((b) => {
      b.inputs.push({ key: "items", label: "Items", type: "list_text" });
      b.templates.push({
        key: "masivo",
        title: "Item {{item}}",
        dod: "Item hecho.",
        stage: "ENTENDER",
        activity_type: "research",
        assign: { role: "diagnostico" },
        fan_out: { over: "items", as: "item" },
      });
    });
    const blueprint = bp(raw);
    const items = Array.from({ length: 45 }, (_, i) => `item ${i + 1}`);
    const inputs = validateLaunchInputs(blueprint, { ...GOOD_INPUTS, items }, {});
    const plan = planLaunch(blueprint, inputs.values, inputs.toggles, NOW);
    expect(plan.ok).toBe(false);
    expect(plan.issues.map((i) => i.code)).toContain("too_many_tasks");
  });

  it("fan_out_key_collision: dos valores que slugifican igual → issue", () => {
    const inputsRes = validateLaunchInputs(
      bp(),
      { ...GOOD_INPUTS, areas: ["direccion", "ventas"] },
      {},
    );
    // Forzamos la colisión inyectando valores equivalentes tras la validación
    // (el slug de "Ventas" y "ventas" coincide).
    const values = { ...inputsRes.values, areas: ["Ventas", "ventas"] };
    const plan = planLaunch(bp(), values, inputsRes.toggles, NOW);
    expect(plan.ok).toBe(false);
    expect(plan.issues.map((i) => i.code)).toContain("fan_out_key_collision");
  });

  it("presupuesto: input presupuesto_fase declarado sobreescribe el default del blueprint", () => {
    const raw = mutateBlueprint((b) => {
      b.inputs.push({ key: "presupuesto_fase", label: "Presupuesto", type: "number", min: 1 });
    });
    const blueprint = bp(raw);
    const inputs = validateLaunchInputs(blueprint, { ...GOOD_INPUTS, presupuesto_fase: 25 }, {});
    const plan = planLaunch(blueprint, inputs.values, inputs.toggles, NOW);
    expect(plan.budget.phaseUsd).toBe(25);
    expect(plan.budget.perRunUsd).toBe(2);
    expect(plan.budget.warningThresholdsPct).toEqual([70, 90, 100]);
  });

  it("proyecto y built-ins: {{cliente}} = alias ?? empresa", () => {
    const plan = goodPlan();
    expect(plan.projectName).toBe("Assessment ACME");
    expect(plan.tasks.find((t) => t.key === "kickoff")!.title).toBe("Kickoff con ACME");
  });
});

describe("slugifyFanOutValue", () => {
  it("minúsculas, sin acentos, separadores a `_`", () => {
    expect(slugifyFanOutValue("Producción")).toBe("produccion");
    expect(slugifyFanOutValue("Ventas→Facturación")).toBe("ventas_facturacion");
    expect(slugifyFanOutValue("  Área de I+D  ")).toBe("area_de_i_d");
  });
});

// Regresión: un launch real de "Textiles del Norte S.A." generó
// `workspaces/assessment-Textiles del Norte S.A.` y el spawn del runner falló
// (Windows no admite el punto/espacio final del nombre de directorio).
describe("sanitizeWorkspacePath", () => {
  it("convierte el nombre libre del cliente en una ruta válida por segmento", () => {
    expect(sanitizeWorkspacePath("workspaces/assessment-Textiles del Norte S.A.")).toBe(
      "workspaces/assessment-textiles-del-norte-s-a",
    );
    expect(sanitizeWorkspacePath("workspaces/operacion-Café & Cía.")).toBe(
      "workspaces/operacion-cafe-cia",
    );
  });

  it("no deja segmentos con espacios, puntos finales ni separadores de Windows", () => {
    const out = sanitizeWorkspacePath("workspaces\\implementacion-ACME S.A. ");
    expect(out).toBe("workspaces/implementacion-acme-s-a");
    for (const seg of out.split("/")) {
      expect(seg).toMatch(/^[a-z0-9-]+$/);
      expect(seg.endsWith(".")).toBe(false);
    }
  });

  it("nunca devuelve ruta vacía", () => {
    expect(sanitizeWorkspacePath("///")).toBe("workspaces/sin-nombre");
    expect(sanitizeWorkspacePath("   ")).toBe("workspaces/sin-nombre");
  });
});
