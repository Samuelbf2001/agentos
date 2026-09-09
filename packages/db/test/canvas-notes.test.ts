/**
 * Notas manuscritas: la migración 0010 crea la tabla y el repositorio cumple
 * el contrato de siempre (listado más reciente primero, `expected_version` y
 * captura del PNG). El espejo Postgres se comprueba por tipos en
 * `pg-portability.test.ts` y por datos en `pg-backend.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { emptyCanvasScene, isAgentosError } from "@agentos/shared";
import { openDb, type AgentosSqliteDb } from "../src/client.js";
import { runMigrations } from "../src/migrate.js";
import { createOrganization, createPerson } from "../src/repositories/organizations-people.js";
import { createProject } from "../src/repositories/projects.js";
import {
  captureCanvasNote,
  createCanvasNote,
  getCanvasNote,
  listCanvasNotes,
  updateCanvasNote,
} from "../src/repositories/canvas-notes.js";

function freshDb(): AgentosSqliteDb {
  const db = openDb(":memory:");
  runMigrations(db);
  return db;
}

function fixture(db: AgentosSqliteDb) {
  const org = createOrganization(db, { name: "ACME Notas S.A.", kind: "client" });
  const person = createPerson(db, { orgId: org.id, fullName: "Ernesto", isInternal: true });
  const project = createProject(db, {
    orgId: org.id,
    name: "Assessment con notas",
    type: "assessment",
    stage: "ENTENDER",
    gateState: "pending",
  });
  return { org, person, project };
}

describe("canvas_notes (migración 0010 + repositorio)", () => {
  it("la migración crea la tabla con sus índices", () => {
    const db = freshDb();
    const tables = (
      db.$client
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='canvas_notes'`)
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(tables).toEqual(["canvas_notes"]);

    const indexes = (
      db.$client
        .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='canvas_notes'`)
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(indexes).toContain("idx_canvas_notes_project");
    expect(indexes).toContain("idx_canvas_notes_org");
    expect(indexes).toContain("idx_canvas_notes_updated");
  });

  it("crea una nota vacía en borrador y la devuelve entera", () => {
    const db = freshDb();
    const { org, person, project } = fixture(db);
    const note = createCanvasNote(db, {
      orgId: org.id,
      projectId: project.id,
      title: "Reunión con dirección",
      scene: emptyCanvasScene(),
      createdByPersonId: person.id,
    });

    expect(note.status).toBe("draft");
    expect(note.version).toBe(1);
    expect(note.scene).toEqual({ elements: [] });
    expect(note.transcription).toBeNull();
    expect(note.imageArtifactId).toBeNull();
    expect(getCanvasNote(db, note.id)?.title).toBe("Reunión con dirección");
  });

  it("lista más recientes primero y filtra por proyecto", () => {
    const db = freshDb();
    const { org, project } = fixture(db);
    const otro = createProject(db, {
      orgId: org.id,
      name: "Otro proyecto",
      type: "ops",
      stage: "OPERAR",
      gateState: "approved",
    });
    const vieja = createCanvasNote(db, {
      projectId: project.id,
      title: "Vieja",
      scene: emptyCanvasScene(),
    });
    const nueva = createCanvasNote(db, {
      projectId: project.id,
      title: "Nueva",
      scene: emptyCanvasScene(),
    });
    createCanvasNote(db, { projectId: otro.id, title: "De otro", scene: emptyCanvasScene() });

    // `updated_at` puede empatar dentro del mismo ms: se toca la nueva para
    // que el orden sea determinista y no dependa del reloj.
    updateCanvasNote(db, nueva.id, { title: "Nueva" });

    const delProyecto = listCanvasNotes(db, { projectId: project.id });
    expect(delProyecto.map((n) => n.title)).toEqual(["Nueva", "Vieja"]);
    expect(listCanvasNotes(db)).toHaveLength(3);
    expect(listCanvasNotes(db, { status: "captured" })).toEqual([]);
    expect(vieja.projectId).toBe(project.id);
  });

  it("guardar la escena sube la versión; una versión vieja da version_conflict", () => {
    const db = freshDb();
    const { project } = fixture(db);
    const note = createCanvasNote(db, {
      projectId: project.id,
      title: "Boceto",
      scene: emptyCanvasScene(),
    });

    const guardada = updateCanvasNote(
      db,
      note.id,
      { scene: { elements: [{ id: "trazo-1", type: "freedraw" }] } },
      note.version,
    );
    expect(guardada.version).toBe(2);
    expect((guardada.scene.elements as { id: string }[])[0]?.id).toBe("trazo-1");

    try {
      updateCanvasNote(db, note.id, { title: "Tarde" }, note.version);
      throw new Error("debería haber lanzado version_conflict");
    } catch (err) {
      expect(isAgentosError(err)).toBe(true);
      expect((err as { code: string }).code).toBe("version_conflict");
    }

    // Sin expected_version se acepta (autoguardado a ciegas del propio dueño).
    expect(updateCanvasNote(db, note.id, { title: "Boceto 2" }).version).toBe(3);
  });

  it("capturar registra la ruta del PNG y pasa la nota a captured", () => {
    const db = freshDb();
    const { project } = fixture(db);
    const note = createCanvasNote(db, {
      projectId: project.id,
      title: "Entrevista",
      scene: emptyCanvasScene(),
    });

    const captured = captureCanvasNote(db, note.id, {
      imagePath: `notas/${note.id}/nota.png`,
      imageBytes: 4096,
    });
    expect(captured.status).toBe("captured");
    expect(captured.imagePath).toBe(`notas/${note.id}/nota.png`);
    expect(captured.imageBytes).toBe(4096);
    expect(captured.capturedAt).toBeGreaterThan(0);
    expect(captured.version).toBe(note.version + 1);
    // El binario NUNCA entra en la base: sólo su ruta relativa.
    expect(captured.imagePath?.startsWith("/")).toBe(false);
  });

  it("una nota inexistente no se puede guardar ni capturar", () => {
    const db = freshDb();
    expect(() => updateCanvasNote(db, "no-existe", { title: "x" })).toThrow();
    expect(() =>
      captureCanvasNote(db, "no-existe", { imagePath: "a.png", imageBytes: 1 }),
    ).toThrow();
  });
});
