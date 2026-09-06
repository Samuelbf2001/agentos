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
import HoyView from "../src/views/HoyView";
import ProjectsView from "../src/views/ProjectsView";
import TareasView from "../src/views/TareasView";
import SystemHealthView from "../src/views/SystemHealthView";
import SystemTeamView from "../src/views/SystemTeamView";
import AssetView from "../src/views/AssetView";
import ContextView from "../src/views/ContextView";
import AdminView from "../src/views/AdminView";
import { AgentsSection } from "../src/views/AgentsSection";
import LoginView from "../src/views/LoginView";
import {
  agents,
  makeApproval,
  makeMessage,
  makeRun,
  makeTask,
  mockFetch,
  person,
  personB,
  project,
  projectB,
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
  { path: /^\/api\/projects\/[^/]+\/sources$/, body: { sources: [] } },
  { path: /^\/api\/projects\/[^/]+\/phase-status$/, body: { status: { launchId: null, complete: false, items: [], reason: "no_launch" } } },
  { path: "/api/processes", body: { processes: [] } },
  {
    path: "/api/methodologies",
    body: {
      methodologies: [
        { id: "m-1", slug: "sixteam-core", version: 2, bodyMd: "# Método", changelog: null, createdAt: 1, updatedAt: 1 },
      ],
    },
  },
  {
    path: "/api/modules",
    body: {
      modules: [
        {
          slug: "consultoria",
          version: 1,
          name: "Consultoría (Assessment 14 días)",
          phase: "ENTENDER",
          project_type: "assessment",
          status: "active",
          methodology: { slug: "sixteam-core", version: 2 },
          templates_count: 9,
          blueprint_hash: "abc",
        },
      ],
    },
  },
  {
    path: "/api/brain/overview",
    body: {
      generated_at: "2026-09-05T10:00:00.000Z",
      core: {
        counts: { projects: 3, tasks: 40, people: 2, agents: 2, knowledge_docs: 8, project_sources: 4 },
        people: [
          { id: "p-ana", full_name: "Ana García", role: "Dirección", is_internal: true },
          { id: "p-cli", full_name: "Cliente Demo", role: "Sponsor", is_internal: false },
        ],
      },
      agents: {
        items: [
          {
            id: "a-alex",
            slug: "alex",
            name: "Alex",
            layer: "consultoria",
            runtime: "ai_sdk",
            model: "claude-sonnet-4-5",
            autonomy: "supervised",
            status: "active",
          },
        ],
        tree: null,
        health: [],
      },
      sources: [
        {
          id: "agentos",
          label: "AgentOS",
          status: "connected",
          mode: "local",
          last_checked_at: "2026-09-05T09:59:00.000Z",
          counts: { projects: 3 },
          detail: "Núcleo de trabajo operativo.",
        },
      ],
      modules: [
        {
          id: "board",
          label: "Tablero",
          description: "Tareas y proyectos como verdad operativa.",
          source_id: "agentos",
          status: "available",
        },
      ],
    },
  },
  { path: "/api/config", body: { config: [] } },
  { path: "/api/projects", body: { projects: [project, projectB] } },
  { path: "/api/labels", body: { labels: [] } },
  {
    path: "/api/tasks",
    body: {
      tasks: [makeTask(), makeTask({ id: "t2", projectId: projectB.id, title: "Cadencia semanal" })],
    },
  },
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
    ui(<BoardView projectId={project.id} />);
    expect(screen.getByText("Entender")).toBeTruthy();
    expect(screen.getAllByText("Backlog").length).toBeGreaterThan(0);
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

  it("Hoy pinta la aprobación pendiente y el entregable en revisión (antes «Esperando por ti»)", async () => {
    ui(<HoyView />);
    // loadApprovals (vía /api/waiting) trae ambas cosas a la misma bandeja.
    expect(await screen.findByText("Autorizar email.send")).toBeTruthy();
    expect(screen.getByText("Informe en revisión")).toBeTruthy();
    expect(screen.getAllByText("Aprobar").length).toBeGreaterThan(0);
  });

  it("Tareas pinta la base transversal: dos clientes en la misma lista", async () => {
    useStore.setState({ projects: [project, projectB], people: [person, personB] });
    ui(<TareasView />, "/tareas");
    expect(await screen.findByRole("heading", { level: 1, name: "Tareas" })).toBeTruthy();
    expect(await screen.findByTestId("tarea-fila-t1")).toBeTruthy();
    expect(screen.getByTestId("tarea-fila-t2")).toBeTruthy();
    expect(screen.getByTestId("tareas-resumen").textContent).toContain("2 clientes");
  });

  it("ProjectsView lista los clientes con su posición en el ciclo", async () => {
    ui(<ProjectsView />);
    expect(await screen.findByRole("heading", { level: 1, name: "Clientes" })).toBeTruthy();
    expect(screen.getAllByText(project.name).length).toBeGreaterThan(0);
  });

  it("Sistema › Fuentes pinta las fuentes (lo que era el Cerebro) y enlaza a la cola de 2brain", async () => {
    ui(<SystemHealthView />);
    expect(await screen.findByText("AgentOS")).toBeTruthy();
    expect(screen.getByText("Núcleo de trabajo operativo.")).toBeTruthy();
    expect(screen.queryByText("Cola de reuniones")).toBeNull();
    expect(screen.getByRole("link", { name: "Ver la cola de reuniones en 2brain" }).getAttribute("href")).toBe(
      "/2brain/reuniones",
    );
  });

  it("Sistema › Equipo pinta personas y agentes", async () => {
    ui(<SystemTeamView />);
    expect(await screen.findByText("Ana García")).toBeTruthy();
    expect(screen.getByText("Sixteam")).toBeTruthy();
  });

  it("Sistema › Equipo pinta la tabla de agentes aunque /api/brain/overview falle", async () => {
    mockFetch(baseRoutes.map((route) => (route.path === "/api/brain/overview" ? { ...route, status: 500 } : route)));
    ui(<SystemTeamView />);
    expect(await screen.findByText("Alex")).toBeTruthy();
  });

  it("Activo Sixteam pinta módulos de fase y metodologías", async () => {
    ui(<AssetView />);
    expect(await screen.findByRole("heading", { level: 1, name: "Activo Sixteam" })).toBeTruthy();
    expect(await screen.findByTestId("asset-module-consultoria")).toBeTruthy();
  });

  it("ContextView pinta pestañas y estado vacío", async () => {
    ui(<ContextView projectId={project.id} sub="documentos" />);
    expect(screen.getByText("Documentos")).toBeTruthy();
    expect(await screen.findByText("Sin documentos")).toBeTruthy();
  });

  it("AgentsSection pinta la tabla de agentes con pausa", async () => {
    ui(<AgentsSection />);
    expect(await screen.findByText("Alex")).toBeTruthy();
    expect(screen.getAllByText("⏸ Pausar").length).toBeGreaterThan(0);
  });

  it("AdminView pinta la configuración", async () => {
    ui(<AdminView />);
    expect(await screen.findByText("app_config (semáforos y presupuestos)")).toBeTruthy();
  });
});
