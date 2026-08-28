/**
 * Jerarquía de agentes (Fase 2): salud de la cadena de mando y su efecto sobre
 * la asignabilidad. Un ancestro terminado/faltante o un ciclo hacen NO asignable
 * a un agente aunque él mismo esté activo.
 */
import { describe, expect, it } from "vitest";
import { ErrorCodes, isAgentosError } from "@agentos/shared";
import { getAgentBySlug, updateAgent, type Agent, type AgentosDb } from "@agentos/db";
import {
  assertNoCycle,
  computeOrgChainHealth,
  getChainOfCommand,
  orgForCompany,
  wouldCreateCycle,
} from "../src/index.js";
import { fixture, seedTask } from "./helpers.js";

/** Fija reports_to leyendo la versión fresca (evita conflictos entre pasos). */
function setManager(db: AgentosDb, agent: Agent, managerId: string | null): Agent {
  const fresh = getAgentBySlug(db, agent.slug)!;
  return updateAgent(db, fresh.id, { reportsTo: managerId }, fresh.version);
}

describe("salud de la cadena de mando", () => {
  it("getChainOfCommand sube del agente a la raíz", () => {
    const f = fixture();
    setManager(f.db, f.sam, f.alex.id); // sam → alex
    const chain = getChainOfCommand(f.db, f.sam.id).map((a) => a.slug);
    expect(chain).toEqual(["sam", "alex"]);
    // La raíz tiene una cadena de un solo elemento (ella misma).
    expect(getChainOfCommand(f.db, f.alex.id).map((a) => a.slug)).toEqual(["alex"]);
  });

  it("healthy cuando todos los ancestros están activos", () => {
    const f = fixture();
    setManager(f.db, f.sam, f.alex.id);
    expect(computeOrgChainHealth(f.db, f.sam.id).status).toBe("healthy");
    expect(computeOrgChainHealth(f.db, f.alex.id).status).toBe("healthy"); // raíz activa
  });

  it("terminated_ancestor cuando un manager queda pausado; se restaura al reactivarlo", () => {
    const f = fixture();
    setManager(f.db, f.sam, f.alex.id);
    // Pausar al manager NO toca la fila del report: la salud se calcula.
    const paused = updateAgent(f.db, f.alex.id, { status: "paused" }, f.alex.version);
    const health = computeOrgChainHealth(f.db, f.sam.id);
    expect(health.status).toBe("terminated_ancestor");
    expect(health.offendingAgentId).toBe(f.alex.id);
    // El report sigue "active" en su fila: la cascada es por cálculo, no persistida.
    expect(getAgentBySlug(f.db, "sam")!.status).toBe("active");
    // Reactivar al manager restaura la asignabilidad sin tocar al report.
    updateAgent(f.db, f.alex.id, { status: "active" }, paused.version);
    expect(computeOrgChainHealth(f.db, f.sam.id).status).toBe("healthy");
  });

  it("missing_manager cuando reports_to apunta a un agente inexistente", () => {
    const f = fixture();
    // La FK reports_to→agents.id impide esta corrupción por vía normal (bien);
    // la simulamos con foreign_keys OFF para ejercitar la defensa de la salud.
    f.db.$client.pragma("foreign_keys = OFF");
    setManager(f.db, f.sam, "agente-que-no-existe");
    f.db.$client.pragma("foreign_keys = ON");
    const health = computeOrgChainHealth(f.db, f.sam.id);
    expect(health.status).toBe("missing_manager");
    expect(health.offendingAgentId).toBe("agente-que-no-existe");
  });

  it("cycle cuando la cadena se cierra sobre sí misma", () => {
    const f = fixture();
    // Construimos un ciclo saltándonos assertNoCycle (estado corrupto simulado):
    setManager(f.db, f.sam, f.alex.id); // sam → alex
    setManager(f.db, f.alex, f.sam.id); // alex → sam  (ciclo)
    expect(computeOrgChainHealth(f.db, f.sam.id).status).toBe("cycle");
    expect(computeOrgChainHealth(f.db, f.alex.id).status).toBe("cycle");
  });

  it("wouldCreateCycle / assertNoCycle detectan el ciclo ANTES de escribir", () => {
    const f = fixture();
    setManager(f.db, f.sam, f.alex.id); // sam → alex
    // Poner a alex bajo sam cerraría el ciclo.
    expect(wouldCreateCycle(f.db, f.alex.id, f.sam.id)).toBe(true);
    // Reportarse a sí mismo también.
    expect(wouldCreateCycle(f.db, f.alex.id, f.alex.id)).toBe(true);
    // Hacerse raíz nunca crea ciclo.
    expect(wouldCreateCycle(f.db, f.sam.id, null)).toBe(false);
    expect(() => assertNoCycle(f.db, f.alex.id, f.sam.id)).toThrow();
    try {
      assertNoCycle(f.db, f.alex.id, f.sam.id);
    } catch (err) {
      expect(isAgentosError(err, ErrorCodes.AGENT_NOT_ASSIGNABLE)).toBe(true);
    }
  });

  it("orgForCompany devuelve el bosque agrupado por manager", () => {
    const f = fixture();
    setManager(f.db, f.sam, f.alex.id); // sam → alex
    const tree = orgForCompany(f.db);
    const roots = tree.map((n) => n.agent.slug).sort();
    expect(roots).toEqual(["alex"]); // única raíz (sam cuelga de alex)
    const alexNode = tree.find((n) => n.agent.slug === "alex")!;
    expect(alexNode.reports.map((n) => n.agent.slug)).toEqual(["sam"]);
  });
});

describe("asignabilidad gobernada por la cadena (motor)", () => {
  it("assertAgentCanRun lanza agent_not_assignable si un ancestro está terminado", () => {
    const f = fixture();
    setManager(f.db, f.sam, f.alex.id);
    // Cadena sana → puede correr.
    expect(() => f.engine.assertAgentCanRun("sam")).not.toThrow();
    expect(f.engine.isAgentAssignable("sam")).toBe(true);

    updateAgent(f.db, f.alex.id, { status: "paused" }, f.alex.version);
    expect(f.engine.isAgentAssignable("sam")).toBe(false);
    try {
      f.engine.assertAgentCanRun("sam");
      throw new Error("debió lanzar");
    } catch (err) {
      expect(isAgentosError(err, ErrorCodes.AGENT_NOT_ASSIGNABLE)).toBe(true);
      expect((err as { details?: { reason?: string } }).details?.reason).toBe("terminated_ancestor");
    }
  });

  it("engine.claim rechaza reclamar una tarea con cadena rota", () => {
    const f = fixture();
    setManager(f.db, f.sam, f.alex.id);
    const task = seedTask(f, { status: "READY", assignee: f.sam });
    updateAgent(f.db, f.alex.id, { status: "disabled" }, f.alex.version);
    expect(() => f.engine.claim({ taskId: task.id, agentId: f.sam.id })).toThrow();
    try {
      f.engine.claim({ taskId: task.id, agentId: f.sam.id });
    } catch (err) {
      expect(isAgentosError(err, ErrorCodes.AGENT_NOT_ASSIGNABLE)).toBe(true);
    }
  });
});
