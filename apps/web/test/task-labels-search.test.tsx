/**
 * Etiquetas de tarea (editor aislado + drawer + filtro del tablero) y caja de
 * búsqueda de tareas con antirrebote.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { useStore } from "../src/state/store";
import BoardView from "../src/views/BoardView";
import { TaskDrawer } from "../src/views/TaskDrawer";
import { LabelsEditor } from "../src/views/task/LabelsPicker";
import { SearchHitRow, TaskSearchBox } from "../src/views/TaskSearchBox";
import type { TaskSearchHit } from "../src/lib/types";
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
    taskDetail: null,
    taskDetailLoading: false,
    taskDetailError: null,
    taskMutationError: null,
    taskSaving: false,
    toasts: [],
    labelCatalog: [],
    blockedMove: null,
    boardFilter: "all",
    boardLabelFilter: null,
    taskSearchResults: [],
    taskSearchLoading: false,
    taskSearchError: null,
    board: { projectId: project.id, tasks: {} },
  });
}

/** El editor es controlado: quien lo abre guarda al cerrar el popover. */
function ControlledLabels({ onChange }: { onChange: (labels: string[]) => void }) {
  const [value, setValue] = useState(["cliente"]);
  return (
    <LabelsEditor
      value={value}
      catalog={[]}
      onChange={(labels) => {
        setValue(labels);
        onChange(labels);
      }}
    />
  );
}

describe("LabelsEditor aislado", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("añade con Enter normalizando a minúsculas y sin duplicados, y permite quitar", () => {
    const onChange = vi.fn();
    render(<ControlledLabels onChange={onChange} />);

    const input = screen.getByTestId("task-label-input");
    fireEvent.change(input, { target: { value: "  URGENTE  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByText("urgente")).toBeTruthy();

    // Duplicado (mismo valor normalizado que ya existe): no se añade dos veces.
    fireEvent.change(input, { target: { value: "Cliente" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getAllByText("cliente")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Quitar etiqueta cliente" }));

    expect(onChange).toHaveBeenLastCalledWith(["urgente"]);
    expect(screen.queryByTestId("save-labels")).toBeNull();
  });
});

describe("Etiquetas en el drawer completo", () => {
  beforeEach(() => {
    baseState();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("PUT /api/tasks/t1/labels recibe { labels } sin expected_version", async () => {
    const task = makeTask({ id: "t1", version: 3, labels: ["cliente"] });
    useStore.setState({ taskDetail: { task, events: [], artifacts: [], runs: [], project } });
    const { calls } = mockFetch([
      { path: "/api/projects/proj-1/people", body: { org_id: "org-1", people: [person] } },
      {
        method: "PUT",
        path: "/api/tasks/t1/labels",
        body: { task: { ...task, labels: ["cliente", "urgente"] }, labels: ["cliente", "urgente"] },
      },
    ]);

    render(
      <MemoryRouter>
        <TaskDrawer />
      </MemoryRouter>,
    );

    // Etiquetas va plegada tras "N más propiedades"; el popover guarda al cerrar.
    fireEvent.click(screen.getByTestId("task-more-properties"));
    fireEvent.click(screen.getByTestId("prop-labels"));
    const input = await screen.findByTestId("task-label-input");
    fireEvent.change(input, { target: { value: "urgente" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.queryByTestId("save-labels")).toBeNull();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });

    await waitFor(() => {
      const call = calls.find((c) => c.method === "PUT" && c.url.endsWith("/api/tasks/t1/labels"));
      expect(call?.body).toEqual({ labels: ["cliente", "urgente"] });
      expect(call?.body).not.toHaveProperty("expected_version");
    });
  });
});

describe("Filtro por etiqueta en el tablero", () => {
  beforeEach(() => {
    baseState();
    mockFetch([
      { path: "/api/projects/proj-1/launches", body: { launches: [] } },
      { path: "/api/projects/proj-1/phase-status", body: { status: { reason: "no_launch" } } },
    ]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("pinta los chips y filtra tarjetas por etiqueta", () => {
    const withLabel = makeTask({ id: "t-con", labels: ["cliente"] });
    const withoutLabel = makeTask({ id: "t-sin", labels: [] });
    useStore.setState({
      labelCatalog: [{ label: "cliente", count: 1 }],
      board: { projectId: project.id, tasks: { "t-con": withLabel, "t-sin": withoutLabel } },
    });

    render(<BoardView projectId={project.id} />);

    expect(screen.getByTestId("card-labels-t-con").textContent).toContain("cliente");
    expect(screen.getByTestId("task-card-t-con")).toBeTruthy();
    expect(screen.getByTestId("task-card-t-sin")).toBeTruthy();

    fireEvent.click(screen.getByTestId("board-label-cliente"));
    expect(screen.getByTestId("task-card-t-con")).toBeTruthy();
    expect(screen.queryByTestId("task-card-t-sin")).toBeNull();

    fireEvent.click(screen.getByTestId("board-label-all"));
    expect(screen.getByTestId("task-card-t-con")).toBeTruthy();
    expect(screen.getByTestId("task-card-t-sin")).toBeTruthy();
  });
});

describe("TaskSearchBox", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    baseState();
  });

  it("dispara la búsqueda antirrebotada y pinta resultados", async () => {
    const hits: TaskSearchHit[] = [
      {
        id: "t-hit-1",
        projectId: project.id,
        title: "Mapear el proceso de cobranza",
        status: "READY",
        stage: "ENTENDER",
        dueAt: null,
        snippet: "…proceso de cobranza…",
        source: "task",
        rank: 1,
      },
      {
        id: "t-hit-2",
        projectId: project.id,
        title: "Otra tarea",
        status: "IN_PROGRESS",
        stage: "ENTENDER",
        dueAt: null,
        snippet: "…mencionada en un comentario…",
        source: "comment",
        rank: 2,
      },
    ];
    const { calls } = mockFetch([
      { path: "/api/tasks/search", body: { query: "cobranza", hits } },
      {
        path: "/api/tasks/t-hit-1",
        body: { task: makeTask({ id: "t-hit-1" }), events: [], artifacts: [], runs: [] },
      },
    ]);

    render(<TaskSearchBox />);
    fireEvent.change(screen.getByTestId("task-search"), { target: { value: "cobranza" } });

    await waitFor(
      () => {
        expect(screen.getByTestId("task-search-results")).toBeTruthy();
        expect(screen.getByTestId("search-hit-t-hit-1")).toBeTruthy();
      },
      { timeout: 1000 },
    );
    expect(
      calls.some((call) => call.method === "GET" && call.url.includes("/api/tasks/search") && call.url.includes("q=cobranza")),
    ).toBe(true);
    expect(screen.getByTestId("search-hit-t-hit-2").textContent).toContain("en un comentario");

    fireEvent.click(screen.getByTestId("search-hit-t-hit-1"));
    await waitFor(() => {
      expect(calls.some((call) => call.method === "GET" && call.url.endsWith("/api/tasks/t-hit-1"))).toBe(
        true,
      );
    });
  });
});

describe("SearchHitRow aislado", () => {
  it("marca los resultados que provienen de un comentario", () => {
    const hit: TaskSearchHit = {
      id: "t-1",
      projectId: "proj-1",
      title: "Tarea con match en comentario",
      status: "READY",
      stage: "ENTENDER",
      dueAt: null,
      snippet: "…",
      source: "comment",
      rank: 1,
    };
    render(
      <ul>
        <SearchHitRow hit={hit} onOpen={vi.fn()} />
      </ul>,
    );
    expect(screen.getByText("en un comentario")).toBeTruthy();
  });
});
