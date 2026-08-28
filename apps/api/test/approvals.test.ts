/**
 * Gate 2 completo (US-5): la tool de efecto externo NO ejecuta — crea approval
 * pendiente; decide approve → el efecto se ejecuta vía executeApproved del
 * gateway (stub email.send marca ejecutado) → run de reanudación encolado con
 * resume_of_run_id.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getRun, getTask, listPendingApprovals, listRuns, queryAudit } from "@agentos/db";
import { callTool, makeFixture, makeReadyTask, waitFor, type TestFixture } from "./helpers.js";

let fx: TestFixture;

beforeAll(async () => {
  fx = await makeFixture();
});
afterAll(async () => {
  await fx.close();
});

describe("approvals (Gate 2)", () => {
  it("tool_call pending → approve → efecto ejecutado → run de reanudación con resume_of_run_id", async () => {
    const task = makeReadyTask(fx, fx.sam, { title: "Enviar propuesta por email" });

    // Fase 1: el agente intenta email.send → pending_approval → BLOCKED y cierra turno.
    fx.aiRunner.setBehavior(async (input, ctx) => {
      const result = (await callTool(input, "email.send", {
        to: "cliente@acme.com",
        subject: "Propuesta",
        body: "Adjunto la propuesta.",
      })) as { status: string; approval_id: string };
      expect(result.status).toBe("pending_approval");
      const current = getTask(fx.db, ctx.taskId!)!;
      await callTool(input, "tasks.move", {
        task_id: current.id,
        to: "BLOCKED",
        expected_version: current.version,
        blocked_reason: "approval",
      });
      return { text: "Necesito aprobación humana para enviar el email." };
    });

    const report = await fx.api.ctx.dispatcher.tick();
    expect(report.dispatched).toHaveLength(1);
    const firstRunId = report.dispatched[0]!;

    await waitFor(() => getRun(fx.db, firstRunId)!.status === "succeeded");
    expect(getTask(fx.db, task.id)!.status).toBe("BLOCKED");
    expect(getTask(fx.db, task.id)!.blockedReason).toBe("approval");

    const pending = listPendingApprovals(fx.db);
    expect(pending).toHaveLength(1);
    const approval = pending[0]!;
    expect(approval.kind).toBe("tool_call");
    expect(approval.runId).toBe(firstRunId);
    expect((approval.payload as { tool: string }).tool).toBe("email.send");

    // También visible por REST.
    const listRes = await fx.api.app.inject({
      method: "GET",
      url: "/api/approvals/pending",
      headers: fx.authHeaders,
    });
    expect(listRes.statusCode).toBe(200);
    expect((listRes.json() as { approvals: unknown[] }).approvals).toHaveLength(1);

    // Fase 2: al reanudarse, el agente cierra la tarea con evidencia.
    fx.aiRunner.setBehavior(async (input, ctx) => {
      const current = getTask(fx.db, ctx.taskId!)!;
      await callTool(input, "tasks.attach_artifact", {
        task_id: current.id,
        kind: "email",
        title: "Email enviado (simulado)",
        content: "Propuesta enviada a cliente@acme.com",
      });
      const after = getTask(fx.db, current.id)!;
      await callTool(input, "tasks.move", {
        task_id: current.id,
        to: "REVIEW",
        expected_version: after.version,
      });
      return { text: "Email enviado; tarea en revisión." };
    });

    const decideRes = await fx.api.app.inject({
      method: "POST",
      url: `/api/approvals/${approval.id}/decide`,
      headers: fx.authHeaders,
      payload: { decision: "approved", note: "adelante" },
    });
    expect(decideRes.statusCode).toBe(200);
    const decided = decideRes.json() as {
      approval: { status: string };
      executed: { status: string; result: { simulated: boolean } };
      resume_run_id: string;
    };
    expect(decided.approval.status).toBe("approved");
    // El stub email.send se ejecutó de verdad vía executeApproved (simulated:true).
    expect(decided.executed.status).toBe("ok");
    expect(decided.executed.result.simulated).toBe(true);
    expect(decided.resume_run_id).toBeTruthy();

    // Auditoría de la ejecución aprobada (el gateway escribe ANTES de actuar).
    const audit = queryAudit(fx.db, { entityType: "tool", entityId: "email.send" });
    expect(audit.some((a) => a.action === "tool.execute_approved")).toBe(true);

    // Run de reanudación ligado al original.
    const resumeRun = getRun(fx.db, decided.resume_run_id)!;
    expect(resumeRun.resumeOfRunId).toBe(firstRunId);
    expect(resumeRun.trigger).toBe("approval_resume");
    expect(resumeRun.rootRunId).toBe(getRun(fx.db, firstRunId)!.rootRunId);

    await waitFor(() => getRun(fx.db, decided.resume_run_id)!.status === "succeeded");
    await waitFor(() => getTask(fx.db, task.id)!.status === "REVIEW");
    expect(listPendingApprovals(fx.db)).toHaveLength(0);
    expect(listRuns(fx.db, { taskId: task.id })).toHaveLength(2);
  });

  it("decidir dos veces la misma aprobación falla explícitamente (conflict)", async () => {
    const decided = await fx.api.app.inject({
      method: "GET",
      url: "/api/runs",
      headers: fx.authHeaders,
    });
    expect(decided.statusCode).toBe(200);

    // La aprobación del test anterior ya está decidida.
    const approvals = queryAudit(fx.db, { action: "approval.approved" });
    expect(approvals.length).toBeGreaterThan(0);
    const approvalId = approvals[0]!.entityId!;
    const res = await fx.api.app.inject({
      method: "POST",
      url: `/api/approvals/${approvalId}/decide`,
      headers: fx.authHeaders,
      payload: { decision: "approved" },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe("conflict");
  });
});
