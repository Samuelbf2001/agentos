/**
 * Hoy: la pantalla de entrada (PLAN-v1.5 §3). Las tres decisiones más urgentes
 * arriba, el resto agrupado por proyecto y por gate, y aprobación en lote sólo
 * para las de riesgo bajo, con llamadas secuenciales a la API que ya existe.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import HoyView from "../src/views/HoyView";
import { useStore } from "../src/state/store";
import { agents, makeApproval, makeArtifact, makeTask, mockFetch, person, project } from "./helpers";
import type { Project } from "../src/lib/types";

const conecty: Project = { ...project, id: "proj-2", name: "Conecty", stage: "CONSTRUIR" };

const approvals = [
  makeApproval({ id: "ap-tool", kind: "tool_call", createdAt: 1_000 }),
  makeApproval({ id: "ap-gate", kind: "gate", createdAt: 5_000, taskId: null, runId: null }),
  makeApproval({ id: "ap-deliv", kind: "deliverable", projectId: conecty.id, createdAt: 2_000 }),
];

const reviewTasks = [
  {
    // Rutinaria de verdad: con su artefacto (M5, un REVIEW sin evidencia no
    // puede ser riesgo bajo, así que no vale como fixture de lote batchable).
    task: makeTask({ id: "t-rutina", status: "REVIEW", title: "Notas de la entrevista 4", updatedAt: 3_000 }),
    artifacts: [makeArtifact({ id: "art-t-rutina", taskId: "t-rutina" })],
  },
  {
    task: makeTask({
      id: "t-sensible",
      status: "REVIEW",
      title: "Correo al sponsor",
      requiresApproval: true,
      updatedAt: 4_000,
    }),
    artifacts: [],
  },
  {
    task: makeTask({ id: "t-rutina-2", status: "REVIEW", title: "Notas de la entrevista 5", updatedAt: 6_000 }),
    artifacts: [makeArtifact({ id: "art-t-rutina-2", taskId: "t-rutina-2" })],
  },
];

function baseRoutes() {
  return [
    { path: "/api/waiting", body: { approvals, review_tasks: reviewTasks } },
    { path: "/api/runs", body: { runs: [] } },
    { path: /^\/api\/projects\/[^/]+\/phase-status$/, body: { status: { launchId: null, complete: false, items: [], reason: "no_launch" } } },
    { path: "/api/tasks", body: { tasks: [] } },
    { path: /^\/api\/tasks\/[^/]+\/approve$/, method: "POST", body: ({ url }: { url: string }) => ({ task: makeTask({ id: url.split("/")[5] ?? "t", status: "DONE" }) }) },
  ];
}

function renderHoy(entry = "/hoy") {
  useStore.setState({
    person,
    token: "tok",
    projects: [project, conecty],
    activeProjectId: project.id,
    agents,
    approvals: [],
    reviewTasks: [],
    board: { projectId: project.id, tasks: {} },
    toasts: [],
  });
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <HoyView />
    </MemoryRouter>,
  );
}

describe("Hoy", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("abre con la frase que importa y cuenta todo lo que espera decisión", async () => {
    mockFetch(baseRoutes());
    renderHoy();
    expect(await screen.findByRole("heading", { name: "Te esperan 6 decisiones" })).toBeTruthy();
  });

  it("pone arriba las tres más urgentes, ordenadas por riesgo", async () => {
    mockFetch(baseRoutes());
    const { container } = renderHoy();
    await screen.findByTestId("decision-approval:ap-tool");

    const order = [...container.querySelectorAll("[data-testid^='decision-approval'], [data-testid^='decision-review']")]
      .map((el) => el.getAttribute("data-testid"))
      .slice(0, 3);
    // Riesgo alto primero y, a igual riesgo, la que lleva más esperando.
    expect(order).toEqual([
      "decision-approval:ap-tool",
      "decision-approval:ap-gate",
      "decision-approval:ap-deliv",
    ]);
  });

  it("dice qué desbloquea un gate y lleva a la ruta del proyecto", async () => {
    mockFetch(baseRoutes());
    renderHoy();
    const gate = await screen.findByTestId("decision-approval:ap-gate");
    expect(gate.textContent).toContain("Cierra Entender");
    expect(gate.textContent).toContain("abre Construir");
    const link = within(gate).getByRole("link", { name: "Ver la ruta y el gate" });
    expect(link.getAttribute("href")).toBe(`/proyectos/${project.id}/ruta`);
  });

  it("renderiza el payload como líneas legibles, con el JSON literal detrás de un desplegable", async () => {
    mockFetch(baseRoutes());
    renderHoy();
    const tool = await screen.findByTestId("decision-approval:ap-tool");
    expect(within(tool).getByText("cliente@acme.com")).toBeTruthy();
    expect(within(tool).getByText("Ver el payload literal")).toBeTruthy();
  });

  it("agrupa el resto por proyecto y por gate", async () => {
    mockFetch(baseRoutes());
    renderHoy();
    const group = await screen.findByTestId(`decision-group-${project.id}|review`);
    expect(group.textContent).toContain("ACME assessment");
    expect(within(group).getAllByTestId(/^decision-review:/).length).toBe(3);
  });

  it("aprueba en lote sólo las de riesgo bajo, una llamada por decisión", async () => {
    const { calls } = mockFetch(baseRoutes());
    renderHoy();

    const bar = await screen.findByTestId("batch-bar");
    expect(bar.textContent).toContain("2 decisiones de riesgo bajo");
    // Lo sensible y los gates no tienen casilla.
    expect(screen.queryByTestId("decision-select-review:t-sensible")).toBeNull();
    expect(screen.queryByTestId("decision-select-approval:ap-gate")).toBeNull();

    fireEvent.click(within(bar).getByText("Seleccionarlas todas"));
    fireEvent.click(screen.getByTestId("batch-approve"));

    await waitFor(() => {
      const approvals = calls.filter((c) => c.method === "POST" && c.url.includes("/approve"));
      expect(approvals.map((c) => c.url.split("/")[5])).toEqual(["t-rutina", "t-rutina-2"]);
    });
  });

  it("si una aprobación del lote falla, cuenta 1 aprobada y 1 fallida y no reporta éxito total (B1)", async () => {
    const routes = baseRoutes().map((route) =>
      route.path instanceof RegExp && route.path.test("/api/tasks/t-rutina-2/approve")
        ? {
            ...route,
            statusFn: ({ url }: { url: string }) => (url.includes("t-rutina-2") ? 409 : 200),
            body: ({ url }: { url: string }) =>
              url.includes("t-rutina-2")
                ? { error: { code: "version_conflict", message: "La tarea cambió" } }
                : { task: makeTask({ id: url.split("/")[5] ?? "t", status: "DONE" }) },
          }
        : route,
    );
    const { calls } = mockFetch(routes);
    renderHoy();

    const bar = await screen.findByTestId("batch-bar");
    fireEvent.click(within(bar).getByText("Seleccionarlas todas"));
    fireEvent.click(screen.getByTestId("batch-approve"));

    await waitFor(() => {
      const approvals = calls.filter((c) => c.method === "POST" && c.url.includes("/approve"));
      expect(approvals.length).toBe(2);
    });

    // No se reintenta tras el fallo real: exactamente una llamada por decisión.
    const approveCalls = calls.filter((c) => c.method === "POST" && c.url.includes("/approve"));
    expect(approveCalls.map((c) => c.url.split("/")[5])).toEqual(["t-rutina", "t-rutina-2"]);

    await waitFor(() => {
      const toasts = useStore.getState().toasts;
      expect(toasts.filter((t) => t.kind === "ok").length).toBe(1);
      expect(toasts.some((t) => t.kind === "error" && t.text.includes("version_conflict"))).toBe(true);
      expect(toasts.some((t) => t.kind === "error" && t.text.includes("Lote detenido: 1 de 2"))).toBe(true);
    });
    expect(useStore.getState().toasts.some((t) => t.text.includes("2 decisiones aprobadas"))).toBe(false);

    // loadApprovals() una sola vez al final del lote (M6): la carga inicial +
    // la del cierre del lote, ninguna intermedia por ítem.
    const waitingCalls = calls.filter((c) => c.url.includes("/api/waiting"));
    expect(waitingCalls.length).toBe(2);
  });

  it("el filtro por proyecto acota la bandeja al cliente que traes del tablero", async () => {
    mockFetch(baseRoutes());
    renderHoy(`/hoy?proyecto=${conecty.id}`);
    expect(await screen.findByRole("heading", { name: "Te espera 1 decisión" })).toBeTruthy();
    expect(screen.getByText("Sólo Conecty")).toBeTruthy();
  });

  it("con la bandeja limpia habla al usuario, no al desarrollador", async () => {
    mockFetch([
      { path: "/api/waiting", body: { approvals: [], review_tasks: [] } },
      { path: "/api/runs", body: { runs: [] } },
      { path: /^\/api\/projects\/[^/]+\/phase-status$/, body: { status: { launchId: null, complete: false, items: [], reason: "no_launch" } } },
      { path: "/api/tasks", body: { tasks: [] } },
    ]);
    renderHoy();
    expect(await screen.findByRole("heading", { name: "Nada espera tu decisión" })).toBeTruthy();
    expect(screen.getByText("Bandeja limpia")).toBeTruthy();
  });
});
