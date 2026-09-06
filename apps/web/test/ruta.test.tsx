/**
 * La Ruta (PLAN-v1.5 §4). Antes era un panel enterrado bajo los filtros del
 * tablero y el gate era un cartel: aquí el candado es el botón que hace avanzar
 * el sistema, y cada entregable que falta enlaza a la tarea que lo produce.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import RutaView from "../src/views/RutaView";
import { useStore } from "../src/state/store";
import { agents, makeTask, mockFetch, person, project } from "./helpers";
import type { LaunchReceipt, PhaseClosureStatus, Project } from "../src/lib/types";

const receipt: LaunchReceipt = {
  id: "l-1",
  module_slug: "consultoria",
  module_version: 1,
  module_name: "Consultoría (Assessment 14 días)",
  phase: "ENTENDER",
  org_id: "org-1",
  project_id: project.id,
  inputs: { empresa: "ACME", objetivo: "[redacted]", areas: ["direccion", "operaciones"] },
  toggles: { iso9001: true },
  task_count: 9,
  budget_phase_usd: 15,
  budget_per_run_usd: 2,
  previous_launch_id: null,
  actor: "person:p-ernesto",
  actor_name: "Ernesto",
  label: "Disparado desde Consultoría (Assessment 14 días) v1 por Ernesto",
  created_at: Date.parse("2026-08-20T15:00:00Z"),
};

const incomplete: PhaseClosureStatus = {
  launchId: "l-1",
  complete: false,
  items: [
    {
      kind: "proceso_asis",
      source: "process",
      required: 2,
      found: 0,
      missing: 'Falta(n) 2 de 2 "proceso_asis" — procesos as-is',
    },
    { kind: "resumen_ejecutivo", source: "knowledge_doc", required: 1, found: 1, missing: null },
  ],
};

const complete: PhaseClosureStatus = {
  launchId: "l-1",
  complete: true,
  items: incomplete.items.map((i) => ({ ...i, found: i.required, missing: null })),
};

const producer = makeTask({
  id: "t-asis",
  title: "Mapear los procesos as-is",
  activityType: "proceso_asis",
  status: "IN_PROGRESS",
});

function routes(status: PhaseClosureStatus, launches: LaunchReceipt[] = [receipt], gateProject?: Project) {
  return [
    { path: `/api/projects/${project.id}/launches`, body: { launches } },
    { path: `/api/projects/${project.id}/phase-status`, body: { status } },
    { path: "/api/runs", body: { runs: [] } },
    { path: "/api/projects", body: { projects: [gateProject ?? project] } },
    {
      path: `/api/projects/${project.id}/gate`,
      method: "POST",
      body: { project: gateProject ?? { ...project, gateState: "approved" } },
    },
    { path: /^\/api\/tasks\/[^/]+$/, body: { task: producer, events: [], artifacts: [], runs: [] } },
  ];
}

function renderRuta(p: Project = project) {
  useStore.setState({
    person,
    token: "tok",
    projects: [p],
    activeProjectId: p.id,
    agents,
    board: { projectId: p.id, tasks: { [producer.id]: producer } },
    toasts: [],
  });
  return render(
    <MemoryRouter initialEntries={[`/proyectos/${p.id}/ruta`]}>
      <RutaView project={p} />
    </MemoryRouter>,
  );
}

describe("Ruta del proyecto", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("pinta el mapa del ciclo con las tres columnas y el recibo del launch", async () => {
    mockFetch(routes(incomplete));
    renderRuta();

    expect(await screen.findByTestId("cycle-map")).toBeTruthy();
    expect(screen.getByTestId("cycle-column-ENTENDER")).toBeTruthy();
    expect(screen.getByTestId("cycle-column-CONSTRUIR")).toBeTruthy();
    expect(screen.getByTestId("cycle-column-OPERAR")).toBeTruthy();

    const recibo = await screen.findByTestId("launch-receipt");
    expect(recibo.textContent).toContain("Consultoría (Assessment 14 días) v1");
    expect(recibo.textContent).toContain("Ernesto");
    expect(recibo.textContent).toContain("9");
    // Los inputs llegan ya redactados del servidor y se pintan tal cual.
    expect(recibo.textContent).toContain("[redacted]");
    expect(recibo.textContent).toContain("direccion, operaciones");
  });

  it("rotula la columna del mapa como trabajo de la fase y el panel de cierre como Entregables (Context Hub)", async () => {
    mockFetch(routes(incomplete));
    renderRuta();

    const column = await screen.findByTestId("cycle-column-ENTENDER");
    expect(column.textContent).toContain("Trabajo de la fase");
    // El contador de cada hito dice qué cuenta, no un "N/M" desnudo.
    expect(column.textContent).toMatch(/\d+\/\d+ tareas cerradas/);

    const closurePanel = await screen.findByTestId("phase-closure");
    expect(closurePanel.textContent).toContain("Entregables (Context Hub)");
  });

  it("con entregables pendientes el candado sigue cerrado y no ofrece aprobar", async () => {
    mockFetch(routes(incomplete));
    renderRuta();

    const gate = await screen.findByTestId("gate-G1");
    expect(gate.getAttribute("data-gate-state")).toBe("locked");
    expect(screen.queryByTestId("gate-approve-G1")).toBeNull();
    expect(screen.getByText(/espera 1 entregable/)).toBeTruthy();
  });

  it("cada entregable que falta enlaza a la tarea que lo produce", async () => {
    mockFetch(routes(incomplete));
    renderRuta();

    const missing = await screen.findByTestId("missing-proceso_asis");
    // Nombre legible, nunca la enumeración cruda, y el título de la tarea.
    expect(missing.textContent).toContain("Procesos as-is");
    expect(missing.textContent).toContain("Mapear los procesos as-is");
    fireEvent.click(missing);
    await waitFor(() => {
      expect(useStore.getState().taskDetailId).toBe(producer.id);
    });
    useStore.getState().closeTask();
  });

  it("con todo completo el candado se abre y aprobarlo llama al gate de la API", async () => {
    const { calls } = mockFetch(routes(complete));
    renderRuta();

    const approve = await screen.findByTestId("gate-approve-G1");
    fireEvent.click(approve);

    await waitFor(() => {
      const call = calls.find(
        (c) => c.method === "POST" && c.url.includes(`/api/projects/${project.id}/gate`),
      );
      expect(call).toBeTruthy();
      expect((call?.body as { decision: string }).decision).toBe("approve");
    });
    // Tras aprobar, el candado queda verde con quién y cuándo.
    await waitFor(() => {
      expect(screen.getByTestId("gate-G1").getAttribute("data-gate-state")).toBe("passed");
    });
    expect(screen.getByTestId("gate-G1").textContent).toContain("Ernesto");
  });

  it("con la fase cerrada ofrece lanzar la siguiente por el asistente", async () => {
    const approved: Project = { ...project, gateState: "approved" };
    mockFetch(routes(complete, [receipt], approved));
    renderRuta(approved);

    expect(await screen.findByTestId("next-phase")).toBeTruthy();
    expect(screen.getByTestId("next-phase").textContent).toContain("Construir");
  });

  it("un proyecto sin launch lo dice con palabras, no con un panel vacío", async () => {
    mockFetch(routes({ launchId: null, complete: false, items: [], reason: "no_launch" }, []));
    renderRuta();

    expect(
      await screen.findByText(/no nació de un módulo de fase/),
    ).toBeTruthy();
    expect(screen.queryByTestId("launch-receipt")).toBeNull();
  });
});
