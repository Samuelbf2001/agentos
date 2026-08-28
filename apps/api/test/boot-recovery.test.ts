/**
 * Recuperación al arrancar (NFR-4): un run 'running' preexistente pasa a
 * 'interrupted', su tarea con lease vuelve a READY y las aprobaciones
 * pendientes sobreviven intactas.
 */
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import {
  claimTask,
  createApproval,
  createRun,
  getApproval,
  getRun,
  getTask,
  updateRun,
} from "@agentos/db";
import { makeFixture, makeReadyTask } from "./helpers.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-api-recovery-"));
const dbPath = path.join(tmpDir, "recovery.db");

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("recuperación al arrancar (NFR-4)", () => {
  it("run 'running' → 'interrupted', tarea con lease → READY, approval pendiente intacta", async () => {
    // ── Sesión 1: estado "a medias" y apagado brusco ──────────────────────
    const fx1 = await makeFixture({ dbPath });
    const task = makeReadyTask(fx1, fx1.sam);
    const runId = createRun(fx1.db, {
      taskId: task.id,
      projectId: fx1.project.id,
      agentId: fx1.sam.id,
      trigger: "dispatcher",
      runtime: "ai_sdk",
      status: "queued",
    }).id;
    const claim = claimTask(fx1.db, { taskId: task.id, agentId: fx1.sam.slug, runId });
    expect(claim.claimed).toBe(true);
    updateRun(fx1.db, runId, { status: "running", startedAt: Date.now() });

    const approval = createApproval(fx1.db, {
      kind: "tool_call",
      payload: { tool: "email.send", args: { to: "x@y.z", subject: "s", body: "b" } },
      runId,
      taskId: task.id,
      projectId: fx1.project.id,
      requestedBy: "agent:sam",
    });
    expect(getTask(fx1.db, task.id)!.status).toBe("IN_PROGRESS");
    await fx1.close(); // "reinicio": el proceso muere con el run en vuelo

    // ── Sesión 2: boot con recuperación ───────────────────────────────────
    const fx2 = await makeFixture({ dbPath });
    try {
      expect(fx2.api.ctx.recovery.interruptedRuns).toContain(runId);
      expect(fx2.api.ctx.recovery.requeuedTasks).toContain(task.id);

      const run = getRun(fx2.db, runId)!;
      expect(run.status).toBe("interrupted");
      expect(run.finishedAt).not.toBeNull();

      const recovered = getTask(fx2.db, task.id)!;
      expect(recovered.status).toBe("READY");
      expect(recovered.leaseUntil).toBeNull();

      // La aprobación pendiente sobrevive al reinicio (CA-5.4).
      const survived = getApproval(fx2.db, approval.id)!;
      expect(survived.status).toBe("pending");
      expect(survived.actionDigest).toBe(approval.actionDigest);
    } finally {
      await fx2.close();
    }
  });
});
