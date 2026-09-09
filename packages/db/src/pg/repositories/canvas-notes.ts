/** Espejo Postgres de src/repositories/canvas-notes.ts — misma superficie, asíncrona (§NFR-9). */
import { and, desc, eq, sql } from "drizzle-orm";
import { errors, newId, nowMs, type CanvasNoteStatus } from "@agentos/shared";
import type { AgentosPgDb } from "../client-pg.js";
import { canvasNotes } from "../schema-pg.js";
import type { CanvasNote, NewCanvasNote } from "../types-pg.js";

export type CanvasNotePatch = Partial<
  Pick<CanvasNote, "title" | "scene" | "projectId" | "orgId" | "status" | "transcription">
>;

export interface CanvasNoteCapture {
  imagePath: string;
  imageBytes: number;
  /** Sólo cuando la nota se ancló a una tarea (artifacts.task_id es NOT NULL). */
  imageArtifactId?: string | null;
}

export interface CanvasNoteFilter {
  projectId?: string;
  orgId?: string;
  status?: CanvasNoteStatus;
}

export async function createCanvasNote(
  db: AgentosPgDb,
  input: Omit<NewCanvasNote, "id" | "createdAt" | "updatedAt" | "version"> & { id?: string },
): Promise<CanvasNote> {
  const now = nowMs();
  const row: NewCanvasNote = {
    ...input,
    id: input.id ?? newId(),
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(canvasNotes).values(row);
  return (await getCanvasNote(db, row.id!))!;
}

export async function getCanvasNote(
  db: AgentosPgDb,
  id: string,
): Promise<CanvasNote | undefined> {
  const [row] = await db.select().from(canvasNotes).where(eq(canvasNotes.id, id)).limit(1);
  return row;
}

export async function listCanvasNotes(
  db: AgentosPgDb,
  filter: CanvasNoteFilter = {},
): Promise<CanvasNote[]> {
  const conds = [];
  if (filter.projectId) conds.push(eq(canvasNotes.projectId, filter.projectId));
  if (filter.orgId) conds.push(eq(canvasNotes.orgId, filter.orgId));
  if (filter.status) conds.push(eq(canvasNotes.status, filter.status));
  const base = db.select().from(canvasNotes);
  const q = conds.length > 0 ? base.where(and(...conds)) : base;
  return await q.orderBy(desc(canvasNotes.updatedAt));
}

export async function updateCanvasNote(
  db: AgentosPgDb,
  id: string,
  patch: CanvasNotePatch,
  expectedVersion?: number,
): Promise<CanvasNote> {
  const current = await getCanvasNote(db, id);
  if (!current) throw errors.notFound("canvas_note", id);

  const set = { ...patch, updatedAt: nowMs(), version: sql`${canvasNotes.version} + 1` };
  if (expectedVersion !== undefined) {
    const rows = await db
      .update(canvasNotes)
      .set(set)
      .where(and(eq(canvasNotes.id, id), eq(canvasNotes.version, expectedVersion)))
      .returning({ id: canvasNotes.id });
    if (rows.length === 0) throw errors.versionConflict("canvas_note", id, expectedVersion);
  } else {
    await db.update(canvasNotes).set(set).where(eq(canvasNotes.id, id));
  }
  return (await getCanvasNote(db, id))!;
}

export async function captureCanvasNote(
  db: AgentosPgDb,
  id: string,
  capture: CanvasNoteCapture,
): Promise<CanvasNote> {
  const current = await getCanvasNote(db, id);
  if (!current) throw errors.notFound("canvas_note", id);
  await db
    .update(canvasNotes)
    .set({
      imagePath: capture.imagePath,
      imageBytes: capture.imageBytes,
      imageArtifactId: capture.imageArtifactId ?? null,
      capturedAt: nowMs(),
      status: "captured",
      updatedAt: nowMs(),
      version: sql`${canvasNotes.version} + 1`,
    })
    .where(eq(canvasNotes.id, id));
  return (await getCanvasNote(db, id))!;
}
