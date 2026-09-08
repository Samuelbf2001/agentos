/**
 * Menú lateral y cambio de perspectiva (Sixteam ↔ cliente). En agencia el
 * lateral pinta los grupos "2brain"/"Agencia"/"Sistema" y el selector dice
 * "Sixteam"; dentro de un cliente pinta sus pestañas y el selector muestra el
 * cliente y el proyecto. El popover del selector lista los clientes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import App from "../src/App";
import { useStore } from "../src/state/store";
import { BRAIN_URL } from "../src/lib/nav";
import { agents, makeTask, mockFetch, person, project, projectB } from "./helpers";

const locationProbe: { pathname: string } = { pathname: "" };

function LocationProbe() {
  const location = useLocation();
  locationProbe.pathname = location.pathname;
  return null;
}

const withOrgNames = [
  { ...project, orgName: "ACME" },
  { ...projectB, orgName: "Beta Corp" },
];

const routes = [
  { path: "/api/waiting", body: { approvals: [], review_tasks: [] } },
  { path: "/api/runs", body: { runs: [] } },
  { path: "/api/projects", body: { projects: withOrgNames } },
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
    projects: withOrgNames,
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

describe("sidebar y cambio de perspectiva", () => {
  beforeEach(() => {
    mockFetch(routes);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("en /hoy el lateral pinta los grupos de agencia y el selector dice Sixteam", async () => {
    const { container } = renderApp("/hoy");
    await screen.findByRole("navigation", { name: "Navegación principal" });
    const aside = container.querySelector("aside");
    expect(aside).toBeTruthy();
    const sidebar = within(aside as HTMLElement);

    expect(sidebar.getByText("2brain")).toBeTruthy();
    expect(sidebar.getByText("Agencia")).toBeTruthy();
    expect(sidebar.getByText("Sistema")).toBeTruthy();
    expect(sidebar.getByTestId("perspective-switch").textContent).toContain("Sixteam");
  });

  it("en /proyectos/p1/ruta el selector muestra cliente y proyecto, con Volver a Sixteam y sin 2brain", async () => {
    const { container } = renderApp(`/proyectos/${project.id}/ruta`);
    await screen.findByRole("heading", { name: project.name });
    const aside = container.querySelector("aside");
    const sidebar = within(aside as HTMLElement);

    const trigger = sidebar.getByTestId("perspective-switch");
    expect(trigger.textContent).toContain("ACME");
    expect(trigger.textContent).toContain(project.name);
    expect(sidebar.getByRole("link", { name: /Volver a Sixteam/ })).toBeTruthy();

    for (const label of ["Resumen", "Tablero", "Contexto", "Conversación", "Actividad", "Decisiones"]) {
      expect(sidebar.getByRole("link", { name: label })).toBeTruthy();
    }
    expect(sidebar.queryByText("2brain")).toBeNull();
  });

  it("los enlaces de 2brain abren en pestaña nueva y apuntan a la URL de 2brain", async () => {
    const { container } = renderApp("/hoy");
    await screen.findByRole("navigation", { name: "Navegación principal" });
    const aside = container.querySelector("aside") as HTMLElement;
    const sidebar = within(aside);

    for (const label of ["Conversaciones", "Notas de voz", "Videos", "Grafo", "Agente 2brain"]) {
      const link = sidebar.getByRole("link", { name: label });
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("href")).toMatch(new RegExp(`^${BRAIN_URL}`));
    }
  });

  it("en /hoy?proyecto=<id> el lateral es el de cliente y Decisiones queda activo", async () => {
    const { container } = renderApp(`/hoy?proyecto=${project.id}`);
    await screen.findByRole("navigation", { name: "Navegación principal" });
    const aside = container.querySelector("aside");
    const sidebar = within(aside as HTMLElement);

    expect(sidebar.getByRole("link", { name: /Volver a Sixteam/ })).toBeTruthy();
    expect(sidebar.getByRole("link", { name: "Resumen" })).toBeTruthy();
    expect(sidebar.queryByText("2brain")).toBeNull();
    const decisiones = sidebar.getByRole("link", { name: "Decisiones" });
    expect(decisiones.getAttribute("aria-current")).toBe("page");
  });

  it("el popover del selector lista los clientes y al elegir uno navega a su Ruta", async () => {
    const { container } = renderApp("/hoy");
    await screen.findByRole("navigation", { name: "Navegación principal" });
    const aside = container.querySelector("aside") as HTMLElement;

    fireEvent.click(within(aside).getByTestId("perspective-switch"));
    const popover = await screen.findByTestId("perspective-popover");
    expect(within(popover).getByText("ACME")).toBeTruthy();
    expect(within(popover).getByText("Beta Corp")).toBeTruthy();

    fireEvent.click(within(popover).getByTestId(`perspective-project-${projectB.id}`));

    await waitFor(() => {
      expect(locationProbe.pathname).toBe(`/proyectos/${projectB.id}/ruta`);
    });
  });
});
