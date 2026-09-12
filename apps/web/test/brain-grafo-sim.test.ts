/**
 * `useGraphSim`: física del lienzo del grafo (Coulomb + resorte + centro +
 * damping), con `requestAnimationFrame` falso montado sobre timers falsos —
 * así el reloj de la simulación lo controla el test, no el navegador.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useGraphSim } from "../src/views/brain/grafo/useGraphSim";

/** rAF encadenado sobre setTimeout(16ms): avanza con los timers falsos. */
function installFakeRaf() {
  const raf = vi.fn((cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 16) as unknown as number);
  const caf = vi.fn((handle: number) => clearTimeout(handle as unknown as ReturnType<typeof setTimeout>));
  vi.stubGlobal("requestAnimationFrame", raf);
  vi.stubGlobal("cancelAnimationFrame", caf);
  return { raf, caf };
}

describe("useGraphSim", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("converge y se detiene sola (auto-stop por energía cinética)", () => {
    const { raf } = installFakeRaf();
    const { result } = renderHook(() => useGraphSim({ width: 400, height: 300 }));

    act(() => {
      result.current.setData(
        [{ id: "a" }, { id: "b" }],
        [{ source: "a", target: "b", weight: 1 }],
      );
      result.current.reheat();
    });
    expect(raf).toHaveBeenCalled();

    // Deja correr la física muchos frames simulados: debe apagarse sola.
    act(() => {
      vi.advanceTimersByTime(16 * 3000);
    });
    const callsOnceSettled = raf.mock.calls.length;

    // Sin nueva interacción, no debe programar más frames: sigue apagada.
    act(() => {
      vi.advanceTimersByTime(16 * 100);
    });
    expect(raf.mock.calls.length).toBe(callsOnceSettled);
  });

  it("reheat reactiva la simulación tras haberse detenido", () => {
    const { raf } = installFakeRaf();
    const { result } = renderHook(() => useGraphSim({ width: 400, height: 300 }));

    act(() => {
      result.current.setData([{ id: "a" }, { id: "b" }], [{ source: "a", target: "b" }]);
      result.current.reheat();
    });
    act(() => {
      vi.advanceTimersByTime(16 * 3000);
    });
    const callsOnceSettled = raf.mock.calls.length;

    // Arrastrar un nodo: fija su posición y reactiva el motor.
    act(() => {
      result.current.setFixed("a", 10, 20);
      result.current.reheat();
    });
    expect(raf.mock.calls.length).toBeGreaterThan(callsOnceSettled);

    // Fijo: no se mueve aunque la simulación siga corriendo.
    const pinned = result.current.getPosition("a");
    expect(pinned).toMatchObject({ x: 10, y: 20, fixed: true });

    act(() => {
      result.current.releaseFixed("a");
    });
    expect(result.current.getPosition("a")?.fixed).toBe(false);
  });

  it("setData conserva la posición de los nodos ya existentes (no 'salta')", () => {
    installFakeRaf();
    const { result } = renderHook(() => useGraphSim({ width: 400, height: 300 }));

    act(() => {
      result.current.setData([{ id: "a" }], []);
      result.current.setFixed("a", 55, 77);
    });
    const before = result.current.getPosition("a");
    expect(before).toMatchObject({ x: 55, y: 77 });

    act(() => {
      // Mismo nodo + uno nuevo: "a" no debe reubicarse.
      result.current.setData([{ id: "a" }, { id: "b" }], []);
    });
    const after = result.current.getPosition("a");
    expect(after).toMatchObject({ x: 55, y: 77 });
    expect(result.current.getPosition("b")).not.toBeNull();
  });

  it("getPosition devuelve null para un id desconocido", () => {
    installFakeRaf();
    const { result } = renderHook(() => useGraphSim({ width: 400, height: 300 }));
    expect(result.current.getPosition("no-existe")).toBeNull();
  });
});
