/**
 * El shell (menú lateral + cambio de perspectiva). El proyecto es el objeto
 * raíz cuando se trabaja dentro de un cliente, pero la puerta del trabajo
 * diario es Hoy más Tareas: el lateral pinta agencia o cliente según la URL,
 * y ni un emoji de navegación ni la ruta del navegador impresa en pantalla.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import App from "../src/App";
import { useStore } from "../src/state/store";
import { agents, makeTask, mockFetch, person, project } from "./helpers";

const locationProbe: { pathname: string; search: string } = { pathname: "", search: "" };

function LocationProbe() {
  const location = useLocation();
  locationProbe.pathname = location.pathname;
  locationProbe.search = location.search;
  return null;
}

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
      <LocationProbe />
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

  it("el menú lateral pinta las entradas de agencia, sin emoji ni ruta impresa", async () => {
    const { container } = renderApp("/hoy");
    const nav = await screen.findByRole("navigation", { name: "Navegación principal" });
    for (const label of [
      "Hoy",
      "Tareas",
      "Clientes",
      "Reuniones",
      "Método",
      "Equipo",
      "Ahora mismo",
      "Actividad",
      "Fuentes",
      "Configuración",
    ]) {
      expect(within(nav).getByRole("link", { name: label })).toBeTruthy();
    }

    // Los destinos hermanos que se desmontaron ya no son entradas de menú.
    // "Mis tareas" tampoco: ahora es un filtro dentro de Tareas.
    for (const gone of ["Chat", "Cerebro", "Enjambre", "Esperando por ti", "Admin", "Mis tareas"]) {
      expect(within(nav).queryByText(gone)).toBeNull();
    }
    expect(container.textContent).not.toContain("/hoy");
  });

  it("la puerta después del login es Hoy, nunca un chat vacío", async () => {
    renderApp("/");
    expect(await screen.findByRole("heading", { level: 1, name: /decisi/i })).toBeTruthy();
  });

  it("dentro del proyecto muestra cliente, fase y el menú de cliente en el lateral", async () => {
    renderApp(`/proyectos/${project.id}/ruta`);
    expect(await screen.findByRole("heading", { name: project.name })).toBeTruthy();
    const nav = await screen.findByRole("navigation", { name: "Navegación principal" });
    for (const label of ["Resumen", "Tablero", "Contexto", "Conversación", "Actividad", "Decisiones"]) {
      expect(within(nav).getByRole("link", { name: label })).toBeTruthy();
    }
    // El chip de fase vive en la cabecera de la página y en la miga de pan.
    expect(screen.getAllByTitle("Fase Entender").length).toBeGreaterThan(0);
    expect(screen.getByText("Gate pendiente")).toBeTruthy();
  });

  it("las rutas viejas redirigen a su nuevo sitio en vez de romperse", async () => {
    renderApp("/brain");
    expect(await screen.findByRole("heading", { name: "Fuentes" })).toBeTruthy();
    expect(screen.getByText("Estado de las fuentes externas y de la cola de reuniones.")).toBeTruthy();
  });

  it("el enjambre vive en Sistema y ya no es entrada de menú", async () => {
    renderApp("/swarm");
    expect(await screen.findByText("Quién está trabajando en este segundo y con qué herramienta.")).toBeTruthy();
  });

  it("el shell pinta el menú lateral y la barra superior con la miga de pan", async () => {
    const { container } = renderApp("/hoy");
    await screen.findByRole("navigation", { name: "Navegación principal" });
    expect(container.querySelector("aside")).toBeTruthy();
    expect(container.querySelector("header")).toBeTruthy();
    expect(screen.getAllByText("Sixteam").length).toBeGreaterThan(0);
  });

  it("la sub-pestaña de Contexto vive en la URL y el lateral la refleja", async () => {
    renderApp(`/proyectos/${project.id}/contexto/procesos`);
    const nav = await screen.findByRole("navigation", { name: "Navegación principal" });
    const contextoLink = within(nav).getByRole("link", { name: "Contexto" });
    expect(contextoLink.className).toContain("bg-link");
    // El hijo del lateral sólo se pinta con el padre activo.
    expect(within(nav).getByRole("link", { name: "Procesos" })).toBeTruthy();
    expect(await screen.findByText("Sin procesos mapeados")).toBeTruthy();
  });

  it("una sub-pestaña de Contexto inválida redirige a documentos", async () => {
    renderApp(`/proyectos/${project.id}/contexto/otra`);
    expect(await screen.findByText("Sin documentos")).toBeTruthy();
  });

  it("/board redirige a /proyectos", async () => {
    renderApp("/board");
    expect(await screen.findByRole("heading", { name: "Proyectos" })).toBeTruthy();
  });

  it("/context redirige a /proyectos", async () => {
    renderApp("/context");
    expect(await screen.findByRole("heading", { name: "Proyectos" })).toBeTruthy();
  });

  it("/meetings redirige a Sistema › Fuentes", async () => {
    renderApp("/meetings");
    expect(await screen.findByText("Estado de las fuentes externas y de la cola de reuniones.")).toBeTruthy();
  });

  it("/sistema/salud redirige a Sistema › Fuentes", async () => {
    renderApp("/sistema/salud");
    expect(await screen.findByText("Estado de las fuentes externas y de la cola de reuniones.")).toBeTruthy();
  });

  it("/sistema/ajustes redirige a Sistema › Configuración", async () => {
    renderApp("/sistema/ajustes");
    expect(await screen.findByText("Configuración de la aplicación y estado de los agentes.")).toBeTruthy();
  });

  it("/admin redirige a Sistema › Configuración", async () => {
    renderApp("/admin");
    expect(await screen.findByText("Configuración de la aplicación y estado de los agentes.")).toBeTruthy();
  });

  it("/?tarea=t1 termina en /hoy conservando la query", async () => {
    renderApp("/?tarea=t1");
    await screen.findByRole("heading", { level: 1, name: /decisi/i });
    await waitFor(() => {
      expect(locationProbe.pathname).toBe("/hoy");
      expect(locationProbe.search).toBe("?tarea=t1");
    });
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
