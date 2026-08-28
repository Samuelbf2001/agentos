/**
 * Jerarquía de agentes (Fase 2) en apps/api: una cadena de mando rota (manager
 * pausado) bloquea el despacho/ejecución de las tareas de sus reports, y el
 * endpoint GET /api/agents/org expone el árbol + la salud de cada cadena.
 */
import { describe, expect, it } from "vitest";
import { getAgentBySlug, getTask, listRuns, updateAgent } from "@agentos/db";
import { makeFixture, makeReadyTask, waitFor } from "./helpers.js";

interface OrgNode {
  agent: { slug: string };
  reports: OrgNode[];
}
interface OrgResponse {
  tree: OrgNode[];
  health: { slug: string; chain: { status: string } }[];
}

describe("jerarquía de agentes (apps/api)", () => {
  it("manager pausado → la tarea del report NO se despacha; al reactivarlo sí", async () => {
    const fx = await makeFixture();
    try {
      // sam reporta a alex.
      updateAgent(fx.db, fx.sam.id, { reportsTo: fx.alex.id }, fx.sam.version);
      const task = makeReadyTask(fx, fx.sam, { title: "Tarea de Sam con cadena" });
      fx.aiRunner.setBehavior(() => ({ text: "no debería correr con la cadena rota" }));

      // Pausar al manager: la cascada es por cálculo (sam sigue active).
      const alex = getAgentBySlug(fx.db, "alex")!;
      updateAgent(fx.db, alex.id, { status: "paused" }, alex.version);

      const report = await fx.api.ctx.dispatcher.tick();
      expect(report.dispatched).toHaveLength(0);
      expect(getTask(fx.db, task.id)!.status).toBe("READY");
      expect(listRuns(fx.db, { taskId: task.id })).toHaveLength(0);
      expect(getAgentBySlug(fx.db, "sam")!.status).toBe("active"); // no cascada persistida

      // Reactivar al manager restaura la asignabilidad del report.
      const paused = getAgentBySlug(fx.db, "alex")!;
      updateAgent(fx.db, paused.id, { status: "active" }, paused.version);

      const report2 = await fx.api.ctx.dispatcher.tick();
      expect(report2.dispatched).toHaveLength(1);
      await waitFor(() => listRuns(fx.db, { taskId: task.id }).length === 1, { label: "run despachado" });
    } finally {
      await fx.close();
    }
  });

  it("GET /api/agents/org devuelve el árbol y la salud de cada cadena", async () => {
    const fx = await makeFixture();
    try {
      updateAgent(fx.db, fx.sam.id, { reportsTo: fx.alex.id }, fx.sam.version);

      const res = await fx.api.app.inject({
        method: "GET",
        url: "/api/agents/org",
        headers: fx.authHeaders,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OrgResponse;
      expect(body.tree.map((n) => n.agent.slug)).toContain("alex");
      const alexNode = body.tree.find((n) => n.agent.slug === "alex")!;
      expect(alexNode.reports.map((r) => r.agent.slug)).toContain("sam");
      expect(body.health.find((h) => h.slug === "sam")!.chain.status).toBe("healthy");

      // Pausar al manager → la cadena de sam pasa a terminated_ancestor.
      const alex = getAgentBySlug(fx.db, "alex")!;
      updateAgent(fx.db, alex.id, { status: "paused" }, alex.version);
      const res2 = await fx.api.app.inject({
        method: "GET",
        url: "/api/agents/org",
        headers: fx.authHeaders,
      });
      const body2 = res2.json() as OrgResponse;
      expect(body2.health.find((h) => h.slug === "sam")!.chain.status).toBe("terminated_ancestor");
    } finally {
      await fx.close();
    }
  });
});
