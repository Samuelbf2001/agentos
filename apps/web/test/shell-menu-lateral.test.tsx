/**
 * Menú lateral ocultable (escritorio): el botón de la cabecera y Ctrl+B lo
 * alternan, el contenido ocupa todo el ancho y la preferencia se recuerda en
 * localStorage. El cajón móvil no cambia: abre aunque el menú esté colapsado.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import App from "../src/App";
import { useStore } from "../src/state/store";
import {
  SIDEBAR_COLAPSADO_KEY,
  esAtajoMenuLateral,
  guardarSidebarColapsado,
  leerSidebarColapsado,
} from "../src/lib/shell";
import { agents, makeTask, mockFetch, person, project } from "./helpers";

const NAV = { name: "Navegación principal" };

const routes = [
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
  { path: "/api/brain/overview", body: { generated_at: null, core: { counts: {}, people: [] }, agents: { items: [], tree: null, health: [] }, sources: [], modules: [] } },
  { path: "/api/knowledge", body: { docs: [] } },
  { path: /^\/api\/projects\/[^/]+\/sources$/, body: { sources: [] } },
  { path: "/api/processes", body: { processes: [] } },
];

function renderApp(entry: string) {
  useStore.setState({
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
  });
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <App />
    </MemoryRouter>,
  );
}

describe("menú lateral ocultable", () => {
  beforeEach(() => {
    mockFetch(routes);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("el botón de la cabecera oculta el menú, lo recuerda y lo vuelve a mostrar", async () => {
    renderApp("/hoy");
    expect(await screen.findByRole("navigation", NAV)).toBeTruthy();

    const ocultar = screen.getByRole("button", { name: "Ocultar menú" });
    expect(ocultar.getAttribute("aria-expanded")).toBe("true");
    expect(ocultar.getAttribute("aria-controls")).toBe("menu-lateral");
    expect(document.getElementById("menu-lateral")).toBeTruthy();
    // Área de pulsación mínima y foco visible: se escribe con tableta.
    expect(ocultar.className).toContain("min-h-10");
    expect(ocultar.className).toContain("focus-visible:outline");

    fireEvent.click(ocultar);
    // Desaparece del todo (no queda un carril estrecho) y la preferencia se escribe.
    expect(screen.queryByRole("navigation", NAV)).toBeNull();
    expect(document.getElementById("menu-lateral")).toBeNull();
    expect(localStorage.getItem(SIDEBAR_COLAPSADO_KEY)).toBe("1");

    const mostrar = screen.getByRole("button", { name: "Mostrar menú" });
    expect(mostrar.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(mostrar);
    expect(screen.getByRole("navigation", NAV)).toBeTruthy();
    expect(localStorage.getItem(SIDEBAR_COLAPSADO_KEY)).toBe("0");
  });

  it("arranca como se dejó: con la preferencia guardada el menú no se pinta al montar", async () => {
    localStorage.setItem(SIDEBAR_COLAPSADO_KEY, "1");
    renderApp("/hoy");
    expect(await screen.findByRole("heading", { level: 1, name: /decisi/i })).toBeTruthy();
    expect(screen.queryByRole("navigation", NAV)).toBeNull();
    expect(screen.getByRole("button", { name: "Mostrar menú" })).toBeTruthy();
  });

  it("Ctrl+B alterna el menú desde cualquier pantalla; una «b» sola no hace nada", async () => {
    renderApp("/hoy");
    await screen.findByRole("navigation", NAV);

    fireEvent.keyDown(window, { key: "b" });
    expect(screen.getByRole("navigation", NAV)).toBeTruthy();

    fireEvent.keyDown(window, { key: "b", ctrlKey: true });
    expect(screen.queryByRole("navigation", NAV)).toBeNull();
    expect(localStorage.getItem(SIDEBAR_COLAPSADO_KEY)).toBe("1");

    fireEvent.keyDown(window, { key: "b", ctrlKey: true });
    expect(screen.getByRole("navigation", NAV)).toBeTruthy();
    expect(localStorage.getItem(SIDEBAR_COLAPSADO_KEY)).toBe("0");
  });

  it("el cajón móvil sigue abriendo aunque el menú de escritorio esté colapsado", async () => {
    localStorage.setItem(SIDEBAR_COLAPSADO_KEY, "1");
    renderApp("/hoy");
    await screen.findByRole("heading", { level: 1, name: /decisi/i });
    expect(screen.queryByRole("navigation", NAV)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Abrir menú" }));
    expect(await screen.findByRole("navigation", NAV)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Cerrar menú" }));
    await waitFor(() => {
      expect(screen.queryByRole("navigation", NAV)).toBeNull();
    });
  });
});

describe("preferencia del menú lateral (helpers puros)", () => {
  afterEach(() => {
    localStorage.clear();
  });

  it("sin valor o con basura se lee como visible; lo guardado se recupera", () => {
    expect(leerSidebarColapsado()).toBe(false);
    localStorage.setItem(SIDEBAR_COLAPSADO_KEY, "sí");
    expect(leerSidebarColapsado()).toBe(false);
    guardarSidebarColapsado(true);
    expect(localStorage.getItem(SIDEBAR_COLAPSADO_KEY)).toBe("1");
    expect(leerSidebarColapsado()).toBe(true);
    guardarSidebarColapsado(false);
    expect(leerSidebarColapsado()).toBe(false);
  });

  it("el atajo es Ctrl+B o Cmd+B, sin Alt ni Shift, y da igual la mayúscula", () => {
    const base = { ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };
    expect(esAtajoMenuLateral({ ...base, key: "b", ctrlKey: true })).toBe(true);
    expect(esAtajoMenuLateral({ ...base, key: "B", metaKey: true })).toBe(true);
    expect(esAtajoMenuLateral({ ...base, key: "b" })).toBe(false);
    expect(esAtajoMenuLateral({ ...base, key: "b", ctrlKey: true, shiftKey: true })).toBe(false);
    expect(esAtajoMenuLateral({ ...base, key: "b", ctrlKey: true, altKey: true })).toBe(false);
    expect(esAtajoMenuLateral({ ...base, key: "/", ctrlKey: true })).toBe(false);
  });
});
