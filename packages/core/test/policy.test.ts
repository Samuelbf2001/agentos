import { describe, expect, it } from "vitest";
import { ErrorCodes, isAgentosError } from "@agentos/shared";
import { attachArtifact, getTask } from "@agentos/db";
import { computeRequiresApproval, QUINN_REVIEWED_ACTIVITY_TYPES } from "../src/index.js";
import { fixture, type Fixture } from "./helpers.js";

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

// ── Q1: los entregables que Quinn revisa exigen gate humano (no van a DONE por un agente) ──

function inProgressTask(f: Fixture, activityType: string) {
  const t = f.engine.createTask(
    {
      projectId: f.project.id,
      title: `Entregable ${activityType}`,
      stage: "ENTENDER",
      activityType,
      assigneeAgentId: f.sam.id,
    },
    { actor: `person:${f.person.id}` },
  );
  // Colocar en IN_PROGRESS fuera de la máquina (setup, no acopla tests).
  f.db.$client
    .prepare(`UPDATE tasks SET status = 'IN_PROGRESS', version = version + 1 WHERE id = ?`)
    .run(t.id);
  return getTask(f.db, t.id)!;
}

function moveCode(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (err) {
    if (isAgentosError(err)) return err.code;
    throw err;
  }
}

describe("Q1: entregables revisados por Quinn ⇒ requires_approval (lista única de core)", () => {
  it("todo tipo de QUINN_REVIEWED_ACTIVITY_TYPES → requires_approval true", () => {
    for (const at of QUINN_REVIEWED_ACTIVITY_TYPES) {
      expect(computeRequiresApproval({ activityType: at })).toBe(true);
    }
    // Los cuatro entregables de consultoría que antes quedaban en false (Q1).
    for (const at of ["org_profile", "process_map", "leak_analysis", "iso_gap"]) {
      expect(computeRequiresApproval({ activityType: at })).toBe(true);
    }
  });

  it("un agente NO puede llevar a DONE ningún tipo sensible → human_approval_required", () => {
    for (const at of ["org_profile", "process_map", "leak_analysis", "iso_gap", "report", "roadmap", "code"]) {
      const f = fixture();
      const t = inProgressTask(f, at);
      expect(t.requiresApproval).toBe(true);
      expect(
        moveCode(() =>
          f.engine.moveTask({ taskId: t.id, to: "DONE", expectedVersion: t.version, actor: "agent:sam" }),
        ),
      ).toBe(ErrorCodes.HUMAN_APPROVAL_REQUIRED);
      // A REVIEW sí llega (con artefacto): de ahí lo cierra un humano.
      attachArtifact(f.db, { taskId: t.id, kind: "doc", title: "borrador" });
      expect(
        f.engine.moveTask({ taskId: t.id, to: "REVIEW", expectedVersion: t.version, actor: "agent:sam" }).status,
      ).toBe("REVIEW");
    }
  });

  it("un tipo NO sensible (research) sí puede ir directo a DONE por el agente", () => {
    const f = fixture();
    const t = inProgressTask(f, "research");
    expect(t.requiresApproval).toBe(false);
    attachArtifact(f.db, { taskId: t.id, kind: "doc", title: "notas" });
    expect(
      f.engine.moveTask({ taskId: t.id, to: "DONE", expectedVersion: t.version, actor: "agent:sam" }).status,
    ).toBe("DONE");
  });
});
