/**
 * 2brain › Grafo (vista): nodos accesibles en el lienzo SVG, leyenda por tipo
 * y el panel lateral que abre al seleccionar un nodo. Datos siempre mock — la
 * vista debe tolerar también una respuesta vacía o `{}` sin romper.
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

describe("2brain › Grafo (vista)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("pinta los nodos del lienzo, la leyenda por tipo y abre el panel al seleccionar uno", async () => {
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

    // Nodos como `<g role="button">` accesibles (nombre = tipo + etiqueta).
    const contactoNode = await screen.findByRole("button", { name: /Jefe de Producción ACME/ });
    const notaVozNode = screen.getByRole("button", { name: /Idea rápida/ });
    expect(contactoNode).toBeTruthy();
    expect(notaVozNode).toBeTruthy();

    // Sin selección: el panel enseña el estado vacío.
    expect(screen.getByText("Sin nodo seleccionado")).toBeTruthy();

    fireEvent.click(contactoNode);

    const panel = screen.getByTestId("grafo-panel-nodo");
    expect(within(panel).getByText("Jefe de Producción ACME")).toBeTruthy();
    expect(within(panel).getByText(/Teléfono: \+58 412 111 1111/)).toBeTruthy();
    const link = within(panel).getByRole("link", { name: /Ver en Conversaciones/ });
    expect(link.getAttribute("href")).toBe("/2brain/conversaciones?tel=%2B58%20412%20111%201111");
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
});
