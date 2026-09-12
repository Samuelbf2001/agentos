/**
 * 2brain › Grabadora (vista): render, estado "micrófono no disponible"
 * (jsdom no tiene `MediaRecorder`/`getUserMedia`), borrador en `localStorage`
 * y envío con `fetch` mockeado. No se ejercita la grabación real: eso vive
 * detrás de `useGrabadora` y no es testeable sin un navegador de verdad.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import GrabadoraView from "../src/views/brain/GrabadoraView";
import { mockFetch } from "./helpers";

describe("2brain › Grabadora (vista)", () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  function renderVista() {
    return render(
      <MemoryRouter initialEntries={["/2brain/grabadora"]}>
        <GrabadoraView />
      </MemoryRouter>,
    );
  }

  it("pinta su título y el botón de grabar, en modo micrófono no disponible (jsdom)", () => {
    mockFetch([]);
    renderVista();
    expect(screen.getByRole("heading", { level: 1, name: "Grabadora" })).toBeTruthy();
    expect(screen.getByText(/Micrófono no disponible en este dispositivo/)).toBeTruthy();
    const boton = screen.getByRole("button", { name: "Empezar a grabar" });
    expect(boton).toBeTruthy();
    expect(boton.hasAttribute("disabled")).toBe(true);
  });

  it("enlaza de vuelta a Notas de voz", () => {
    mockFetch([]);
    renderVista();
    const enlace = screen.getByRole("link", { name: /Notas de voz/ });
    expect(enlace.getAttribute("href")).toBe("/2brain/notas-voz");
  });

  it("un borrador de una sesión anterior se ofrece reenviar, y el envío llama a la API", async () => {
    localStorage.setItem(
      "agentos_rec_draft",
      JSON.stringify({ transcript: "Nota pendiente de una sesión anterior", durationSec: 8, audioBase64: null, mimetype: null, ts: Date.now() }),
    );
    const { calls } = mockFetch([
      {
        method: "POST",
        path: "/api/brain/notas-voz/voice",
        body: { ok: true, voiceNoteId: 42, title: "Nota pendiente", notionTasks: [] },
      },
    ]);
    renderVista();

    expect(await screen.findByText(/Tienes una nota sin enviar/)).toBeTruthy();
    const boton = screen.getByText("Enviar ahora");
    boton.click();

    await waitFor(() => {
      expect(calls.some((c) => c.method === "POST" && c.url.includes("/api/brain/notas-voz/voice"))).toBe(true);
    });
    const enviado = calls.find((c) => c.url.includes("/api/brain/notas-voz/voice"))!;
    expect((enviado.body as { transcript: string }).transcript).toBe("Nota pendiente de una sesión anterior");
    expect((enviado.body as { source: string }).source).toBe("agentos");

    // Éxito: el borrador se limpia y aparece el resultado.
    await waitFor(() => {
      expect(localStorage.getItem("agentos_rec_draft")).toBeNull();
    });
    expect(await screen.findByText("Nota procesada")).toBeTruthy();
  });

  it("sin borrador previo no muestra el aviso de reenvío", () => {
    mockFetch([]);
    renderVista();
    expect(screen.queryByText(/Tienes una nota sin enviar/)).toBeNull();
  });
});
