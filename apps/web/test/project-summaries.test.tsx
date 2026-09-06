/**
 * useProjectSummaries (I2): antes pedía las tareas de cada proyecto por
 * separado (N llamadas con `project_id`); ahora es una sola lista global
 * agrupada en cliente.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useProjectSummaries } from "../src/state/useProjectSummaries";
import { makeTask, mockFetch, project, projectB } from "./helpers";

describe("useProjectSummaries", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("pide las tareas una sola vez, sin project_id, y las agrupa en cliente (I2)", async () => {
    const tasks = [
      makeTask({ id: "t-acme", projectId: project.id, status: "READY" }),
      makeTask({ id: "t-beta", projectId: projectB.id, status: "READY" }),
    ];
    const { calls } = mockFetch([
      { path: "/api/tasks", body: { tasks } },
      { path: /^\/api\/projects\/[^/]+\/phase-status$/, body: { status: { launchId: null, complete: false, items: [], reason: "no_launch" } } },
      { path: "/api/runs", body: { runs: [] } },
    ]);

    const { result } = renderHook(() => useProjectSummaries([project, projectB]));

    await waitFor(() => expect(result.current.loading).toBe(false));

    // Una sola llamada a /api/tasks para los dos proyectos, no una por proyecto.
    const taskCalls = calls.filter((c) => c.method === "GET" && c.url.includes("/api/tasks") && !c.url.includes("/api/tasks/"));
    expect(taskCalls.length).toBe(1);
    expect(taskCalls[0]?.url.includes("project_id")).toBe(false);

    const acme = result.current.summaries.find((s) => s.project.id === project.id);
    const beta = result.current.summaries.find((s) => s.project.id === projectB.id);
    expect(acme?.tasks?.map((t) => t.id)).toEqual(["t-acme"]);
    expect(beta?.tasks?.map((t) => t.id)).toEqual(["t-beta"]);
  });
});
