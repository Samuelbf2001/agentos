import { describe, expect, it } from "vitest";
import {
  blueprintHash,
  canonicalizeBlueprint,
  isAgentosError,
  renderTemplate,
  validateBlueprint,
} from "../src/index.js";
import { makeBlueprint, mutateBlueprint as mutate } from "./fixtures.js";

function codes(raw: unknown): string[] {
  return validateBlueprint(raw).issues.map((i) => i.code);
}

describe("validateBlueprint — blueprint válido", () => {
  it("acepta el blueprint completo y devuelve el parseado", () => {
    const res = validateBlueprint(makeBlueprint());
    expect(res.issues).toEqual([]);
    expect(res.ok).toBe(true);
    expect(res.blueprint?.slug).toBe("demo");
    expect(res.blueprint?.templates).toHaveLength(4);
  });
});

describe("validateBlueprint — reglas fail-closed (§13.5)", () => {
  it("schema_version no soportada → unsupported_schema_version (código propio, no schema_invalid)", () => {
    const res = validateBlueprint(makeBlueprint({ schema_version: 2 }));
    expect(res.ok).toBe(false);
    expect(res.issues).toEqual([
      expect.objectContaining({ code: "unsupported_schema_version", path: "schema_version" }),
    ]);
  });

  it("schema roto → schema_invalid con path", () => {
    const res = validateBlueprint(makeBlueprint({ phase: "INVENTADA" }));
    expect(res.ok).toBe(false);
    expect(res.issues[0]?.code).toBe("schema_invalid");
    expect(res.issues[0]?.path).toContain("phase");
  });

  it("duplicate_template_key", () => {
    const raw = mutate((bp) => bp.templates.push({ ...bp.templates[0] }));
    expect(codes(raw)).toContain("duplicate_template_key");
  });

  it("unknown_dependency", () => {
    const raw = mutate((bp) => bp.templates[1].depends_on.push("no_existe"));
    expect(codes(raw)).toContain("unknown_dependency");
  });

  it("circular_dependency (Kahn) reporta el ciclo en details", () => {
    const raw = mutate((bp) => {
      bp.templates[0].depends_on = ["informe"]; // kickoff → informe → ... → kickoff
    });
    const res = validateBlueprint(raw);
    const issue = res.issues.find((i) => i.code === "circular_dependency");
    expect(issue).toBeDefined();
    expect(issue?.details?.["cycle"]).toEqual(expect.arrayContaining(["kickoff", "informe"]));
  });

  it("auto-dependencia también es circular_dependency", () => {
    const raw = mutate((bp) => (bp.templates[0].depends_on = ["kickoff"]));
    expect(codes(raw)).toContain("circular_dependency");
  });

  it("missing_dod", () => {
    const raw = mutate((bp) => delete bp.templates[0].dod);
    expect(codes(raw)).toContain("missing_dod");
  });

  it("unknown_role", () => {
    const raw = mutate((bp) => (bp.templates[0].assign.role = "inventado"));
    expect(codes(raw)).toContain("unknown_role");
  });

  it("unknown_layer (AgentLayer de shared)", () => {
    const raw = mutate((bp) => (bp.roster[0].layer = "marte"));
    expect(codes(raw)).toContain("unknown_layer");
  });

  it("undeclared_variable en título (la var de fan_out solo vale en su plantilla)", () => {
    const raw = mutate((bp) => (bp.templates[0].title = "Kickoff de {{area}}"));
    const res = validateBlueprint(raw);
    const issue = res.issues.find((i) => i.code === "undeclared_variable");
    expect(issue?.details?.["variable"]).toBe("area");
  });

  it("built-ins ({{cliente}}, {{hoy}}...) siempre permitidas", () => {
    const raw = mutate((bp) => (bp.templates[0].title = "Kickoff {{cliente}} {{hoy}} {{sponsor}} {{fecha_objetivo}}"));
    expect(codes(raw)).not.toContain("undeclared_variable");
  });

  it("fan_out_over_unknown_input: over debe ser multi_select|list_text existente", () => {
    const unknown = mutate((bp) => (bp.templates[1].fan_out.over = "no_existe"));
    expect(codes(unknown)).toContain("fan_out_over_unknown_input");
    const wrongType = mutate((bp) => (bp.templates[1].fan_out.over = "empresa"));
    expect(codes(wrongType)).toContain("fan_out_over_unknown_input");
  });

  it("unknown_toggle_ref en plantilla y en entregable", () => {
    const tpl = mutate((bp) => (bp.templates[2].when_toggle = "no_existe"));
    expect(codes(tpl)).toContain("unknown_toggle_ref");
    const del = mutate((bp) => (bp.closing_deliverables[1].when_toggle = "no_existe"));
    expect(codes(del)).toContain("unknown_toggle_ref");
  });

  it("deliverable_without_producer: produced_by vacío o que no declara el kind", () => {
    const empty = mutate((bp) => delete bp.closing_deliverables[0].produced_by);
    expect(codes(empty)).toContain("deliverable_without_producer");
    const wrong = mutate((bp) => (bp.templates[1].produces = [])); // entrevista deja de producir interview
    expect(codes(wrong)).toContain("deliverable_without_producer");
  });

  it("gate_without_deliverable: el gate debe alimentarse de plantillas que producen cierre", () => {
    const raw = mutate((bp) => (bp.gates[0].fed_by = ["kickoff"])); // kickoff no produce nada
    expect(codes(raw)).toContain("gate_without_deliverable");
  });

  it("stage_mismatch: template.stage ≠ phase del módulo", () => {
    const raw = mutate((bp) => (bp.templates[0].stage = "OPERAR"));
    expect(codes(raw)).toContain("stage_mismatch");
  });

  it("budget_invalid: phase_usd<=0, per_run>phase y semáforos no crecientes o fuera de (0,100]", () => {
    expect(codes(mutate((bp) => (bp.budget.phase_usd = 0)))).toContain("budget_invalid");
    expect(codes(mutate((bp) => (bp.budget.per_run_usd = 99)))).toContain("budget_invalid");
    expect(codes(mutate((bp) => (bp.budget.warning_thresholds_pct = [90, 70])))).toContain("budget_invalid");
    expect(codes(mutate((bp) => (bp.budget.warning_thresholds_pct = [70, 90, 120])))).toContain("budget_invalid");
    expect(codes(mutate((bp) => (bp.budget.warning_thresholds_pct = [0, 50])))).toContain("budget_invalid");
  });
});

