/**
 * Alta de tarea desde el tablero: validación pura + render del diálogo +
 * envío del POST con el cuerpo correcto.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useStore } from "../src/state/store";
import BoardView from "../src/views/BoardView";
import {
  CreateTaskDialog,
  emptyDraft,
  validateDraft,
  type CreateTaskDraft,
} from "../src/views/CreateTaskDialog";
import { makeTask, mockFetch, person, project } from "./helpers";

function baseState() {
  useStore.setState({
    person,
    token: "tok",
    projects: [project],
    activeProjectId: project.id,
    people: [person],
    peopleLoading: false,
    peopleError: null,
    projectPeople: null,
    projectPeopleId: null,
    taskDetail: null,
    taskDetailLoading: false,
    taskDetailError: null,
    taskMutationError: null,
    taskSaving: false,
    taskCreating: false,
    toasts: [],
    boardFilter: "all",
    boardLabelFilter: null,
    labelCatalog: [],
    board: { projectId: project.id, tasks: {} },
  });
}

describe("validateDraft (pura)", () => {
  it("título vacío o demasiado corto bloquea el envío", () => {
    const empty = validateDraft(emptyDraft("ENTENDER"));
    expect(empty.issues.title).toBeTruthy();
    expect(empty.blocking).toBe(true);

    const short: CreateTaskDraft = { ...emptyDraft("ENTENDER"), title: "ab" };
    const shortResult = validateDraft(short);
    expect(shortResult.issues.title).toBeTruthy();
    expect(shortResult.blocking).toBe(true);
  });

  it("sin definición de terminado avisa pero no bloquea", () => {
    const draft: CreateTaskDraft = { ...emptyDraft("ENTENDER"), title: "Mapear el proceso" };
    const { issues, blocking } = validateDraft(draft);
    expect(issues.definitionOfDone).toBeTruthy();
    expect(blocking).toBe(false);
  });

  it("sin responsables avisa pero no bloquea", () => {
    const draft: CreateTaskDraft = {
      ...emptyDraft("ENTENDER"),
      title: "Mapear el proceso",
      definitionOfDone: "Mapa validado",
    };
    const { issues, blocking } = validateDraft(draft);
    expect(issues.assignees).toBeTruthy();
    expect(blocking).toBe(false);
  });

  it("un borrador completo no tiene issues bloqueantes", () => {
    const draft: CreateTaskDraft = {
      ...emptyDraft("ENTENDER"),
      title: "Mapear el proceso",
      definitionOfDone: "Mapa validado",
      assigneeIds: ["p-ernesto"],
      primaryAssigneeId: "p-ernesto",
    };
    const { issues, blocking } = validateDraft(draft);
    expect(issues.title).toBeUndefined();
    expect(issues.due).toBeUndefined();
    expect(blocking).toBe(false);
  });
});

describe("CreateTaskDialog (render)", () => {
  beforeEach(() => {
    baseState();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("un título de 1 carácter muestra el error en línea y deshabilita el envío", () => {
    render(
      <CreateTaskDialog open onOpenChange={vi.fn()} projectId={project.id} defaultStage="ENTENDER" />,
    );
    const titleInput = screen.getByTestId("new-task-title");
    fireEvent.change(titleInput, { target: { value: "a" } });
    expect(screen.getByRole("alert").textContent).toContain("al menos 3 caracteres");
    expect((screen.getByTestId("new-task-submit") as HTMLButtonElement).disabled).toBe(true);
  });

  it("un título válido habilita el envío antes de enviar (validación en línea)", () => {
    render(
      <CreateTaskDialog open onOpenChange={vi.fn()} projectId={project.id} defaultStage="ENTENDER" />,
    );
    const titleInput = screen.getByTestId("new-task-title");
    fireEvent.change(titleInput, { target: { value: "Mapear el proceso" } });
    expect(screen.queryByRole("alert")).toBeNull();
    expect((screen.getByTestId("new-task-submit") as HTMLButtonElement).disabled).toBe(false);
  });

  it("los avisos de DoD y responsables aparecen vacíos y desaparecen al rellenarlos", () => {
    render(
      <CreateTaskDialog open onOpenChange={vi.fn()} projectId={project.id} defaultStage="ENTENDER" />,
    );
    expect(screen.getByTestId("new-task-dod-hint")).toBeTruthy();
    expect(screen.getByTestId("new-task-assignee-hint")).toBeTruthy();

    fireEvent.change(screen.getByTestId("new-task-dod"), {
      target: { value: "Mapa SIPOC validado por el cliente" },
    });
    expect(screen.queryByTestId("new-task-dod-hint")).toBeNull();

    fireEvent.click(screen.getByRole("checkbox", { name: /Ernesto/ }));
    expect(screen.queryByTestId("new-task-assignee-hint")).toBeNull();
  });

  it("enviar hace POST /api/tasks con el cuerpo correcto y cierra el diálogo", async () => {
    const created = makeTask({
      id: "t-new",
      title: "Preparar propuesta comercial",
      definitionOfDone: "Propuesta firmada por el cliente",
      assigneePersonId: person.id,
      assignees: [{ personId: person.id, isPrimary: true }],
      labels: ["cliente"],
    });
    const { calls } = mockFetch([
      { method: "POST", path: "/api/tasks", body: { task: created } },
      { path: "/api/tasks/t-new", body: { task: created, events: [], artifacts: [], runs: [] } },
      {
        path: "/api/board/proj-1",
        body: { project, board_seq: 1, total: 0, columns: {}, cells: {} },
      },
      { path: "/api/labels", body: { labels: [] } },
      { path: "/api/auth/people", body: { people: [person] } },
    ]);
    const onOpenChange = vi.fn();
    render(
      <CreateTaskDialog open onOpenChange={onOpenChange} projectId={project.id} defaultStage="ENTENDER" />,
    );

    fireEvent.change(screen.getByTestId("new-task-title"), {
      target: { value: "Preparar propuesta comercial" },
    });
    fireEvent.change(screen.getByTestId("new-task-dod"), {
      target: { value: "Propuesta firmada por el cliente" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: /Ernesto/ }));
    fireEvent.change(screen.getByTestId("new-task-label"), { target: { value: "cliente" } });
    fireEvent.keyDown(screen.getByTestId("new-task-label"), { key: "Enter" });

    fireEvent.click(screen.getByTestId("new-task-submit"));

    await waitFor(() => {
      const createCall = calls.find((call) => call.method === "POST" && call.url.endsWith("/api/tasks"));
      expect(createCall).toBeTruthy();
      expect(createCall?.body).toMatchObject({
        project_id: "proj-1",
        title: "Preparar propuesta comercial",
        stage: "ENTENDER",
        priority: "normal",
        definition_of_done: "Propuesta firmada por el cliente",
        assignee_person_ids: ["p-ernesto"],
        // El único responsable marcado queda como principal sin que el
        // humano tenga que elegirlo: si no, la tarea nace bloqueada para
        // BACKLOG→READY (defecto de usabilidad detectado en verificación).
        primary_assignee_person_id: "p-ernesto",
        labels: ["cliente"],
      });
    });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    await waitFor(() => {
      expect(calls.some((call) => call.method === "GET" && call.url.endsWith("/api/tasks/t-new"))).toBe(
        true,
      );
    });
  });

  it("con un único responsable no hay selector de principal, pero se marca solo (y se puede cambiar al añadir otro)", async () => {
    const otherPerson = { id: "p-otro", full_name: "Sofía", role: "Consultora" };
    useStore.setState({ people: [person, otherPerson] });
    const created = makeTask({
      id: "t-new-2",
      title: "Preparar propuesta comercial",
      definitionOfDone: "Propuesta firmada por el cliente",
      assigneePersonId: otherPerson.id,
      assignees: [
        { personId: person.id, isPrimary: false },
        { personId: otherPerson.id, isPrimary: true },
      ],
    });
    const { calls } = mockFetch([
      { method: "POST", path: "/api/tasks", body: { task: created } },
      { path: "/api/tasks/t-new-2", body: { task: created, events: [], artifacts: [], runs: [] } },
      {
        path: "/api/board/proj-1",
        body: { project, board_seq: 1, total: 0, columns: {}, cells: {} },
      },
      { path: "/api/labels", body: { labels: [] } },
      { path: "/api/auth/people", body: { people: [person, otherPerson] } },
    ]);
    render(
      <CreateTaskDialog open onOpenChange={vi.fn()} projectId={project.id} defaultStage="ENTENDER" />,
    );

    fireEvent.change(screen.getByTestId("new-task-title"), {
      target: { value: "Preparar propuesta comercial" },
    });
    fireEvent.change(screen.getByTestId("new-task-dod"), {
      target: { value: "Propuesta firmada por el cliente" },
    });

    // Con un solo responsable marcado, no se pide elegir principal.
    fireEvent.click(screen.getByRole("checkbox", { name: /Ernesto/ }));
    expect(screen.queryByLabelText("Persona principal")).toBeNull();

    // Al añadir un segundo, el selector aparece y permite cambiar al recién añadido.
    fireEvent.click(screen.getByRole("checkbox", { name: /Sofía/ }));
    const primarySelect = screen.getByLabelText("Persona principal") as HTMLSelectElement;
    expect(primarySelect.value).toBe("p-ernesto");
    fireEvent.change(primarySelect, { target: { value: "p-otro" } });

    fireEvent.click(screen.getByTestId("new-task-submit"));

    await waitFor(() => {
      const createCall = calls.find((call) => call.method === "POST" && call.url.endsWith("/api/tasks"));
      expect(createCall?.body).toMatchObject({
        assignee_person_ids: ["p-ernesto", "p-otro"],
        primary_assignee_person_id: "p-otro",
      });
    });
  });
});

describe("Botón de alta en el tablero", () => {
  beforeEach(() => {
    baseState();
    useStore.setState({ board: { projectId: project.id, tasks: { t1: makeTask() } } });
    mockFetch([
      { path: "/api/projects/proj-1/launches", body: { launches: [] } },
      { path: "/api/projects/proj-1/phase-status", body: { status: { reason: "no_launch" } } },
    ]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("board-new-task abre create-task-dialog", () => {
    render(<BoardView />);
    expect(screen.queryByTestId("create-task-dialog")).toBeNull();
    fireEvent.click(screen.getByTestId("board-new-task"));
    expect(screen.getByTestId("create-task-dialog")).toBeTruthy();
  });
});
