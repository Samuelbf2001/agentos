/**
 * Notas manuscritas en celular (< 1024px): Inicio (fotografiar/subir/nota a
 * mano + recientes), Revisar fotos (antes de crear la nota) y la nota abierta
 * con pestañas Foto/Texto/Tareas. `window.matchMedia` se dobla para que
 * `useEsCelular` responda `true`; Excalidraw se dobla igual que en
 * `notas.test.tsx` (la única frontera con la librería), esta vez incluyendo
 * `refrescar` (el lienzo no se desmonta al cambiar de pestaña).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import NotasView from "../src/views/NotasView";
import { useStore } from "../src/state/store";
import { tituloTablero } from "../src/views/notas/titulo-tablero";
import { mockFetch, person } from "./helpers";
import { reducirFoto } from "../src/views/notas/foto";
import type { CanvasNote, TranscripcionBloque } from "../src/lib/types";

vi.mock("../src/views/notas/foto", () => ({ reducirFoto: vi.fn() }));

const refrescar = vi.fn();
const insertarFoto = vi.fn();
const insertarTranscripcion = vi.fn();
let escena: { elements: unknown[] } = { elements: [] };

vi.mock("../src/views/notas/Lienzo", async () => {
  const React = await import("react");
  const reglas = await import("../src/views/notas/transcripcion-elementos");
  return {
    default: ({
      onSceneChange,
      onReady,
    }: {
      onSceneChange: (scene: { elements: unknown[] }) => void;
      onReady: (handle: unknown) => void;
    }) => {
      // El Excalidraw real avisa `excalidrawAPI` tras montar (efecto), no
      // durante el render: en un `useEffect` para no disparar `setState`
      // (la foto encadena `transcribir()`) en medio del render de un padre.
      React.useEffect(() => {
        onReady({
          getScene: () => escena,
          estaVacio: () => escena.elements.length === 0,
          exportarPng: async () => new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" }),
          insertarTranscripcion: (bloques: TranscripcionBloque[], alturaTipica: number) => {
            insertarTranscripcion(bloques, alturaTipica);
            const nuevos = reglas.skeletonsTranscripcion(bloques, alturaTipica).map((s, i) => ({
              ...s,
              id: `texto-${i}`,
            }));
            escena = { elements: [...reglas.sinTranscripcionPrevia(escena.elements), ...nuevos] };
            onSceneChange(escena);
            return nuevos.length;
          },
          insertarFoto: (foto: unknown) => {
            insertarFoto(foto);
            const id = `foto-${escena.elements.length}`;
            escena = { elements: [...escena.elements, { id, type: "image", ...(foto as object) }] };
            onSceneChange(escena);
            return id;
          },
          refrescar,
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);
      return <div data-testid="lienzo">lienzo</div>;
    },
  };
});

/** `matches: true` siempre: toda la suite corre "en celular". */
function stubMatchMediaCelular() {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: true,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

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
    noteDudas: [],
    toasts: [],
  });
  return render(
    <MemoryRouter initialEntries={["/notas"]}>
      <NotasView />
    </MemoryRouter>,
  );
}

function archivo(nombre: string) {
  return new File([new Uint8Array([1, 2, 3])], nombre, { type: "image/jpeg" });
}

describe("Título del tablero (función pura)", () => {
  it("«Tablero <día> <mes>, <hora>:<minuto>» en español, sin cero a la izquierda en la hora", () => {
    expect(tituloTablero(new Date(2026, 8, 23, 8, 10))).toBe("Tablero 23 sep, 8:10");
    expect(tituloTablero(new Date(2026, 0, 3, 14, 5))).toBe("Tablero 3 ene, 14:05");
  });
});

