/**
 * 2brain › Grafo (vista): carga progresiva sobre el proxy dinámico.
 *
 * El lienzo se mockea entero: sigma necesita WebGL y el layout de FA2 se
 * instancia desde un `blob:` — nada de eso existe en jsdom. Lo que se prueba
 * aquí es el cableado de la vista: esqueleto → pintado → indicador, filtros,
 * panel del nodo, "ver vecinos" que MEZCLA, búsqueda contra el servidor y el
 * desmontaje sin peticiones colgando.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const canvasHandle = {
  refresh: vi.fn(),
  setHighlight: vi.fn(),
  setTypeFilter: vi.fn(),
  setSearchHit: vi.fn(),
  setSelected: vi.fn(),
  fit: vi.fn(),
  destroy: vi.fn(),
};

/** Lienzo falso: expone el handle y un botón para simular el clic en un nodo. */
vi.mock("../src/views/brain/grafo/SigmaCanvas", () => ({
  SigmaCanvas: ({
    onSelect,
    onReady,
    ariaLabel,
  }: {
    onSelect: (id: string | null) => void;
    onReady?: (h: typeof canvasHandle) => void;
    ariaLabel: string;
  }) => {
    onReady?.(canvasHandle);
    return (
      <div role="img" aria-label={ariaLabel}>
        <button type="button" onClick={() => onSelect("contacto:1")}>
          simular clic en nodo
        </button>
      </div>
    );
  },
}));

import GrafoView, { progressLabel } from "../src/views/brain/GrafoView";
import { mockFetch } from "./helpers";

const TYPES = ["contacto", "empresa", "equipo", "reunion", "nota", "nota_voz", "pagina", "tema"];
const EDGE_TYPES = [
  "pertenece-a", "asignado-a", "reunion-contacto", "reunion-empresa", "nota-contacto",
  "nota-empresa", "participo-en", "tagged", "relacionada-con", "creada-por",
];

const SKELETON = {
  v: 1,
  index: "default:1757700000000:1547:4009",
  refs: ["contacto:1", "empresa:1"],
  nodes: { count: 2, type: [0, 1], label: ["Jefe de Producción ACME", "ACME"], ts: [1757000000000, null], deg: [3, 9] },
  stubs: { count: 0, type: [], label: [], ts: [] },
  edges: { count: 1, s: [0], t: [1], type: [0], w: [1] },
  meta: {
    types: TYPES,
    edgeTypes: EDGE_TYPES,
    counts: { contacto: 1, empresa: 1, reunion: 1 },
    loaded: { contacto: 1, empresa: 1 },
    range: { reunion: { min: 1700000000000, max: 1757000000000 } },
    totals: { nodes: 3, edges: 2 },
  },
};

const LAYER_DONE = {
  v: 1,
  index: "default:1757700000000:1547:4009",
  refs: ["reunion:88", "contacto:1"],
  nodes: { count: 1, type: [3], label: ["Kickoff ACME"], ts: [1756900000000], deg: [2] },
  stubs: { count: 1, type: [0], label: ["Jefe de Producción ACME"], ts: [1757000000000] },
  edges: { count: 1, s: [0], t: [1], type: [2], w: [1] },
  meta: { types: TYPES, edgeTypes: EDGE_TYPES },
  cursor: { next: null, remainingByType: {}, done: true },
};

const EMPTY_LAYER = { ...LAYER_DONE, refs: [], nodes: { count: 0, type: [], label: [], ts: [], deg: [] }, stubs: { count: 0, type: [], label: [], ts: [] }, edges: { count: 0, s: [], t: [], type: [], w: [] } };

function ui() {
  return render(
    <MemoryRouter initialEntries={["/2brain/grafo"]}>
      <GrafoView />
    </MemoryRouter>,
  );
}

