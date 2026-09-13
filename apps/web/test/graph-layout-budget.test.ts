/**
 * Presupuesto y física del grafo: port a TS/vitest de
 * `WhatsAppHub/web/src/pages/grafo/graphPerformance.test.js`. Verifica que
 * `boundGraph` acota nodos/aristas incluso contra un backend viejo o
 * desbordado, que la repulsión en clústeres se queda O(n) sin coordenadas
 * infinitas, y que el runner de animación respeta su presupuesto de
 * ticks/tiempo incluso si la energía nunca converge.
 */
import { describe, expect, it } from "vitest";
import { boundGraph, HARD_MAX_NODES, HARD_MAX_EDGES, type GraphEdge, type GraphNode } from "../src/lib/brain/grafo";
import { createLayoutRunner, stepLayout, MAX_LAYOUT_TICKS, REPULSION_SAMPLES } from "../src/views/brain/grafo/graphLayout";
import type { SimNodeState } from "../src/views/brain/grafo/useGraphSim";

describe("boundGraph: topes ante respuestas sobredimensionadas", () => {
  it("acota nodos/aristas, conserva el foco y elimina aristas colgantes", () => {
    const nodes: GraphNode[] = Array.from({ length: 5000 }, (_, i): GraphNode => ({ id: String(i), type: "tema", label: String(i), meta: {} }));
    const edges: GraphEdge[] = Array.from({ length: 20000 }, (_, i): GraphEdge => ({ source: String(i % 120), target: String((i + 1) % 120) }));

    const result = boundGraph({ nodes, edges }, { focus: "4999" });
    expect(result.nodes).toHaveLength(120);
    expect(result.edges).toHaveLength(240);
    expect(result.nodes[0]?.id).toBe("4999");
    expect(result.stats.truncated).toBe(true);
    const ids = new Set(result.nodes.map((n) => n.id));
    expect(result.edges.every((e) => ids.has(e.source) && ids.has(e.target))).toBe(true);

    expect(boundGraph({ nodes, edges }, { maxNodes: 1e9, maxEdges: 1e9 }).nodes).toHaveLength(HARD_MAX_NODES);
    expect(boundGraph({ nodes, edges }, { maxNodes: 1e9, maxEdges: 1e9 }).edges).toHaveLength(HARD_MAX_EDGES);
  });
});

describe("stepLayout: repulsión en clústeres", () => {
  it("se mantiene lineal (≤ n * REPULSION_SAMPLES interacciones) y las coordenadas siguen finitas", () => {
    const nodes = new Map<string, SimNodeState>(
      Array.from({ length: 300 }, (_, i) => [String(i), { x: 100, y: 100, vx: 0, vy: 0, fixed: false }] as const),
    );
    const anchored = nodes.get("0");
    if (anchored) anchored.fixed = true;

    for (let tick = 0; tick < MAX_LAYOUT_TICKS; tick++) {
      const result = stepLayout(nodes, [{ source: "0", target: "1", weight: Infinity }], 800, 600, tick);
      expect(result.interactions).toBeLessThanOrEqual(nodes.size * REPULSION_SAMPLES);
      expect([...nodes.values()].every((n) => Number.isFinite(n.x) && Number.isFinite(n.y))).toBe(true);
    }
    expect(nodes.get("0")?.x).toBe(100);
  });
});

describe("createLayoutRunner: presupuesto de ticks/tiempo", () => {
  function clockHarness() {
    const frames = new Map<number, FrameRequestCallback>();
    let id = 0;
    let time = 0;
    let hidden = false;
    let steps = 0;
    const runner = createLayoutRunner({
      step: () => {
        steps++;
        return 1;
      },
      draw: () => {},
      requestFrame: (cb) => {
        frames.set(++id, cb);
        return id;
      },
      cancelFrame: (handle) => {
        frames.delete(handle);
      },
      now: () => time,
      hidden: () => hidden,
    });
    return {
      runner,
      frames,
      steps: () => steps,
      hide: (value: boolean) => {
        hidden = value;
        runner.visibilityChanged();
      },
      tick: (ms = 16) => {
        time += ms;
        const next = [...frames.entries()][0];
        if (next) {
          frames.delete(next[0]);
          next[1](time);
        }
      },
    };
  }

  it("se detiene al agotar el presupuesto de ticks aunque la energía nunca converja", () => {
    const clock = clockHarness();
    clock.runner.reheat();
    for (let i = 0; i < 1000; i++) clock.tick();
    expect(clock.steps()).toBe(MAX_LAYOUT_TICKS);
    expect(clock.frames.size).toBe(0);

    clock.hide(true);
    clock.hide(false);
    expect(clock.frames.size).toBe(0);

    clock.runner.reheat();
    expect(clock.frames.size).toBe(1);
    clock.runner.stop();
    expect(clock.frames.size).toBe(0);
  });

  it("la pausa por visibilidad conserva el presupuesto restante y el timeout por tiempo detiene frames lentos", () => {
    const clock = clockHarness();
    clock.runner.reheat();
    clock.tick();
    clock.hide(true);
    expect(clock.frames.size).toBe(0);
    clock.tick(10000);
    expect(clock.steps()).toBe(1);
    clock.hide(false);
    clock.tick();
    expect(clock.steps()).toBe(2);
    clock.tick(6000);
    expect(clock.frames.size).toBe(0);
  });

  it("reheat(budgetTicks) corto (arrastre) concede solo unos pocos ticks, no el presupuesto completo", () => {
    const clock = clockHarness();
    clock.runner.reheat(40);
    for (let i = 0; i < 1000; i++) clock.tick();
    expect(clock.steps()).toBe(40);
    expect(clock.frames.size).toBe(0);
  });
});
