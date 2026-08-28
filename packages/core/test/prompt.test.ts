import { describe, expect, it } from "vitest";
import { createDoc, createPromptVersion, upsertMethodology } from "@agentos/db";
import { assemblePrompt, PROVENANCE_GUIDANCE } from "../src/index.js";
import { fixture, seedTask } from "./helpers.js";

describe("assemblePrompt — 3 capas", () => {
  it("stable contiene identidad + constitución con PROVENANCE y NO_ANSWER_CAME", () => {
    const f = fixture();
    createPromptVersion(f.db, {
      agentId: f.sam.id,
      stable: "Eres Sam, consultor de diagnóstico de Sixteam.",
      context: null,
      volatileTpl: null,
    });
    const prompt = assemblePrompt(f.db, { agent: "sam" });
    expect(prompt.stable).toContain("Eres Sam, consultor de diagnóstico");
    expect(prompt.stable).toContain("Cita el doc id del Context Hub");
    expect(prompt.stable).toContain("no verificado");
    expect(prompt.stable).toContain("NO_ANSWER_CAME");
    expect(PROVENANCE_GUIDANCE).toContain("no verificado");
  });

  it("context contiene metodología activa, Context Hub y DoD; volatile la tarea y el timestamp", () => {
    const f = fixture();
    upsertMethodology(f.db, {
      slug: "assessment-14d",
      version: 1,
      bodyMd: "## Fase 1: Entrevistas\nPregunta por los 3 procesos que más duelen.",
    });
    const doc = createDoc(f.db, {
      projectId: f.project.id,
      orgId: f.org.id,
      kind: "org_profile",
      title: "Perfil ACME",
      bodyMd: "Manufactura, 40 empleados",
    });
    const task = seedTask(f, { status: "IN_PROGRESS" });
    const now = Date.UTC(2026, 7, 27, 12, 0, 0);
    const prompt = assemblePrompt(f.db, { agent: f.sam, project: f.project.id, task: task.id, now });

    // context: metodología (desde la tabla methodologies) + hub + DoD
    expect(prompt.context).toContain("assessment-14d v1");
    expect(prompt.context).toContain("Pregunta por los 3 procesos que más duelen");
    expect(prompt.context).toContain(`[doc:${doc.id}]`);
    expect(prompt.context).toContain("Proceso documentado con SIPOC");
    expect(prompt.context).toContain("Gate 1 (g1_plan): pending");

    // volatile: tarea + eventos + timestamp
    expect(prompt.volatile).toContain(task.id);
    expect(prompt.volatile).toContain("Mapear proceso de ventas");
    expect(prompt.volatile).toContain("2026-08-27T12:00:00.000Z");

    // orden deliberado para prefix cache: stable → context → volatile
    expect(prompt.full.indexOf(prompt.stable)).toBeLessThan(prompt.full.indexOf(prompt.context));
    expect(prompt.full.indexOf(prompt.context)).toBeLessThan(prompt.full.indexOf(prompt.volatile));
  });

  it("sin metodología registrada lo dice explícitamente (no inventa)", () => {
    const f = fixture();
    const prompt = assemblePrompt(f.db, { agent: "alex", project: f.project.id });
    expect(prompt.context).toContain("Sin metodología registrada");
  });
});