describe("2brain › Grafo (vista)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const fn of Object.values(canvasHandle)) fn.mockClear();
  });

  it("pinta el esqueleto, encadena la tanda y termina con el conteo real", async () => {
    mockFetch([
      { path: "/api/brain/grafo/skeleton", body: SKELETON },
      { path: "/api/brain/grafo/layer", body: LAYER_DONE },
    ]);
    ui();

    expect(await screen.findByRole("heading", { level: 1, name: "Grafo" })).toBeTruthy();
    // Leyenda con el conteo real del grafo vivo (no el del servidor).
    expect(await screen.findByText("Contacto")).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId("grafo-conteo").textContent).toBe("3 nodos · 2 aristas"));
    await waitFor(() => expect(screen.getByTestId("grafo-progreso").textContent).toBe("3 de 3 nodos"));
    // El lienzo anuncia el tamaño para lectores de pantalla.
    expect(screen.getByRole("img").getAttribute("aria-label")).toMatch(/3 nodos y 2 aristas/);
  });

  it("clic en un nodo abre el panel; 'Ver vecinos' MEZCLA la ego-red", async () => {
    const { calls } = mockFetch([
      { path: "/api/brain/grafo/skeleton", body: SKELETON },
      { path: "/api/brain/grafo/layer", body: EMPTY_LAYER },
      { path: /^\/api\/brain\/grafo\/neighbors\//, body: LAYER_DONE },
    ]);
    ui();

    fireEvent.click(await screen.findByRole("button", { name: "simular clic en nodo" }));
    const panel = await screen.findByTestId("grafo-panel-nodo");
    expect(within(panel).getByText("Jefe de Producción ACME")).toBeTruthy();
    expect(within(panel).getByText(/1 conexión en esta vista/)).toBeTruthy();

    fireEvent.click(within(panel).getByRole("button", { name: "Ver vecinos" }));
    await waitFor(() =>
      expect(calls.some((c) => c.url.includes("/api/brain/grafo/neighbors/contacto%3A1"))).toBe(true),
    );
    // Mezcla: el nodo nuevo entra y los anteriores siguen ahí.
    await waitFor(() => expect(screen.getByTestId("grafo-conteo").textContent).toBe("3 nodos · 2 aristas"));
  });

  it("la búsqueda consulta al servidor y al elegir un resultado lo centra", async () => {
    const { calls } = mockFetch([
      { path: "/api/brain/grafo/skeleton", body: SKELETON },
      { path: "/api/brain/grafo/layer", body: EMPTY_LAYER },
      {
        path: "/api/brain/grafo/search",
        body: { v: 1, index: "default:1", results: [{ id: "reunion:88", type: "reunion", label: "Kickoff ACME", ts: 1 }] },
      },
      { path: /^\/api\/brain\/grafo\/neighbors\//, body: LAYER_DONE },
    ]);
    ui();

    fireEvent.change(await screen.findByLabelText("Buscar en todo el grafo"), { target: { value: "kickoff" } });
    fireEvent.click(screen.getByRole("button", { name: "Buscar" }));

    const hit = await screen.findByRole("button", { name: "Kickoff ACME" });
    expect(calls.some((c) => c.url.includes("/api/brain/grafo/search?q=kickoff"))).toBe(true);

    fireEvent.click(hit);
    // El nodo no estaba cargado: primero se trae su ego-red, luego se centra.
    await waitFor(() => expect(canvasHandle.fit).toHaveBeenCalledWith("reunion:88"));
    expect(canvasHandle.setSearchHit).toHaveBeenCalledWith("reunion:88");
  });

  it("los filtros por tipo bajan al lienzo como reducers, no como recarga", async () => {
    const { calls } = mockFetch([
      { path: "/api/brain/grafo/skeleton", body: SKELETON },
      { path: "/api/brain/grafo/layer", body: EMPTY_LAYER },
    ]);
    ui();

    const checkbox = await screen.findByLabelText("Mostrar Contacto");
    // Espera a que la tanda inicial haya pasado: así lo que se mide es el clic.
    await waitFor(() => expect(calls.some((c) => c.url.includes("/api/brain/grafo/layer"))).toBe(true));
    const before = calls.length;
    fireEvent.click(checkbox);

    await waitFor(() => expect(canvasHandle.setTypeFilter).toHaveBeenCalled());
    const visible = canvasHandle.setTypeFilter.mock.calls.at(-1)![0] as Set<string>;
    expect(visible.has("contacto")).toBe(false);
    expect(visible.has("empresa")).toBe(true);
    expect(calls).toHaveLength(before); // ni una petición más
  });

  it("'cargar más antiguos' pide otra tanda al servidor", async () => {
    const { calls } = mockFetch([
      { path: "/api/brain/grafo/skeleton", body: SKELETON },
      { path: "/api/brain/grafo/layer", body: { ...EMPTY_LAYER, cursor: { next: { ts: 1, id: "reunion:2" }, remainingByType: { reunion: 5 }, done: false } } },
    ]);
    ui();

    await waitFor(() => expect(calls.some((c) => c.url.includes("/api/brain/grafo/layer"))).toBe(true));
    const before = calls.filter((c) => c.url.includes("/layer")).length;
    fireEvent.click(screen.getByRole("button", { name: "Cargar más antiguos" }));
    await waitFor(() => expect(calls.filter((c) => c.url.includes("/layer")).length).toBeGreaterThan(before));
  });

  it("error del servidor: caja de error legible, sin lienzo roto", async () => {
    mockFetch([
      {
        path: "/api/brain/grafo/skeleton",
        status: 502,
        body: { error: { code: "provider_error", message: "WhatsAppHub no responde" } },
      },
    ]);
    ui();
    expect(await screen.findByText("WhatsAppHub no responde")).toBeTruthy();
  });

  it("aborta el fetch en curso al desmontar (no deja la petición colgada)", async () => {
    let capturedSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        capturedSignal ??= init?.signal ?? undefined;
        return new Promise<Response>(() => {});
      }),
    );

    const { unmount } = ui();
    await vi.waitFor(() => expect(capturedSignal).toBeDefined());
    expect(capturedSignal?.aborted).toBe(false);

    unmount();
    expect(capturedSignal?.aborted).toBe(true);
  });
});

describe("progressLabel", () => {
  const base = { loaded: 0, total: 0, budgetUsed: 0, budgetMax: 1500 };

  it("nombra el tipo y el avance de la tanda en curso", () => {
    expect(progressLabel({ ...base, phase: "layer", type: "reunion", loaded: 300, total: 390 })).toBe(
      "Cargando: reuniones recientes 300/390",
    );
  });

  it("al terminar dice cuántos nodos hay de cuántos", () => {
    expect(progressLabel({ ...base, phase: "done", loaded: 1278, total: 1278 })).toBe("1.278 de 1.278 nodos");
  });

  it("con el presupuesto agotado lo dice como lo que es", () => {
    expect(progressLabel({ ...base, phase: "idle", budgetUsed: 1500 })).toBe("Mostrando los 1.500 más recientes");
  });
});
