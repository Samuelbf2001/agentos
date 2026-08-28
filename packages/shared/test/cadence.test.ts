/**
 * M6a — cadencia consent-first (CA-M3.4), piezas PURAS:
 * - `cadence_period_days` en el schema + reglas de validateBlueprint
 *   (cadence_with_dependencies, cadence_sensitive_variable).
 * - `planLaunch(..., cadencesConfirmed)`: las confirmadas SÍ entran al plan
 *   (primera instancia con due), las no confirmadas quedan fuera; claves
 *   desconocidas/no-cadence/apagadas y cadencias sin periodo → issues.
 * - `cadenceProposals` para el resumen del wizard.
 */
import { describe, expect, it } from "vitest";
import {
  DAY_MS,
  cadencePeriodDays,
  planLaunch,
  validateBlueprint,
  validateLaunchInputs,
  type ModuleBlueprint,
  type ModuleTemplate,
} from "../src/index.js";
import { makeBlueprint, mutateBlueprint } from "./fixtures.js";

const NOW = Date.parse("2026-08-28T12:00:00.000Z");

function bp(raw: Record<string, unknown> = makeBlueprint()): ModuleBlueprint {
  const res = validateBlueprint(raw);
  if (!res.ok || !res.blueprint) throw new Error(`fixture inválido: ${JSON.stringify(res.issues)}`);
  return res.blueprint;
}

const GOOD_INPUTS = {
  empresa: "ACME S.A.",
  alias: "ACME",
  areas: ["direccion", "ventas"],
  fecha_objetivo: "2026-09-15",
};

/** Blueprint base + una plantilla cadence configurable. */
function withCadence(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return mutateBlueprint((b) => {
    b.templates.push({
      key: "reporte_semanal",
      title: "Reporte semanal de {{cliente}}",
      dod: "Reporte enviado.",
      stage: "ENTENDER",
      activity_type: "research",
      assign: { role: "diagnostico" },
      cadence: true,
      cadence_period_days: 7,
      ...overrides,
    });
  });
}

function planWith(
  raw: Record<string, unknown>,
  cadencesConfirmed: string[],
  toggles: Record<string, boolean> = {},
) {
  const blueprint = bp(raw);
  const inputs = validateLaunchInputs(blueprint, GOOD_INPUTS, toggles);
  expect(inputs.ok).toBe(true);
  return planLaunch(blueprint, inputs.values, inputs.toggles, NOW, cadencesConfirmed);
}

describe("validateBlueprint — reglas de cadencia (M6a)", () => {
  it("acepta cadence_period_days (schema) y lo expone tipado", () => {
    const blueprint = bp(withCadence());
    const tpl = blueprint.templates.find((t) => t.key === "reporte_semanal")!;
    expect(tpl.cadence_period_days).toBe(7);
  });

  it("cadence con depends_on → cadence_with_dependencies (las cadencias son independientes)", () => {
    const res = validateBlueprint(withCadence({ depends_on: ["kickoff"] }));
    expect(res.ok).toBe(false);
    const issue = res.issues.find((i) => i.code === "cadence_with_dependencies")!;
    expect(issue.path).toContain("depends_on");
    expect(issue.details?.["key"]).toBe("reporte_semanal");
  });

  it("cadence con variable sensitive → cadence_sensitive_variable (el re-render usa el recibo redactado)", () => {
    const raw = mutateBlueprint((b) => {
      b.inputs.push({ key: "notas", label: "Notas", type: "textarea", sensitive: true });
      b.templates.push({
        key: "reporte_semanal",
        title: "Reporte con {{notas}}",
        dod: "Reporte enviado.",
        stage: "ENTENDER",
        activity_type: "research",
        assign: { role: "diagnostico" },
        cadence: true,
        cadence_period_days: 7,
      });
    });
    const res = validateBlueprint(raw);
    expect(res.ok).toBe(false);
    const issue = res.issues.find((i) => i.code === "cadence_sensitive_variable")!;
    expect(issue.details?.["variable"]).toBe("notas");
    // La MISMA variable en una plantilla NO-cadence no es issue.
    const okRaw = mutateBlueprint((b) => {
      b.inputs.push({ key: "notas", label: "Notas", type: "textarea", sensitive: true });
      b.templates[0].description = "Contexto: {{notas}}";
    });
    expect(validateBlueprint(okRaw).ok).toBe(true);
  });

  it("cadence_period_days no positivo → schema_invalid (Zod)", () => {
    const res = validateBlueprint(withCadence({ cadence_period_days: 0 }));
    expect(res.ok).toBe(false);
    expect(res.issues.some((i) => i.code === "schema_invalid")).toBe(true);
  });
});

