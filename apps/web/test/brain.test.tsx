import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import BrainView from "../src/views/BrainView";
import type { BrainOverview } from "../src/lib/types";
import { mockFetch } from "./helpers";

const overview: BrainOverview = {
  generated_at: "2026-09-03T14:30:00.000Z",
  core: {
    counts: {
      projects: 12,
      tasks: 84,
      people: 4,
      internal_people: 3,
      agents: 2,
      knowledge_docs: 18,
      project_sources: 6,
    },
    people: [
      { id: "p-ana", full_name: "Ana García", role: "Dirección", is_internal: true },
      { id: "p-luis", full_name: "Luis Díaz", role: "Operaciones", is_internal: true },
      { id: "p-client", full_name: "Cliente Demo", role: "Cliente", is_internal: false },
    ],
  },
  agents: {
    items: [
      {
        id: "a-root",
        slug: "root",
        name: "Orquestador",
        layer: "meta",
        runtime: "ai_sdk",
        model: "gpt-5.6-luna",
        autonomy: "supervised",
        status: "active",
      },
      {
        id: "a-builder",
        slug: "builder",
        name: "Constructor",
        layer: "implementacion",
        runtime: "ai_sdk",
        model: null,
        autonomy: "supervised",
        status: "paused",
        reports_to: "a-root",
      },
    ],
    tree: null,
    health: [{ id: "a-builder", slug: "builder", status: "paused", reports_to: "a-root", chain: null }],
  },
  sources: [
    {
      id: "agentos",
      label: "AgentOS",
      status: "connected",
      mode: "local",
      last_checked_at: "2026-09-03T14:29:00.000Z",
      counts: { projects: 12, tasks: 84 },
      detail: "Núcleo de trabajo operativo.",
    },
    {
      id: "whatsapphub",
      label: "2brain · VPS / WhatsAppHub",
      status: "degraded",
      mode: "read-only",
      last_checked_at: null,
      counts: {},
      detail: "El VPS responde parcialmente.",
    },
    {
      id: "llm_wiki",
      label: "LLM Wiki",
      status: "not_configured",
      mode: "filesystem",
      last_checked_at: null,
      counts: {},
      detail: "Falta configurar la ruta de la wiki.",
    },
    {
      id: "notion",
      label: "Notion · Projects & Tasks (1)",
      status: "offline",
      mode: "snapshot",
      last_checked_at: "2026-09-02T18:00:00.000Z",
      last_snapshot_at: "2026-09-02T17:45:00.000Z",
      counts: { tasks: 1197, projects: 33 },
      detail: "La fuente conserva su snapshot y su historial.",
      stages: {
        tasks: ["Sin empezar", "Realizando", "En validación", "Completada"],
        projects: ["OnBoarding", "Implementacion", "Finalizado"],
      },
    },
  ],
  modules: [
    { id: "board", label: "Tablero", description: "Tareas y proyectos como verdad operativa.", source_id: "agentos", status: "available" },
    { id: "wiki", label: "Context Hub", description: "Conocimiento y fuentes del 2brain.", source_id: "llm_wiki", status: "partial" },
  ],
};

describe("BrainView", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("muestra datos del equipo, agentes, fuentes y etapas de Notion", async () => {
    mockFetch([{ path: "/api/brain/overview", body: overview }]);
    render(
      <MemoryRouter initialEntries={["/brain"]}>
        <BrainView />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("heading", { name: "El cerebro operativo" })).toBeTruthy();
    expect(screen.getByText("Ana García")).toBeTruthy();
    expect(screen.getAllByText("Orquestador").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Reporta a:").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("2brain · VPS / WhatsAppHub")).toBeTruthy();
    expect(screen.getByText("Sin empezar")).toBeTruthy();
    expect(screen.getByText("OnBoarding")).toBeTruthy();
    expect(screen.getByText("Capacidades y sus dependencias")).toBeTruthy();
    expect(screen.getByText("Cadena agente → subagente")).toBeTruthy();
    expect(screen.getByText("La API entrega relaciones de reporte; esta vista no las presenta como eventos de handoff de tareas.")).toBeTruthy();
    expect(screen.queryByText("p-ana")).toBeNull();
    expect(screen.getByText("Captura:")).toBeTruthy();
  });

  it("conecta las cuatro lentes con sus secciones reales", async () => {
    mockFetch([{ path: "/api/brain/overview", body: overview }]);
    render(<BrainView />);

    expect(await screen.findByRole("navigation", { name: "Cuatro lentes del blueprint operativo" })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Procesos y tareas/ }).getAttribute("href")).toBe("#processes-lens");
    expect(screen.getByRole("link", { name: /Equipo y roles/ }).getAttribute("href")).toBe("#team-lens");
    expect(screen.getByRole("link", { name: /Herramientas y módulos/ }).getAttribute("href")).toBe("#tools-lens");
    expect(screen.getByRole("link", { name: /Datos y conocimiento/ }).getAttribute("href")).toBe("#knowledge-lens");
    expect(screen.getAllByText("Depende de").length).toBeGreaterThan(0);
  });

  it("distingue estados degradado, no configurado y offline", async () => {
    mockFetch([{ path: "/api/brain/overview", body: overview }]);
    render(<BrainView />);

    expect(await screen.findByText("degradada")).toBeTruthy();
    expect(screen.getAllByText("no configurada").length).toBeGreaterThan(0);
    expect(screen.getAllByText("offline").length).toBeGreaterThan(0);
    expect(screen.getByText("El VPS responde parcialmente.")).toBeTruthy();
  });

  it("expone reintento accesible cuando la lectura falla", async () => {
    mockFetch([{ path: "/api/brain/overview", status: 503, body: { error: { code: "unavailable", message: "API no disponible" } } }]);
    render(<BrainView />);

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reintentar" })).toBeTruthy();
  });
});
