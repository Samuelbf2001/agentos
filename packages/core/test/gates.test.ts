import { describe, expect, it } from "vitest";
import { ErrorCodes, isAgentosError } from "@agentos/shared";
import { getProject, queryAudit } from "@agentos/db";
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

describe("Gate 1 — proyecto (g1_plan)", () => {
  it("tarea CONSTRUIR no sale de BACKLOG sin g1 aprobado; ENTENDER sí fluye", () => {
    const f = fixture();
    const construir = seedTask(f, { stage: "CONSTRUIR" });
    expect(
      codeOf(() =>
        f.engine.moveTask({
          taskId: construir.id,
          to: "READY",
          expectedVersion: construir.version,
          actor: `person:${f.person.id}`,
        }),
      ),
    ).toBe(ErrorCodes.GATE_NOT_PASSED);

    const entender = seedTask(f, { stage: "ENTENDER" });
    expect(
      f.engine.moveTask({
        taskId: entender.id,
        to: "READY",
        expectedVersion: entender.version,
        actor: `person:${f.person.id}`,
      }).status,
    ).toBe("READY");
  });

  it("approveGate desbloquea CONSTRUIR y deja auditoría before/after", () => {
    const f = fixture();
    const t = seedTask(f, { stage: "CONSTRUIR" });
    const updated = f.engine.approveGate(f.project.id, "g1_plan", f.person.id, "diagnóstico validado");
    expect(updated.gateState).toBe("approved");
    expect(getProject(f.db, f.project.id)!.gateState).toBe("approved");

    const audit = queryAudit(f.db, { entityType: "project", entityId: f.project.id });
    const entry = audit.find((a) => a.action === "gate.approve")!;
    expect(entry.before).toMatchObject({ gateState: "pending" });
    expect(entry.after).toMatchObject({ gateState: "approved", gate: "g1_plan" });
    expect(entry.actor).toBe(`person:${f.person.id}`);

    expect(
      f.engine.moveTask({
        taskId: t.id,
        to: "READY",
        expectedVersion: t.version,
        actor: `person:${f.person.id}`,
      }).status,
    ).toBe("READY");
  });

  it("un gate desconocido se rechaza", () => {
    const f = fixture();
    expect(codeOf(() => f.engine.approveGate(f.project.id, "g9" as never, f.person.id))).toBe(
      ErrorCodes.VALIDATION_ERROR,
    );
  });

  it("cancelar una tarea CONSTRUIR en BACKLOG no exige gate (humano)", () => {
    const f = fixture();
    const t = seedTask(f, { stage: "CONSTRUIR" });
    expect(
      f.engine.moveTask({
        taskId: t.id,
        to: "CANCELLED",
        expectedVersion: t.version,
        actor: `person:${f.person.id}`,
      }).status,
    ).toBe("CANCELLED");
  });
});

describe("Gate 2 — approvals con payload literal + digest", () => {
  it("requestApproval crea pendiente y es idempotente por (digest, run)", () => {
    const f = fixture();
    const payload = { tool: "email.send", args: { to: "cliente@acme.com", subject: "Informe" } };
    const a1 = f.engine.requestApproval({ kind: "tool_call", payload, runId: f.run.id });
    expect(a1.status).toBe("pending");
    expect(a1.actionDigest).toHaveLength(64);
    const a2 = f.engine.requestApproval({ kind: "tool_call", payload, runId: f.run.id });
    expect(a2.id).toBe(a1.id);
  });

  it("aprobar un tool_call devuelve el payload literal para el despachador", () => {
    const f = fixture();
    const payload = { tool: "email.send", args: { to: "x@y.z", subject: "s", body: "b" } };
    const approval = f.engine.requestApproval({ kind: "tool_call", payload, runId: f.run.id });
    const decided = f.engine.decideApproval(approval.id, "approved", f.person.id, "ok, mándalo");
    expect(decided.approval.status).toBe("approved");
    expect(decided.approval.decidedByPersonId).toBe(f.person.id);
    expect(decided.executePayload).toEqual(payload);

    const audit = queryAudit(f.db, { entityType: "approval", entityId: approval.id });
    expect(audit.some((a) => a.action === "approval.approved")).toBe(true);
  });

  it("rechazar no devuelve payload ejecutable", () => {
    const f = fixture();
    const approval = f.engine.requestApproval({
      kind: "tool_call",
      payload: { tool: "email.send", args: {} },
      runId: f.run.id,
    });
    const decided = f.engine.decideApproval(approval.id, "rejected", f.person.id, "no procede");
    expect(decided.approval.status).toBe("rejected");
    expect(decided.executePayload).toBeUndefined();
  });

  it("payload manipulado tras crear la aprobación → approval_invalidated", () => {
    const f = fixture();
    const approval = f.engine.requestApproval({
      kind: "tool_call",
      payload: { tool: "email.send", args: { to: "real@acme.com" } },
      runId: f.run.id,
    });
    // Ataque: alguien cambia los argumentos por debajo (el digest ya no coincide).
    f.db.$client
      .prepare(`UPDATE approvals SET payload = ? WHERE id = ?`)
      .run(JSON.stringify({ tool: "email.send", args: { to: "atacante@evil.com" } }), approval.id);
    expect(codeOf(() => f.engine.decideApproval(approval.id, "approved", f.person.id))).toBe(
      ErrorCodes.APPROVAL_INVALIDATED,
    );
  });

  it("decidir dos veces falla explícitamente", () => {
    const f = fixture();
    const approval = f.engine.requestApproval({
      kind: "deliverable",
      payload: { type: "question", body: "¿seguimos?" },
      runId: f.run.id,
    });
    f.engine.decideApproval(approval.id, "approved", f.person.id);
    expect(codeOf(() => f.engine.decideApproval(approval.id, "approved", f.person.id))).toBe(ErrorCodes.CONFLICT);
  });

  it("una aprobación pendiente sobrevive en DB y aparece en la bandeja", () => {
    const f = fixture();
    const approval = f.engine.requestApproval({
      kind: "tool_call",
      payload: { tool: "email.send", args: { to: "a@b.c" } },
      runId: f.run.id,
    });
    const pending = f.engine.listPendingApprovals();
    expect(pending.map((a) => a.id)).toContain(approval.id);
  });
});
