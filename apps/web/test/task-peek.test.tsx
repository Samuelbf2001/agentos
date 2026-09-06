/**
 * Ficha de tarea al estilo Notion (docs/DISENO-FICHA-TAREA-NOTION.md §5):
 * side peek redimensionable y persistido, edición inline sin modo edición,
 * reconciliación 409, cambio de proyecto, deep link `?tarea` y móvil.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { useTaskDeepLink } from "../src/App";
import { PEEK_WIDTH_KEY } from "../src/lib/tareas";
import { emptyEventState, reduceEvent } from "../src/state/reducer";
import { useStore } from "../src/state/store";
import { TaskDrawer } from "../src/views/TaskDrawer";
import { domainEvent, makeTask, mockFetch, person, project, projectB } from "./helpers";

function baseState() {
  useStore.setState({
    person,
    token: "tok",
    projects: [project, projectB],
    activeProjectId: project.id,
    people: [person, { id: "p-ana", full_name: "Ana", role: "Líder" }],
    peopleLoading: false,
    peopleError: null,
    projectPeople: null,
    projectPeopleId: null,
    taskDetail: null,
    taskDetailId: null,
    taskDetailLoading: false,
    taskDetailError: null,
    taskMutationError: null,
    taskConflict: null,
    taskSaving: false,
    copilotOpen: false,
    toasts: [],
    labelCatalog: [],
    blockedMove: null,
    board: { projectId: project.id, tasks: {} },
  });
}

function setViewport(width: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width });
  fireEvent(window, new Event("resize"));
}

function renderPeek(task = makeTask({ id: "t1", version: 3 })) {
  useStore.setState({ taskDetail: { task, events: [], artifacts: [], runs: [], project }, taskDetailId: task.id });
  return render(
    <MemoryRouter>
      <TaskDrawer />
    </MemoryRouter>,
  );
}

function pressEscape() {
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
}

describe("side peek redimensionable", () => {
  beforeEach(() => {
    baseState();
    localStorage.clear();
    setViewport(1400);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("arrastrar el tirador cambia el ancho, lo persiste y el remontaje arranca con él", () => {
    mockFetch([{ path: "/api/projects/proj-1/people", body: { org_id: "org-1", people: [person] } }]);
    const first = renderPeek();
    const handle = screen.getByTestId("peek-resize");
    expect(handle.getAttribute("role")).toBe("separator");
    expect(handle.getAttribute("aria-orientation")).toBe("vertical");

    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 840 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 700 });
    expect(screen.getByTestId("task-peek").style.width).toBe("700px");
    fireEvent.pointerUp(window, { pointerId: 1 });

    expect(handle.getAttribute("aria-valuenow")).toBe("700");
    expect(localStorage.getItem(PEEK_WIDTH_KEY)).toBe("700");

    first.unmount();
    renderPeek();
    expect(screen.getByTestId("task-peek").style.width).toBe("700px");
  });

  it("el ancho respeta mínimo y máximo aunque el puntero salga de la ventana", () => {
    mockFetch([{ path: "/api/projects/proj-1/people", body: { org_id: "org-1", people: [person] } }]);
    renderPeek();
    const handle = screen.getByTestId("peek-resize");

    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 840 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: -500 });
    expect(screen.getByTestId("task-peek").style.width).toBe("920px");
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 1395 });
    expect(screen.getByTestId("task-peek").style.width).toBe("384px");
    fireEvent.pointerUp(window, { pointerId: 1 });
    expect(handle.getAttribute("aria-valuenow")).toBe("384");

    // Teclado: ArrowLeft ensancha, ArrowRight estrecha.
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(handle.getAttribute("aria-valuenow")).toBe("416");
  });

  it("en <768px el peek ocupa todo el ancho y no muestra tirador", () => {
    setViewport(500);
    mockFetch([{ path: "/api/projects/proj-1/people", body: { org_id: "org-1", people: [person] } }]);
    renderPeek();
    const peek = screen.getByTestId("task-peek");
    expect(peek.getAttribute("data-mode")).toBe("mobile");
    expect(peek.style.width).toBe("");
    expect(peek.className).toContain("inset-0");
    expect(screen.queryByTestId("peek-resize")).toBeNull();
  });
});

describe("propiedades inline", () => {
  beforeEach(() => {
    baseState();
    localStorage.clear();
    setViewport(1400);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("cambiar el estado desde la ficha va por POST /move con expected_version, sin modo edición", async () => {
    const task = makeTask({ id: "t1", version: 3, status: "READY" });
    const { calls } = mockFetch([
      { path: "/api/projects/proj-1/people", body: { org_id: "org-1", people: [person] } },
      {
        method: "POST",
        path: "/api/tasks/t1/move",
        body: { task: makeTask({ id: "t1", version: 4, status: "IN_PROGRESS" }) },
      },
    ]);
    renderPeek(task);

    fireEvent.click(screen.getByTestId("prop-status"));
    fireEvent.click(await screen.findByTestId("status-option-IN_PROGRESS"));

    await waitFor(() => {
      const call = calls.find((c) => c.method === "POST" && c.url.endsWith("/api/tasks/t1/move"));
      expect(call?.body).toEqual({ to: "IN_PROGRESS", expected_version: 3 });
    });
    await waitFor(() => expect(useStore.getState().taskDetail?.task.status).toBe("IN_PROGRESS"));
    expect(screen.queryByTestId("edit-title")).toBeNull();
  });

  it("prioridad y vencimiento guardan por PATCH con expected_version; no hay botones de guardar", async () => {
    const task = makeTask({ id: "t1", version: 3 });
    const { calls } = mockFetch([
      { path: "/api/projects/proj-1/people", body: { org_id: "org-1", people: [person] } },
      {
        method: "PATCH",
        path: "/api/tasks/t1",
        body: ({ body }: { body: unknown }) => ({
          task: { ...task, ...(body as Record<string, unknown>), version: 4 },
        }),
      },
    ]);
    renderPeek(task);

    expect(screen.queryByTestId("edit-title")).toBeNull();
    expect(screen.queryByText("Guardar fecha")).toBeNull();
    expect(screen.queryByText("Guardar título")).toBeNull();

    fireEvent.click(screen.getByTestId("prop-priority"));
    fireEvent.click(await screen.findByTestId("priority-option-high"));
    await waitFor(() => {
      const call = calls.find((c) => c.method === "PATCH" && c.url.endsWith("/api/tasks/t1"));
      expect(call?.body).toEqual({ priority: "high", expected_version: 3 });
    });

    // Tras el PATCH la tarea va por la v4: el vencimiento la usa.
    await waitFor(() => expect(useStore.getState().taskDetail?.task.version).toBe(4));
    fireEvent.click(screen.getByTestId("prop-due"));
    const input = await screen.findByTestId("task-due-at");
    fireEvent.change(input, { target: { value: "2026-09-10T10:30" } });
    pressEscape();

    await waitFor(() => {
      const patches = calls.filter((c) => c.method === "PATCH" && c.url.endsWith("/api/tasks/t1"));
      expect(patches).toHaveLength(2);
      expect(patches[1]?.body).toEqual({
        due_at: new Date("2026-09-10T10:30").getTime(),
        expected_version: 4,
      });
    });
    // El Esc del popover no cerró la ficha.
    expect(screen.getByTestId("task-peek")).toBeTruthy();
  });

  it("un 409 relee la tarea y reabre el popover con el valor nuevo", async () => {
    const task = makeTask({ id: "t1", version: 3, priority: "normal" });
    const reread = makeTask({ id: "t1", version: 5, priority: "urgent" });
    const { calls } = mockFetch([
      { path: "/api/projects/proj-1/people", body: { org_id: "org-1", people: [person] } },
      {
        method: "PATCH",
        path: "/api/tasks/t1",
        status: 409,
        body: { error: { code: "version_conflict", message: "La tarea cambió" } },
      },
      { method: "GET", path: "/api/tasks/t1", body: { task: reread, events: [], artifacts: [], runs: [] } },
    ]);
    renderPeek(task);

    fireEvent.click(screen.getByTestId("prop-priority"));
    fireEvent.click(await screen.findByTestId("priority-option-high"));

    await waitFor(() => {
      expect(calls.some((c) => c.method === "GET" && c.url.endsWith("/api/tasks/t1"))).toBe(true);
    });
    await waitFor(() => expect(useStore.getState().taskDetail?.task.version).toBe(5));
    const notice = await screen.findByTestId("prop-priority-notice");
    expect(notice.textContent).toContain("Otra persona lo cambió a Urgente");
    expect(screen.getByTestId("prop-priority").textContent).toContain("Urgente");
    expect(screen.getByTestId("priority-option-urgent").getAttribute("aria-selected")).toBe("true");
  });

  it("elegir otro proyecto llama a POST /project con expected_version", async () => {
    const task = makeTask({ id: "t1", version: 3 });
    useStore.setState({ board: { projectId: project.id, tasks: { t1: task } } });
    const { calls } = mockFetch([
      { path: /\/api\/projects\/[^/]+\/people$/, body: { org_id: "org-2", people: [person] } },
      {
        method: "POST",
        path: "/api/tasks/t1/project",
        body: { task: makeTask({ id: "t1", version: 4, projectId: projectB.id }) },
      },
      { method: "GET", path: "/api/tasks/t1", body: { task: makeTask({ id: "t1", version: 4, projectId: projectB.id }), events: [], artifacts: [], runs: [] } },
    ]);
    renderPeek(task);

    expect(screen.getByTestId("prop-project").textContent).toContain(project.name);
    fireEvent.click(screen.getByTestId("prop-project"));
    fireEvent.change(await screen.findByTestId("project-search"), { target: { value: "beta" } });
    fireEvent.click(screen.getByTestId("project-option-proj-2"));

    await waitFor(() => {
      const call = calls.find((c) => c.method === "POST" && c.url.endsWith("/api/tasks/t1/project"));
      expect(call?.body).toEqual({ project_id: "proj-2", expected_version: 3 });
    });
    await waitFor(() => expect(useStore.getState().taskDetail?.task.projectId).toBe("proj-2"));
    // La tarjeta salió del tablero viejo, que sigue montado.
    expect(useStore.getState().board.tasks.t1).toBeUndefined();
    expect(screen.getByTestId("prop-project").textContent).toContain(projectB.name);
    expect(screen.getByTestId("prop-status")).toBeTruthy();
  });

  it("task.moved_project quita la tarjeta del tablero viejo y la añade al nuevo (reductor)", () => {
    const task = makeTask({ id: "t1", version: 4, projectId: "proj-2" });
    const oldBoard = { ...emptyEventState(), board: { projectId: "proj-1", tasks: { t1: makeTask({ id: "t1" }) } } };
    const left = reduceEvent(
      oldBoard,
      domainEvent("board:proj-1", 7, "task.moved_project", { task, from_project_id: "proj-1", to_project_id: "proj-2" }),
    );
    expect(left.state.board.tasks.t1).toBeUndefined();
    expect(left.effects).toContainEqual({ kind: "refetch_task", taskId: "t1" });

    const newBoard = { ...emptyEventState(), board: { projectId: "proj-2", tasks: {} } };
    const arrived = reduceEvent(
      newBoard,
      domainEvent("board:proj-2", 8, "task.moved_project", { task, from_project_id: "proj-1", to_project_id: "proj-2" }),
    );
    expect(arrived.state.board.tasks.t1?.projectId).toBe("proj-2");
  });
});

// ── Deep link ───────────────────────────────────────────────────────────────

const probe: { pathname: string; search: string; navigate: ((delta: number) => void) | null } = {
  pathname: "",
  search: "",
  navigate: null,
};

function DeepLinkHarness() {
  useTaskDeepLink();
  const location = useLocation();
  const navigate = useNavigate();
  probe.pathname = location.pathname;
  probe.search = location.search;
  probe.navigate = (delta) => navigate(delta);
  return <TaskDrawer />;
}

describe("deep link ?tarea", () => {
  beforeEach(() => {
    baseState();
    setViewport(1400);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("abrir con ?tarea=t1 monta la ficha; Esc la cierra y limpia la query; Atrás la reabre y vuelve a cerrar sin salir de la vista", async () => {
    const task = makeTask({ id: "t1", version: 3 });
    const { calls } = mockFetch([
      { path: "/api/projects/proj-1/people", body: { org_id: "org-1", people: [person] } },
      { method: "GET", path: "/api/tasks/t1", body: { task, events: [], artifacts: [], runs: [] } },
    ]);
    render(
      <MemoryRouter initialEntries={["/tareas?tarea=t1"]}>
        <DeepLinkHarness />
      </MemoryRouter>,
    );

    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/api/tasks/t1"))).toBe(true));
    await screen.findByTestId("task-peek");
    expect(screen.getByTestId("task-title").textContent).toBe(task.title);

    pressEscape();
    await waitFor(() => expect(screen.queryByTestId("task-peek")).toBeNull());
    expect(probe.pathname).toBe("/tareas");
    expect(probe.search).toBe("");
    expect(useStore.getState().taskDetailId).toBeNull();

    // Atrás deshace el cierre (la URL vuelve a tener ?tarea=t1).
    act(() => probe.navigate?.(-1));
    await waitFor(() => expect(probe.search).toBe("?tarea=t1"));
    await screen.findByTestId("task-peek");

    // Y otra vez Atrás vuelve a la entrada original sin salir de Tareas… que
    // en este historial es la propia apertura; adelante para comprobar que
    // abrir desde la interfaz empuja una entrada y Atrás la cierra.
    act(() => probe.navigate?.(1));
    await waitFor(() => expect(probe.search).toBe(""));
    await waitFor(() => expect(screen.queryByTestId("task-peek")).toBeNull());

    await act(async () => {
      await useStore.getState().openTask("t1");
    });
    await waitFor(() => expect(probe.search).toBe("?tarea=t1"));
    await screen.findByTestId("task-peek");

    act(() => probe.navigate?.(-1));
    await waitFor(() => expect(screen.queryByTestId("task-peek")).toBeNull());
    expect(probe.pathname).toBe("/tareas");
    expect(probe.search).toBe("");
  });
});
