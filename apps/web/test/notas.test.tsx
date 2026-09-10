/**
 * Notas manuscritas (vista): monta el lienzo, autoguarda con
 * `expected_version`, y los dos botones de lectura:
 *
 * - «Transcribir» sobre un borrador: captura con `keep_status`, transcribe en
 *   modo `interim`, pone el texto en el lienzo (marcado) y lo autoguarda; la
 *   nota sigue en borrador. Repetirlo REEMPLAZA el texto anterior y jamás toca
 *   los trazos.
 * - «Terminar nota»: el mismo camino en modo `final`.
 *
 * Excalidraw NO se carga de verdad: se dobla el módulo `views/notas/Lienzo`,
 * que es la única frontera con la librería (jsdom no sabe pintar su canvas, y
 * cargarla haría el test lento y frágil sin probar nada nuestro). El doble
 * mantiene una escena propia y usa las MISMAS reglas de marcado y reemplazo
 * que el lienzo real (`transcripcion-elementos`), así que lo que se prueba
 * aquí es lo que pasa en producción salvo la conversión final a elementos.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import NotasView from "../src/views/NotasView";
import { useStore } from "../src/state/store";
import {
  esElementoTranscripcion,
  sinTranscripcionPrevia,
  skeletonsTranscripcion,
  tamanoTexto,
} from "../src/views/notas/transcripcion-elementos";
import { mockFetch, person } from "./helpers";
import type { CanvasNote, TranscripcionBloque } from "../src/lib/types";

/** Trazo que el usuario "dibujó". Nunca debe desaparecer ni cambiar. */
const TRAZO = { id: "trazo-1", type: "freedraw", x: 0, y: 0, points: [[0, 0], [100, 20]] };
/** Escena que el doble del lienzo emite al "dibujar". */
const escenaConTrazo = { elements: [TRAZO] };

/** Escena viva del doble: lo que `getScene` devuelve y lo que se autoguarda. */
let escena: { elements: unknown[] } = { elements: [TRAZO] };
const insertarTranscripcion = vi.fn();

vi.mock("../src/views/notas/Lienzo", async () => {
  const reglas = await import("../src/views/notas/transcripcion-elementos");
  return {
    default: ({
      onSceneChange,
      onReady,
    }: {
      onSceneChange: (scene: { elements: unknown[] }) => void;
      onReady: (handle: {
        getScene: () => { elements: unknown[] };
        estaVacio: () => boolean;
        exportarPng: () => Promise<Blob>;
        insertarTranscripcion: (bloques: TranscripcionBloque[], alturaTipica: number) => number;
      }) => void;
    }) => {
      onReady({
        getScene: () => escena,
        estaVacio: () => false,
        // 4 bytes reconocibles: lo que importa es que lleguen como base64.
        exportarPng: async () =>
          new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" }),
        insertarTranscripcion: (bloques, alturaTipica) => {
          insertarTranscripcion(bloques, alturaTipica);
          // Mismas reglas que el lienzo real; sólo se ahorra Excalidraw.
          const nuevos = reglas.skeletonsTranscripcion(bloques, alturaTipica).map((s, i) => ({
            ...s,
            id: `texto-${Date.now()}-${i}`,
          }));
          escena = { elements: [...reglas.sinTranscripcionPrevia(escena.elements), ...nuevos] };
          onSceneChange(escena);
          return nuevos.length;
        },
      });
      return (
        <button type="button" data-testid="lienzo" onClick={() => onSceneChange(escenaConTrazo)}>
          lienzo
        </button>
      );
    },
  };
});

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

/** Nota ya terminada: tiene imagen en disco. */
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

const BLOQUES: TranscripcionBloque[] = [
  { bloque: 0, caja: { x: 0, y: 0, w: 100, h: 20 }, texto: "Cerrar el presupuesto" },
  { bloque: 1, caja: { x: 0, y: 150, w: 90, h: 20 }, texto: "" },
];

const TRANSCRIPCION = "- Cerrar el presupuesto\n- Hablar con Jorge →";

