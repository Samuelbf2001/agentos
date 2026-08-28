/**
 * M3 (§13.4): config.set acepta budget:project:<id> con shape validado
 * fail-closed (editable por humano vía MCP) y system.health expone los
 * presupuestos de proyecto activos con su gasto acumulado.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { projectBudgetKey } from "@agentos/shared";
import { createRun, getAgentBySlug, getConfig, queryAudit } from "@agentos/db";
import { adminFixture, type AdminFixture } from "./helpers.js";

let f: AdminFixture;

beforeAll(() => {
  f = adminFixture();
});

describe("config.set — budget:project:* (§13.4)", () => {
  it("acepta un presupuesto válido, lo persiste y lo audita", async () => {
    const key = projectBudgetKey(f.project.id);
    const value = {
      phase_usd: 15,
      per_run_usd: 2,
      warning_thresholds_pct: [70, 90, 100],
      launch_id: null,
    };
    const result = await f.call("agentos.config.set", { key, value, reason: "tope de fase demo" });
    expect(result).toEqual({ key, value });
    expect(getConfig(f.db, key)).toEqual(value);

    const audits = queryAudit(f.db, { action: "config.set", entityId: key });
    expect(audits).toHaveLength(1);
    expect(audits[0]!.reason).toBe("tope de fase demo");
  });

  it("rechaza shapes inválidos con validation_error (fail-closed)", async () => {
    const key = projectBudgetKey(f.project.id);
    // Falta per_run_usd.
    await expect(
      f.call("agentos.config.set", { key, value: { phase_usd: 15 } }),
    ).rejects.toMatchObject({ code: "validation_error" });
    // phase_usd no positivo.
    await expect(
      f.call("agentos.config.set", { key, value: { phase_usd: 0, per_run_usd: 2 } }),
    ).rejects.toMatchObject({ code: "validation_error" });
    // Campo desconocido (shape estricto).
    await expect(
      f.call("agentos.config.set", {
        key,
        value: { phase_usd: 15, per_run_usd: 2, sorpresa: true },
      }),
    ).rejects.toMatchObject({ code: "validation_error" });
    // Umbral fuera de rango.
    await expect(
      f.call("agentos.config.set", {
        key,
        value: { phase_usd: 15, per_run_usd: 2, warning_thresholds_pct: [150] },
      }),
    ).rejects.toMatchObject({ code: "validation_error" });
    // Escalar donde va objeto.
    await expect(f.call("agentos.config.set", { key, value: 15 })).rejects.toMatchObject({
      code: "validation_error",
    });
  });

  it("las claves escalares clásicas NO aceptan objetos (sin regresión)", async () => {
    await expect(
      f.call("agentos.config.set", { key: "agents_enabled", value: { on: true } }),
    ).rejects.toMatchObject({ code: "validation_error" });
    // Y una clave fuera de allowlist y de patrón sigue rechazada.
    await expect(
      f.call("agentos.config.set", { key: "budget:project:", value: { phase_usd: 1, per_run_usd: 1 } }),
    ).rejects.toMatchObject({ code: "validation_error" });
  });

  it("system.health lista el presupuesto activo con gasto acumulado y umbrales", async () => {
    // Gasto real del proyecto: 12 de 15 USD (80% → umbral 70 alcanzado).
    const alex = getAgentBySlug(f.db, "alex")!;
    createRun(f.db, {
      agentId: alex.id,
      projectId: f.project.id,
      trigger: "dispatcher",
      runtime: "ai_sdk",
      status: "succeeded",
      costUsd: 12,
    });

    const health = (await f.callRo("agentos.system.health")) as {
      project_budgets: Record<string, unknown>[];
    };
    const entry = health.project_budgets.find((b) => b["project_id"] === f.project.id)!;
    expect(entry).toMatchObject({
      project_id: f.project.id,
      phase_usd: 15,
      per_run_usd: 2,
      launch_id: null,
      spent_usd: 12,
      pct_used: 80,
      warnings_reached: [70],
      exhausted: false,
    });
  });
});
