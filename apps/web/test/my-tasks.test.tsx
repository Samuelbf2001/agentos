/**
 * "Mis tareas": agrupación pura por vencimiento + render de la vista + enlace
 * de navegación desde el shell.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import App from "../src/App";
import { useStore } from "../src/state/store";
import MyTasksView, { groupByDue } from "../src/views/MyTasksView";
import { makeTask, mockFetch, person, project } from "./helpers";

describe("groupByDue (pura)", () => {
  const now = new Date("2026-09-05T12:00:00").getTime();

  it("reparte vencidas, hoy, esta semana, después y sin fecha", () => {
    const overdue = makeTask({ id: "t-overdue", dueAt: now - 60_000 });
    const today = makeTask({ id: "t-today", dueAt: now + 3_600_000 });
    const week = makeTask({ id: "t-week", dueAt: now + 3 * 86_400_000 });
    const later = makeTask({ id: "t-later", dueAt: now + 10 * 86_400_000 });
    const none = makeTask({ id: "t-none", dueAt: null });

    const groups = groupByDue([overdue, today, week, later, none], now);
    expect(groups.get("overdue")!.map((t) => t.id)).toEqual(["t-overdue"]);
    expect(groups.get("today")!.map((t) => t.id)).toEqual(["t-today"]);
    expect(groups.get("week")!.map((t) => t.id)).toEqual(["t-week"]);
    expect(groups.get("later")!.map((t) => t.id)).toEqual(["t-later"]);
    expect(groups.get("none")!.map((t) => t.id)).toEqual(["t-none"]);
  });

  it("dentro de un grupo ordena por fecha y luego por título", () => {
    const first = makeTask({ id: "t-1", title: "B tarea", dueAt: now - 120_000 });
    const second = makeTask({ id: "t-2", title: "A tarea", dueAt: now - 60_000 });
    const tieA = makeTask({ id: "t-3", title: "B empatada", dueAt: now + 2 * 86_400_000 });
    const tieB = makeTask({ id: "t-4", title: "A empatada", dueAt: now + 2 * 86_400_000 });

    const groups = groupByDue([first, second, tieA, tieB], now);
    expect(groups.get("overdue")!.map((t) => t.id)).toEqual(["t-1", "t-2"]);
    expect(groups.get("week")!.map((t) => t.id)).toEqual(["t-4", "t-3"]);
  });
});

describe("MyTasksView (render)", () => {
  beforeEach(() => {
    useStore.setState({
      person,
      token: "tok",
      projects: [project],
      activeProjectId: null,
      myTasks: [],
      myTasksLoading: false,
      myTasksError: null,
      labelCatalog: [],
      taskDetail: null,
      taskDetailLoading: false,
      taskDetailError: null,
      toasts: [],
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("pide GET /api/tasks?mine=1, pinta grupos y oculta cerradas hasta marcarlas", async () => {
    const now = Date.now();
    const overdueTask = makeTask({ id: "t-overdue", title: "Tarea vencida", dueAt: now - 100_000 });
    const doneTask = makeTask({ id: "t-done", title: "Tarea cerrada", status: "DONE", dueAt: null });
    const { calls } = mockFetch([
      { path: "/api/tasks", body: { tasks: [overdueTask, doneTask] } },
      { path: "/api/labels", body: { labels: [{ label: "cliente", count: 1 }] } },
      { path: "/api/tasks/t-overdue", body: { task: overdueTask, events: [], artifacts: [], runs: [] } },
    ]);

    render(
      <MemoryRouter>
        <MyTasksView />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByTestId("bucket-overdue")).toBeTruthy());
    expect(screen.getByTestId("my-task-t-overdue")).toBeTruthy();
    expect(screen.queryByTestId("my-task-t-done")).toBeNull();

    expect(
      calls.some(
        (call) => call.method === "GET" && call.url.includes("/api/tasks?") && call.url.includes("mine=1"),
      ),
    ).toBe(true);

    fireEvent.click(screen.getByTestId("my-tasks-show-closed"));
    await waitFor(() => expect(screen.getByTestId("my-task-t-done")).toBeTruthy());
    expect(screen.getByTestId("bucket-none").textContent).toContain("Tarea cerrada");

    fireEvent.click(screen.getByTestId("my-task-t-overdue"));
    await waitFor(() => {
      expect(
        calls.some((call) => call.method === "GET" && call.url.endsWith("/api/tasks/t-overdue")),
      ).toBe(true);
    });
  });

  it("cambiar la etiqueta vuelve a pedir con label= en la query", async () => {
    const { calls } = mockFetch([
      { path: "/api/tasks", body: { tasks: [] } },
      { path: "/api/labels", body: { labels: [{ label: "cliente", count: 2 }] } },
    ]);

    render(
      <MemoryRouter>
        <MyTasksView />
      </MemoryRouter>,
    );

    await waitFor(() =>
      expect(calls.some((call) => call.method === "GET" && call.url.includes("/api/tasks?"))).toBe(true),
    );

    fireEvent.change(screen.getByTestId("my-tasks-label"), { target: { value: "cliente" } });

    await waitFor(() => {
      expect(
        calls.some(
          (call) =>
            call.method === "GET" && call.url.includes("/api/tasks?") && call.url.includes("label=cliente"),
        ),
      ).toBe(true);
    });
  });
});

describe("Navegación: entrada Mis tareas", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("existe un enlace 'Mis tareas' que apunta a /my-tasks", async () => {
    localStorage.setItem("agentos_token", "tok");
    localStorage.setItem("agentos_person", JSON.stringify(person));
    mockFetch([
      { path: "/api/projects", body: { projects: [] } },
      { path: "/api/auth/people", body: { people: [person] } },
      { path: "/api/waiting", body: { approvals: [], review_tasks: [] } },
      { path: "/api/agents", body: { agents: [] } },
      { path: "/api/config/kill-switch", body: { active: false } },
      { path: "/api/runs", body: { runs: [] } },
      { path: "/api/tasks", body: { tasks: [] } },
      { path: "/api/labels", body: { labels: [] } },
    ]);

    render(
      <MemoryRouter initialEntries={["/my-tasks"]}>
        <App />
      </MemoryRouter>,
    );

    // El shell repite la navegación (sidebar de escritorio + barra móvil): ambas
    // deben apuntar a la misma ruta.
    const links = await screen.findAllByRole("link", { name: /Mis tareas/ });
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) expect(link.getAttribute("href")).toBe("/my-tasks");
  });
});
