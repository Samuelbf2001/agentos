/**
 * `GraphCanvas`: un tick de física nunca debe disparar un render de React —
 * transform, hover y posiciones viven en refs; solo se repinta el `<canvas>`
 * de forma imperativa. También cubre que no queda ningún `requestAnimationFrame`
 * vivo tras desmontar (limpieza total del rAF coalescido + del runner de
 * `useGraphSim`).
 */
import { Profiler } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { GraphCanvas } from "../src/views/brain/grafo/GraphCanvas";
import type { GraphEdge, GraphNode } from "../src/lib/brain/grafo";

const nodes: GraphNode[] = [
  { id: "a", type: "tema", label: "A", meta: {} },
  { id: "b", type: "tema", label: "B", meta: {} },
  { id: "c", type: "tema", label: "C", meta: {} },
];
const edges: GraphEdge[] = [
  { source: "a", target: "b" },
  { source: "b", target: "c" },
];
const degreeById = new Map([
  ["a", 1],
  ["b", 2],
  ["c", 1],
]);

/** rAF encadenado sobre setTimeout(16ms): el reloj de la simulación lo controlan los timers falsos. */
function installFakeRaf() {
  const pending = new Map<number, FrameRequestCallback>();
  let nextId = 0;
  const raf = vi.fn((cb: FrameRequestCallback) => {
    const id = ++nextId;
    pending.set(id, cb);
    setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      cb(Date.now());
    }, 16);
    return id;
  });
  const caf = vi.fn((id: number) => pending.delete(id));
  vi.stubGlobal("requestAnimationFrame", raf);
  vi.stubGlobal("cancelAnimationFrame", caf);
  return { raf, caf, pending };
}

describe("GraphCanvas", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("un tick de la simulación no provoca un render de React (todo va por canvas imperativo)", () => {
    installFakeRaf();
    let renders = 0;
    render(
      <Profiler id="graph-canvas" onRender={() => renders++}>
        <GraphCanvas
          nodes={nodes}
          edges={edges}
          degreeById={degreeById}
          selectedId={null}
          searchMatches={new Set()}
          onSelect={() => {}}
        />
      </Profiler>,
    );
    const rendersAfterMount = renders;
    expect(rendersAfterMount).toBeGreaterThan(0);

    // Deja correr la física muchos frames simulados: no debe volver a renderizar.
    act(() => {
      vi.advanceTimersByTime(16 * 200);
    });

    expect(renders).toBe(rendersAfterMount);
  });

  it("no deja ningún requestAnimationFrame vivo tras desmontar", () => {
    const { pending, caf } = installFakeRaf();
    const { unmount } = render(
      <GraphCanvas nodes={nodes} edges={edges} degreeById={degreeById} selectedId={null} searchMatches={new Set()} onSelect={() => {}} />,
    );
    act(() => {
      vi.advanceTimersByTime(16 * 5);
    });
    expect(pending.size).toBeGreaterThan(0);

    unmount();

    expect(pending.size).toBe(0);
    expect(caf).toHaveBeenCalled();
  });
});