describe("Notas manuscritas — celular", () => {
  beforeEach(() => {
    stubMatchMediaCelular();
    escena = { elements: [] };
    refrescar.mockClear();
    insertarFoto.mockClear();
    insertarTranscripcion.mockClear();
    vi.mocked(reducirFoto).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("Inicio: fotografiar, subir imagen y recientes; no crea ni abre ninguna nota al montar", async () => {
    const { calls } = mockFetch([{ method: "GET", path: "/api/notes", body: { notes: [makeNote()] } }]);
    renderNotas();

    expect(await screen.findByRole("heading", { name: "Notas" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Fotografiar tablero/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Subir imagen/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Nota a mano/i })).toBeTruthy();
    expect(await screen.findByText("Reunión con dirección")).toBeTruthy();

    // Nada de POST: ni nota creada ni lienzo montado.
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    expect(screen.queryByTestId("lienzo")).toBeNull();
  });

  it("Revisar fotos: 2 archivos → «Usar 2 fotos»; «Repetir» quita la última; «Cancelar» vuelve al Inicio", async () => {
    mockFetch([{ method: "GET", path: "/api/notes", body: { notes: [] } }]);
    renderNotas();
    await screen.findByRole("heading", { name: "Notas" });

    fireEvent.click(screen.getByRole("button", { name: /Subir imagen/i }));
    const inputGaleria = screen.getByTestId("foto-inicio-input-galeria") as HTMLInputElement;
    fireEvent.change(inputGaleria, { target: { files: [archivo("a.jpg"), archivo("b.jpg")] } });

    expect(await screen.findByRole("heading", { name: "¿Se lee bien?" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Usar 2 fotos" })).toBeTruthy();
    expect(screen.getAllByRole("img")).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "Repetir" }));
    expect(await screen.findByRole("button", { name: "Usar foto" })).toBeTruthy();
    expect(screen.getAllByRole("img")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(await screen.findByRole("heading", { name: "Notas" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "¿Se lee bien?" })).toBeNull();
  });

  it("«Usar foto»: crea el tablero, inserta la foto, transcribe y deja la vista en Texto con el lienzo montado", async () => {
    vi.mocked(reducirFoto).mockResolvedValue({
      dataURL: "data:image/jpeg;base64,xxx",
      mimeType: "image/jpeg",
      width: 300,
      height: 200,
    });
    const nueva = makeNote({ id: "n-nueva", title: "Tablero 23 sep, 8:10", scene: { elements: [] } });
    let version = 3;
    const { calls } = mockFetch([
      { method: "GET", path: "/api/notes", body: { notes: [] } },
      { method: "POST", path: "/api/notes", status: 201, body: { note: nueva } },
      { method: "PATCH", path: "/api/notes/n-nueva", body: () => ({ note: { ...nueva, version: ++version } }) },
      {
        method: "POST",
        path: "/api/notes/n-nueva/capture",
        status: 201,
        body: () => ({ note: { ...nueva, version: ++version, imagePath: "notas/n-nueva/x.png", imageBytes: 4 } }),
      },
      {
        method: "POST",
        path: "/api/notes/n-nueva/transcribe",
        body: () => ({
          note: { ...nueva, version: ++version, transcription: "- Punto uno" },
          bloques: [{ bloque: 0, caja: { x: 0, y: 0, w: 100, h: 20 }, texto: "Punto uno" }],
          dudas: [],
          alturaTipica: 20,
        }),
      },
    ]);
    renderNotas();
    await screen.findByRole("heading", { name: "Notas" });

    fireEvent.click(screen.getByRole("button", { name: /Fotografiar tablero/i }));
    fireEvent.change(screen.getByTestId("foto-inicio-input-camara"), { target: { files: [archivo("tablero.jpg")] } });
    await screen.findByRole("button", { name: "Usar foto" });

    // Sin temporizadores simulados: la cadena (crear nota → remontar el
    // lienzo → pegar la foto → transcribir) no depende de ningún `setTimeout`
    // real salvo el de autoguardado, que aquí se vacía a mano con `flush()`
    // antes de seguir — así que basta con esperar a que cada paso llegue.
    fireEvent.click(screen.getByRole("button", { name: "Usar foto" }));

    // La nota se crea con el título "Tablero <fecha>".
    await waitFor(() => {
      expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/api/notes"))).toBe(true);
    });
    const crear = calls.find((c) => c.method === "POST" && c.url.endsWith("/api/notes"))!;
    expect((crear.body as { title: string }).title).toMatch(/^Tablero \d/);

    // La foto se insertó y se encadenó la transcripción (interim, nota en borrador).
    await waitFor(() => expect(insertarFoto).toHaveBeenCalledTimes(1));
    const transcribe = await waitFor(() => {
      const found = calls.find((c) => c.url.includes("/transcribe"));
      expect(found).toBeTruthy();
      return found!;
    });
    expect(transcribe.body).toEqual({ mode: "interim" });

    // Pestaña Texto activa, con la transcripción leída; el lienzo sigue montado (oculto).
    expect(await screen.findByRole("tab", { name: "Texto", selected: true })).toBeTruthy();
    expect(screen.getByTestId("lienzo")).toBeTruthy();
  });

  it("Nota abierta: pestañas Foto/Texto/Tareas; Texto muestra la transcripción sin desmontar el lienzo", async () => {
    mockFetch([
      {
        method: "GET",
        path: "/api/notes",
        body: {
          notes: [makeNote({ status: "transcribed", transcription: "Texto ya leído", imagePath: "notas/n1/x.png" })],
        },
      },
    ]);
    renderNotas();
    await screen.findByRole("heading", { name: "Notas" });

    fireEvent.click(await screen.findByText("Reunión con dirección"));

    expect(await screen.findByTestId("lienzo")).toBeTruthy();
    const tabs = screen.getByRole("tablist", { name: "Secciones de la nota" });
    expect(within(tabs).getByRole("tab", { name: "Foto" })).toBeTruthy();
    expect(within(tabs).getByRole("tab", { name: "Texto" })).toBeTruthy();
    expect(within(tabs).getByRole("tab", { name: "Tareas" })).toBeTruthy();
    expect(within(tabs).getByRole("tab", { name: "Foto", selected: true })).toBeTruthy();

    fireEvent.click(within(tabs).getByRole("tab", { name: "Texto" }));
    expect(await screen.findByDisplayValue("Texto ya leído")).toBeTruthy();
    // El lienzo NO se desmontó: sigue en el árbol (oculto con CSS), y al
    // volver a Foto se refresca.
    expect(screen.getByTestId("lienzo")).toBeTruthy();

    fireEvent.click(within(tabs).getByRole("tab", { name: "Foto" }));
    await waitFor(() => expect(refrescar).toHaveBeenCalled());
  });
});
