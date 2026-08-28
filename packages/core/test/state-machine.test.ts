import { describe, expect, it } from "vitest";
import { ErrorCodes, isAgentosError } from "@agentos/shared";
import { attachArtifact, getTask, listTaskEvents } from "@agentos/db";
import { actorKind, isTransitionAllowed } from "../src/index.js";
import { fixture, seedTask } from "./helpers.js";

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (err) {
    if (isAgentosError(err)) return err.code;
    throw err;
  }
}

describe("actorKind", () => {
  it("clasifica agent/person/system y rechaza lo demás", () => {
    expect(actorKind("agent:sam")).toBe("agent");
    expect(actorKind("person:abc")).toBe("human");
    expect(actorKind("system:reaper")).toBe("system");
    expect(() => actorKind("bot:x")).toThrowError();
  });
});

describe("matriz de transiciones (pura)", () => {
  it("REVIEW→DONE jamás para agente, sí para humano", () => {
    expect(isTransitionAllowed("agent", "REVIEW", "DONE")).toBe(false);
    expect(isTransitionAllowed("human", "REVIEW", "DONE")).toBe(true);
    expect(isTransitionAllowed("system", "REVIEW", "DONE")).toBe(false);
  });
  it("cualquiera→CANCELLED solo humano", () => {
    for (const from of ["BACKLOG", "READY", "IN_PROGRESS", "BLOCKED", "REVIEW"] as const) {
      expect(isTransitionAllowed("human", from, "CANCELLED")).toBe(true);
      expect(isTransitionAllowed("agent", from, "CANCELLED")).toBe(false);
      expect(isTransitionAllowed("system", from, "CANCELLED")).toBe(false);
    }
  });
  it("IN_PROGRESS→READY es solo del sistema (reaper)", () => {
    expect(isTransitionAllowed("system", "IN_PROGRESS", "READY")).toBe(true);
    expect(isTransitionAllowed("agent", "IN_PROGRESS", "READY")).toBe(false);
    expect(isTransitionAllowed("human", "IN_PROGRESS", "READY")).toBe(false);
  });
  it("los terminales no se reabren y no hay self-transition", () => {
    expect(isTransitionAllowed("human", "DONE", "READY")).toBe(false);
    expect(isTransitionAllowed("human", "CANCELLED", "READY")).toBe(false);
    expect(isTransitionAllowed("human", "READY", "READY")).toBe(false);
  });
});

