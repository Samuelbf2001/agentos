/**
 * Notas manuscritas (vista): monta el lienzo, autoguarda con
 * `expected_version` tras el retardo y "Terminar notas" manda el PNG.
 *
 * Excalidraw NO se carga de verdad: se dobla el módulo `views/notas/Lienzo`,
 * que es la única frontera con la librería (jsdom no sabe pintar su canvas, y
 * cargarla haría el test lento y frágil sin probar nada nuestro).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import NotasView from "../src/views/NotasView";
import { useStore } from "../src/state/store";
import { mockFetch, person } from "./helpers";
import type { CanvasNote } from "../src/lib/types";

/** Escena que el doble del lienzo emite al "dibujar". */
const escenaConTrazo = { elements: [{ id: "trazo-1", type: "freedraw" }] };

vi.mock("../src/views/notas/Lienzo", () => ({
  default: ({
    onSceneChange,
    onReady,
  }: {
    onSceneChange: (scene: { elements: unknown[] }) => void;
    onReady: (handle: {
      getScene: () => { elements: unknown[] };
      estaVacio: () => boolean;
      exportarPng: () => Promise<Blob>;
    }) => void;
  }) => {
    onReady({
      getScene: () => escenaConTrazo,
      estaVacio: () => false,
      // 4 bytes reconocibles: lo que importa es que lleguen como base64.
      exportarPng: async () =>
        new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" }),
    });
    return (
      <button type="button" data-testid="lienzo" onClick={() => onSceneChange(escenaConTrazo)}>
        lienzo
      </button>
    );
  },
}));

function makeNote(overrides: Partial<CanvasNote> = {}): CanvasNote {
  return {
    id: "n1",
    orgId: "org-1",
    projectId: "proj-1",
    title: "Reunión con dirección",
    scene: { elements: [] },
    status: "draft",
    imageArtifactId: null,
    imagePath: null,
    imageBytes: null,
    capturedAt: null,
    transcription: null,
    proposals: [],
    createdByPersonId: person.id,
    version: 3,
    createdAt: 1000,
    updatedAt: 2000,
    ...overrides,
  };
}

function renderNotas() {
  useStore.setState({
    person,
    token: "tok",
    bootstrapped: true,
    notes: [],
    notesLoading: false,
    notesError: null,
    activeNoteId: null,
    noteSaving: false,
    noteSavedAt: null,
    noteCapturing: false,
    noteTranscribing: false,
    noteTranscribeError: null,
    toasts: [],
  });
  return render(
    <MemoryRouter initialEntries={["/notas"]}>
      <NotasView />
    </MemoryRouter>,
  );
}

