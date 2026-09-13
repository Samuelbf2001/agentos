/**
 * 2brain › Grafo (vista): un único `<canvas>` accesible (role="img"), leyenda
 * por tipo y el panel lateral que abre al seleccionar un nodo. Datos siempre
 * mock — la vista debe tolerar también una respuesta vacía o `{}` sin romper.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import GrafoView from "../src/views/brain/GrafoView";
import { mockFetch } from "./helpers";

const GRAPH_SAMPLE = {
  nodes: [
    {
      id: "contacto:1",
      type: "contacto",
      label: "Jefe de Producción ACME",
      refId: 1,
      meta: { phone: "+58 412 111 1111", leadStatus: "cliente" },
    },
    {
      id: "nota_voz:9",
      type: "nota_voz",
      label: "Idea rápida",
      refId: 9,
      meta: { category: "idea", createdBy: "equipo@sixteam.pro" },
    },
  ],
  edges: [{ source: "contacto:1", target: "nota_voz:9", type: "creada-por", weight: 0.6 }],
  stats: { nodeCount: 2, edgeCount: 1, byType: { contacto: 1, nota_voz: 1 }, truncated: false },
};

/**
 * Posición inicial (espiral) que calcula `useGraphSim.setData` para el nodo
 * en el índice `i` de `n`, antes de que corra ningún tick de física — misma
 * fórmula que `useGraphSim.ts`. Congelamos `requestAnimationFrame` para que
 * ningún tick se dispare y esta posición sea la que ve el hit-test del click.
 */
function initialSpiralPosition(index: number, total: number, width = 900, height = 600) {
  const angle = index * 2.399963229728653;
  const radius = Math.sqrt((index + 1) / Math.max(1, total)) * Math.min(width, height) * 0.38;
  return { x: width / 2 + Math.cos(angle) * radius, y: height / 2 + Math.sin(angle) * radius };
}

describe("2brain › Grafo (vista)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("pinta el lienzo (canvas accesible), la leyenda por tipo y abre el panel al seleccionar un nodo", async () => {
    // Sin física: el nodo queda exactamente en su posición inicial en espiral,
    // así el click en coordenadas conocidas siempre acierta.
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 0));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    mockFetch([{ path: /^\/api\/brain\/grafo/, body: GRAPH_SAMPLE }]);
    render(
      <MemoryRouter initialEntries={["/2brain/grafo"]}>
        <GrafoView />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("heading", { level: 1, name: "Grafo" })).toBeTruthy();

    // Leyenda por tipo, con conteo de `stats.byType` (uno por cada tipo presente).
    expect(await screen.findByText("Contacto")).toBeTruthy();
    expect(screen.getByText("Nota de voz")).toBeTruthy();
    expect(screen.getAllByText("(1)")).toHaveLength(2);

    // Un solo <canvas> accesible como imagen, con el nº de nodos en el aria-label.
    const canvas = await screen.findByRole("img");
    expect(canvas.tagName).toBe("CANVAS");
    expect(canvas.getAttribute("aria-label")).toMatch(/2 nodos/);

    // Sin selección: el panel enseña el estado vacío.
    expect(screen.getByText("Sin nodo seleccionado")).toBeTruthy();

    // Clic en las coordenadas del primer nodo ("contacto:1", índice 0 de 2).
    const { x, y } = initialSpiralPosition(0, GRAPH_SAMPLE.nodes.length);
    fireEvent.pointerDown(canvas, { clientX: x, clientY: y, pointerId: 1 });
    fireEvent.pointerUp(canvas, { clientX: x, clientY: y, pointerId: 1 });

    const panel = screen.getByTestId("grafo-panel-nodo");
    expect(within(panel).getByText("Jefe de Producción ACME")).toBeTruthy();
    expect(within(panel).getByText(/Teléfono: \+58 412 111 1111/)).toBeTruthy();
    expect(within(panel).getByText(/1 conexión en esta vista/)).toBeTruthy();
    const link = within(panel).getByRole("link", { name: /Ver en Conversaciones/ });
    expect(link.getAttribute("href")).toBe("/2brain/conversaciones?tel=%2B58%20412%20111%201111");

    // "Ver vecinos" recarga con `focus=<id>`; sin foco activo, "Vista general" no aparece.
    expect(within(panel).queryByRole("button", { name: "Vista general" })).toBeNull();
    fireEvent.click(within(panel).getByRole("button", { name: "Ver vecinos" }));
    expect(await screen.findByRole("button", { name: "Vista general" })).toBeTruthy();
  });

  it("estado vacío: EmptyState cuando el grafo no tiene nodos", async () => {
    mockFetch([
      {
        path: /^\/api\/brain\/grafo/,
        body: { nodes: [], edges: [], stats: { nodeCount: 0, edgeCount: 0, byType: {}, truncated: false } },
      },
    ]);
    render(
      <MemoryRouter initialEntries={["/2brain/grafo"]}>
        <GrafoView />
      </MemoryRouter>,
    );

    expect(await screen.findByText("Todavía no hay datos para graficar")).toBeTruthy();
  });

  it("tolera una respuesta vacía ({}) sin romper", async () => {
    mockFetch([{ path: /^\/api\/brain\/grafo/, body: {} }]);
    render(
      <MemoryRouter initialEntries={["/2brain/grafo"]}>
        <GrafoView />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("heading", { level: 1, name: "Grafo" })).toBeTruthy();
    expect(await screen.findByText("Todavía no hay datos para graficar")).toBeTruthy();
    expect(screen.getByText("0 nodos · 0 aristas")).toBeTruthy();
  });

  it("aborta el fetch en curso al desmontar (no deja la petición colgada)", async () => {
    let capturedSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        capturedSignal = init?.signal ?? undefined;
        return new Promise<Response>(() => {}); // nunca resuelve dentro del test
      }),
    );

    const { unmount } = render(
      <MemoryRouter initialEntries={["/2brain/grafo"]}>
        <GrafoView />
      </MemoryRouter>,
    );

    await vi.waitFor(() => expect(capturedSignal).toBeDefined());
    expect(capturedSignal?.aborted).toBe(false);

    unmount();

    expect(capturedSignal?.aborted).toBe(true);
  });
});
