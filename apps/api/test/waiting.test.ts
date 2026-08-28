/**
 * Bandeja "Esperando por ti" (US-4 CA-4.2, fix H10): GET /api/waiting devuelve
 * TODO lo que espera decisión humana — aprobaciones pendientes Y entregables en
 * REVIEW con sus artefactos. Antes solo listaba aprobaciones: 3 tarjetas en
 * REVIEW mostraban una bandeja "(0)".
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { attachArtifact, getTask, type Approval, type Artifact, type Task } from "@agentos/db";
import { makeFixture, makeReadyTask, type TestFixture } from "./helpers.js";

let fx: TestFixture;

beforeAll(async () => {
  fx = await makeFixture();
});
afterAll(async () => {
  await fx.close();
});

interface WaitingBody {
  approvals: Approval[];
  review_tasks: { task: Task; artifacts: Artifact[] }[];
}

async function getWaiting(): Promise<WaitingBody> {
  const res = await fx.api.app.inject({ method: "GET", url: "/api/waiting", headers: fx.authHeaders });
  expect(res.statusCode).toBe(200);
  return res.json() as WaitingBody;
}

describe("bandeja Esperando por ti (H10)", () => {
  it("lista entregables en REVIEW con su artefacto, además de las aprobaciones pendientes", async () => {
    // Estado inicial: nada espera.
    const empty = await getWaiting();
    expect(empty.approvals).toHaveLength(0);
    expect(empty.review_tasks).toHaveLength(0);

    // Un entregable llega a REVIEW con artefacto (requires_approval como en la demo).
    const task = makeReadyTask(fx, fx.sam, {
      title: "Informe de assessment (borrador)",
      requiresApproval: true,
      activityType: "report",
    });
    const actor = `person:${fx.person.id}`;
    const inProgress = fx.api.ctx.engine.moveTask({
      taskId: task.id,
      to: "IN_PROGRESS",
      expectedVersion: task.version,
      actor,
    });
    attachArtifact(fx.db, {
      taskId: task.id,
      kind: "document",
      title: "Informe v1",
      content: "# Informe\nHallazgos con provenance [doc:x].",
      createdBy: "agent:sam",
    });
    fx.api.ctx.engine.moveTask({
      taskId: task.id,
      to: "REVIEW",
      expectedVersion: inProgress.version,
      actor,
    });

    // Y además una aprobación pendiente (pregunta de otro agente).
    const approval = fx.api.ctx.engine.requestApproval({
      kind: "deliverable",
      payload: { type: "question", title: "¿Reasigno?", body: "Falta insumo" },
      requestedBy: "agent:sam",
      taskId: null,
      projectId: fx.project.id,
    });

    const waiting = await getWaiting();
    expect(waiting.approvals.map((a) => a.id)).toContain(approval.id);
    expect(waiting.review_tasks).toHaveLength(1);
    expect(waiting.review_tasks[0]!.task.id).toBe(task.id);
    expect(waiting.review_tasks[0]!.task.requiresApproval).toBe(true);
    // El artefacto viaja con la tarjeta: la bandeja lo renderiza sin más viajes.
    expect(waiting.review_tasks[0]!.artifacts).toHaveLength(1);
    expect(waiting.review_tasks[0]!.artifacts[0]!.content).toContain("# Informe");

    // Entrar/salir de REVIEW avisa por el topic approvals (badge en vivo).
    const events = fx.api.ctx.bus.getSince("approvals", 0);
    expect(events.some((e) => e.type === "review.changed")).toBe(true);

    // Aprobar por REST (REVIEW→DONE solo humano) la saca de la bandeja.
    const current = getTask(fx.db, task.id)!;
    const approve = await fx.api.app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/approve`,
      headers: fx.authHeaders,
      payload: { expected_version: current.version },
    });
    expect(approve.statusCode).toBe(200);
    const after = await getWaiting();
    expect(after.review_tasks).toHaveLength(0);
  });
});