describe("moveTask por actor", () => {
  it("humano BACKLOG→READY con DoD+asignada funciona y escribe task_events", () => {
    const f = fixture();
    const t = seedTask(f);
    const moved = f.engine.moveTask({
      taskId: t.id,
      to: "READY",
      expectedVersion: t.version,
      actor: `person:${f.person.id}`,
    });
    expect(moved.status).toBe("READY");
    const events = listTaskEvents(f.db, t.id);
    const move = events.find((e) => e.kind === "moved")!;
    expect(move.fromStatus).toBe("BACKLOG");
    expect(move.toStatus).toBe("READY");
    expect(move.actor).toBe(`person:${f.person.id}`);
  });

  it("agente no-orquestador NO puede BACKLOG→READY; el orquestador sí", () => {
    const f = fixture();
    const t1 = seedTask(f);
    expect(
      codeOf(() =>
        f.engine.moveTask({ taskId: t1.id, to: "READY", expectedVersion: t1.version, actor: "agent:sam" }),
      ),
    ).toBe(ErrorCodes.INVALID_TRANSITION);
    const moved = f.engine.moveTask({
      taskId: t1.id,
      to: "READY",
      expectedVersion: t1.version,
      actor: "agent:alex",
    });
    expect(moved.status).toBe("READY");
  });

  it("BACKLOG→READY sin DoD o sin asignado se rechaza", () => {
    const f = fixture();
    const sinDod = seedTask(f, { definitionOfDone: null });
    expect(
      codeOf(() =>
        f.engine.moveTask({ taskId: sinDod.id, to: "READY", expectedVersion: sinDod.version, actor: "agent:alex" }),
      ),
    ).toBe(ErrorCodes.VALIDATION_ERROR);
    const sinDueno = seedTask(f, { assignee: null });
    expect(
      codeOf(() =>
        f.engine.moveTask({
          taskId: sinDueno.id,
          to: "READY",
          expectedVersion: sinDueno.version,
          actor: `person:${f.person.id}`,
        }),
      ),
    ).toBe(ErrorCodes.VALIDATION_ERROR);
  });

  it("agente no mueve READY→IN_PROGRESS con move (solo claim); humano sí puede", () => {
    const f = fixture();
    const t = seedTask(f, { status: "READY" });
    expect(
      codeOf(() =>
        f.engine.moveTask({ taskId: t.id, to: "IN_PROGRESS", expectedVersion: t.version, actor: "agent:sam" }),
      ),
    ).toBe(ErrorCodes.INVALID_TRANSITION);
    const moved = f.engine.moveTask({
      taskId: t.id,
      to: "IN_PROGRESS",
      expectedVersion: t.version,
      actor: `person:${f.person.id}`,
    });
    expect(moved.status).toBe("IN_PROGRESS");
  });

  it("agente REVIEW→DONE se rechaza siempre; humano cierra", () => {
    const f = fixture();
    const t = seedTask(f, { status: "REVIEW" });
    attachArtifact(f.db, { taskId: t.id, kind: "doc", title: "informe" });
    expect(
      codeOf(() => f.engine.moveTask({ taskId: t.id, to: "DONE", expectedVersion: t.version, actor: "agent:sam" })),
    ).toBe(ErrorCodes.INVALID_TRANSITION);
    const moved = f.engine.moveTask({
      taskId: t.id,
      to: "DONE",
      expectedVersion: t.version,
      actor: `person:${f.person.id}`,
    });
    expect(moved.status).toBe("DONE");
  });

  it("rechazo de REVIEW exige nota y vuelve a IN_PROGRESS", () => {
    const f = fixture();
    const t = seedTask(f, { status: "REVIEW" });
    attachArtifact(f.db, { taskId: t.id, kind: "doc", title: "informe" });
    expect(
      codeOf(() =>
        f.engine.moveTask({ taskId: t.id, to: "IN_PROGRESS", expectedVersion: t.version, actor: `person:${f.person.id}` }),
      ),
    ).toBe(ErrorCodes.VALIDATION_ERROR);
    const moved = f.engine.moveTask({
      taskId: t.id,
      to: "IN_PROGRESS",
      expectedVersion: t.version,
      actor: `person:${f.person.id}`,
      note: "Falta la fuente del dato de fugas",
    });
    expect(moved.status).toBe("IN_PROGRESS");
    const rejection = listTaskEvents(f.db, t.id).find((e) => e.kind === "moved")!;
    expect(rejection.payload).toMatchObject({ note: "Falta la fuente del dato de fugas" });
  });

  it("agente no cancela; humano cancela desde cualquier estado", () => {
    const f = fixture();
    const t = seedTask(f, { status: "IN_PROGRESS" });
    expect(
      codeOf(() =>
        f.engine.moveTask({ taskId: t.id, to: "CANCELLED", expectedVersion: t.version, actor: "agent:sam" }),
      ),
    ).toBe(ErrorCodes.INVALID_TRANSITION);
    const moved = f.engine.moveTask({
      taskId: t.id,
      to: "CANCELLED",
      expectedVersion: t.version,
      actor: `person:${f.person.id}`,
    });
    expect(moved.status).toBe("CANCELLED");
  });

  it("expected_version desactualizada → version_conflict (nunca last-write-wins)", () => {
    const f = fixture();
    const t = seedTask(f, { status: "IN_PROGRESS" });
    const ok = f.engine.moveTask({
      taskId: t.id,
      to: "BLOCKED",
      expectedVersion: t.version,
      actor: "agent:sam",
      blockedReason: "manual",
    });
    expect(ok.status).toBe("BLOCKED");
    expect(
      codeOf(() =>
        f.engine.moveTask({ taskId: t.id, to: "READY", expectedVersion: t.version, actor: "agent:sam" }),
      ),
    ).toBe(ErrorCodes.VERSION_CONFLICT);
    // Releyendo la versión actual, la transición procede.
    const fresh = getTask(f.db, t.id)!;
    expect(
      f.engine.moveTask({ taskId: t.id, to: "READY", expectedVersion: fresh.version, actor: "agent:sam" }).status,
    ).toBe("READY");
  });

  it("agente IN_PROGRESS→DONE con requires_approval → human_approval_required", () => {
    const f = fixture();
    const t = seedTask(f, { status: "IN_PROGRESS", requiresApproval: true });
    attachArtifact(f.db, { taskId: t.id, kind: "doc", title: "informe" });
    expect(
      codeOf(() => f.engine.moveTask({ taskId: t.id, to: "DONE", expectedVersion: t.version, actor: "agent:sam" })),
    ).toBe(ErrorCodes.HUMAN_APPROVAL_REQUIRED);
    // A REVIEW sí puede llegar.
    expect(
      f.engine.moveTask({ taskId: t.id, to: "REVIEW", expectedVersion: t.version, actor: "agent:sam" }).status,
    ).toBe("REVIEW");
  });

  it("regla anti-teatro: REVIEW/DONE sin artefacto → missing_artifact", () => {
    const f = fixture();
    const t = seedTask(f, { status: "IN_PROGRESS" });
    expect(
      codeOf(() => f.engine.moveTask({ taskId: t.id, to: "REVIEW", expectedVersion: t.version, actor: "agent:sam" })),
    ).toBe(ErrorCodes.MISSING_ARTIFACT);
    expect(
      codeOf(() =>
        f.engine.moveTask({ taskId: t.id, to: "DONE", expectedVersion: t.version, actor: `person:${f.person.id}` }),
      ),
    ).toBe(ErrorCodes.MISSING_ARTIFACT);
    attachArtifact(f.db, { taskId: t.id, kind: "doc", title: "evidencia" });
    expect(
      f.engine.moveTask({ taskId: t.id, to: "REVIEW", expectedVersion: t.version, actor: "agent:sam" }).status,
    ).toBe("REVIEW");
  });
});
