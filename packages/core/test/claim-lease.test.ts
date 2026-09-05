import { describe, expect, it } from "vitest";
import { ErrorCodes, isAgentosError } from "@agentos/shared";
import { getTask, updateAgent } from "@agentos/db";
import { fixture, seedTask } from "./helpers.js";

describe("claim atómico con lease", () => {
  it("carrera de doble claim: el segundo recibe {claimed:false}", async () => {
    const f = await fixture();
    const t = await seedTask(f, { status: "READY", assignee: null });
    const first = await f.engine.claim({ taskId: t.id, agentId: f.sam.id });
    expect(first.claimed).toBe(true);
    expect(first.task!.status).toBe("IN_PROGRESS");
    expect(first.task!.leaseUntil).toBeGreaterThan(Date.now());
    const second = await f.engine.claim({ taskId: t.id, agentId: f.alex.id });
    expect(second.claimed).toBe(false);
  });

  it("una tarea asignada a otro agente no se roba", async () => {
    const f = await fixture();
    const t = await seedTask(f, { status: "READY", assignee: f.sam });
    const result = await f.engine.claim({ taskId: t.id, agentId: f.alex.id });
    expect(result.claimed).toBe(false);
    // El asignado sí la toma.
    expect((await f.engine.claim({ taskId: t.id, agentId: f.sam.id })).claimed).toBe(true);
  });

  it("kill switch activo bloquea el claim; apagarlo lo permite", async () => {
    const f = await fixture();
    const t = await seedTask(f, { status: "READY" });
    await f.engine.setKillSwitch(true, `person:${f.person.id}`, "freno de mano");
    try {
      await f.engine.claim({ taskId: t.id, agentId: f.sam.id });
      expect.unreachable("debió lanzar kill_switch_active");
    } catch (err) {
      expect(isAgentosError(err, ErrorCodes.KILL_SWITCH_ACTIVE)).toBe(true);
    }
    await f.engine.setKillSwitch(false, `person:${f.person.id}`);
    expect((await f.engine.claim({ taskId: t.id, agentId: f.sam.id })).claimed).toBe(true);
  });

  it("agente pausado no reclama (policy_denied) sin afectar a los demás", async () => {
    const f = await fixture();
    const t = await seedTask(f, { status: "READY", assignee: null });
    await updateAgent(f.db, f.sam.id, { status: "paused" }, f.sam.version);
    expect(await f.engine.isAgentPaused("sam")).toBe(true);
    try {
      await f.engine.claim({ taskId: t.id, agentId: f.sam.id });
      expect.unreachable("debió lanzar policy_denied");
    } catch (err) {
      expect(isAgentosError(err, ErrorCodes.POLICY_DENIED)).toBe(true);
    }
    expect((await f.engine.claim({ taskId: t.id, agentId: f.alex.id })).claimed).toBe(true);
  });

  it("renewLease renueva solo tareas IN_PROGRESS", async () => {
    const f = await fixture();
    const t = await seedTask(f, { status: "READY" });
    expect(await f.engine.renewLease(t.id)).toBe(false); // aún no reclamada
    await f.engine.claim({ taskId: t.id, agentId: f.sam.id, leaseMs: 5 });
    expect(await f.engine.renewLease(t.id, 120_000)).toBe(true);
    expect((await getTask(f.db, t.id))!.leaseUntil).toBeGreaterThan(Date.now() + 60_000);
  });

  it("reaper: lease vencido vuelve a READY; con attempts>=3 pasa a BLOCKED 'stuck'", async () => {
    const f = await fixture();
    const t = await seedTask(f, { status: "READY" });

    // Intentos 1 y 2: lease vencido → reaper la devuelve a READY.
    for (const attempt of [1, 2]) {
      const claimed = await f.engine.claim({ taskId: t.id, agentId: f.sam.id, leaseMs: -10 });
      expect(claimed.claimed).toBe(true);
      expect(claimed.task!.attempts).toBe(attempt);
      const result = await f.engine.reap();
      expect(result.requeued).toContain(t.id);
      expect((await getTask(f.db, t.id))!.status).toBe("READY");
    }

    // Intento 3: el reaper la bloquea como 'stuck' en vez de reencolarla.
    await f.engine.claim({ taskId: t.id, agentId: f.sam.id, leaseMs: -10 });
    const final = await f.engine.reap();
    expect(final.blocked).toContain(t.id);
    const stuck = (await getTask(f.db, t.id))!;
    expect(stuck.status).toBe("BLOCKED");
    expect(stuck.blockedReason).toBe("stuck");

    // El reaper no toca leases vivos.
    const other = await seedTask(f, { status: "READY", assignee: null });
    await f.engine.claim({ taskId: other.id, agentId: f.alex.id, leaseMs: 60_000 });
    const noop = await f.engine.reap();
    expect(noop.requeued).toHaveLength(0);
    expect(noop.blocked).toHaveLength(0);
  });

  it("humano desbloquea una tarea stuck: BLOCKED→READY resetea attempts", async () => {
    const f = await fixture();
    const t = await seedTask(f, { status: "READY" });
    for (let i = 0; i < 3; i++) {
      await f.engine.claim({ taskId: t.id, agentId: f.sam.id, leaseMs: -10 });
      await f.engine.reap();
    }
    const stuck = (await getTask(f.db, t.id))!;
    expect(stuck.status).toBe("BLOCKED");
    const moved = await f.engine.moveTask({
      taskId: t.id,
      to: "READY",
      expectedVersion: stuck.version,
      actor: `person:${f.person.id}`,
    });
    expect(moved.status).toBe("READY");
    expect(moved.attempts).toBe(0);
  });
});
