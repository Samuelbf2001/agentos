/**
 * Kanban: move optimista revertido si la API rechaza (409) con toast del
 * error de dominio; si acepta, el estado del servidor manda.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../src/state/store";
import { makeTask, mockFetch, project } from "./helpers";

function seedBoard() {
  useStore.setState({
    board: { projectId: project.id, tasks: { t1: makeTask({ status: "READY", version: 3 }) } },
    toasts: [],
  });
}

describe("moveTaskOptimistic", () => {
  beforeEach(() => {
    seedBoard();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("pinta el destino al instante y consolida con la tarea del servidor", async () => {
    const { calls } = mockFetch([
      {
        method: "POST",
        path: "/api/tasks/t1/move",
        body: { task: makeTask({ status: "IN_PROGRESS", version: 4 }) },
      },
    ]);
    const ok = await useStore.getState().moveTaskOptimistic("t1", "IN_PROGRESS");
    expect(ok).toBe(true);
    const task = useStore.getState().board.tasks["t1"]!;
    expect(task.status).toBe("IN_PROGRESS");
    expect(task.version).toBe(4);
    const move = calls.find((c) => c.url.includes("/api/tasks/t1/move"));
    expect(move?.body).toEqual({ to: "IN_PROGRESS", expected_version: 3 });
  });

  it("revierte con toast si la API rechaza la transición (409 version_conflict)", async () => {
    mockFetch([
      {
        method: "POST",
        path: "/api/tasks/t1/move",
        status: 409,
        body: {
          error: { code: "version_conflict", message: "La tarea cambió: relee antes de mover" },
        },
      },
      // El conflicto de versión refetchea el snapshot del tablero.
      {
        method: "GET",
        path: `/api/board/${project.id}`,
        body: {
          project,
          board_seq: 9,
          total: 1,
          columns: { READY: [makeTask({ status: "READY", version: 5 })] },
          cells: {},
        },
      },
    ]);
    const ok = await useStore.getState().moveTaskOptimistic("t1", "DONE");
    expect(ok).toBe(false);
    // Revertida al estado previo (luego el refetch puede traer la verdad).
    const toasts = useStore.getState().toasts;
    expect(toasts.some((t) => t.kind === "error" && t.text.includes("version_conflict"))).toBe(true);
    // Espera al refetch para no dejar promesas colgando.
    await vi.waitFor(() => {
      expect(useStore.getState().board.tasks["t1"]!.version).toBe(5);
    });
  });

  it("revierte y cuenta el error de dominio en transiciones ilegales (422)", async () => {
    mockFetch([
      {
        method: "POST",
        path: "/api/tasks/t1/move",
        status: 422,
        body: {
          error: { code: "invalid_transition", message: "READY → DONE no es una transición válida" },
        },
      },
    ]);
    const ok = await useStore.getState().moveTaskOptimistic("t1", "DONE");
    expect(ok).toBe(false);
    expect(useStore.getState().board.tasks["t1"]!.status).toBe("READY");
    expect(
      useStore.getState().toasts.some((t) => t.text.includes("invalid_transition")),
    ).toBe(true);
  });
});