describe("cadencePeriodDays — periodo efectivo", () => {
  const base = {
    key: "x",
    title: "X",
    stage: "ENTENDER",
    activity_type: "research",
    assign: { role: "r" },
  } as unknown as ModuleTemplate;

  it("explícito gana; due_offset_days positivo es fallback; nada → null", () => {
    expect(cadencePeriodDays({ ...base, cadence_period_days: 14, due_offset_days: 7 })).toBe(14);
    expect(cadencePeriodDays({ ...base, due_offset_days: 7 })).toBe(7);
    expect(cadencePeriodDays({ ...base, due_offset_days: -3 })).toBeNull();
    expect(cadencePeriodDays(base)).toBeNull();
  });
});

describe("planLaunch — cadences_confirmed (consent-first M6a)", () => {
  it("sin confirmación: excluida del plan pero propuesta al wizard", () => {
    const plan = planWith(withCadence(), []);
    expect(plan.ok).toBe(true);
    expect(plan.tasks.map((t) => t.key)).not.toContain("reporte_semanal");
    expect(plan.cadenceExcluded).toEqual(["reporte_semanal"]);
    expect(plan.cadencesConfirmed).toEqual([]);
    expect(plan.cadenceProposals).toEqual([
      {
        key: "reporte_semanal",
        title: "Reporte semanal de ACME", // {{cliente}} renderizado
        description: null,
        activityType: "research",
        role: "diagnostico",
        periodDays: 7,
      },
    ]);
  });

  it("confirmada: entra al plan como primera instancia READY con due = now + period", () => {
    const plan = planWith(withCadence(), ["reporte_semanal"]);
    expect(plan.ok).toBe(true);
    const instancia = plan.tasks.find((t) => t.key === "reporte_semanal")!;
    expect(instancia.status).toBe("READY"); // sin deps por validación
    expect(instancia.dueAt).toBe(NOW + 7 * DAY_MS);
    expect(plan.cadencesConfirmed).toEqual(["reporte_semanal"]);
    expect(plan.cadenceExcluded).toEqual([]);
  });

  it("confirmada con due_offset_days: la primera instancia usa el offset declarado", () => {
    const plan = planWith(withCadence({ due_offset_days: 3 }), ["reporte_semanal"]);
    expect(plan.tasks.find((t) => t.key === "reporte_semanal")!.dueAt).toBe(NOW + 3 * DAY_MS);
  });

  it("clave desconocida o no-cadence → cadence_unknown_key (fail-closed)", () => {
    const desconocida = planWith(withCadence(), ["no_existe"]);
    expect(desconocida.ok).toBe(false);
    expect(desconocida.issues.map((i) => i.code)).toContain("cadence_unknown_key");

    const noCadence = planWith(withCadence(), ["kickoff"]);
    expect(noCadence.ok).toBe(false);
    const issue = noCadence.issues.find((i) => i.code === "cadence_unknown_key")!;
    expect(issue.details?.["reason"]).toBe("not_a_cadence_template");
  });

  it("cadence apagada por toggle NO es confirmable → cadence_unknown_key(disabled_by_toggle)", () => {
    const plan = planWith(withCadence({ when_toggle: "iso9001" }), ["reporte_semanal"], {
      iso9001: false,
    });
    expect(plan.ok).toBe(false);
    const issue = plan.issues.find((i) => i.code === "cadence_unknown_key")!;
    expect(issue.details?.["reason"]).toBe("disabled_by_toggle");
  });

  it("cadence sin periodo (ni due_offset positivo) confirmada → cadence_missing_period", () => {
    const plan = planWith(withCadence({ cadence_period_days: undefined }), ["reporte_semanal"]);
    expect(plan.ok).toBe(false);
    expect(plan.issues.map((i) => i.code)).toContain("cadence_missing_period");
  });
});
