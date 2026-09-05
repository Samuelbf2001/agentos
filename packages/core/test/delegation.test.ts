import { describe, expect, it } from "vitest";
import { ErrorCodes, isAgentosError } from "@agentos/shared";
import { createRun, listTaskEvents, type Task } from "@agentos/db";
import { fixture, seedTask, type Fixture } from "./helpers.js";

const PAYLOAD = {
  tarea: "Entrevistar al responsable de ventas",
  limites: ["máx 45 min", "no prometer alcance"],
  forma_de_buena_respuesta: "Transcripción + resumen con pain points citados",
};

function delegateFrom(f: Fixture, parent: Task, runId?: string | null): Promise<Task> {
  return f.engine.delegate({
    parentTaskId: parent.id,
    payload: PAYLOAD,
    assignee: "sam",
    actor: "agent:alex",
    runId: runId ?? null,
  });
}

describe("delegación = tarea hija tipada", () => {
  it("crea la hija en READY con DoD, asignada, y registra eventos en padre e hija", async () => {
    const f = await fixture();
    const parent = await seedTask(f, { status: "IN_PROGRESS" });
    const child = await delegateFrom(f, parent, f.run.id);
    expect(child.parentTaskId).toBe(parent.id);
    expect(child.status).toBe("READY");
    expect(child.assigneeAgentId).toBe(f.sam.id);
    expect(child.definitionOfDone).toBe(PAYLOAD.forma_de_buena_respuesta);
    expect(child.stage).toBe(parent.stage);

    const parentEvents = await listTaskEvents(f.db, parent.id);
    expect(parentEvents.some((e) => e.kind === "delegated")).toBe(true);
    const childEvents = await listTaskEvents(f.db, child.id);
    expect(childEvents.some((e) => e.kind === "created")).toBe(true);
  });

  it("payload no tipado se rechaza (nunca texto libre)", async () => {
    const f = await fixture();
    const parent = await seedTask(f, { status: "IN_PROGRESS" });
    try {
      await f.engine.delegate({
        parentTaskId: parent.id,
        payload: { tarea: "haz algo" } as never,
        assignee: "sam",
        actor: "agent:alex",
      });
      expect.unreachable("debió rechazar el payload");
    } catch (err) {
      expect(isAgentosError(err, ErrorCodes.VALIDATION_ERROR)).toBe(true);
    }
  });

  it("profundidad 4 se rechaza con error claro (máx 3, no trunca)", async () => {
    const f = await fixture();
    const root = await seedTask(f, { status: "IN_PROGRESS" }); // depth 0
    const c1 = await delegateFrom(f, root); // depth 1
    const c2 = await delegateFrom(f, c1); // depth 2
    const c3 = await delegateFrom(f, c2); // depth 3
    try {
      await delegateFrom(f, c3); // depth 4 → rechazo
      expect.unreachable("debió rechazar depth 4");
    } catch (err) {
      expect(isAgentosError(err, ErrorCodes.DELEGATION_LIMIT)).toBe(true);
      expect((err as Error).message).toContain("profundidad");
    }
  });

  it("fan-out 5 en el mismo run se rechaza; otro run vuelve a contar de cero", async () => {
    const f = await fixture();
    const parent = await seedTask(f, { status: "IN_PROGRESS" });
    for (let i = 0; i < 4; i++) await delegateFrom(f, parent, f.run.id);
    try {
      await delegateFrom(f, parent, f.run.id);
      expect.unreachable("debió rechazar fan-out 5");
    } catch (err) {
      expect(isAgentosError(err, ErrorCodes.DELEGATION_LIMIT)).toBe(true);
      expect((err as Error).message).toContain("fan-out");
    }
    // El límite es POR RUN: un run nuevo puede delegar otra vez.
    const otherRun = await createRun(f.db, { trigger: "manual", runtime: "ai_sdk", agentId: f.alex.id });
    expect((await delegateFrom(f, parent, otherRun.id)).parentTaskId).toBe(parent.id);
  });

  it("delegar bajo CONSTRUIR sin G1 aprobado → gate_not_passed (fail-closed)", async () => {
    const f = await fixture();
    const parent = await seedTask(f, { stage: "CONSTRUIR", status: "IN_PROGRESS" });
    try {
      await delegateFrom(f, parent);
      expect.unreachable("debió exigir el gate");
    } catch (err) {
      expect(isAgentosError(err, ErrorCodes.GATE_NOT_PASSED)).toBe(true);
    }
    await f.engine.approveGate(f.project.id, "g1_plan", f.person.id);
    expect((await delegateFrom(f, parent)).status).toBe("READY");
  });
});
