import type { SimNodeState, SimInputEdge } from "./useGraphSim";

export const MAX_LAYOUT_TICKS = 150;
export const MAX_LAYOUT_MS = 5000;
export const REPULSION_SAMPLES = 24;

// Muestreo rotativo: acota la repulsión a N * 24 interacciones incluso en grafos muy agrupados.
export function stepLayout(nodes: Map<string, SimNodeState>, edges: SimInputEdge[], width: number, height: number, tick = 0) {
  const values = Array.from(nodes.values());
  const n = values.length;
  let interactions = 0;
  const samples = Math.min(REPULSION_SAMPLES, n - 1);
  for (let i = 0; i < n; i++) {
    const a = values[i]!;
    if (a.fixed) continue;
    for (let s = 0; s < samples; s++) {
      const offset = 1 + ((s + tick * REPULSION_SAMPLES) % (n - 1));
      const b = values[(i + offset) % n]!;
      let dx = a.x - b.x;
      let dy = a.y - b.y;
      if (dx * dx + dy * dy < 0.01) {
        dx = i % 2 ? 0.1 : -0.1;
        dy = 0.1;
      }
      const distSq = Math.max(25, dx * dx + dy * dy);
      const force = (2600 * ((n - 1) / samples)) / (distSq * Math.sqrt(distSq));
      a.vx += dx * force;
      a.vy += dy * force;
      interactions++;
    }
  }
  for (const edge of edges) {
    const a = nodes.get(edge.source);
    const b = nodes.get(edge.target);
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = Math.hypot(dx, dy) || 0.01;
    const weight = Number.isFinite(edge.weight) ? Math.max(0.05, Math.min(2, edge.weight!)) : 1;
    const force = ((dist - 90) * 0.02 * weight) / dist;
    if (!a.fixed) {
      a.vx += dx * force;
      a.vy += dy * force;
    }
    if (!b.fixed) {
      b.vx -= dx * force;
      b.vy -= dy * force;
    }
  }
  let kinetic = 0;
  const cooling = Math.max(0.08, 1 - tick / MAX_LAYOUT_TICKS);
  for (const node of values) {
    if (node.fixed) continue;
    node.vx = Math.max(-12, Math.min(12, (node.vx + (width / 2 - node.x) * 0.004) * 0.8));
    node.vy = Math.max(-12, Math.min(12, (node.vy + (height / 2 - node.y) * 0.004) * 0.8));
    node.x += node.vx * cooling;
    node.y += node.vy * cooling;
    kinetic += node.vx ** 2 + node.vy ** 2;
  }
  return { kinetic: kinetic / Math.max(1, n), interactions };
}

interface LayoutRunnerOptions {
  step: (tick: number) => number;
  draw: () => void;
  requestFrame: (cb: FrameRequestCallback) => number;
  cancelFrame: (id: number) => void;
  now: () => number;
  hidden?: () => boolean;
}

// Pausar/reanudar conserva el presupuesto restante; solo una interacción explícita lo recarga.
export function createLayoutRunner({ step, draw, requestFrame, cancelFrame, now, hidden = () => false }: LayoutRunnerOptions) {
  let frame: number | null = null;
  let ticks = 0;
  let elapsed = 0;
  let last = 0;
  let requested = false;
  const pause = () => {
    if (frame !== null) cancelFrame(frame);
    frame = null;
  };
  const exhausted = () => ticks >= MAX_LAYOUT_TICKS || elapsed >= MAX_LAYOUT_MS;
  const run = () => {
    frame = null;
    if (!requested || hidden() || exhausted()) return;
    const current = now();
    elapsed += Math.max(0, current - last);
    last = current;
    if (exhausted()) {
      requested = false;
      return;
    }
    const kinetic = step(ticks++);
    draw();
    if (kinetic < 0.02 || exhausted()) {
      requested = false;
      return;
    }
    frame = requestFrame(run);
  };
  const resume = () => {
    if (!requested || hidden() || exhausted() || frame !== null) return;
    last = now();
    frame = requestFrame(run);
  };
  return {
    /**
     * Recarga la simulación. Sin argumento usa el presupuesto completo (datos
     * nuevos); con `budgetTicks` corto (p. ej. tras soltar un nodo arrastrado)
     * solo concede unos pocos ticks para reacomodar sin reiniciar la animación
     * entera.
     */
    reheat(budgetTicks: number = MAX_LAYOUT_TICKS) {
      pause();
      ticks = Math.max(0, MAX_LAYOUT_TICKS - Math.max(0, Math.min(MAX_LAYOUT_TICKS, budgetTicks)));
      elapsed = 0;
      requested = true;
      resume();
    },
    stop() {
      requested = false;
      pause();
    },
    visibilityChanged() {
      if (hidden()) pause();
      else resume();
    },
  };
}