describe("Notas manuscritas (vista)", () => {
  beforeEach(() => {
    useStore.setState({
      notes: [],
      activeNoteId: null,
      toasts: [],
      noteTranscribing: false,
      noteTranscribeError: null,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("monta la vista y abre la nota más reciente en el lienzo", async () => {
    mockFetch([{ method: "GET", path: "/api/notes", body: { notes: [makeNote()] } }]);
    renderNotas();

    expect(await screen.findByRole("heading", { name: "Reunión con dirección" })).toBeTruthy();
    expect(await screen.findByTestId("lienzo")).toBeTruthy();
    // El hueco de la fase 2 existe ya, vacío a propósito.
    expect(screen.getByText(/Transcripción pendiente/i)).toBeTruthy();
  });

  it("el autoguardado dispara PATCH con expected_version tras el retardo", async () => {
    const { calls } = mockFetch([
      { method: "GET", path: "/api/notes", body: { notes: [makeNote()] } },
      {
        method: "PATCH",
        path: "/api/notes/n1",
        body: () => ({ note: makeNote({ version: 4, scene: escenaConTrazo }) }),
      },
    ]);
    renderNotas();
    const lienzo = await screen.findByTestId("lienzo");

    vi.useFakeTimers();
    fireEvent.click(lienzo);
    // Antes del retardo no se llama: se escribe, no se martillea la API.
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_100);
    });
    vi.useRealTimers();

    await waitFor(() => {
      const patch = calls.find((c) => c.method === "PATCH");
      expect(patch).toBeTruthy();
      expect(patch!.url).toContain("/api/notes/n1");
      expect(patch!.body).toMatchObject({ expected_version: 3, scene: escenaConTrazo });
    });
  });

  it("«Terminar notas» exporta el PNG y lo manda a /capture", async () => {
    const { calls } = mockFetch([
      { method: "GET", path: "/api/notes", body: { notes: [makeNote()] } },
      { method: "PATCH", path: "/api/notes/n1", body: () => ({ note: makeNote({ version: 4 }) }) },
      {
        method: "POST",
        path: "/api/notes/n1/capture",
        status: 201,
        body: () => ({
          note: makeNote({
            status: "captured",
            version: 5,
            imagePath: "notas/n1/n1-4.png",
            imageBytes: 4,
          }),
        }),
      },
    ]);
    renderNotas();
    await screen.findByTestId("lienzo");

    fireEvent.click(screen.getByRole("button", { name: /Terminar notas/i }));

    await waitFor(() => {
      const capture = calls.find((c) => c.url.includes("/capture"));
      expect(capture).toBeTruthy();
      const body = capture!.body as { image_base64: string };
      expect(body.image_base64).toMatch(/^data:image\/png;base64,/);
    });

    // La nota queda "Terminada" y ofrece la imagen guardada.
    expect(await screen.findByText("Terminada")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Ver la imagen guardada/i })).toBeTruthy();
  });

  /** Nota ya terminada: tiene imagen en disco, así que se puede transcribir. */
  function notaCapturada(overrides: Partial<CanvasNote> = {}): CanvasNote {
    return makeNote({
      status: "captured",
      version: 5,
      imagePath: "notas/n1/n1-4.png",
      imageBytes: 4,
      capturedAt: 3000,
      ...overrides,
    });
  }

  it("«Transcribir» llama al endpoint y deja el texto editable", async () => {
    const { calls } = mockFetch([
      { method: "GET", path: "/api/notes", body: { notes: [notaCapturada()] } },
      {
        method: "POST",
        path: "/api/notes/n1/transcribe",
        body: () => ({
          note: notaCapturada({
            status: "transcribed",
            version: 6,
            transcription: "- Cerrar el presupuesto\n- Hablar con Jorge →",
          }),
        }),
      },
    ]);
    renderNotas();
    await screen.findByTestId("lienzo");
    // Sin transcripción todavía: se ofrece hacerla, no se inventa nada.
    expect(screen.getByText(/Todavía sin transcribir/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /^Transcribir$/i }));

    await waitFor(() => {
      expect(calls.find((c) => c.url.includes("/transcribe") && c.method === "POST")).toBeTruthy();
    });
    const campo = (await screen.findByLabelText(
      "Transcripción de la nota",
    )) as HTMLTextAreaElement;
    expect(campo.value).toContain("Cerrar el presupuesto");
    expect(await screen.findByText("Transcrita")).toBeTruthy();
  });

  it("la corrección a mano se guarda al salir del campo (PATCH con expected_version)", async () => {
    const { calls } = mockFetch([
      {
        method: "GET",
        path: "/api/notes",
        body: {
          notes: [
            notaCapturada({ status: "transcribed", transcription: "presupesto [?: presupuesto]" }),
          ],
        },
      },
      {
        method: "PATCH",
        path: "/api/notes/n1",
        body: () => ({
          note: notaCapturada({ status: "transcribed", version: 6, transcription: "presupuesto" }),
        }),
      },
    ]);
    renderNotas();
    const campo = (await screen.findByLabelText(
      "Transcripción de la nota",
    )) as HTMLTextAreaElement;
    expect(campo.value).toBe("presupesto [?: presupuesto]");

    fireEvent.change(campo, { target: { value: "presupuesto" } });
    fireEvent.blur(campo);

    await waitFor(() => {
      const patch = calls.find((c) => c.method === "PATCH");
      expect(patch).toBeTruthy();
      expect(patch!.body).toMatchObject({ transcription: "presupuesto", expected_version: 5 });
    });
  });

  it("si el proveedor falla, se enseña el error y el texto sigue vacío", async () => {
    mockFetch([
      { method: "GET", path: "/api/notes", body: { notes: [notaCapturada()] } },
      {
        method: "POST",
        path: "/api/notes/n1/transcribe",
        status: 502,
        body: {
          error: {
            code: "provider_unavailable",
            message: "No se pudo transcribir con 'openai': falta OPENAI_API_KEY",
          },
        },
      },
    ]);
    renderNotas();
    await screen.findByTestId("lienzo");

    fireEvent.click(screen.getByRole("button", { name: /^Transcribir$/i }));

    const error = await screen.findByTestId("error-transcripcion");
    expect(error.textContent).toContain("OPENAI_API_KEY");
    // Ni un textarea con texto inventado: el hueco sigue siendo un hueco.
    expect(screen.queryByLabelText("Transcripción de la nota")).toBeNull();
  });
});
