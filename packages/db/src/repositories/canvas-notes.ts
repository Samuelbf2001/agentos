/**
 * Notas manuscritas (fase 1 del módulo de Notas): un lienzo Excalidraw por
 * fila. La escena se guarda íntegra y opaca; el PNG exportado al terminar NO
 * entra en la base — se escribe bajo la raíz de artefactos y aquí queda su
 * ruta relativa (misma regla que `artifacts.path`, ARCHITECTURE §5).
 *
 * `version` es el token de `expected_version`: dos pestañas escribiendo la
 * misma nota no se pisan en silencio, igual que en el tablero.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { errors, newId, nowMs, type CanvasNoteStatus } from "@agentos/shared";
import type { AgentosSqliteDb } from "../client.js";
import { canvasNotes } from "../schema.js";
import type { CanvasNote, NewCanvasNote } from "../types.js";

/** Campos que el usuario puede reescribir; el resto lo mueve la plataforma. */
export type CanvasNotePatch = Partial<
  Pick<
    CanvasNote,
    "title" | "scene" | "projectId" | "orgId" | "status" | "transcription" | "proposals"
  >
>;

/** Datos del PNG exportado al pulsar "Terminar notas". */
export interface CanvasNoteCapture {
  imagePath: string;
  imageBytes: number;
  /** Sólo cuando la nota se ancló a una tarea (artifacts.task_id es NOT NULL). */
  imageArtifactId?: string | null;
  /**
   * Captura intermedia («Transcribir» mientras se sigue escribiendo): guarda
   * el PNG y sube la versión, pero NO cambia el estado (un borrador sigue en
   * borrador). Sin esto, la captura pasa la nota a `captured` como siempre.
   */
  keepStatus?: boolean;
}

export interface CanvasNoteFilter {
  projectId?: string;
  orgId?: string;
  status?: CanvasNoteStatus;
}

export function createCanvasNote(
  db: AgentosSqliteDb,
  input: Omit<NewCanvasNote, "id" | "createdAt" | "updatedAt" | "version"> & { id?: string },
): CanvasNote {
  const now = nowMs();
  const row: NewCanvasNote = {
    ...input,
    id: input.id ?? newId(),
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
  db.insert(canvasNotes).values(row).run();
  return getCanvasNote(db, row.id!)!;
}

export function getCanvasNote(db: AgentosSqliteDb, id: string): CanvasNote | undefined {
  return db.select().from(canvasNotes).where(eq(canvasNotes.id, id)).get();
}

/** Más recientes primero: la lista de notas es un diario, no un catálogo. */
export function listCanvasNotes(
  db: AgentosSqliteDb,
  filter: CanvasNoteFilter = {},
): CanvasNote[] {
  const conds = [];
  if (filter.projectId) conds.push(eq(canvasNotes.projectId, filter.projectId));
  if (filter.orgId) conds.push(eq(canvasNotes.orgId, filter.orgId));
  if (filter.status) conds.push(eq(canvasNotes.status, filter.status));
  const base = db.select().from(canvasNotes);
  const q = conds.length > 0 ? base.where(and(...conds)) : base;
  return q.orderBy(desc(canvasNotes.updatedAt)).all();
}

/**
 * Guarda título y/o escena. Con `expectedVersion`, un conflicto lanza
 * `version_conflict` en vez de aplicar un last-write-wins silencioso.
 */
export function updateCanvasNote(
  db: AgentosSqliteDb,
  id: string,
  patch: CanvasNotePatch,
  expectedVersion?: number,
): CanvasNote {
  const current = getCanvasNote(db, id);
  if (!current) throw errors.notFound("canvas_note", id);

  const set = { ...patch, updatedAt: nowMs(), version: sql`${canvasNotes.version} + 1` };
  if (expectedVersion !== undefined) {
    const res = db
      .update(canvasNotes)
      .set(set)
      .where(and(eq(canvasNotes.id, id), eq(canvasNotes.version, expectedVersion)))
      .run();
    if (res.changes === 0) throw errors.versionConflict("canvas_note", id, expectedVersion);
  } else {
    db.update(canvasNotes).set(set).where(eq(canvasNotes.id, id)).run();
  }
  return getCanvasNote(db, id)!;
}

/**
 * Registra el PNG exportado y pasa la nota a `captured`. No exige
 * `expected_version`: capturar no compite con la escritura (viene del mismo
 * gesto humano) y perder la captura por una carrera del autoguardado sería
 * peor que aceptarla.
 */
export function captureCanvasNote(
  db: AgentosSqliteDb,
  id: string,
  capture: CanvasNoteCapture,
): CanvasNote {
  const current = getCanvasNote(db, id);
  if (!current) throw errors.notFound("canvas_note", id);
  db.update(canvasNotes)
    .set({
      imagePath: capture.imagePath,
      imageBytes: capture.imageBytes,
      imageArtifactId: capture.imageArtifactId ?? null,
      capturedAt: nowMs(),
      status: capture.keepStatus ? current.status : "captured",
      updatedAt: nowMs(),
      version: sql`${canvasNotes.version} + 1`,
    })
    .where(eq(canvasNotes.id, id))
    .run();
  return getCanvasNote(db, id)!;
}
