/**
 * 2brain como módulo propio: panorama de módulos y la cola de reuniones que
 * ya vive dentro de AgentOS.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import BrainView from "../src/views/BrainView";
import BrainMeetingsView from "../src/views/BrainMeetingsView";
import { mockFetch } from "./helpers";

const overview = {
  generated_at: "2026-09-06T10:00:00.000Z",
  core: { counts: {}, people: [] },
  agents: { items: [], tree: null, health: [] },
  sources: [
    {
      id: "whatsapphub",
      label: "2brain / WhatsAppHub",
      status: "connected",
      mode: "remote_read_only",
      last_checked_at: "2026-09-06T09:59:00.000Z",
      counts: { wiki_pages: 8 },
      detail: "Agregados remotos disponibles en modo solo lectura.",
    },
    {
      id: "llm_wiki",
      label: "LLM Wiki local",
      status: "connected",
      mode: "filesystem_read_only",
      last_checked_at: "2026-09-06T09:59:00.000Z",
      counts: { markdown_files: 12 },
      detail: "Inventario local disponible.",
    },
    {
      id: "notion",
      label: "Notion · Projects & Tasks (1)",
      status: "connected",
      mode: "snapshot_read_only",
      last_checked_at: "2026-09-06T09:59:00.000Z",
      counts: { tasks: 100, projects: 10 },
      detail: "Snapshot disponible.",
    },
  ],
  modules: [],
};

const meetingsPending = {
  source: "2brain / WhatsAppHub" as const,
  mode: "remote_read_only" as const,
  page: 1,
  page_size: 20,
  status: "pending" as const,
  total: 3,
  has_more: false,
  queue: { pending: 3, errors: 0, complete: 5 },
  agentos_context: { linked: 3, ingested: 2, errors: 0 },
  meetings: [],
};

describe("2brain como módulo propio", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("/2brain pinta los módulos, el chip de pendientes y los enlaces internos a cada módulo", async () => {
    mockFetch([
      { path: "/api/brain/overview", body: overview },
      { path: "/api/meetings/processing", body: meetingsPending },
    ]);
    render(
      <MemoryRouter initialEntries={["/2brain"]}>
        <BrainView />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("heading", { level: 1, name: "2brain" })).toBeTruthy();
    for (const name of [
      "Reuniones",
      "Conversaciones",
      "Notas de voz",
      "Grabadora",
      "Videos",
      "Grafo",
      "Agente 2brain",
      "Wiki",
      "Notion",
    ]) {
      expect(screen.getByText(name)).toBeTruthy();
    }

    expect(await screen.findByText("3 pendientes de revisión")).toBeTruthy();
    const openLinks = screen.getAllByRole("link", { name: "Abrir" });
    const hrefs = openLinks.map((link) => link.getAttribute("href"));
    expect(hrefs).toContain("/2brain/reuniones");
    expect(hrefs).toContain("/2brain/conversaciones");
    expect(hrefs).toContain("/2brain/notas-voz");
    expect(hrefs).toContain("/2brain/grabadora");
    expect(hrefs).toContain("/2brain/videos");
    expect(hrefs).toContain("/2brain/grafo");
    expect(hrefs).toContain("/2brain/agente");
    for (const link of openLinks) {
      expect(link.getAttribute("target")).toBeNull();
    }
  });

  it("/2brain/reuniones pinta la cabecera y la cola de reuniones", async () => {
    mockFetch([{ path: "/api/meetings/processing", body: { ...meetingsPending, status: "all" } }]);
    render(
      <MemoryRouter initialEntries={["/2brain/reuniones"]}>
        <BrainMeetingsView />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("heading", { level: 1, name: "Reuniones" })).toBeTruthy();
    const externalLink = screen.getByRole("link", { name: /Abrir en 2brain/ });
    expect(externalLink.getAttribute("target")).toBe("_blank");
    expect(await screen.findByText(/Reuniones observadas/)).toBeTruthy();
  });
});
