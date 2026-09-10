/**
 * Notas manuscritas (REST): crear → autoguardar con `expected_version` →
 * capturar el PNG → transcribir (intermedia sobre el borrador o final) →
 * servir la imagen. Cubre el 409 por versión, que el binario NO entra en la
 * base (queda en disco con ruta relativa), el enlace a `artifacts` cuando la
 * captura viene anclada a una tarea y que la transcripción por regiones vuelve
 * casada con las cajas de la segmentación.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { errors } from "@agentos/shared";
import { queryAudit, updateCanvasNote } from "@agentos/db";
import { makeFixture, makeReadyTask, type TestFixture } from "./helpers.js";
import type {
  NoteTranscriber,
  TranscribeNoteInput,
  TranscribeNoteResult,
} from "../src/notes/transcripcion.js";

/** PNG 1×1 real: el endpoint guarda bytes, no una cadena cualquiera. */
const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

interface NoteWire {
  id: string;
  title: string;
  status: string;
  version: number;
  projectId: string | null;
  orgId: string | null;
  imagePath: string | null;
  imageBytes: number | null;
  imageArtifactId: string | null;
  capturedAt: number | null;
  transcription: string | null;
  scene: { elements: unknown[] };
}

interface TranscribeWire {
  note: NoteWire;
  bloques: { bloque: number; caja: { x: number; y: number; w: number; h: number }; texto: string }[];
  dudas: string[];
  alturaTipica: number;
}

/** Doble del transcriptor: salida estructurada fija, sin modelo real. */
function resultado(
  overrides: Partial<Pick<TranscribeNoteResult, "markdown" | "bloques" | "dudas">> = {},
): TranscribeNoteResult {
  return {
    // Con los marcadores de duda que pide el prompt: la ruta los quita del texto.
    markdown: "# Reunión\n\n- Cerrar el presupuesto [?: presupuesto]\n- Hablar con Jorge [?] →",
    bloques: [
      { bloque: 0, texto: "Cerrar el presupuesto [?: presupuesto/presupuestó]" },
      { bloque: 1, texto: "Hablar con Jorge →" },
    ],
    dudas: ["presupuesto"],
    proveedor: "openai",
    modelo: "modelo-de-prueba",
    usage: { tokensIn: 1200, tokensOut: 80, tokensCacheRead: null, tokensCacheWrite: null },
    costUsd: null,
    ...overrides,
  };
}

/** Escena con dos regiones separadas verticalmente (bloque 0 arriba, 1 abajo). */
const ESCENA_DOS_BLOQUES = {
  elements: [
    { id: "a", type: "freedraw", x: 0, y: 0, points: [[0, 0], [100, 20]] },
    { id: "b", type: "freedraw", x: 0, y: 150, points: [[0, 0], [90, 20]] },
  ],
};

