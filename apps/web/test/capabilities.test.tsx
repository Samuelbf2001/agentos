/**
 * Shell por capacidades (PLAN-v1.5 §Shell por capacidades). Con las
 * capacidades por defecto (rol único, hoy) el menú lateral muestra todas las
 * entradas; con un conjunto reducido, las entradas ausentes desaparecen del
 * menú y las rutas que dependen de ellas redirigen en vez de romperse.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import App from "../src/App";
import { useStore } from "../src/state/store";
import { ALL_CAPABILITIES, useCapabilities, type Capability } from "../src/lib/capabilities";
import { agents, makeTask, mockFetch, person, project } from "./helpers";

vi.mock("../src/lib/capabilities", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/capabilities")>();
  return { ...actual, useCapabilities: vi.fn(actual.useCapabilities) };
});

const realUseCapabilities = vi.mocked(useCapabilities).getMockImplementation();

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

describe("shell por capacidades", () => {
  beforeEach(() => {
    mockFetch(routes);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
    if (realUseCapabilities) vi.mocked(useCapabilities).mockImplementation(realUseCapabilities);
  });

  it("con las capacidades por defecto el menú lateral muestra todas las entradas", async () => {
    const { container } = renderApp("/hoy");
    const nav = await screen.findByRole("navigation", { name: "Navegación principal" });
    for (const label of ["Hoy", "Tareas", "Clientes", "Método", "Equipo", "Configuración"]) {
      expect(within(nav).getByRole("link", { name: label })).toBeTruthy();
    }
    expect(container.textContent).toContain("Pausar agentes");
  });

  it("sin sistema:configuracion, agentes:pausar ni proyecto:conversacion se ocultan y la ruta redirige", async () => {
    const reduced = new Set(
      [...ALL_CAPABILITIES].filter(
        (c): c is Capability =>
          c !== "sistema:configuracion" && c !== "agentes:pausar" && c !== "proyecto:conversacion",
      ),
    );
    vi.mocked(useCapabilities).mockReturnValue(reduced);

    renderApp(`/proyectos/${project.id}/conversacion`);

    const nav = await screen.findByRole("navigation", { name: "Navegación principal" });
    expect(within(nav).queryByText("Configuración")).toBeNull();
    expect(screen.queryByText("Pausar agentes")).toBeNull();
    expect(screen.queryByText("Reanudar agentes")).toBeNull();

    // /proyectos/:id/conversacion redirige a la primera pestaña disponible (Ruta).
    expect(await screen.findByRole("heading", { name: project.name })).toBeTruthy();
    expect(within(nav).queryByText("Conversación")).toBeNull();
    const rutaLink = within(nav).getByRole("link", { name: "Resumen" });
    expect(rutaLink.className).toContain("bg-link");
  });
});
