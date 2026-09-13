/**
 * 2brain › Grafo: ForceAtlas2 en un worker, con parada por tiempo Y por quietud.
 *
 * FA2 en worker no avisa de convergencia: si nadie lo para, se queda girando
 * para siempre y el portátil del usuario lo nota. Aquí se para por dos
 * caminos (spec §C.10): un temporizador (8 s al arrancar, 1,2 s por cada
 * recalentado tras una tanda) y un muestreo de 64 nodos cada 500 ms que corta
 * en cuanto el desplazamiento medio baja de 0,4 unidades de mundo.
 *
 * El worker se instancia desde un `blob:` (así lo hace la librería). Si alguna
 * CSP lo prohíbe —o el entorno no tiene `Worker`— se cae solo a la versión
 * SÍNCRONA en tandas de 100 iteraciones dentro de `requestIdleCallback`, con
 * la misma API. Ese es también el camino en jsdom, donde no hay worker.
 *
 * Nadie importa este módulo desde los tests: el import dinámico de FA2 solo
 * ocurre al llamar `createLayout`.
 */
import type { GraphologyGraph } from "../../../lib/brain/graphStore";

export interface GraphLayout {
  /** Arranca (o recalienta) el layout durante `ms` milisegundos. */
  start(ms?: number): void;
  stop(): void;
  kill(): void;
  isRunning(): boolean;
  /** `true` si el layout corre en el hilo principal (worker no disponible). */
  isSynchronous(): boolean;
}

export const INITIAL_RUN_MS = 8000;
export const REHEAT_MS = 1200;
const SAMPLE_EVERY_MS = 500;
const SAMPLE_NODES = 64;
const QUIET_DISPLACEMENT = 0.4;
const SYNC_ITERATIONS_PER_CHUNK = 100;

/**
 * Ajustes de ForceAtlas2 sobre los que infiere la librería (`inferSettings`).
 * Los de serie daban una bola: `strongGravityMode` con `gravity 0.05` aplasta
 * todo contra el centro y, sin `adjustSizes`, las hojas se meten DENTRO de su
 * hub. Aquí:
 *  - `barnesHutOptimize`: obligatorio con 1.500 nodos para acabar en segundos.
 *  - `adjustSizes`: anticolisión real — las hojas rodean al hub, no lo tapan.
 *  - `scalingRatio` alto + `gravity` floja y NO fuerte: los racimos se separan
 *    en vez de comprimirse contra el centro.
 *  - `linLogMode` apagado a propósito: su atracción logarítmica es tan floja a
 *    larga distancia que un nodo que nace lejos no vuelve nunca — los temas se
 *    quedaban de aro en el borde. La atracción lineal recoge desde cualquier
 *    sitio dentro del presupuesto de 8 s.
 *  - `outboundAttractionDistribution: false`: con «disuadir hubs» activo los
 *    hubs se van al perímetro; apagado, cada uno queda en su propio racimo.
 * `slowDown` se hereda de `inferSettings` (1 + ln(orden)) para no oscilar.
 */
export const LAYOUT_SETTINGS = {
  barnesHutOptimize: true,
  adjustSizes: true,
  linLogMode: false,
  strongGravityMode: false,
  gravity: 0.1,
  scalingRatio: 24,
  outboundAttractionDistribution: false,
} as const;

interface Supervisor {
  start(): void;
  stop(): void;
  kill(): void;
  isRunning(): boolean;
}

function sampleIds(graph: GraphologyGraph): string[] {
  const nodes = graph.nodes();
  if (nodes.length <= SAMPLE_NODES) return nodes;
  const step = Math.floor(nodes.length / SAMPLE_NODES);
  const picked: string[] = [];
  for (let i = 0; i < nodes.length && picked.length < SAMPLE_NODES; i += step) picked.push(nodes[i]!);
  return picked;
}

/**
 * Crea el layout. Devuelve el mando de inmediato (la carga de FA2 es
 * asíncrona): las llamadas a `start` antes de que llegue quedan pendientes y
 * se aplican en cuanto el motor está listo.
 */
