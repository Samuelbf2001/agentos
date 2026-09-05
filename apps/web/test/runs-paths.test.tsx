/**
 * Caminos de vuelta (PLAN-v1.5 §5). Desde una ejecución se llega siempre a su
 * tarea y a su proyecto: la API ya aceptaba esos filtros y la tabla no los
 * pintaba, así que el identificador quedaba impreso como texto muerto.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import RunsView from "../src/views/RunsView";
import RunDetailView from "../src/views/RunDetailView";
import { useStore } from "../src/state/store";
import { agents, makeRun, makeTask, mockFetch, person, project } from "./helpers";

const task = makeTask({ id: "t1", title: "Mapear proceso de ventas" });
const run = makeRun({ id: "r1", taskId: task.id, projectId: project.id });

const routes = [
  { path: "/api/runs", body: { runs: [run] } },
  { path: "/api/runs/r1", body: { run, spans: [], tree: [run], last_seq: 5 } },
  { path: "/api/tasks", body: { tasks: [task] } },
  { path: /^\/api\/tasks\/[^/]+$/, body: { task, events: [], artifacts: [], runs: [run] } },
];

function seed() {
  useStore.setState({
    person,
    token: "tok",
    projects: [project],
    activeProjectId: project.id,
    agents,
    board: { projectId: project.id, tasks: { [task.id]: task } },
    toasts: [],
  });
}

describe("caminos de vuelta desde la actividad", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    useStore.getState().closeTask();
  });

  it("la tabla trae columnas de Tarea y Proyecto con su nombre, no con un id", async () => {
    mockFetch(routes);
    seed();
    render(
      <MemoryRouter initialEntries={["/sistema/actividad"]}>
        <RunsView />
      </MemoryRouter>,
    );

    const row = await screen.findByTestId("run-row-r1");
    expect(within(row).getByText("Mapear proceso de ventas")).toBeTruthy();
    expect(within(row).getByRole("link", { name: project.name }).getAttribute("href")).toBe(
      `/proyectos/${project.id}/ruta`,
    );
    expect(within(row).getByRole("link", { name: /r1/ }).getAttribute("href")).toBe(
      "/sistema/actividad/r1",
    );
  });

  it("desde una fila se abre la tarjeta de su tarea", async () => {
    mockFetch(routes);
    seed();
    render(
      <MemoryRouter initialEntries={["/sistema/actividad"]}>
        <RunsView />
      </MemoryRouter>,
    );
    const row = await screen.findByTestId("run-row-r1");
    fireEvent.click(within(row).getByText("Mapear proceso de ventas"));
    await waitFor(() => {
      expect(useStore.getState().taskDetailId).toBe(task.id);
    });
  });

  it("dentro de un proyecto la lista se filtra por ese proyecto", async () => {
    const { calls } = mockFetch(routes);
    seed();
    render(
      <MemoryRouter initialEntries={[`/proyectos/${project.id}/actividad`]}>
        <RunsView projectId={project.id} />
      </MemoryRouter>,
    );
    await screen.findByTestId("run-row-r1");
    expect(calls.some((c) => c.url.includes(`project_id=${project.id}`))).toBe(true);
  });

  it("el detalle de la ejecución lleva miga de pan Proyecto › Tarea › Run", async () => {
    mockFetch(routes);
    seed();
    render(
      <MemoryRouter initialEntries={["/sistema/actividad/r1"]}>
        <Routes>
          <Route path="/sistema/actividad/:runId" element={<RunDetailView />} />
        </Routes>
      </MemoryRouter>,
    );

    const crumb = await screen.findByRole("navigation", { name: "Dónde estás" });
    expect(within(crumb).getByRole("link", { name: project.name }).getAttribute("href")).toBe(
      `/proyectos/${project.id}/ruta`,
    );
    const taskCrumb = within(crumb).getByTestId("run-breadcrumb-task");
    expect(taskCrumb.textContent).toBe("Mapear proceso de ventas");
    fireEvent.click(taskCrumb);
    await waitFor(() => {
      expect(useStore.getState().taskDetailId).toBe(task.id);
    });
  });
});
