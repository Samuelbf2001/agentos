/**
 * Ficha de tarea: bloqueo por regla anti-teatro (missing_artifact), adjuntar
 * evidencia y reintentar, y edición de título/prioridad/definición de
 * terminado.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { useStore } from "../src/state/store";
import { ArtifactAttacher, TaskDrawer } from "../src/views/TaskDrawer";
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
    board: { projectId: project.id, tasks: {} },
  });
}

describe("mover a DONE sin artefacto", () => {
  beforeEach(() => {
    baseState();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("muestra qué falta, revierte el tablero y ofrece reintentar", async () => {
    const task = makeTask({ id: "t1", status: "READY", version: 3 });
    useStore.setState({ board: { projectId: project.id, tasks: { t1: task } } });
    mockFetch([
      {
        method: "POST",
        path: "/api/tasks/t1/move",
        status: 422,
        body: {
          error: {
            code: "missing_artifact",
            message: "Adjunta un archivo o enlace antes de mover a DONE.",
          },
        },
      },
      { path: "/api/tasks/t1", body: { task, events: [], artifacts: [], runs: [] } },
    ]);

    const ok = await useStore.getState().moveTaskOptimistic("t1", "DONE");
    expect(ok).toBe(false);
    expect(useStore.getState().board.tasks.t1?.status).toBe("READY");
    expect(useStore.getState().blockedMove).toEqual({
      taskId: "t1",
      to: "DONE",
      code: "missing_artifact",
      message: "Adjunta un archivo o enlace antes de mover a DONE.",
    });

    render(
      <MemoryRouter>
        <TaskDrawer />
      </MemoryRouter>,
    );
    const notice = screen.getByTestId("blocked-move");
    expect(notice.textContent).toContain("Adjunta un archivo o enlace antes de mover a DONE.");
    expect(screen.getByTestId("blocked-move-retry")).toBeTruthy();
  });

  it("tras adjuntar evidencia y reintentar, el aviso desaparece", async () => {
    const task = makeTask({ id: "t1", status: "READY", version: 3 });
    useStore.setState({
      board: { projectId: project.id, tasks: { t1: task } },
      taskDetail: { task, events: [], artifacts: [], runs: [], project },
      blockedMove: {
        taskId: "t1",
        to: "DONE",
        code: "missing_artifact",
        message: "Adjunta un archivo o enlace antes de mover a DONE.",
      },
    });
    const { calls } = mockFetch([
      {
        method: "POST",
        path: "/api/tasks/t1/artifacts",
        status: 201,
        body: {
          artifact: {
            id: "art-1",
            taskId: "t1",
            runId: null,
            kind: "link",
            title: "Informe",
            content: null,
            path: "https://example.com/informe.pdf",
            meta: null,
            createdBy: null,
            createdAt: 1,
          },
        },
      },
      {
        path: "/api/tasks/t1",
        body: {
          task,
          events: [],
          artifacts: [
            {
              id: "art-1",
              taskId: "t1",
              runId: null,
              kind: "link",
              title: "Informe",
              content: null,
              path: "https://example.com/informe.pdf",
              meta: null,
              createdBy: null,
              createdAt: 1,
            },
          ],
          runs: [],
        },
      },
      {
        method: "POST",
        path: "/api/tasks/t1/move",
        status: 200,
        body: { task: makeTask({ id: "t1", status: "DONE", version: 4 }) },
      },
    ]);

    render(
      <MemoryRouter>
        <TaskDrawer />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByTestId("artifact-mode-link"));
    fireEvent.change(screen.getByTestId("artifact-url"), {
      target: { value: "https://example.com/informe.pdf" },
    });
    fireEvent.change(screen.getByTestId("artifact-title"), { target: { value: "Informe" } });
    fireEvent.click(screen.getByTestId("artifact-submit"));

    await waitFor(() => {
      expect(
        calls.some((call) => call.method === "POST" && call.url.endsWith("/api/tasks/t1/artifacts")),
      ).toBe(true);
    });

    await waitFor(() => expect(screen.getByTestId("blocked-move-retry")).toBeTruthy());
    fireEvent.click(screen.getByTestId("blocked-move-retry"));

    await waitFor(() => expect(useStore.getState().blockedMove).toBeNull());
  });
});

describe("ArtifactAttacher aislado", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rechaza en línea una URL sin http(s) y acepta una válida", async () => {
    const onUpload = vi.fn();
    const onLink = vi.fn().mockResolvedValue(true);
    render(<ArtifactAttacher saving={false} onUpload={onUpload} onLink={onLink} />);

    fireEvent.click(screen.getByTestId("artifact-mode-link"));
    fireEvent.change(screen.getByTestId("artifact-url"), { target: { value: "ftp://malo.com" } });
    expect(screen.getByRole("alert").textContent).toContain("http://");
    expect((screen.getByTestId("artifact-submit") as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByTestId("artifact-url"), {
      target: { value: "https://example.com/deliverable" },
    });
    fireEvent.change(screen.getByTestId("artifact-title"), { target: { value: "Deliverable" } });
    fireEvent.click(screen.getByTestId("artifact-submit"));

    await waitFor(() =>
      expect(onLink).toHaveBeenCalledWith({ title: "Deliverable", url: "https://example.com/deliverable" }),
    );
    expect(onUpload).not.toHaveBeenCalled();
  });

  it("sube un archivo con onUpload cuando el modo es archivo", async () => {
    const onUpload = vi.fn().mockResolvedValue(true);
    const onLink = vi.fn();
    render(<ArtifactAttacher saving={false} onUpload={onUpload} onLink={onLink} />);

    const file = new File(["x"], "informe.txt", { type: "text/plain" });
    const input = screen.getByTestId("artifact-file") as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });
    fireEvent.click(screen.getByTestId("artifact-submit"));

    await waitFor(() => expect(onUpload).toHaveBeenCalledWith(file, undefined));
    expect(onLink).not.toHaveBeenCalled();
  });
});

describe("Ficha de tarea: campos editables", () => {
  beforeEach(() => {
    baseState();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function renderDrawerWith(task: ReturnType<typeof makeTask>) {
    useStore.setState({ taskDetail: { task, events: [], artifacts: [], runs: [], project } });
    return render(
      <MemoryRouter>
        <TaskDrawer />
      </MemoryRouter>,
    );
  }

  // Rediseño Notion: el título es un H1 contenteditable que guarda en blur;
  // ya no existen "Editar título" ni "Guardar título".
  it("editar el título en sitio guarda con PATCH y expected_version al perder el foco", async () => {
    const task = makeTask({ id: "t1", version: 3 });
    const { calls } = mockFetch([
      { path: "/api/projects/proj-1/people", body: { org_id: "org-1", people: [person] } },
      {
        method: "PATCH",
        path: "/api/tasks/t1",
        body: ({ body }: { body: unknown }) => ({
          task: { ...task, ...(body as Record<string, unknown>) },
        }),
      },
    ]);
    renderDrawerWith(task);

    expect(screen.queryByTestId("edit-title")).toBeNull();
    const title = screen.getByTestId("task-title");
    title.textContent = "Mapear el proceso de cobranza";
    fireEvent.blur(title);

    await waitFor(() => {
      const call = calls.find((c) => c.method === "PATCH" && c.url.endsWith("/api/tasks/t1"));
      expect(call?.body).toEqual({ title: "Mapear el proceso de cobranza", expected_version: 3 });
    });
  });

  it("vaciar el título no guarda: se restaura el anterior", () => {
    const task = makeTask({ id: "t1", version: 3 });
    const { calls } = mockFetch([
      { path: "/api/projects/proj-1/people", body: { org_id: "org-1", people: [person] } },
    ]);
    renderDrawerWith(task);

    const title = screen.getByTestId("task-title");
    title.textContent = "   ";
    fireEvent.blur(title);

    expect(title.textContent).toBe(task.title);
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("cambiar la prioridad desde el popover dispara PATCH con priority", async () => {
    const task = makeTask({ id: "t1", version: 3 });
    const { calls } = mockFetch([
      { path: "/api/projects/proj-1/people", body: { org_id: "org-1", people: [person] } },
      {
        method: "PATCH",
        path: "/api/tasks/t1",
        body: ({ body }: { body: unknown }) => ({
          task: { ...task, ...(body as Record<string, unknown>) },
        }),
      },
    ]);
    renderDrawerWith(task);

    fireEvent.click(screen.getByTestId("prop-priority"));
    fireEvent.click(await screen.findByTestId("priority-option-high"));

    await waitFor(() => {
      const call = calls.find((c) => c.method === "PATCH" && c.url.endsWith("/api/tasks/t1"));
      expect(call?.body).toEqual({ priority: "high", expected_version: 3 });
    });
  });

  it("editar la definición de terminado guarda en blur con definition_of_done", async () => {
    const task = makeTask({ id: "t1", version: 3, definitionOfDone: "Mapa SIPOC validado" });
    const { calls } = mockFetch([
      { path: "/api/projects/proj-1/people", body: { org_id: "org-1", people: [person] } },
      {
        method: "PATCH",
        path: "/api/tasks/t1",
        body: ({ body }: { body: unknown }) => ({
          task: { ...task, ...(body as Record<string, unknown>) },
        }),
      },
    ]);
    renderDrawerWith(task);

    expect(screen.queryByTestId("edit-dod")).toBeNull();
    fireEvent.change(screen.getByTestId("task-dod-input"), {
      target: { value: "Mapa SIPOC validado por el cliente" },
    });
    fireEvent.blur(screen.getByTestId("task-dod-input"));

    await waitFor(() => {
      const call = calls.find((c) => c.method === "PATCH" && c.url.endsWith("/api/tasks/t1"));
      expect(call?.body).toEqual({
        definition_of_done: "Mapa SIPOC validado por el cliente",
        expected_version: 3,
      });
    });
  });

  it("sin definición de terminado se ve el aviso dod-missing", () => {
    const task = makeTask({ id: "t1", version: 3, definitionOfDone: null });
    renderDrawerWith(task);
    expect(screen.getByTestId("dod-missing")).toBeTruthy();
  });
});
