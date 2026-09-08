/**
 * "Ver como cliente" (previsualización local, no un rol de sesión real):
 * desde el lateral de un proyecto, un botón reduce el shell a lo que vería el
 * cliente (Resumen/Contexto/Decisiones, sin buscar ni pausar agentes) y otro
 * lo devuelve a la vista completa de Sixteam. Salir del proyecto la apaga.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useNavigate } from "react-router-dom";
import App from "../src/App";
import { useStore } from "../src/state/store";
import { agents, makeTask, mockFetch, person, project } from "./helpers";

const withOrgName = { ...project, orgName: "ACME" };

const routes = [
  { path: "/api/waiting", body: { approvals: [], review_tasks: [] } },
  { path: "/api/runs", body: { runs: [] } },
  { path: "/api/projects", body: { projects: [withOrgName] } },
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

/** Navega a `/tareas` sin pasar por un enlace del lateral: fuera de un proyecto. */
function GoToTareas() {
  const navigate = useNavigate();
  return (
    <button type="button" data-testid="goto-tareas" onClick={() => navigate("/tareas")}>
      ir a tareas
    </button>
  );
}

function renderApp(entry: string) {
  useStore.setState({
    person,
    token: "tok",
    bootstrapped: true,
    projects: [withOrgName],
    activeProjectId: project.id,
    agents,
    approvals: [],
    reviewTasks: [],
    failedRunsCount: 0,
    board: { projectId: project.id, tasks: {} },
    toasts: [],
    killSwitch: false,
    previewRole: null,
  });
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <App />
      <GoToTareas />
    </MemoryRouter>,
  );
}

describe("ver como cliente (previsualización)", () => {
  beforeEach(() => {
    mockFetch(routes);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("reduce el shell a Resumen/Contexto/Decisiones y se puede deshacer", async () => {
    const { container } = renderApp(`/proyectos/${project.id}/ruta`);
    await screen.findByRole("heading", { name: project.name });
    const aside = container.querySelector("aside") as HTMLElement;
    const sidebar = within(aside);

    fireEvent.click(sidebar.getByRole("button", { name: /Ver como cliente/ }));

    // Sidebar reducido: sólo lo que puede ver un cliente.
    await waitFor(() => {
      expect(sidebar.getByRole("link", { name: "Resumen" })).toBeTruthy();
    });
    expect(sidebar.getByRole("link", { name: "Contexto" })).toBeTruthy();
    expect(sidebar.getByRole("link", { name: "Decisiones" })).toBeTruthy();
    expect(sidebar.queryByRole("link", { name: "Tablero" })).toBeNull();
    expect(sidebar.queryByRole("link", { name: "Conversación" })).toBeNull();
    expect(sidebar.queryByRole("link", { name: "Actividad" })).toBeNull();

    // Acciones globales fuera del alcance de un cliente.
    expect(screen.queryByText("Buscar tareas")).toBeNull();
    expect(screen.queryByText("Pausar agentes")).toBeNull();
    expect(screen.queryByText("Reanudar agentes")).toBeNull();

    expect(sidebar.getByText("Estás viendo lo que ve el cliente")).toBeTruthy();

    fireEvent.click(sidebar.getByRole("button", { name: /Volver a la vista de Sixteam/ }));

    await waitFor(() => {
      expect(sidebar.getByRole("link", { name: "Tablero" })).toBeTruthy();
    });
    expect(sidebar.getByRole("link", { name: "Conversación" })).toBeTruthy();
    expect(sidebar.getByRole("link", { name: "Actividad" })).toBeTruthy();
    expect(screen.getByText("Buscar tareas")).toBeTruthy();
    expect(screen.getByText("Pausar agentes")).toBeTruthy();
    expect(sidebar.queryByText("Estás viendo lo que ve el cliente")).toBeNull();
  });

  it("navegar fuera del proyecto apaga la previsualización", async () => {
    const { container } = renderApp(`/proyectos/${project.id}/ruta`);
    await screen.findByRole("heading", { name: project.name });
    const aside = container.querySelector("aside") as HTMLElement;
    const sidebar = within(aside);

    fireEvent.click(sidebar.getByRole("button", { name: /Ver como cliente/ }));
    await waitFor(() => {
      expect(useStore.getState().previewRole).toBe("sponsor");
    });

    fireEvent.click(screen.getByTestId("goto-tareas"));

    await waitFor(() => {
      expect(useStore.getState().previewRole).toBeNull();
    });
  });
});