describe("Notas manuscritas (REST)", () => {
  let artifactsDir: string;
  let previousArtifactsDir: string | undefined;
  const fixtures: TestFixture[] = [];

  beforeAll(() => {
    previousArtifactsDir = process.env.AGENTOS_ARTIFACTS_DIR;
    artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-notas-"));
    process.env.AGENTOS_ARTIFACTS_DIR = artifactsDir;
  });

  afterAll(() => {
    fs.rmSync(artifactsDir, { recursive: true, force: true });
    if (previousArtifactsDir === undefined) delete process.env.AGENTOS_ARTIFACTS_DIR;
    else process.env.AGENTOS_ARTIFACTS_DIR = previousArtifactsDir;
  });

  afterEach(async () => {
    for (const fixture of fixtures.splice(0)) await fixture.close();
  });

  async function fx(overrides: Parameters<typeof makeFixture>[0] = {}): Promise<TestFixture> {
    const fixture = await makeFixture(overrides);
    fixtures.push(fixture);
    return fixture;
  }

  async function createNote(fixture: TestFixture, payload: Record<string, unknown> = {}) {
    const res = await fixture.api.app.inject({
      method: "POST",
      url: "/api/notes",
      headers: fixture.authHeaders,
      payload,
    });
    expect(res.statusCode).toBe(201);
    return (res.json() as { note: NoteWire }).note;
  }

  it("nace en borrador, con escena vacía y heredando la organización del proyecto", async () => {
    const fixture = await fx();
    const note = await createNote(fixture, {
      title: "Reunión con dirección",
      project_id: fixture.project.id,
    });

    expect(note.status).toBe("draft");
    expect(note.version).toBe(1);
    expect(note.scene.elements).toEqual([]);
    expect(note.projectId).toBe(fixture.project.id);
    expect(note.orgId).toBe(fixture.org.id);
    expect(note.transcription).toBeNull();

    const sinTitulo = await createNote(fixture);
    expect(sinTitulo.title).toBe("Notas sin título");
    expect(sinTitulo.projectId).toBeNull();

    const list = await fixture.api.app.inject({
      method: "GET",
      url: `/api/notes?project_id=${fixture.project.id}`,
      headers: fixture.authHeaders,
    });
    expect(list.statusCode).toBe(200);
    expect((list.json() as { notes: NoteWire[] }).notes.map((n) => n.id)).toEqual([note.id]);
  });

  it("el autoguardado manda expected_version: sube la versión y una vieja da 409 version_conflict", async () => {
    const fixture = await fx();
    const note = await createNote(fixture, { project_id: fixture.project.id });

    const saved = await fixture.api.app.inject({
      method: "PATCH",
      url: `/api/notes/${note.id}`,
      headers: fixture.authHeaders,
      payload: {
        scene: { elements: [{ id: "trazo-1", type: "freedraw" }] },
        expected_version: note.version,
      },
    });
    expect(saved.statusCode).toBe(200);
    const updated = (saved.json() as { note: NoteWire }).note;
    expect(updated.version).toBe(2);
    expect(updated.scene.elements).toHaveLength(1);

    const stale = await fixture.api.app.inject({
      method: "PATCH",
      url: `/api/notes/${note.id}`,
      headers: fixture.authHeaders,
      payload: { title: "Tarde", expected_version: note.version },
    });
    expect(stale.statusCode).toBe(409);
    expect((stale.json() as { error: { code: string } }).error.code).toBe("version_conflict");

    const vacío = await fixture.api.app.inject({
      method: "PATCH",
      url: `/api/notes/${note.id}`,
      headers: fixture.authHeaders,
      payload: {},
    });
    expect(vacío.statusCode).toBe(400);
  });

  it("terminar notas guarda el PNG fuera de la base y deja la nota en captured", async () => {
    const fixture = await fx();
    const note = await createNote(fixture, { project_id: fixture.project.id });

    const res = await fixture.api.app.inject({
      method: "POST",
      url: `/api/notes/${note.id}/capture`,
      headers: fixture.authHeaders,
      payload: { image_base64: `data:image/png;base64,${PNG_1X1_BASE64}` },
    });
    expect(res.statusCode).toBe(201);
    const captured = (res.json() as { note: NoteWire }).note;

    expect(captured.status).toBe("captured");
    expect(captured.capturedAt).toBeGreaterThan(0);
    expect(captured.imageBytes).toBe(Buffer.from(PNG_1X1_BASE64, "base64").byteLength);
    // Ruta RELATIVA a la raíz de artefactos, nunca absoluta ni dentro del repo.
    expect(captured.imagePath).toMatch(/^notas\//);
    expect(path.isAbsolute(captured.imagePath!)).toBe(false);
    expect(fs.existsSync(path.join(artifactsDir, captured.imagePath!))).toBe(true);
    // Sin tarea no hay fila en `artifacts` (su task_id es NOT NULL).
    expect(captured.imageArtifactId).toBeNull();
    // La transcripción es fase 2: aquí sigue vacía.
    expect(captured.transcription).toBeNull();

    const image = await fixture.api.app.inject({
      method: "GET",
      url: `/api/notes/${note.id}/image`,
      headers: fixture.authHeaders,
    });
    expect(image.statusCode).toBe(200);
    expect(image.headers["content-type"]).toBe("image/png");
    expect(image.rawPayload.byteLength).toBe(captured.imageBytes);

    const audit = await queryAudit(fixture.db, { entityType: "canvas_note", entityId: note.id });
    expect(audit.map((a) => a.action)).toContain("note.capture");
  });

  it("con task_id, la captura queda además enlazada como artefacto de esa tarea", async () => {
    const fixture = await fx();
    const task = await makeReadyTask(fixture, fixture.sam);
    const note = await createNote(fixture, { project_id: fixture.project.id, title: "Boceto" });

    const res = await fixture.api.app.inject({
      method: "POST",
      url: `/api/notes/${note.id}/capture`,
      headers: fixture.authHeaders,
      payload: { image_base64: PNG_1X1_BASE64, task_id: task.id },
    });
    expect(res.statusCode).toBe(201);
    const captured = (res.json() as { note: NoteWire }).note;
    expect(captured.imageArtifactId).toBeTruthy();

    const detail = await fixture.api.app.inject({
      method: "GET",
      url: `/api/tasks/${task.id}`,
      headers: fixture.authHeaders,
    });
    const artifacts = (detail.json() as { artifacts: { id: string; path: string | null }[] }).artifacts;
    expect(artifacts.map((a) => a.id)).toContain(captured.imageArtifactId);
    expect(artifacts[0]?.path).toBe(captured.imagePath);
  });

  // ── Transcripción (fase 2) ────────────────────────────────────────────────

  /**
   * Captura el PNG de prueba. Sin opciones deja la nota en `captured`; con
   * `keep_status` es la captura intermedia de «Transcribir» y no toca el estado.
   */
  async function capturar(
    fixture: TestFixture,
    noteId: string,
    opts: { keep_status?: boolean } = {},
  ): Promise<NoteWire> {
    const res = await fixture.api.app.inject({
      method: "POST",
      url: `/api/notes/${noteId}/capture`,
      headers: fixture.authHeaders,
      payload: { image_base64: PNG_1X1_BASE64, ...opts },
    });
    expect(res.statusCode).toBe(201);
    return (res.json() as { note: NoteWire }).note;
  }

  async function guardarEscena(fixture: TestFixture, note: NoteWire, scene: unknown): Promise<void> {
    const res = await fixture.api.app.inject({
      method: "PATCH",
      url: `/api/notes/${note.id}`,
      headers: fixture.authHeaders,
      payload: { scene, expected_version: note.version },
    });
    expect(res.statusCode).toBe(200);
  }

  async function transcribir(fixture: TestFixture, noteId: string, mode?: "interim" | "final") {
    return fixture.api.app.inject({
      method: "POST",
      url: `/api/notes/${noteId}/transcribe`,
      headers: fixture.authHeaders,
      ...(mode ? { payload: { mode } } : {}),
    });
  }

  it("transcribe la nota capturada con el proveedor (modo final por defecto) y guarda el Markdown", async () => {
    const llamadas: TranscribeNoteInput[] = [];
    const transcriber: NoteTranscriber = {
      async transcribe(input) {
        llamadas.push(input);
        // El bloque 7 no existe en la escena: el modelo se lo inventó y se descarta.
        return resultado({
          bloques: [...resultado().bloques, { bloque: 7, texto: "inventado" }],
        });
      },
    };
    const fixture = await fx({ noteTranscriber: transcriber });
    const note = await createNote(fixture, { project_id: fixture.project.id });
    // Escena con dos renglones separados: el transcriptor debe recibir el orden de lectura.
    await guardarEscena(fixture, note, ESCENA_DOS_BLOQUES);
    const capturada = await capturar(fixture, note.id);

    const res = await transcribir(fixture, note.id);
    expect(res.statusCode).toBe(200);
    const salida = res.json() as TranscribeWire;
    const transcrita = salida.note;

    expect(transcrita.status).toBe("transcribed");
    // El Markdown se guarda SIN los marcadores de duda: queda la lectura elegida.
    expect(transcrita.transcription).toBe(
      "# Reunión\n\n- Cerrar el presupuesto\n- Hablar con Jorge →",
    );
    expect(transcrita.version).toBeGreaterThan(capturada.version);

    // Texto por región casado con la caja de la segmentación, también sin
    // marcadores; el índice inventado no tiene caja y se descarta. Nada de
    // esto se persiste.
    expect(salida.bloques).toEqual([
      { bloque: 0, caja: { x: 0, y: 0, w: 100, h: 20 }, texto: "Cerrar el presupuesto" },
      { bloque: 1, caja: { x: 0, y: 150, w: 90, h: 20 }, texto: "Hablar con Jorge →" },
    ]);
    // Lo incierto viaja aparte, intacto: es la única huella de la duda.
    expect(salida.dudas).toEqual(["presupuesto"]);
    expect(JSON.stringify([salida.note.transcription, salida.bloques])).not.toContain("[?");
    expect(salida.alturaTipica).toBe(20);

    // El modelo recibe la IMAGEN del disco y la segmentación como orden de lectura.
    expect(llamadas).toHaveLength(1);
    expect(llamadas[0]!.imagen.byteLength).toBe(Buffer.from(PNG_1X1_BASE64, "base64").byteLength);
    expect(llamadas[0]!.segmentacion.resumen).toMatchObject({ renglones: 2, bloques: 2 });

    const audit = await queryAudit(fixture.db, { entityType: "canvas_note", entityId: note.id });
    const registro = audit.find((a) => a.action === "note.transcribe");
    expect(registro).toBeTruthy();
    // La auditoría guarda el modo, el modelo y los tokens; jamás una clave.
    expect(registro!.after).toMatchObject({
      mode: "final",
      model: "modelo-de-prueba",
      tokensIn: 1200,
      blocksRead: 2,
      blocksDropped: 1,
    });
    expect(JSON.stringify(registro!.after)).not.toMatch(/sk-/);
  });

  it("«Transcribir» sobre el borrador: captura con keep_status y transcripción interim, y sigue en draft", async () => {
    const fixture = await fx({
      noteTranscriber: {
        async transcribe() {
          return resultado();
        },
      },
    });
    const note = await createNote(fixture, { project_id: fixture.project.id });
    await guardarEscena(fixture, note, ESCENA_DOS_BLOQUES);

    // La captura intermedia deja la imagen en disco y NO saca la nota del borrador.
    const capturada = await capturar(fixture, note.id, { keep_status: true });
    expect(capturada.status).toBe("draft");
    expect(capturada.imagePath).toMatch(/^notas\//);
    expect(capturada.version).toBe(3);

    const res = await transcribir(fixture, note.id, "interim");
    expect(res.statusCode).toBe(200);
    const salida = res.json() as TranscribeWire;
    // Sigue editable: draft, con el texto guardado y la versión subida.
    expect(salida.note.status).toBe("draft");
    expect(salida.note.transcription).toContain("Cerrar el presupuesto");
    expect(salida.note.version).toBe(capturada.version + 1);
    expect(salida.bloques.map((b) => b.bloque)).toEqual([0, 1]);
    expect(salida.bloques[1]!.caja).toEqual({ x: 0, y: 150, w: 90, h: 20 });

    const audit = await queryAudit(fixture.db, { entityType: "canvas_note", entityId: note.id });
    expect(audit.find((a) => a.action === "note.capture")!.after).toMatchObject({
      status: "draft",
      keepStatus: true,
    });
    expect(audit.find((a) => a.action === "note.transcribe")!.after).toMatchObject({
      mode: "interim",
      status: "draft",
    });

    // Se puede repetir y, al «Terminar nota», el modo final la cierra.
    const otra = await transcribir(fixture, note.id, "interim");
    expect((otra.json() as TranscribeWire).note.status).toBe("draft");
    await capturar(fixture, note.id);
    const final = await transcribir(fixture, note.id, "final");
    expect(final.statusCode).toBe(200);
    expect((final.json() as TranscribeWire).note.status).toBe("transcribed");
  });

  it("una nota con tareas creadas (converted) no admite transcripción interim: 409", async () => {
    let llamado = false;
    const fixture = await fx({
      noteTranscriber: {
        async transcribe() {
          llamado = true;
          return resultado();
        },
      },
    });
    const note = await createNote(fixture, { project_id: fixture.project.id });
    await capturar(fixture, note.id);
    await updateCanvasNote(fixture.db, note.id, { status: "converted" });

    const res = await transcribir(fixture, note.id, "interim");
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe("conflict");
    expect(llamado).toBe(false);

    // En modo final sí: rehacer la lectura sigue permitido.
    const final = await transcribir(fixture, note.id, "final");
    expect(final.statusCode).toBe(200);
    expect(llamado).toBe(true);
  });

  it("sin imagen capturada no se transcribe (ni en borrador ni en interim): 409 con mensaje claro", async () => {
    let llamado = false;
    const fixture = await fx({
      noteTranscriber: {
        async transcribe() {
          llamado = true;
          throw new Error("no debería llamarse");
        },
      },
    });
    const note = await createNote(fixture, { project_id: fixture.project.id });

    for (const mode of [undefined, "interim", "final"] as const) {
      const res = await transcribir(fixture, note.id, mode);
      expect(res.statusCode).toBe(409);
      expect((res.json() as { error: { code: string } }).error.code).toBe("conflict");
      expect((res.json() as { error: { message: string } }).error.message).toMatch(/captura/i);
    }
    expect(llamado).toBe(false);

    const otro = await transcribir(fixture, note.id, "otro" as never);
    expect(otro.statusCode).toBe(400);
  });

  it("si el proveedor falla, sale provider_unavailable y la nota NO se toca", async () => {
    const fixture = await fx({
      noteTranscriber: {
        async transcribe() {
          throw errors.providerUnavailable(
            "No se pudo transcribir con 'openai' (gpt-5.6-luna): el proveedor rechazó las credenciales (revisa OPENAI_API_KEY).",
          );
        },
      },
    });
    const note = await createNote(fixture, { project_id: fixture.project.id });
    const capturada = await capturar(fixture, note.id);

    const res = await fixture.api.app.inject({
      method: "POST",
      url: `/api/notes/${note.id}/transcribe`,
      headers: fixture.authHeaders,
    });
    expect(res.statusCode).toBe(502);
    const error = (res.json() as { error: { code: string; message: string } }).error;
    expect(error.code).toBe("provider_unavailable");
    expect(error.message).toContain("OPENAI_API_KEY");

    // Ni transcripción inventada ni cambio de estado.
    const despues = await fixture.api.app.inject({
      method: "GET",
      url: `/api/notes/${note.id}`,
      headers: fixture.authHeaders,
    });
    const nota = (despues.json() as { note: NoteWire }).note;
    expect(nota.transcription).toBeNull();
    expect(nota.status).toBe("captured");
    expect(nota.version).toBe(capturada.version);
  });

  it("el humano corrige la transcripción por PATCH; con versión vieja da 409", async () => {
    const fixture = await fx({
      noteTranscriber: {
        async transcribe() {
          return resultado({
            markdown: "presupesto [?: presupuesto]",
            bloques: [{ bloque: 0, texto: "presupesto" }],
            dudas: ["presupesto"],
          });
        },
      },
    });
    const note = await createNote(fixture, { project_id: fixture.project.id });
    await capturar(fixture, note.id);
    const transcrita = (
      (
        await fixture.api.app.inject({
          method: "POST",
          url: `/api/notes/${note.id}/transcribe`,
          headers: fixture.authHeaders,
        })
      ).json() as { note: NoteWire }
    ).note;
    // Se guarda la lectura elegida, sin el marcador; la duda va en `dudas`.
    expect(transcrita.transcription).toBe("presupesto");

    const corregida = await fixture.api.app.inject({
      method: "PATCH",
      url: `/api/notes/${note.id}`,
      headers: fixture.authHeaders,
      payload: { transcription: "presupuesto", expected_version: transcrita.version },
    });
    expect(corregida.statusCode).toBe(200);
    const nota = (corregida.json() as { note: NoteWire }).note;
    expect(nota.transcription).toBe("presupuesto");
    // Corregir el texto no devuelve la nota a otro estado.
    expect(nota.status).toBe("transcribed");

    // Segunda corrección con la versión ya consumida: 409, no se pisa nada.
    const tarde = await fixture.api.app.inject({
      method: "PATCH",
      url: `/api/notes/${note.id}`,
      headers: fixture.authHeaders,
      payload: { transcription: "otra cosa", expected_version: transcrita.version },
    });
    expect(tarde.statusCode).toBe(409);
    expect((tarde.json() as { error: { code: string } }).error.code).toBe("version_conflict");
  });

  it("una nota inexistente responde 404 y sin sesión no se pasa", async () => {
    const fixture = await fx();
    const missing = await fixture.api.app.inject({
      method: "GET",
      url: "/api/notes/no-existe",
      headers: fixture.authHeaders,
    });
    expect(missing.statusCode).toBe(404);

    const anon = await fixture.api.app.inject({ method: "GET", url: "/api/notes" });
    expect(anon.statusCode).toBe(401);
  });
});
