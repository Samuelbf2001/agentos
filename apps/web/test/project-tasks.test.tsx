import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api, setToken } from "../src/lib/api";
import { taskDueState } from "../src/lib/types";
import { useStore } from "../src/state/store";
import BoardView, { filterBoardTasks } from "../src/views/BoardView";
import { TaskDrawer } from "../src/views/TaskDrawer";
import { makeTask, mockFetch, person, project } from "./helpers";

describe("contrato visual de proyectos y tareas", () => {
  beforeEach(() => {
    setToken("tok");
    useStore.setState({
      person,
      token: "tok",
      projects: [project],
      activeProjectId: project.id,
      people: [person, { id: "p-ana", full_name: "Ana", role: "Líder" }],
      peopleLoading: false,
      peopleError: null,
      taskDetailLoading: false,
      taskDetailError: null,
      taskMutationError: null,
      taskSaving: false,
      toasts: [],
      boardFilter: "all",
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("clasifica y filtra vencidas/próximas y responsables sin tocar estados canónicos", () => {
    const now = new Date("2026-09-01T12:00:00").getTime();
    const overdue = makeTask({ id: "overdue", dueAt: now - 60_000 });
    const mine = makeTask({ id: "mine", assignees: [{ personId: person.id, isPrimary: true }] });
    const unassigned = makeTask({ id: "unassigned", assignees: [], assigneePersonId: null });
    const upcoming = makeTask({ id: "upcoming", dueAt: now + 2 * 86_400_000 });
    expect(taskDueState(overdue, now)).toBe("overdue");
    expect(filterBoardTasks([mine, unassigned], "mine", person.id, now).map((task) => task.id)).toEqual(["mine"]);
    expect(filterBoardTasks([mine, unassigned], "unassigned", person.id, now).map((task) => task.id)).toEqual(["unassigned"]);
    expect(filterBoardTasks([overdue, upcoming], "due", person.id, now).map((task) => task.id)).toEqual([
      "overdue",
      "upcoming",
    ]);
  });

  it("lista tareas con el filtro REST y normaliza responsables enriquecidos", async () => {
    mockFetch([
      {
        path: "/api/tasks",
        body: {
          tasks: [
            makeTask({
              assignees: [
                { personId: "p-ana", isPrimary: true, person: { id: "p-ana", fullName: "Ana", role: "Líder" } },
              ],
            }),
          ],
        },
      },
    ]);
    const response = await api.tasks({ project_id: project.id, assignee_person_id: "p-ana" });
    expect(response.tasks[0]?.assignees?.[0]?.person?.full_name).toBe("Ana");
    expect(response.tasks[0]?.assigneePersonId).toBe("p-ana");
  });

  it("muestra la ficha contextual y persiste responsables con expected_version", async () => {
    const task = makeTask({
      assignees: [{ personId: person.id, isPrimary: true }],
      dueAt: new Date("2026-09-04T10:30:00").getTime(),
    });
    useStore.setState({
      taskDetail: {
        task,
        events: [],
        artifacts: [],
        runs: [],
        project,
        projectContext: {
          project,
          sources: [
            {
              id: "source-1",
              projectId: project.id,
              kind: "meeting",
              externalRef: { system: "whatsapphub", title: "Kickoff ACME" },
              status: "linked",
              knowledgeDocId: null,
              lastError: null,
              lastIngestedAt: null,
              createdBy: null,
              createdAt: 1,
            },
          ],
          documents: [{ id: "doc-1", orgId: project.orgId, projectId: project.id, kind: "note", title: "Mapa de contexto", bodyMd: "", sourceRefs: null, tags: null, createdBy: null, createdAt: 1, updatedAt: 1 }],
        },
      },
    });
    const { calls } = mockFetch([
      {
        method: "POST",
        path: "/api/tasks/t1/assign",
        body: { task: makeTask({ version: 4, assigneePersonId: "p-ana", assignees: [{ personId: "p-ana", isPrimary: true }] }) },
      },
    ]);
    render(
      <MemoryRouter>
        <TaskDrawer />
      </MemoryRouter>,
    );
    expect(screen.getByText("Kickoff ACME")).toBeTruthy();
    expect(screen.getByText("Mapa de contexto")).toBeTruthy();
    // Rediseño Notion: el selector de personas es un popover que guarda al
    // cerrarse; no existe "Guardar responsables".
    expect(screen.queryByRole("button", { name: "Guardar responsables" })).toBeNull();
    fireEvent.click(screen.getByTestId("prop-assignees"));
    fireEvent.click(await screen.findByRole("checkbox", { name: /Ana/ }));
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => {
      expect(calls.find((call) => call.method === "POST" && call.url.includes("/assign"))?.body).toEqual({
        expected_version: 3,
        assignee_person_ids: ["p-ernesto", "p-ana"],
        primary_assignee_person_id: "p-ernesto",
      });
    });
  });

  it("marcar el primer responsable en una tarea sin nadie asignado lo deja como principal (defecto de usabilidad)", async () => {
    const task = makeTask({ assignees: [], assigneePersonId: null });
    useStore.setState({
      taskDetail: { task, events: [], artifacts: [], runs: [], project },
    });
    const { calls } = mockFetch([
      {
        method: "POST",
        path: "/api/tasks/t1/assign",
        body: { task: makeTask({ version: 4, assigneePersonId: "p-ana", assignees: [{ personId: "p-ana", isPrimary: true }] }) },
      },
    ]);
    render(
      <MemoryRouter>
        <TaskDrawer />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByTestId("prop-assignees"));
    fireEvent.click(await screen.findByRole("checkbox", { name: /Ana/ }));
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => {
      expect(calls.find((call) => call.method === "POST" && call.url.includes("/assign"))?.body).toEqual({
        expected_version: 3,
        assignee_person_ids: ["p-ana"],
        primary_assignee_person_id: "p-ana",
      });
    });
  });

  it("edita la descripción en la ficha e inserta enlace e imagen con vista previa", async () => {
    const task = makeTask({ description: null });
    useStore.setState({
      taskDetail: { task, events: [], artifacts: [], runs: [], project },
    });
    const { calls } = mockFetch([
      {
        method: "PATCH",
        path: "/api/tasks/t1",
        body: (input: { body: unknown }) => ({
          task: makeTask({ version: 4, description: (input.body as { description?: string }).description ?? null }),
        }),
      },
    ]);
    render(
      <MemoryRouter>
        <TaskDrawer />
      </MemoryRouter>,
    );

    // Rediseño Notion: el textarea está siempre visible y guarda al salir del
    // bloque; no existen "Editar" ni "Guardar descripción".
    expect(screen.queryByRole("button", { name: "Editar" })).toBeNull();
    fireEvent.change(screen.getByTestId("task-description-input"), { target: { value: "Preparar el material." } });

    fireEvent.click(screen.getByRole("button", { name: /Enlace/ }));
    fireEvent.change(screen.getByLabelText("Texto visible"), { target: { value: "Brief" } });
    fireEvent.change(screen.getByLabelText("URL"), { target: { value: "https://example.com/brief" } });
    fireEvent.click(screen.getByRole("button", { name: "Insertar" }));
    expect(screen.getByRole("link", { name: "Brief" }).getAttribute("href")).toBe("https://example.com/brief");

    fireEvent.click(screen.getByRole("button", { name: /Imagen/ }));
    fireEvent.change(screen.getByLabelText("Texto alternativo"), { target: { value: "Mapa del proceso" } });
    fireEvent.change(screen.getByLabelText("URL"), { target: { value: "https://images.example.com/mapa.png" } });
    fireEvent.click(screen.getByRole("button", { name: "Insertar" }));
    expect(screen.getByAltText("Mapa del proceso").getAttribute("src")).toBe("https://images.example.com/mapa.png");

    expect(screen.queryByRole("button", { name: "Guardar descripción" })).toBeNull();
    fireEvent.blur(screen.getByTestId("task-description-input"));
    await waitFor(() => {
      expect(calls.find((call) => call.method === "PATCH" && call.url.includes("/api/tasks/t1"))?.body).toEqual({
        expected_version: 3,
        description: expect.stringContaining("![Mapa del proceso](<https://images.example.com/mapa.png>)"),
      });
    });
  });

  it("el tablero conserva una ruta operable con teclado para abrir tarjetas", () => {
    useStore.setState({ board: { projectId: project.id, tasks: { t1: makeTask() } } });
    mockFetch([
      { path: "/api/projects/proj-1/launches", body: { launches: [] } },
      { path: "/api/projects/proj-1/phase-status", body: { status: { reason: "no_launch" } } },
    ]);
    render(<BoardView projectId={project.id} />);
    const card = screen.getByTestId("task-card-t1");
    expect(card.getAttribute("role")).toBe("button");
    expect(card.getAttribute("tabindex")).toBe("0");
  });

  it("con stage ENTENDER el carril Construir nace plegado y «Mostrar» lo abre", () => {
    useStore.setState({
      board: {
        projectId: project.id,
        tasks: {
          t1: makeTask({ id: "t1", stage: "ENTENDER" }),
          t2: makeTask({ id: "t2", stage: "CONSTRUIR" }),
        },
      },
    });
    mockFetch([
      { path: "/api/projects/proj-1/launches", body: { launches: [] } },
      { path: "/api/projects/proj-1/phase-status", body: { status: { reason: "no_launch" } } },
    ]);
    render(<BoardView projectId={project.id} />);

    // Entender es la etapa activa del proyecto: se ve abierta de entrada.
    expect(screen.getByTestId("task-card-t1")).toBeTruthy();
    // Construir no es la etapa actual: nace plegado, sin su tarjeta visible.
    expect(screen.getByTestId("lane-CONSTRUIR-plegado")).toBeTruthy();
    expect(screen.queryByTestId("task-card-t2")).toBeNull();

    fireEvent.click(screen.getByTestId("lane-CONSTRUIR-mostrar"));
    expect(screen.getByTestId("task-card-t2")).toBeTruthy();
    expect(screen.queryByTestId("lane-CONSTRUIR-plegado")).toBeNull();
  });
});
