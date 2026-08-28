/** Smoke de render de cada vista principal con datos fixture (API mockeada). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { useStore } from "../src/state/store";
import BoardView from "../src/views/BoardView";
import ChatView from "../src/views/ChatView";
import SwarmView from "../src/views/SwarmView";
import RunsView from "../src/views/RunsView";
import RunDetailView from "../src/views/RunDetailView";
import WaitingView from "../src/views/WaitingView";
import ContextView from "../src/views/ContextView";
import AdminView from "../src/views/AdminView";
import LoginView from "../src/views/LoginView";
import {
  agents,
  makeApproval,
  makeMessage,
  makeRun,
  makeTask,
  mockFetch,
  person,
  project,
  thread,
} from "./helpers";

function ui(el: React.ReactElement, path = "/") {
  return render(<MemoryRouter initialEntries={[path]}>{el}</MemoryRouter>);
}

const baseRoutes = [
  { path: "/api/auth/people", body: { people: [person] } },
  { path: "/api/threads", body: { threads: [thread] } },
  { path: /^\/api\/threads\/[^/]+\/messages$/, body: { messages: [makeMessage()] } },
  { path: /^\/api\/threads\/[^/]+$/, body: { thread, last_seq: 3 } },
  { path: "/api/runs", body: { runs: [makeRun()] } },
  {
    path: /^\/api\/runs\/r1$/,
    body: { run: makeRun(), spans: [], tree: [makeRun()], last_seq: 5 },
  },
  { path: "/api/approvals/pending", body: { approvals: [makeApproval()] } },
  {
    path: "/api/waiting",
    body: {
      approvals: [makeApproval()],
      review_tasks: [
        { task: makeTask({ id: "t-review", status: "REVIEW", title: "Informe en revisión" }), artifacts: [] },
      ],
    },
  },
  { path: "/api/knowledge", body: { docs: [] } },
  { path: "/api/processes", body: { processes: [] } },
  { path: "/api/methodologies", body: { methodologies: [] } },
  { path: "/api/config", body: { config: [] } },
  { path: /^\/api\/tasks\/[^/]+$/, body: { task: makeTask(), events: [], artifacts: [], runs: [] } },
];

describe("smoke de vistas", () => {
  beforeEach(() => {
    mockFetch(baseRoutes);
    useStore.setState({
      person,
      token: "tok",
      projects: [project],
      activeProjectId: project.id,
      agents,
      approvals: [makeApproval()],
      board: { projectId: project.id, tasks: { t1: makeTask() } },
      chat: { threadId: thread.id, messages: [makeMessage()], streams: {} },
      threads: [thread],
      toolCalls: {},
      createdTasks: [],
      runsLive: {},
      edges: [],
      toasts: [],
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("LoginView pinta selector de persona y contraseña", async () => {
    ui(<LoginView />);
    expect(await screen.findByText("¿Quién eres?")).toBeTruthy();
    expect(screen.getByLabelText("Contraseña compartida")).toBeTruthy();
  });

  it("BoardView pinta carriles, columnas y la tarjeta", () => {
    ui(<BoardView />);
    expect(screen.getByText("Entender")).toBeTruthy();
    expect(screen.getAllByText("BACKLOG").length).toBeGreaterThan(0);
    expect(screen.getByText("Mapear proceso de ventas")).toBeTruthy();
  });

  it("ChatView pinta hilos y mensajes", async () => {
    ui(<ChatView />);
    expect(await screen.findByText("Arranca un assessment para ACME")).toBeTruthy();
    expect(screen.getByText("＋ Nuevo hilo")).toBeTruthy();
  });

  it("SwarmView pinta un nodo por agente", async () => {
    ui(<SwarmView />);
    expect(await screen.findByTestId("swarm-node-alex")).toBeTruthy();
    expect(screen.getByTestId("swarm-node-sam")).toBeTruthy();
  });

  it("RunsView lista runs con coste", async () => {
    ui(<RunsView />);
    expect(await screen.findByText("$0.0123")).toBeTruthy();
    expect(screen.getByText("Todos los agentes")).toBeTruthy();
  });

  it("RunDetailView pinta tokens y botón Reproducir", async () => {
    render(
      <MemoryRouter initialEntries={["/runs/r1"]}>
        <Routes>
          <Route path="/runs/:runId" element={<RunDetailView />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText("▶ Reproducir")).toBeTruthy();
    expect(screen.getByText("Tokens in / out")).toBeTruthy();
  });

  it("WaitingView pinta la aprobación pendiente con su payload literal", async () => {
    ui(<WaitingView />);
    expect(await screen.findByText("email.send")).toBeTruthy();
    expect(screen.getByText("✓ Aprobar")).toBeTruthy();
  });

  it("WaitingView pinta también los entregables en REVIEW (H10)", async () => {
    ui(<WaitingView />);
    // loadApprovals (vía /api/waiting) trae la tarjeta en REVIEW a la bandeja.
    expect(await screen.findByText("Informe en revisión")).toBeTruthy();
    expect(screen.getByText("Entregable en REVIEW")).toBeTruthy();
    expect(screen.getByText("✓ Aprobar → DONE")).toBeTruthy();
  });

  it("ContextView pinta pestañas y estado vacío", async () => {
    ui(<ContextView />);
    expect(screen.getByText("Documentos")).toBeTruthy();
    expect(await screen.findByText("Sin documentos")).toBeTruthy();
  });

  it("AdminView pinta la tabla de agentes con pausa", async () => {
    ui(<AdminView />);
    expect(await screen.findByText("Alex")).toBeTruthy();
    expect(screen.getAllByText("⏸ Pausar").length).toBeGreaterThan(0);
  });
});
