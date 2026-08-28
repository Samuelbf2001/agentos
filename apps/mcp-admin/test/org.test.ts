/**
 * MCP admin — jerarquía de agentes (Fase 2): agentos.agents.set_manager fija el
 * organigrama (con anti-ciclo y expected_version) y agentos.agents.org expone el
 * árbol + la salud de cada cadena.
 */
import { describe, expect, it } from "vitest";
import { ErrorCodes } from "@agentos/shared";
import { getAgentBySlug } from "@agentos/db";
import { adminFixture } from "./helpers.js";

interface SetManagerResult {
  agent: { reportsTo: string | null; version: number };
  chain_health: { status: string };
}
interface OrgResult {
  tree: { agent: { slug: string } }[];
  health: { slug: string; reportsTo: string | null; chain: { status: string } }[];
}

describe("agentos.agents.set_manager", () => {
  it("fija el manager de un agente y reporta la salud de la cadena resultante", async () => {
    const f = adminFixture();
    const clara = getAgentBySlug(f.db, "clara")!;
    const sam = getAgentBySlug(f.db, "sam")!;
    const res = (await f.call("agentos.agents.set_manager", {
      agent: "clara",
      manager: "sam",
      expected_version: clara.version,
    })) as SetManagerResult;
    expect(res.agent.reportsTo).toBe(sam.id); // clara → sam → alex
    expect(res.chain_health.status).toBe("healthy");
    expect(getAgentBySlug(f.db, "clara")!.reportsTo).toBe(sam.id);
  });

  it("null hace al agente raíz", async () => {
    const f = adminFixture();
    const sam = getAgentBySlug(f.db, "sam")!;
    const res = (await f.call("agentos.agents.set_manager", {
      agent: "sam",
      manager: null,
      expected_version: sam.version,
    })) as SetManagerResult;
    expect(res.agent.reportsTo).toBeNull();
  });

  it("rechaza un ciclo con agent_not_assignable (reason=cycle) sin escribir", async () => {
    const f = adminFixture();
    // sam ya reporta a alex (seed). Poner a alex bajo sam cerraría el ciclo.
    const alex = getAgentBySlug(f.db, "alex")!;
    await expect(
      f.call("agentos.agents.set_manager", {
        agent: "alex",
        manager: "sam",
        expected_version: alex.version,
      }),
    ).rejects.toMatchObject({ code: ErrorCodes.AGENT_NOT_ASSIGNABLE });
    // Fail-closed: alex sigue siendo raíz.
    expect(getAgentBySlug(f.db, "alex")!.reportsTo).toBeNull();
  });

  it("exige expected_version (conflicto → version_conflict)", async () => {
    const f = adminFixture();
    await expect(
      f.call("agentos.agents.set_manager", {
        agent: "clara",
        manager: "sam",
        expected_version: 999,
      }),
    ).rejects.toMatchObject({ code: ErrorCodes.VERSION_CONFLICT });
  });

  it("perfil ro rechaza la mutación", async () => {
    const f = adminFixture();
    const clara = getAgentBySlug(f.db, "clara")!;
    await expect(
      f.callRo("agentos.agents.set_manager", {
        agent: "clara",
        manager: null,
        expected_version: clara.version,
      }),
    ).rejects.toThrow();
  });
});

describe("agentos.agents.org", () => {
  it("devuelve el bosque (Alex y Quinn raíces) con la salud de cada cadena", async () => {
    const f = adminFixture();
    const org = (await f.call("agentos.agents.org")) as OrgResult;
    const roots = org.tree.map((n) => n.agent.slug);
    expect(roots).toContain("alex");
    expect(roots).toContain("quinn");
    // Todas las cadenas nacen sanas del seed.
    expect(org.health.every((h) => h.chain.status === "healthy")).toBe(true);
    // Pausar a Alex rompe la cadena de sus reports por cálculo.
    const alex = getAgentBySlug(f.db, "alex")!;
    await f.call("agentos.agents.set_status", {
      agent: "alex",
      status: "paused",
      expected_version: alex.version,
    });
    const org2 = (await f.call("agentos.agents.org")) as OrgResult;
    expect(org2.health.find((h) => h.slug === "sam")!.chain.status).toBe("terminated_ancestor");
  });
});