export function createLayout(graph: GraphologyGraph): GraphLayout {
  let supervisor: Supervisor | null = null;
  let synchronous = false;
  let killed = false;
  let running = false;
  let pendingMs: number | null = null;
  let stopTimer: ReturnType<typeof setTimeout> | null = null;
  let sampleTimer: ReturnType<typeof setInterval> | null = null;
  let lastSample: Map<string, { x: number; y: number }> | null = null;

  const clearTimers = (): void => {
    if (stopTimer !== null) {
      clearTimeout(stopTimer);
      stopTimer = null;
    }
    if (sampleTimer !== null) {
      clearInterval(sampleTimer);
      sampleTimer = null;
    }
    lastSample = null;
  };

  const stop = (): void => {
    clearTimers();
    running = false;
    supervisor?.stop();
  };

  /** Muestreo de quietud: si nada se mueve, no hay nada que esperar. */
  const sampleDisplacement = (): void => {
    const ids = sampleIds(graph);
    const current = new Map<string, { x: number; y: number }>();
    for (const id of ids) {
      if (!graph.hasNode(id)) continue;
      current.set(id, { x: graph.getNodeAttribute(id, "x"), y: graph.getNodeAttribute(id, "y") });
    }
    if (lastSample) {
      let sum = 0;
      let n = 0;
      for (const [id, pos] of current) {
        const before = lastSample.get(id);
        if (!before) continue;
        sum += Math.hypot(pos.x - before.x, pos.y - before.y);
        n++;
      }
      if (n > 0 && sum / n < QUIET_DISPLACEMENT) {
        stop();
        return;
      }
    }
    lastSample = current;
  };

  const run = (ms: number): void => {
    if (killed || !supervisor) return;
    clearTimers();
    running = true;
    supervisor.start();
    stopTimer = setTimeout(stop, ms);
    sampleTimer = setInterval(sampleDisplacement, SAMPLE_EVERY_MS);
  };

  /** Camino B: FA2 síncrono en tandas cortas dentro de `requestIdleCallback`. */
  function makeSyncSupervisor(assign: (g: GraphologyGraph, params: unknown) => void, settings: Record<string, unknown>): Supervisor {
    let active = false;
    let handle: number | null = null;
    const schedule = (cb: () => void): number => {
      const idle = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number })
        .requestIdleCallback;
      return typeof idle === "function" ? idle(cb, { timeout: 200 }) : (setTimeout(cb, 16) as unknown as number);
    };
    const tick = (): void => {
      handle = null;
      if (!active || killed) return;
      assign(graph, { iterations: SYNC_ITERATIONS_PER_CHUNK, settings });
      handle = schedule(tick);
    };
    return {
      start() {
        if (active) return;
        active = true;
        handle = schedule(tick);
      },
      stop() {
        active = false;
        if (handle !== null) {
          const cancelIdle = (globalThis as { cancelIdleCallback?: (h: number) => void }).cancelIdleCallback;
          if (typeof cancelIdle === "function") cancelIdle(handle);
          else clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
          handle = null;
        }
      },
      kill() {
        this.stop();
      },
      isRunning: () => active,
    };
  }

  void (async () => {
    let inferSettings: ((g: GraphologyGraph) => Record<string, unknown>) | undefined;
    let assign: ((g: GraphologyGraph, params: unknown) => void) | undefined;
    let settings: Record<string, unknown> = { ...LAYOUT_SETTINGS };
    try {
      const fa2 = (await import("graphology-layout-forceatlas2")) as unknown as {
        default: {
          inferSettings(g: GraphologyGraph): Record<string, unknown>;
          assign(g: GraphologyGraph, params: unknown): void;
        };
      };
      inferSettings = fa2.default.inferSettings;
      assign = fa2.default.assign;
      settings = { ...inferSettings(graph), ...LAYOUT_SETTINGS };
      const mod = (await import("graphology-layout-forceatlas2/worker")) as unknown as {
        default: new (g: GraphologyGraph, params?: Record<string, unknown>) => Supervisor;
      };
      supervisor = new mod.default(graph, { settings });
    } catch {
      // CSP sin `worker-src blob:`, entorno sin Worker (jsdom) o FA2 no cargable.
      supervisor = assign ? makeSyncSupervisor(assign, settings) : null;
      synchronous = true;
    }
    if (killed) {
      supervisor?.kill();
      supervisor = null;
      return;
    }
    if (pendingMs !== null && supervisor) {
      const ms = pendingMs;
      pendingMs = null;
      run(ms);
    }
  })();

  return {
    start(ms = INITIAL_RUN_MS) {
      if (killed) return;
      if (!supervisor) {
        pendingMs = ms;
        return;
      }
      run(ms);
    },
    stop,
    kill() {
      killed = true;
      clearTimers();
      running = false;
      supervisor?.kill();
      supervisor = null;
    },
    isRunning: () => running,
    isSynchronous: () => synchronous,
  };
}
