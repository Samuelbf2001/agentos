/**
 * M3 (§13.4): presupuesto de fase por proyecto en el despachador.
 * - budgetFromLimits combina agents.limits con budget:project:* → tope por run
 *   efectivo = min(max_usd del agente, per_run_usd del proyecto).
 * - Corte de fase: gasto acumulado (Σ runs.cost_usd del proyecto) ≥ phase_usd
 *   ⇒ el tick NO despacha tareas de ese proyecto; por debajo, sí.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { projectBudgetKey, type ProjectBudget } from "@agentos/shared";
import {
  createProject,
  createRun,
  getAgentBySlug,
  getTask,
  listRuns,
  setConfig,
  updateAgent,
  type Project,
} from "@agentos/db";
import { budgetFromLimits } from "../src/dispatcher.js";
import { makeFixture, makeReadyTask, waitFor, type TestFixture } from "./helpers.js";

let fx: TestFixture;

beforeAll(async () => {
  fx = await makeFixture();
});
afterAll(async () => {
  await fx.close();
});

const budget = (over: Partial<ProjectBudget> = {}): ProjectBudget => ({
  warningThresholdsPct: [70, 90, 100],
  launchId: null,
  ...over,
});

describe("budgetFromLimits + budget:project (unidad)", () => {
  it("min(max_usd del agente, per_run_usd del proyecto) — el más estricto manda", () => {
    expect(budgetFromLimits({ max_usd: 5 }, budget({ perRunUsd: 2 }))?.maxUsd).toBe(2);
    expect(budgetFromLimits({ max_usd: 1 }, budget({ perRunUsd: 2 }))?.maxUsd).toBe(1);
  });

  it("si solo existe uno de los dos topes, aplica ese", () => {
    expect(budgetFromLimits(null, budget({ perRunUsd: 2 }))?.maxUsd).toBe(2);
    expect(budgetFromLimits({ max_usd: 5 }, null)?.maxUsd).toBe(5);
    expect(budgetFromLimits({ max_usd: 5 }, budget())?.maxUsd).toBe(5); // budget sin per_run
  });

  it("sin límites ni presupuesto → undefined (comportamiento previo intacto)", () => {
    expect(budgetFromLimits(null, null)).toBeUndefined();
    expect(budgetFromLimits({ max_steps: 7 }, null)).toEqual({ maxSteps: 7 });
  });
});

describe("corte de presupuesto de fase en el tick", () => {
  it("gasto acumulado ≥ phase_usd → el proyecto NO recibe despachos (la tarea espera en READY)", async () => {
    setConfig(fx.db, projectBudgetKey(fx.project.id), {
      phase_usd: 5,
      per_run_usd: 2,
      warning_thresholds_pct: [70, 90, 100],
      launch_id: null,
    });
    // Gasto ya consumido por la fase: 6 USD ≥ 5.
    createRun(fx.db, {
      agentId: fx.sam.id,
      projectId: fx.project.id,
      trigger: "dispatcher",
      runtime: "ai_sdk",
      status: "succeeded",
      costUsd: 6,
    });
    const task = makeReadyTask(fx, fx.sam, { title: "No debe despachar" });

    const report = await fx.api.ctx.dispatcher.tick();
    expect(report.dispatched).toEqual([]);
    expect(fx.aiRunner.calls).toHaveLength(0); // ningún run arrancó
    expect(getTask(fx.db, task.id)!.status).toBe("READY"); // ni claim ni lease
  });

  it("por debajo del tope SÍ despacha, y el run lleva maxUsd = min(agente, per_run del proyecto)", async () => {
    const projectB: Project = createProject(fx.db, {
      orgId: fx.org.id,
      name: "Assessment Nova (presupuesto)",
      type: "assessment",
      stage: "ENTENDER",
      gateState: "pending",
    });
    setConfig(fx.db, projectBudgetKey(projectB.id), {
      phase_usd: 10,
      per_run_usd: 2,
      warning_thresholds_pct: [70, 90, 100],
      launch_id: null,
    });
    // Gasto previo por debajo del tope de fase.
    createRun(fx.db, {
      agentId: fx.sam.id,
      projectId: projectB.id,
      trigger: "dispatcher",
      runtime: "ai_sdk",
      status: "succeeded",
      costUsd: 3,
    });
    // Límite propio del agente MÁS laxo que el del proyecto: gana el proyecto.
    const sam = getAgentBySlug(fx.db, "sam")!;
    updateAgent(fx.db, sam.id, { limits: { max_usd: 5 } }, sam.version);

    const task = makeReadyTask(fx, fx.sam, { title: "Sí despacha", projectId: projectB.id });
    const report = await fx.api.ctx.dispatcher.tick();

    expect(report.dispatched).toHaveLength(1);
    const call = fx.aiRunner.calls.at(-1)!;
    expect(call.ctx.taskId).toBe(task.id);
    expect(call.input.budget?.maxUsd).toBe(2); // min(5 del agente, 2 del proyecto)

    await waitFor(
      () => listRuns(fx.db, { taskId: task.id }).some((r) => r.status === "succeeded"),
      { label: "run del proyecto B terminado" },
    );
  });
});