/** Respuesta de /transcribe: la nota con el Markdown y el texto por región. */
function respuestaTranscribe(note: CanvasNote) {
  return {
    note: { ...note, transcription: TRANSCRIPCION },
    bloques: BLOQUES,
    dudas: ["presupuesto"],
    alturaTipica: 20,
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

/** Pulsa un botón de la cabecera y deja correr el camino completo más el autoguardado (2 s). */
async function pulsarYEsperarGuardado(nombre: RegExp) {
  vi.useFakeTimers();
  fireEvent.click(screen.getByRole("button", { name: nombre }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2_500);
  });
  vi.useRealTimers();
}

describe("Notas manuscritas (vista)", () => {
  beforeEach(() => {
    escena = { elements: [TRAZO] };
    insertarTranscripcion.mockClear();
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
    // Sin transcripción todavía: el hueco se enseña vacío, no se inventa.
    expect(screen.getByText(/Transcripción pendiente/i)).toBeTruthy();
    // Los dos botones, con su ayuda breve.
    expect(screen.getByRole("button", { name: /^Transcribir$/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Terminar nota$/ })).toBeTruthy();
    expect(screen.getByText(/puedes seguir escribiendo/i)).toBeTruthy();
    expect(screen.getByText(/lista para proponer tareas/i)).toBeTruthy();
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

  /**
   * Rutas que se comportan como la API real: cada respuesta lleva la nota
   * COMPLETA en su estado más reciente (el autoguardado que sigue a la
   * inserción devuelve la fila con la transcripción, no una nota vacía).
   */
  function rutasConEstado(inicial: CanvasNote, alTerminar: Partial<CanvasNote>) {
    let actual = inicial;
    const avanzar = (patch: Partial<CanvasNote>) => {
      actual = { ...actual, ...patch, version: actual.version + 1 };
      return actual;
    };
    return {
      nota: () => actual,
      rutas: [
        { method: "GET", path: "/api/notes", body: { notes: [inicial] } },
        {
          method: "PATCH",
          path: "/api/notes/n1",
          body: ({ body }: { body: unknown }) => ({
            note: avanzar((body as { scene?: CanvasNote["scene"] }).scene ? { scene: (body as { scene: CanvasNote["scene"] }).scene } : {}),
          }),
        },
        {
          method: "POST",
          path: "/api/notes/n1/capture",
          status: 201,
          body: ({ body }: { body: unknown }) => ({
            note: avanzar({
              imagePath: "notas/n1/n1-3.png",
              imageBytes: 4,
              capturedAt: 3000,
              // Sin keep_status la captura pasa a `captured`, como la API.
              ...((body as { keep_status?: boolean }).keep_status ? {} : { status: "captured" }),
            }),
          }),
        },
        {
          method: "POST",
          path: "/api/notes/n1/transcribe",
          body: () => respuestaTranscribe(avanzar({ ...alTerminar, transcription: TRANSCRIPCION })),
        },
      ],
    };
  }

  it("«Transcribir» en borrador: captura con keep_status, transcribe interim, pone el texto en el lienzo y lo guarda", async () => {
    const { rutas } = rutasConEstado(makeNote(), {});
    const { calls } = mockFetch(rutas);
    renderNotas();
    await screen.findByTestId("lienzo");

    await pulsarYEsperarGuardado(/^Transcribir$/);

    const capture = calls.find((c) => c.url.includes("/capture"));
    expect(capture).toBeTruthy();
    expect(capture!.body).toMatchObject({ keep_status: true });
    expect((capture!.body as { image_base64: string }).image_base64).toMatch(/^data:image\/png;base64,/);

    const transcribe = calls.find((c) => c.url.includes("/transcribe"));
    expect(transcribe).toBeTruthy();
    expect(transcribe!.body).toEqual({ mode: "interim" });
    // Orden: primero la captura, luego la transcripción.
    expect(calls.indexOf(capture!)).toBeLessThan(calls.indexOf(transcribe!));

    // El texto va al lienzo con las regiones y la altura que devolvió la API…
    expect(insertarTranscripcion).toHaveBeenCalledTimes(1);
    expect(insertarTranscripcion).toHaveBeenCalledWith(BLOQUES, 20);

    // …y la escena resultante se autoguarda: el trazo intacto + UN texto
    // marcado (el bloque vacío no pinta nada), debajo de su región.
    const guardado = calls.filter((c) => c.method === "PATCH").at(-1)!;
    const elementos = (guardado.body as { scene: { elements: unknown[] } }).scene.elements;
    expect(elementos[0]).toEqual(TRAZO);
    const textos = elementos.filter(esElementoTranscripcion);
    expect(textos).toHaveLength(1);
    expect(textos[0]).toMatchObject({
      type: "text",
      text: "Cerrar el presupuesto",
      x: 0,
      y: 28,
      fontSize: 16,
      strokeColor: "#5c5c5c",
      customData: { agentos: { transcripcion: true, bloque: 0 } },
    });

    // La nota sigue en borrador y el Markdown queda editable en el panel.
    expect(screen.getByText("Borrador")).toBeTruthy();
    const campo = screen.getByLabelText("Transcripción de la nota") as HTMLTextAreaElement;
    expect(campo.value).toContain("Cerrar el presupuesto");
  });

  it("repetir «Transcribir» reemplaza el texto anterior (no lo apila) y no toca los trazos", async () => {
    let version = 3;
    const { calls } = mockFetch([
      { method: "GET", path: "/api/notes", body: { notes: [makeNote()] } },
      { method: "PATCH", path: "/api/notes/n1", body: () => ({ note: makeNote({ version: ++version }) }) },
      {
        method: "POST",
        path: "/api/notes/n1/capture",
        status: 201,
        body: () => ({ note: makeNote({ version: ++version, imagePath: "notas/n1/x.png", imageBytes: 4 }) }),
      },
      {
        method: "POST",
        path: "/api/notes/n1/transcribe",
        body: () => ({
          ...respuestaTranscribe(makeNote({ version: ++version, imagePath: "notas/n1/x.png", imageBytes: 4 })),
          // Segunda lectura distinta: es la que debe quedar.
          bloques: [{ bloque: 0, caja: { x: 0, y: 0, w: 100, h: 20 }, texto: `Lectura ${version}` }],
        }),
      },
    ]);
    renderNotas();
    await screen.findByTestId("lienzo");

    await pulsarYEsperarGuardado(/^Transcribir$/);
    await pulsarYEsperarGuardado(/^Transcribir$/);

    expect(insertarTranscripcion).toHaveBeenCalledTimes(2);
    expect(calls.filter((c) => c.url.includes("/transcribe"))).toHaveLength(2);

    const elementos = escena.elements;
    // El trazo sigue ahí, idéntico y el primero.
    expect(elementos.filter((el) => (el as { type: string }).type === "freedraw")).toEqual([TRAZO]);
    // Un solo texto marcado, el de la última lectura: ni dos, ni el viejo.
    const textos = elementos.filter(esElementoTranscripcion) as { text: string }[];
    expect(textos).toHaveLength(1);
    expect(textos[0]!.text).toMatch(/^Lectura \d+$/);
    expect(textos[0]!.text).not.toBe("Cerrar el presupuesto");
    expect(elementos).toHaveLength(2);
  });

  it("«Terminar nota» hace el mismo camino en modo final y la deja transcrita", async () => {
    const { rutas } = rutasConEstado(makeNote(), { status: "transcribed" });
    const { calls } = mockFetch(rutas);
    renderNotas();
    await screen.findByTestId("lienzo");

    await pulsarYEsperarGuardado(/^Terminar nota$/);

    const capture = calls.find((c) => c.url.includes("/capture"))!;
    expect(capture).toBeTruthy();
    // Captura de verdad: sin keep_status, la nota pasa a `captured`.
    expect(capture.body).not.toHaveProperty("keep_status");
    expect(calls.find((c) => c.url.includes("/transcribe"))!.body).toEqual({ mode: "final" });
    expect(insertarTranscripcion).toHaveBeenCalledWith(BLOQUES, 20);

    // La nota queda "Transcrita", con el texto editable y la imagen guardada.
    expect(await screen.findByText("Transcrita")).toBeTruthy();
    expect((screen.getByLabelText("Transcripción de la nota") as HTMLTextAreaElement).value).toContain(
      "Cerrar el presupuesto",
    );
    expect(screen.getByRole("link", { name: /Ver la imagen guardada/i })).toBeTruthy();
  });

  it("sobre una nota ya transcrita, «Transcribir» rehace la lectura en modo final", async () => {
    const { calls } = mockFetch([
      {
        method: "GET",
        path: "/api/notes",
        body: { notes: [notaCapturada({ status: "transcribed", transcription: "vieja" })] },
      },
      {
        method: "POST",
        path: "/api/notes/n1/capture",
        status: 201,
        body: () => ({ note: notaCapturada({ version: 6 }) }),
      },
      {
        method: "POST",
        path: "/api/notes/n1/transcribe",
        body: () => respuestaTranscribe(notaCapturada({ status: "transcribed", version: 7 })),
      },
    ]);
    renderNotas();
    await screen.findByTestId("lienzo");

    fireEvent.click(screen.getByRole("button", { name: /^Transcribir$/ }));

    await waitFor(() => {
      expect(calls.find((c) => c.url.includes("/transcribe"))!.body).toEqual({ mode: "final" });
    });
    expect(calls.find((c) => c.url.includes("/capture"))!.body).not.toHaveProperty("keep_status");
  });

  it("mientras corre una lectura, los dos botones se deshabilitan y cada uno enseña su propio estado", async () => {
    mockFetch([
      { method: "GET", path: "/api/notes", body: { notes: [makeNote()] } },
      {
        method: "POST",
        path: "/api/notes/n1/capture",
        status: 201,
        body: () => ({ note: makeNote({ version: 4, imagePath: "notas/n1/x.png", imageBytes: 4 }) }),
      },
      {
        method: "POST",
        path: "/api/notes/n1/transcribe",
        body: () =>
          respuestaTranscribe(makeNote({ version: 5, imagePath: "notas/n1/x.png", imageBytes: 4 })),
      },
    ]);
    // La transcripción se queda "en vuelo" hasta que el test la libere.
    let liberar: (() => void) | null = null;
    const puerta = new Promise<void>((resolve) => {
      liberar = resolve;
    });
    const fetchMock = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/transcribe")) await puerta;
      return fetchMock(input, init);
    });
    renderNotas();
    await screen.findByTestId("lienzo");

    fireEvent.click(screen.getByRole("button", { name: /^Transcribir$/ }));

    const transcribiendo = await screen.findByRole("button", { name: /Transcribiendo…/ });
    expect((transcribiendo as HTMLButtonElement).disabled).toBe(true);
    const terminar = screen.getByRole("button", { name: /^Terminar nota$/ }) as HTMLButtonElement;
    expect(terminar.disabled).toBe(true);

    await waitFor(() => expect(liberar).not.toBeNull());
    await act(async () => {
      liberar!();
    });
    await waitFor(() => {
      expect((screen.getByRole("button", { name: /^Transcribir$/ }) as HTMLButtonElement).disabled).toBe(false);
    });
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

  it("si el proveedor falla, se enseña el error, el texto sigue vacío y el lienzo no se toca", async () => {
    mockFetch([
      { method: "GET", path: "/api/notes", body: { notes: [makeNote()] } },
      {
        method: "POST",
        path: "/api/notes/n1/capture",
        status: 201,
        body: () => ({ note: makeNote({ version: 4, imagePath: "notas/n1/x.png", imageBytes: 4 }) }),
      },
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

    fireEvent.click(screen.getByRole("button", { name: /^Transcribir$/ }));

    const error = await screen.findByTestId("error-transcripcion");
    expect(error.textContent).toContain("OPENAI_API_KEY");
    // Ni un textarea con texto inventado ni un texto en el lienzo: el hueco sigue siendo un hueco.
    expect(screen.queryByLabelText("Transcripción de la nota")).toBeNull();
    expect(insertarTranscripcion).not.toHaveBeenCalled();
    expect(escena.elements).toEqual([TRAZO]);
  });
});

describe("Transcripción → elementos del lienzo (reglas puras)", () => {
  it("un texto por bloque con contenido, DEBAJO de su región, en gris y marcado", () => {
    const skeletons = skeletonsTranscripcion(
      [
        { bloque: 0, caja: { x: 10, y: 20, w: 100, h: 30 }, texto: "  Hola  " },
        { bloque: 1, caja: { x: 10, y: 90, w: 100, h: 30 }, texto: "   " },
        { bloque: 2, caja: { x: 300, y: 20, w: 50, h: 30 }, texto: "Margen" },
      ],
      25,
    );
    expect(skeletons).toEqual([
      {
        type: "text",
        text: "Hola",
        x: 10,
        y: 58,
        fontSize: 20,
        fontFamily: 1,
        strokeColor: "#5c5c5c",
        customData: { agentos: { transcripcion: true, bloque: 0 } },
      },
      {
        type: "text",
        text: "Margen",
        x: 300,
        y: 58,
        fontSize: 20,
        fontFamily: 1,
        strokeColor: "#5c5c5c",
        customData: { agentos: { transcripcion: true, bloque: 2 } },
      },
    ]);
  });

  it("el tamaño de letra sigue al trazo pero se acota entre 14 y 40", () => {
    expect(tamanoTexto(5)).toBe(14);
    expect(tamanoTexto(20)).toBe(16);
    expect(tamanoTexto(30)).toBe(24);
    expect(tamanoTexto(500)).toBe(40);
    expect(tamanoTexto(Number.NaN)).toBe(14);
  });

  it("sólo se retiran los elementos marcados por la transcripción; lo demás se conserva tal cual", () => {
    const trazo = { id: "t", type: "freedraw" };
    const textoHumano = { id: "h", type: "text", text: "escrito a mano con teclado" };
    const otroCustom = { id: "c", type: "text", customData: { agentos: { otraCosa: true } } };
    const marcado = { id: "m", type: "text", customData: { agentos: { transcripcion: true, bloque: 0 } } };
    expect(sinTranscripcionPrevia([trazo, marcado, textoHumano, otroCustom, null, 3])).toEqual([
      trazo,
      textoHumano,
      otroCustom,
      null,
      3,
    ]);
    expect(esElementoTranscripcion(marcado)).toBe(true);
    expect(esElementoTranscripcion(otroCustom)).toBe(false);
  });
});
