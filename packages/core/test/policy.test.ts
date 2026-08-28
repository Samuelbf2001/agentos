import { describe, expect, it } from "vitest";
import { computeRequiresApproval } from "../src/index.js";
import { fixture } from "./helpers.js";

describe("computeRequiresApproval (política determinista)", () => {
  it("efecto externo, entregable de fase y actividad sensible → true", () => {
    expect(computeRequiresApproval({ externalEffect: true })).toBe(true);
    expect(computeRequiresApproval({ activityType: "assessment_report" })).toBe(true);
    expect(computeRequiresApproval({ activityType: "roadmap" })).toBe(true);
    expect(computeRequiresApproval({ activityType: "deploy" })).toBe(true);
    expect(computeRequiresApproval({ activityType: "  DEPLOY " })).toBe(true);
  });

  it("trabajo interno normal → false", () => {
    expect(computeRequiresApproval({})).toBe(false);
    expect(computeRequiresApproval({ activityType: "research" })).toBe(false);
    expect(computeRequiresApproval({ externalEffect: false, activityType: null })).toBe(false);
  });
});

describe("aplicación al crear (el agente no puede rebajarla)", () => {
  it("createTask ignora requires_approval=false si la política dice true", () => {
    const f = fixture();
    const task = f.engine.createTask(
      {
        projectId: f.project.id,
        title: "Enviar informe al cliente",
        stage: "ENTENDER",
        externalEffect: true,
        requiresApproval: false, // intento de rebaja
      },
      { actor: "agent:alex" },
    );
    expect(task.requiresApproval).toBe(true);
  });

  it("el llamador sí puede SUBIR el control", () => {
    const f = fixture();
    const task = f.engine.createTask(
      {
        projectId: f.project.id,
        title: "Notas internas",
        stage: "ENTENDER",
        requiresApproval: true,
      },
      { actor: "agent:alex" },
    );
    expect(task.requiresApproval).toBe(true);
  });
});
