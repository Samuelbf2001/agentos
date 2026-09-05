import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import MeetingProcessingView from "../src/views/MeetingProcessingView";
import { mockFetch } from "./helpers";

const ledger = {
  source: "2brain / WhatsAppHub" as const,
  mode: "remote_read_only" as const,
  page: 1,
  page_size: 20,
  status: "all" as const,
  total: 2,
  has_more: false,
  queue: { pending: 1, errors: 1, complete: 0 },
  agentos_context: { linked: 1, ingested: 1, errors: 0 },
  meetings: [
    {
      id: "m-42",
      title: "Diagnóstico operativo",
      source: "fathom",
      meeting_date: "2026-09-01T13:00:00.000Z",
      created_at: "2026-09-01T14:00:00.000Z",
      extracted_at: "2026-09-01T14:02:00.000Z",
      extract_attempts: 1,
      association_status: "awaiting_confirmation",
      task_status: "candidates_pending_confirmation",
      notion_synced_at: null,
      wiki_exported: false,
      wiki_synced_at: null,
      processing_error: null,
    },
    {
      id: "m-43",
      title: "Reunión con error",
      source: "google_meet",
      meeting_date: null,
      created_at: "2026-09-01T15:00:00.000Z",
      extracted_at: null,
      extract_attempts: 2,
      association_status: "awaiting_confirmation",
      task_status: "candidates_pending_confirmation",
      notion_synced_at: null,
      wiki_exported: false,
      wiki_synced_at: null,
      processing_error: "La extracción agotó los reintentos.",
    },
  ],
};

describe("Procesamiento de reuniones", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("muestra el ledger seguro, el gate humano y filtra sin ejecutar acciones", async () => {
    const { calls } = mockFetch([
      { path: "/api/meetings/processing", body: ledger },
      { path: "/api/meetings/processing", body: { ...ledger, status: "pending", meetings: [ledger.meetings[0]] } },
    ]);
    render(<MemoryRouter><MeetingProcessingView /></MemoryRouter>);
    expect(await screen.findByText("Procesamiento de reuniones")).toBeTruthy();
    expect(screen.getByText("Diagnóstico operativo")).toBeTruthy();
    expect(screen.getByText("requiere revisión")).toBeTruthy();
    expect(screen.getByText(/tareas candidatas siguen siendo candidatas/i)).toBeTruthy();
    expect(screen.getByText("La extracción agotó los reintentos.")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Asociar al contexto/i }).getAttribute("href")).toBe("/context");

    fireEvent.click(screen.getByRole("button", { name: "Pendientes" }));
    await waitFor(() => expect(calls.some((call) => call.url.includes("status=pending"))).toBe(true));
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });
});