describe("canonicalizeBlueprint + blueprintHash", () => {
  it("mismo contenido con claves en otro orden → mismo canónico y mismo hash", () => {
    const a = { z: 1, a: { d: [3, 1], b: "x" } };
    const b = { a: { b: "x", d: [3, 1] }, z: 1 };
    expect(canonicalizeBlueprint(a)).toBe(canonicalizeBlueprint(b));
    expect(blueprintHash(a)).toBe(blueprintHash(b));
    expect(blueprintHash(a)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("el orden de los ARRAYS es semántico: cambiarlo cambia el hash", () => {
    expect(blueprintHash({ a: [1, 2] })).not.toBe(blueprintHash({ a: [2, 1] }));
  });

  it("contenido distinto → hash distinto", () => {
    expect(blueprintHash(makeBlueprint())).not.toBe(blueprintHash(makeBlueprint({ version: 2 })));
  });
});

describe("renderTemplate", () => {
  it("sustituye variables (strings, números, arrays)", () => {
    expect(
      renderTemplate("Assessment {{cliente}} ({{empleados}} empleados): {{areas}}", {
        cliente: "ACME",
        empleados: 40,
        areas: ["direccion", "ventas"],
      }),
    ).toBe("Assessment ACME (40 empleados): direccion, ventas");
  });

  it("variable sin valor → throw con código undeclared_variable (nunca render vacío)", () => {
    try {
      renderTemplate("Hola {{nadie}}", { cliente: "ACME" });
      expect.unreachable("debió lanzar");
    } catch (err) {
      expect(isAgentosError(err, "validation_error")).toBe(true);
      expect((err as { details?: { code?: string; variable?: string } }).details?.code).toBe(
        "undeclared_variable",
      );
      expect((err as { details?: { variable?: string } }).details?.variable).toBe("nadie");
    }
  });
});
