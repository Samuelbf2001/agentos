/**
 * 2brain › Notas de voz (vista): lista + detalle con deep link, auditoría y
 * "Reintentar Notion". El API mockeado responde con la MISMA forma que
 * expone `apps/api/src/routes/brain/notas-voz.ts` (whitelist ya aplicada).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import NotasVozView from "../src/views/brain/NotasVozView";
import { mockFetch } from "./helpers";

const NOTA_1 = {
  id: "1",
  title: "Llamar al proveedor",
  summary: "Confirmar entrega del lote 42.",
  category: "tarea",
  source: "pwa",
  duration_sec: 34,
  created_at: "2026-09-10T10:00:00.000Z",
  routed: {
    wikiNoteId: 7,
    notionTasks: [{ text: "Llamar al proveedor", ok: false, url: null, error: "Notion caído" }],
  },
};

const NOTA_2 = {
  id: "2",
  title: "Idea para el taller",
  summary: null,
  category: "idea",
  source: "pwa",
  duration_sec: 12,
  created_at: "2026-09-09T09:00:00.000Z",
  routed: {},
};

const DETALLE_1 = {
  ...NOTA_1,
  transcript: "Hay que llamar al proveedor por el lote 42.",
  action_items: [{ text: "Llamar al proveedor", due: null }],
  ideas: ["Pedir descuento por volumen"],
  images: [{ url: "/api/brain/notas-voz/media/foto-1.jpg", caption: "Etiqueta del lote", mimetype: "image/jpeg" }],
};

function baseRoutes() {
  return [
    { path: "/api/brain/notas-voz", body: { notes: [NOTA_1, NOTA_2] } },
    { path: "/api/brain/notas-voz/status", body: { transcription: true, vision: true, router_llm: true, notion: true } },
    { path: "/api/brain/notas-voz/1", body: { note: DETALLE_1 } },
    { path: "/api/brain/notas-voz/2", body: { note: { ...NOTA_2, transcript: null, action_items: [], ideas: [], images: [] } } },
    { path: /\/api\/brain\/notas-voz\/audit/, body: { page: 1, limit: 50, total: 0, totalPages: 1, notes: [] } },
  ];
}

function renderVista(ruta = "/2brain/notas-voz") {
  return render(
    <MemoryRouter initialEntries={[ruta]}>
      <NotasVozView />
    </MemoryRouter>,
  );
}

describe("2brain › Notas de voz (vista)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("pinta la lista y abre la primera nota por defecto", async () => {
    mockFetch(baseRoutes());
    renderVista();

    expect(await screen.findByRole("heading", { level: 1, name: "Notas de voz" })).toBeTruthy();
    expect(await screen.findByText("Llamar al proveedor")).toBeTruthy();
    expect(screen.getByText("Idea para el taller")).toBeTruthy();

    // La primera nota se abre sola: su transcripción aparece en el detalle.
    expect(await screen.findByText("Hay que llamar al proveedor por el lote 42.")).toBeTruthy();
    expect(screen.getByText("Pedir descuento por volumen")).toBeTruthy();
  });

  it("deep link `?nota=` abre esa nota directamente", async () => {
    mockFetch(baseRoutes());
    renderVista("/2brain/notas-voz?nota=2");

    expect(await screen.findByRole("heading", { level: 1, name: "Notas de voz" })).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByTestId("nota-fila-2").getAttribute("aria-current")).toBe("true");
    });
  });

  it("estado vacío cuando no hay notas", async () => {
    mockFetch([
      { path: "/api/brain/notas-voz", body: { notes: [] } },
      { path: "/api/brain/notas-voz/status", body: {} },
      { path: /\/api\/brain\/notas-voz\/audit/, body: {} },
    ]);
    renderVista();

    expect(await screen.findByText("No hay notas de voz")).toBeTruthy();
    expect(screen.getByText("Selecciona una nota")).toBeTruthy();
  });

  it("tolera una respuesta vacía `{}` sin romper (smoke de contrato)", async () => {
    mockFetch([{ path: /\/api\/brain\/notas-voz.*/, body: {} }]);
    renderVista();
    expect(await screen.findByRole("heading", { level: 1, name: "Notas de voz" })).toBeTruthy();
    expect(await screen.findByText("No hay notas de voz")).toBeTruthy();
  });

  it("«Reintentar Notion» llama la ruta y refresca el detalle", async () => {
    const { calls } = mockFetch([
      ...baseRoutes(),
      { path: "/api/brain/notas-voz/1/retry-notion", method: "POST", body: { ok: true, notionTasks: [{ text: "Llamar al proveedor", ok: true, url: "https://notion.so/x", error: null }] } },
    ]);
    renderVista("/2brain/notas-voz?nota=1");

    const boton = await screen.findByText("Reintentar Notion");
    boton.click();

    await waitFor(() => {
      expect(calls.some((c) => c.method === "POST" && c.url.includes("/api/brain/notas-voz/1/retry-notion"))).toBe(true);
    });
  });

  it("enlaza a la Grabadora", async () => {
    mockFetch(baseRoutes());
    renderVista();
    const enlace = await screen.findByRole("link", { name: /Grabar una nota/ });
    expect(enlace.getAttribute("href")).toBe("/2brain/grabadora");
  });
});
