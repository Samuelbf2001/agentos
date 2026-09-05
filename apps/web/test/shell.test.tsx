/**
 * El shell (PLAN-v1.5 §2). El proyecto es el objeto raíz cuando se trabaja
 * dentro de un cliente, pero la puerta del trabajo diario es Hoy más Tareas:
 * cinco entradas globales, cinco pestañas dentro del proyecto, y ni un emoji de
 * navegación ni la ruta del navegador impresa en pantalla.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import App from "../src/App";
import { useStore } from "../src/state/store";
import { agents, makeTask, mockFetch, person, project } from "./helpers";

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

describe("shell y navegación", () => {
  beforeEach(() => {
    mockFetch(routes);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("tiene exactamente cinco entradas globales, sin emoji ni ruta impresa", async () => {
    const { container } = renderApp("/hoy");
    const nav = await screen.findByRole("navigation", { name: "Navegación principal" });
    const labels = within(nav)
      .getAllByRole("link")
      .map((a) => a.textContent?.trim());
    expect(labels).toEqual(["Hoy", "Tareas", "Proyectos", "Sistema", "Activo Sixteam"]);

    // Los destinos hermanos que se desmontaron ya no son entradas de menú.
    // "Mis tareas" tampoco: ahora es un filtro dentro de Tareas.
    for (const gone of [
      "Chat",
      "Cerebro",
      "Enjambre",
      "Esperando por ti",
      "Admin",
      "Reuniones",
      "Mis tareas",
    ]) {
      expect(within(nav).queryByText(gone)).toBeNull();
    }
    expect(container.textContent).not.toContain("/hoy");
  });

  it("la puerta después del login es Hoy, nunca un chat vacío", async () => {
    renderApp("/");
    expect(await screen.findByRole("heading", { level: 1, name: /decisi/i })).toBeTruthy();
  });

  it("dentro del proyecto muestra cliente, fase y las cinco pestañas", async () => {
    renderApp(`/proyectos/${project.id}/ruta`);
    expect(await screen.findByRole("heading", { name: project.name })).toBeTruthy();
    const tabs = await screen.findByRole("navigation", { name: "Secciones del proyecto" });
    expect(
      within(tabs)
        .getAllByRole("link")
        .map((a) => a.textContent?.trim()),
    ).toEqual(["Ruta", "Tablero", "Contexto", "Conversación", "Actividad"]);
    // El chip de fase vive en la barra, siempre visible.
    expect(screen.getByTitle("Fase Entender")).toBeTruthy();
    expect(screen.getByText("Gate pendiente")).toBeTruthy();
  });

  it("las rutas viejas redirigen a su nuevo sitio en vez de romperse", async () => {
    renderApp("/brain");
    expect(await screen.findByRole("heading", { name: "Sistema" })).toBeTruthy();
    expect(screen.getByText("Contadores y fuentes de datos.")).toBeTruthy();
  });

  it("el enjambre vive en Sistema y ya no es entrada de menú", async () => {
    renderApp("/swarm");
    expect(await screen.findByText("Quién está trabajando en este segundo y con qué herramienta.")).toBeTruthy();
  });

  it("la barra superior flota con desenfoque y el contenido pasa por debajo", async () => {
    const { container } = renderApp("/hoy");
    await screen.findByRole("navigation", { name: "Navegación principal" });
    expect(container.querySelector("header.chrome")).toBeTruthy();
    expect(container.querySelector(".scroll-edge")).toBeTruthy();
  });

  it("«/» abre el buscador de tareas desde cualquier pantalla y Esc lo cierra", async () => {
    renderApp("/hoy");
    await screen.findByRole("navigation", { name: "Navegación principal" });
    fireEvent.keyDown(window, { key: "/" });
    expect(await screen.findByTestId("task-search")).toBeTruthy();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByTestId("task-search")).toBeNull();
    });
  });
});
