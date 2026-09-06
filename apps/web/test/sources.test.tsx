/**
 * Fuentes del proyecto (F2) en la vista Contexto: la sección lista fuentes con
 * estado, el picker (tabs Reuniones/WhatsApp) asocia+ingiere en un paso con los
 * POST correctos, y Re-ingerir reintenta una fuente en error.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useStore } from "../src/state/store";
import ContextView from "../src/views/ContextView";
import { mockFetch, person, project } from "./helpers";
import type { ProjectSource } from "../src/lib/types";

const ingestedSource: ProjectSource = {
  id: "s-1",
  projectId: project.id,
  kind: "meeting",
  externalRef: { system: "whatsapphub", meetingId: "m-1", title: "Kickoff ACME" },
  status: "ingested",
  knowledgeDocId: "kd-1",
  lastError: null,
  lastIngestedAt: Date.now(),
  createdBy: "person:p-ernesto",
  createdAt: Date.now(),
};

const errorSource: ProjectSource = {
  id: "s-2",
  projectId: project.id,
  kind: "whatsapp_thread",
  externalRef: { system: "whatsapphub", contactId: "c-9", title: "Hilo Gerente" },
  status: "error",
  knowledgeDocId: null,
  lastError: "No se pudo conectar con WhatsAppHub. ¿VPS caído? Reintenta más tarde.",
  lastIngestedAt: null,
  createdBy: null,
  createdAt: Date.now(),
};

describe("Fuentes del proyecto (vista Contexto)", () => {
  beforeEach(() => {
    useStore.setState({
      person,
      token: "tok",
      projects: [project],
      activeProjectId: project.id,
      toasts: [],
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lista fuentes con estado y muestra el error legible del conector", async () => {
    mockFetch([
      { path: "/api/knowledge", body: { docs: [] } },
      {
        path: `/api/projects/${project.id}/sources`,
        body: { sources: [ingestedSource, errorSource] },
      },
    ]);
    render(<ContextView />);
    expect(await screen.findByText("Kickoff ACME")).toBeTruthy();
    expect(screen.getByText("ingerida")).toBeTruthy();
    expect(screen.getByText("error")).toBeTruthy();
    expect(screen.getByText(/VPS caído/)).toBeTruthy();
    // Fuente ya ingerida ofrece Re-ingerir; la fallida también (reintentable).
    expect(screen.getAllByText("Re-ingerir")).toHaveLength(2);
  });

  it("Re-ingerir dispara POST /api/sources/:id/ingest", async () => {
    const { calls } = mockFetch([
      { path: "/api/knowledge", body: { docs: [] } },
      { path: `/api/projects/${project.id}/sources`, body: { sources: [errorSource] } },
      {
        method: "POST",
        path: "/api/sources/s-2/ingest",
        body: {
          source: { ...errorSource, status: "ingested", lastError: null },
          doc: { id: "kd-2", kind: "evidence" },
        },
      },
    ]);
    render(<ContextView />);
    fireEvent.click(await screen.findByText("Re-ingerir"));
    await waitFor(() => {
      expect(calls.some((c) => c.method === "POST" && c.url.includes("/api/sources/s-2/ingest"))).toBe(
        true,
      );
    });
  });

  it("picker: tabs, browse y 'Asociar e ingerir' disparan los POST correctos", async () => {
    const { calls } = mockFetch([
      { path: "/api/knowledge", body: { docs: [] } },
      { method: "GET", path: `/api/projects/${project.id}/sources`, body: { sources: [] } },
      {
        path: "/api/sources/browse",
        body: {
          items: [
            {
              id: "m-7",
              title: "Entrevista Jefe de Producción",
              subtitle: "ACME · 2026-08-21",
              url: null,
              is_internal: false,
            },
          ],
          page: 1,
          page_size: 20,
          total: 1,
          has_more: false,
        },
      },
      {
        method: "POST",
        path: `/api/projects/${project.id}/sources`,
        body: {
          source: {
            ...ingestedSource,
            id: "s-new",
            status: "linked",
            knowledgeDocId: null,
            externalRef: { system: "whatsapphub", meetingId: "m-7", title: "Entrevista Jefe de Producción" },
          },
          deduped: false,
        },
      },
      {
        method: "POST",
        path: "/api/sources/s-new/ingest",
        body: { source: { ...ingestedSource, id: "s-new" }, doc: { id: "kd-9", kind: "interview" } },
      },
    ]);
    render(<ContextView />);

    fireEvent.click(await screen.findByText("+ Asociar fuente"));
    // Modal con tabs Reuniones / WhatsApp y buscador.
    expect(await screen.findByText("Asociar fuente de 2brain")).toBeTruthy();
    expect(screen.getAllByText("Reuniones").length).toBeGreaterThan(0);
    expect(screen.getByText("WhatsApp")).toBeTruthy();
    expect(screen.getByPlaceholderText(/Buscar reunión/)).toBeTruthy();

    // Datos del browse en la lista del picker.
    expect(await screen.findByText("Entrevista Jefe de Producción")).toBeTruthy();

    fireEvent.click(screen.getByText("Asociar e ingerir"));
    await waitFor(() => {
      const link = calls.find(
        (c) => c.method === "POST" && c.url.includes(`/api/projects/${project.id}/sources`),
      );
      expect(link).toBeTruthy();
      expect(link!.body).toEqual({
        kind: "meeting",
        external_ref: {
          system: "whatsapphub",
          meetingId: "m-7",
          title: "Entrevista Jefe de Producción",
        },
      });
      // Asociar + ingerir en UN paso.
      expect(
        calls.some((c) => c.method === "POST" && c.url.includes("/api/sources/s-new/ingest")),
      ).toBe(true);
    });
  });

  it("sin proyecto activo no muestra la sección de fuentes ni llama a su API", async () => {
    useStore.setState({ activeProjectId: null });
    const { calls } = mockFetch([{ path: "/api/knowledge", body: { docs: [] } }]);
    render(<ContextView />);
    await screen.findByText("Sin documentos");
    expect(screen.queryByText("Fuentes del proyecto (2brain)")).toBeNull();
    expect(calls.some((c) => c.url.includes("/sources"))).toBe(false);
  });
});
