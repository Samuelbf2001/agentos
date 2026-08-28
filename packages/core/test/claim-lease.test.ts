import { describe, expect, it } from "vitest";
import { ErrorCodes, isAgentosError } from "@agentos/shared";
import { getTask, updateAgent } from "@agentos/db";
import { fixture, seedTask } from "./helpers.js";

describe("claim atómico con lease", () => {
  it("carrera de doble claim: el segundo recibe {claimed:false}", () => {
    const f = fixture();
    const t = seedTask(f, { status: "READY", assignee: null });
    const first = f.engine.claim({ taskId: t.id, agentId: f.sam.id });
    expect(first.claimed).toBe(true);
    expect(first.task!.status).toBe("IN_PROGRESS");
    expect(first.task!.leaseUntil).toBeGreaterThan(Date.now());
    const second = f.engine.claim({ taskId: t.id, agentId: f.alex.id });
    expect(second.claimed).toBe(false);
  });

  it("una tarea asignada a otro agente no se roba", () => {
    const f = fixture();
    const t = seedTask(f, { status: "READY", assignee: f.sam });
    const result = f.engine.claim({ taskId: t.id, agentId: f.alex.id });
    expect(result.claimed).toBe(false);
    // El asignado sí la toma.
    expect(f.engine.claim({ taskId: t.id, agentId: f.sam.id }).claimed).toBe(true);
  });

  it("kill switch activo bloquea el claim; apagarlo lo permite", () => {
    const f = fixture();
    const t = seedTask(f, { status: "READY" });
    f.engine.setKillSwitch(true, `person:${f.person.id}`, "freno de mano");
    try {
      f.engine.claim({ taskId: t.id, agentId: f.sam.id });
      expect.unreachable("debió lanzar kill_switch_active");
    } catch (err) {
      expect(isAgentosError(err, ErrorCodes.KILL_SWITCH_ACTIVE)).toBe(true);
    }
    f.engine.setKillSwitch(false, `person:${f.person.id}`);
    expect(f.engine.claim({ taskId: t.id, agentId: f.sam.id }).claimed).toBe(true);
  });

  it("agente pausado no reclama (policy_denied) sin afectar a los demás", () => {
    const f = fixture();
    const t = seedTask(f, { status: "READY", assignee: null });
    updateAgent(f.db, f.sam.id, { status: "paused" }, f.sam.version);
    expect(f.engine.isAgentPaused("sam")).toBe(true);
    try {
      f.engine.claim({ taskId: t.id, agentId: f.sam.id });
      expect.unreachable("debió lanzar policy_denied");
    } catch (err) {
      expect(isAgentosError(err, ErrorCodes.POLICY_DENIED)).toBe(true);
    }
    expect(f.engine.claim({ taskId: t.id, agentId: f.alex.id }).claimed).toBe(true);
  });

  it("renewLease renueva solo tareas IN_PROGRESS", () => {
    const f = fixture();
    const t = seedTask(f, { status: "READY" });
    expect(f.engine.renewLease(t.id)).toBe(false); // aún no reclamada
    f.engine.claim({ taskId: t.id, agentId: f.sam.id, leaseMs: 5 });
    expect(f.engine.renewLease(t.id, 120_000)).toBe(true);
    expect(getTask(f.db, t.id)!.leaseUntil).toBeGreaterThan(Date.now() + 60_000);
  });

  it("reaper: lease vencido vuelve a READY; con attempts>=3 pasa a BLOCKED 'stuck'", () => {
    const f = fixture();
    const t = seedTask(f, { status: "READY" });

    // Intentos 1 y 2: lease vencido → reaper la devuelve a READY.
    for (const attempt of [1, 2]) {
      const claimed = f.engine.claim({ taskId: t.id, agentId: f.sam.id, leaseMs: -10 });
      expect(claimed.claimed).toBe(true);
      expect(claimed.task!.attempts).toBe(attempt);
      const result = f.engine.reap();
      expect(result.requeued).toContain(t.id);
      expect(getTask(f.db, t.id)!.status).toBe("READY");
    }

    // Intento 3: el reaper la bloquea como 'stuck' en vez de reencolarla.
    f.engine.claim({ taskId: t.id, agentId: f.sam.id, leaseMs: -10 });
    const final = f.engine.reap();
    expect(final.blocked).toContain(t.id);
    const stuck = getTask(f.db, t.id)!;
    expect(stuck.status).toBe("BLOCKED");
    expect(stuck.blockedReason).toBe("stuck");

    // El reaper no toca leases vivos.
    const other = seedTask(f, { status: "READY", assignee: null });
    f.engine.claim({ taskId: other.id, agentId: f.alex.id, leaseMs: 60_000 });
    const noop = f.engine.reap();
    expect(noop.requeued).toHaveLength(0);
    expect(noop.blocked).toHaveLength(0);
  });

  it("humano desbloquea una tarea stuck: BLOCKED→READY resetea attempts", () => {
    const f = fixture();
    const t = seedTask(f, { status: "READY" });
    for (let i = 0; i < 3; i++) {
      f.engine.claim({ taskId: t.id, agentId: f.sam.id, leaseMs: -10 });
      f.engine.reap();
    }
    const stuck = getTask(f.db, t.id)!;
    expect(stuck.status).toBe("BLOCKED");
    const moved = f.engine.moveTask({
      taskId: t.id,
      to: "READY",
      expectedVersion: stuck.version,
      actor: `person:${f.person.id}`,
    });
    expect(moved.status).toBe("READY");
    expect(moved.attempts).toBe(0);
  });
});
