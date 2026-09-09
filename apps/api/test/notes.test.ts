/**
 * Notas manuscritas (REST): crear → autoguardar con `expected_version` →
 * terminar (captura del PNG) → servir la imagen. Cubre el 409 por versión, que
 * el binario NO entra en la base (queda en disco con ruta relativa) y el enlace
 * a `artifacts` cuando la captura viene anclada a una tarea.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { queryAudit } from "@agentos/db";
import { makeFixture, makeReadyTask, type TestFixture } from "./helpers.js";

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

  async function fx(): Promise<TestFixture> {
    const fixture = await makeFixture();
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
