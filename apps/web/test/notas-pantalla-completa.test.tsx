/**
 * Notas manuscritas: el lienzo llena el alto disponible y el modo «Pantalla
 * completa» deja SOLO el lienzo con una barra mínima (sin menú lateral, sin
 * cabecera de la app, sin panel derecho). Esc y «Salir» lo cierran; salir de
 * la vista con el modo puesto devuelve el shell a su sitio.
 *
 * Es layout, no la Fullscreen API: jsdom no mide, así que se comprueban las
 * clases y qué se pinta, no píxeles. Excalidraw se dobla como en `notas.test`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import App from "../src/App";
import NotasView from "../src/views/NotasView";
import { useStore } from "../src/state/store";
import { useShell } from "../src/state/shell";
import { agents, makeTask, mockFetch, person, project } from "./helpers";
import type { CanvasNote } from "../src/lib/types";

vi.mock("../src/views/notas/Lienzo", () => ({
  default: ({ onReady }: { onReady: (handle: unknown) => void }) => {
    onReady({
      getScene: () => ({ elements: [] }),
      estaVacio: () => true,
      exportarPng: async () => new Blob(),
      insertarTranscripcion: () => 0,
    });
    return <div data-testid="lienzo">lienzo</div>;
  },
}));

const nota: CanvasNote = {
  id: "n1",
  orgId: "org-1",
  projectId: "proj-1",
  title: "Reunión con dirección",
  scene: { elements: [] },
  status: "draft",
  imageArtifactId: null,
  imagePath: null,
  imageBytes: null,
  capturedAt: null,
  transcription: null,
  proposals: [],
  createdByPersonId: person.id,
  version: 3,
  createdAt: 1000,
  updatedAt: 2000,
};

const routes = [
  { method: "GET", path: "/api/notes", body: { notes: [nota] } },
  { path: "/api/waiting", body: { approvals: [], review_tasks: [] } },
  { path: "/api/runs", body: { runs: [] } },
  { path: "/api/projects", body: { projects: [project] } },
  { path: /^\/api\/projects\/[^/]+\/phase-status$/, body: { status: { launchId: null, complete: false, items: [], reason: "no_launch" } } },
  { path: /^\/api\/projects\/[^/]+\/launches$/, body: { launches: [] } },
  { path: /^\/api\/projects\/[^/]+\/people$/, body: { org_id: "org-1", people: [person] } },
  { path: /^\/api\/board\/[^/]+$/, body: { project, board_seq: 1, total: 1, columns: { READY: [makeTask()] }, cells: {} } },
  { path: "/api/labels", body: { labels: [] } },
  { path: "/api/tasks", body: { tasks: [] } },
  { path: "/api/auth/people", body: { people: [person] } },
  { path: "/api/knowledge", body: { docs: [] } },
];

const estadoBase = {
  person,
  token: "tok",
  bootstrapped: true,
  projects: [project],
  activeProjectId: project.id,
  agents,
  approvals: [],
  reviewTasks: [],
  failedRunsCount: 0,
  board: { projectId: project.id, tasks: {} },
  toasts: [],
  notes: [],
  notesLoading: false,
  notesError: null,
  activeNoteId: null,
  noteSaving: false,
  noteSavedAt: null,
  noteCapturing: false,
  noteTranscribing: false,
  noteTranscribeError: null,
  noteDudas: [],
};

function renderApp() {
  useStore.setState(estadoBase);
  return render(
    <MemoryRouter initialEntries={["/notas"]}>
      <App />
    </MemoryRouter>,
  );
}

function renderVista() {
  useStore.setState(estadoBase);
  return render(
    <MemoryRouter initialEntries={["/notas"]}>
      <NotasView />
    </MemoryRouter>,
  );
}

const NAV = { name: "Navegación principal" };

describe("Notas: lienzo a pantalla completa", () => {
  beforeEach(() => {
    mockFetch(routes);
    useShell.setState({ inmersivo: false });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("«Pantalla completa» deja solo el lienzo y la barra mínima; Esc lo devuelve todo", async () => {
    renderApp();
    expect(await screen.findByRole("heading", { name: "Reunión con dirección" })).toBeTruthy();
    expect(await screen.findByTestId("lienzo")).toBeTruthy();
    // Con el shell completo: menú, cabecera de la app (hamburguesa) y panel.
    expect(screen.getByRole("navigation", NAV)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Abrir menú" })).toBeTruthy();
    expect(screen.getByTestId("panel-lateral-notas")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Pantalla completa" }));

    expect(screen.queryByRole("navigation", NAV)).toBeNull();
    expect(screen.queryByRole("button", { name: "Abrir menú" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Ocultar menú" })).toBeNull();
    expect(screen.queryByTestId("panel-lateral-notas")).toBeNull();
    expect(screen.getByTestId("notas-vista").getAttribute("data-pantalla-completa")).toBe("true");
    // El lienzo sigue montado (no se pierde el trabajo) y la barra mínima trae lo imprescindible.
    expect(screen.getByTestId("lienzo")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Transcribir$/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Terminar nota$/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Salir de pantalla completa" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Nueva nota/ })).toBeNull();

    fireEvent.keyDown(window, { key: "Escape" });

    expect(screen.getByRole("navigation", NAV)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Abrir menú" })).toBeTruthy();
    expect(screen.getByTestId("panel-lateral-notas")).toBeTruthy();
    expect(screen.getByTestId("notas-vista").getAttribute("data-pantalla-completa")).toBeNull();
    expect(screen.getByTestId("lienzo")).toBeTruthy();
  });

  it("«Salir» también cierra el modo, y Esc dentro de un campo de texto no lo cierra", async () => {
    renderApp();
    await screen.findByTestId("lienzo");
    fireEvent.click(screen.getByRole("button", { name: "Pantalla completa" }));
    expect(screen.queryByRole("navigation", NAV)).toBeNull();

    // Esc con el foco en un campo (Excalidraw edita texto en un textarea) es
    // para terminar de escribir, no para salir del modo.
    const campo = document.createElement("textarea");
    document.body.appendChild(campo);
    fireEvent.keyDown(campo, { key: "Escape" });
    expect(screen.queryByRole("navigation", NAV)).toBeNull();
    campo.remove();

    fireEvent.click(screen.getByRole("button", { name: "Salir de pantalla completa" }));
    expect(screen.getByRole("navigation", NAV)).toBeTruthy();
    expect(screen.getByTestId("panel-lateral-notas")).toBeTruthy();
  });

  it("si el menú estaba colapsado, al salir de pantalla completa sigue colapsado (la preferencia manda)", async () => {
    renderApp();
    await screen.findByTestId("lienzo");
    fireEvent.click(screen.getByRole("button", { name: "Ocultar menú" }));
    expect(screen.queryByRole("navigation", NAV)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Pantalla completa" }));
    fireEvent.keyDown(window, { key: "Escape" });

    expect(screen.queryByRole("navigation", NAV)).toBeNull();
    expect(screen.getByRole("button", { name: "Mostrar menú" })).toBeTruthy();
  });

  it("salir de la vista con el modo puesto apaga el modo inmersivo del shell", async () => {
    const { unmount } = renderVista();
    await screen.findByTestId("lienzo");
    fireEvent.click(screen.getByRole("button", { name: "Pantalla completa" }));
    await waitFor(() => {
      expect(useShell.getState().inmersivo).toBe(true);
    });
    unmount();
    expect(useShell.getState().inmersivo).toBe(false);
  });
});

describe("Notas: el lienzo llena el alto disponible", () => {
  beforeEach(() => {
    mockFetch(routes);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("la vista ocupa el alto del shell y recorta: nunca scroll vertical de página", async () => {
    renderVista();
    const lienzo = await screen.findByTestId("lienzo");

    const vista = screen.getByTestId("notas-vista");
    for (const clase of ["flex", "flex-col", "h-full", "min-h-0", "overflow-hidden"]) {
      expect(vista.className.split(" ")).toContain(clase);
    }
    for (const prohibida of ["overflow-auto", "overflow-y-auto", "h-screen", "min-h-screen"]) {
      expect(vista.className.split(" ")).not.toContain(prohibida);
    }

    // La sección del lienzo hereda una altura definida y no empuja hacia abajo.
    const seccion = lienzo.closest("section");
    expect(seccion).toBeTruthy();
    for (const clase of ["min-h-0", "min-w-0", "flex-1", "overflow-hidden"]) {
      expect((seccion as HTMLElement).className.split(" ")).toContain(clase);
    }
    // Las cabeceras no se estiran a costa del lienzo.
    const cabecera = vista.querySelector("header");
    expect(cabecera?.className.split(" ")).toContain("shrink-0");
  });

  it("en escritorio el panel derecho no estrecha el lienzo por debajo del 60 %", async () => {
    renderVista();
    const lienzo = await screen.findByTestId("lienzo");
    const seccion = lienzo.closest("section") as HTMLElement;
    expect(seccion.className.split(" ")).toContain("lg:min-w-[60%]");
    const panel = screen.getByTestId("panel-lateral-notas");
    expect(panel.className.split(" ")).toContain("max-w-[40%]");
    expect(panel.className.split(" ")).toContain("w-80");
  });
});
