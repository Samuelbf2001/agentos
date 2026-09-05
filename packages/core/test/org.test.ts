/**
 * Jerarquía de agentes (Fase 2): salud de la cadena de mando y su efecto sobre
 * la asignabilidad. Un ancestro terminado/faltante o un ciclo hacen NO asignable
 * a un agente aunque él mismo esté activo.
 */
import { describe, expect, it } from "vitest";
import { ErrorCodes, isAgentosError } from "@agentos/shared";
import { getAgentBySlug, updateAgent, type Agent, type AgentosSqliteDb } from "@agentos/db";
import {
  assertNoCycle,
  computeOrgChainHealth,
  getChainOfCommand,
  orgForCompany,
  wouldCreateCycle,
} from "../src/index.js";
import { fixture, seedTask } from "./helpers.js";

/** Fija reports_to leyendo la versión fresca (evita conflictos entre pasos). */
async function setManager(db: AgentosSqliteDb, agent: Agent, managerId: string | null): Promise<Agent> {
  const fresh = (await getAgentBySlug(db, agent.slug))!;
  return updateAgent(db, fresh.id, { reportsTo: managerId }, fresh.version);
}

describe("salud de la cadena de mando", () => {
  it("getChainOfCommand sube del agente a la raíz", async () => {
    const f = await fixture();
    await setManager(f.db, f.sam, f.alex.id); // sam → alex
    const chain = (await getChainOfCommand(f.db, f.sam.id)).map((a) => a.slug);
    expect(chain).toEqual(["sam", "alex"]);
    // La raíz tiene una cadena de un solo elemento (ella misma).
    expect((await getChainOfCommand(f.db, f.alex.id)).map((a) => a.slug)).toEqual(["alex"]);
  });

  it("healthy cuando todos los ancestros están activos", async () => {
    const f = await fixture();
    await setManager(f.db, f.sam, f.alex.id);
    expect((await computeOrgChainHealth(f.db, f.sam.id)).status).toBe("healthy");
    expect((await computeOrgChainHealth(f.db, f.alex.id)).status).toBe("healthy"); // raíz activa
  });

  it("terminated_ancestor cuando un manager queda pausado; se restaura al reactivarlo", async () => {
    const f = await fixture();
    await setManager(f.db, f.sam, f.alex.id);
    // Pausar al manager NO toca la fila del report: la salud se calcula.
    const paused = await updateAgent(f.db, f.alex.id, { status: "paused" }, f.alex.version);
    const health = await computeOrgChainHealth(f.db, f.sam.id);
    expect(health.status).toBe("terminated_ancestor");
    expect(health.offendingAgentId).toBe(f.alex.id);
    // El report sigue "active" en su fila: la cascada es por cálculo, no persistida.
    expect((await getAgentBySlug(f.db, "sam"))!.status).toBe("active");
    // Reactivar al manager restaura la asignabilidad sin tocar al report.
    await updateAgent(f.db, f.alex.id, { status: "active" }, paused.version);
    expect((await computeOrgChainHealth(f.db, f.sam.id)).status).toBe("healthy");
  });

  it("missing_manager cuando reports_to apunta a un agente inexistente", async () => {
    const f = await fixture();
    // La FK reports_to→agents.id impide esta corrupción por vía normal (bien);
    // la simulamos con foreign_keys OFF para ejercitar la defensa de la salud.
    f.db.$client.pragma("foreign_keys = OFF");
    await setManager(f.db, f.sam, "agente-que-no-existe");
    f.db.$client.pragma("foreign_keys = ON");
    const health = await computeOrgChainHealth(f.db, f.sam.id);
    expect(health.status).toBe("missing_manager");
    expect(health.offendingAgentId).toBe("agente-que-no-existe");
  });

  it("cycle cuando la cadena se cierra sobre sí misma", async () => {
    const f = await fixture();
    // Construimos un ciclo saltándonos assertNoCycle (estado corrupto simulado):
    await setManager(f.db, f.sam, f.alex.id); // sam → alex
    await setManager(f.db, f.alex, f.sam.id); // alex → sam  (ciclo)
    expect((await computeOrgChainHealth(f.db, f.sam.id)).status).toBe("cycle");
    expect((await computeOrgChainHealth(f.db, f.alex.id)).status).toBe("cycle");
  });

  it("wouldCreateCycle / assertNoCycle detectan el ciclo ANTES de escribir", async () => {
    const f = await fixture();
    await setManager(f.db, f.sam, f.alex.id); // sam → alex
    // Poner a alex bajo sam cerraría el ciclo.
    expect(await wouldCreateCycle(f.db, f.alex.id, f.sam.id)).toBe(true);
    // Reportarse a sí mismo también.
    expect(await wouldCreateCycle(f.db, f.alex.id, f.alex.id)).toBe(true);
    // Hacerse raíz nunca crea ciclo.
    expect(await wouldCreateCycle(f.db, f.sam.id, null)).toBe(false);
    await expect(assertNoCycle(f.db, f.alex.id, f.sam.id)).rejects.toThrow();
    try {
      await assertNoCycle(f.db, f.alex.id, f.sam.id);
    } catch (err) {
      expect(isAgentosError(err, ErrorCodes.AGENT_NOT_ASSIGNABLE)).toBe(true);
    }
  });

  it("orgForCompany devuelve el bosque agrupado por manager", async () => {
    const f = await fixture();
    await setManager(f.db, f.sam, f.alex.id); // sam → alex
    const tree = await orgForCompany(f.db);
    const roots = tree.map((n) => n.agent.slug).sort();
    expect(roots).toEqual(["alex"]); // única raíz (sam cuelga de alex)
    const alexNode = tree.find((n) => n.agent.slug === "alex")!;
    expect(alexNode.reports.map((n) => n.agent.slug)).toEqual(["sam"]);
  });
});

describe("asignabilidad gobernada por la cadena (motor)", () => {
  it("assertAgentCanRun lanza agent_not_assignable si un ancestro está terminado", async () => {
    const f = await fixture();
    await setManager(f.db, f.sam, f.alex.id);
    // Cadena sana → puede correr.
    await expect(f.engine.assertAgentCanRun("sam")).resolves.not.toThrow();
    expect(await f.engine.isAgentAssignable("sam")).toBe(true);

    await updateAgent(f.db, f.alex.id, { status: "paused" }, f.alex.version);
    expect(await f.engine.isAgentAssignable("sam")).toBe(false);
    try {
      await f.engine.assertAgentCanRun("sam");
      throw new Error("debió lanzar");
    } catch (err) {
      expect(isAgentosError(err, ErrorCodes.AGENT_NOT_ASSIGNABLE)).toBe(true);
      expect((err as { details?: { reason?: string } }).details?.reason).toBe("terminated_ancestor");
    }
  });

  it("engine.claim rechaza reclamar una tarea con cadena rota", async () => {
    const f = await fixture();
    await setManager(f.db, f.sam, f.alex.id);
    const task = await seedTask(f, { status: "READY", assignee: f.sam });
    await updateAgent(f.db, f.alex.id, { status: "disabled" }, f.alex.version);
    await expect(f.engine.claim({ taskId: task.id, agentId: f.sam.id })).rejects.toThrow();
    try {
      await f.engine.claim({ taskId: task.id, agentId: f.sam.id });
    } catch (err) {
      expect(isAgentosError(err, ErrorCodes.AGENT_NOT_ASSIGNABLE)).toBe(true);
    }
  });
});
