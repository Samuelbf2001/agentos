/**
 * Notas manuscritas (fase 1 del módulo de Notas): un lienzo Excalidraw donde
 * se escribe con tableta gráfica, autoguardado desde la interfaz y, al pulsar
 * "Terminar notas", un PNG limpio guardado para que una fase posterior lo
 * transcriba.
 *
 * Reglas heredadas del repo:
 * - `expected_version` en el guardado → 409 `version_conflict`, igual que
 *   `/api/tasks/:id`. El autoguardado no hace last-write-wins en silencio.
 * - El binario NUNCA entra en la base: se escribe bajo la raíz de artefactos
 *   (`AGENTOS_ARTIFACTS_DIR` …) y la fila guarda la ruta relativa, misma
 *   frontera que `artifacts.path` (ARCHITECTURE §5, adenda 2026-09-05).
 * - Toda mutación audita.
 *
 * `image_artifact_id` sólo se puede rellenar cuando la captura viene con
 * `task_id`: `artifacts.task_id` es NOT NULL y una nota no es una tarea. Sin
 * tarea, la nota se basta con su propia ruta (`GET /api/notes/:id/image`).
 */
import fs from "node:fs";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { CanvasNoteStatus, emptyCanvasScene, errors, newId } from "@agentos/shared";
import {
  appendAudit,
  attachArtifact,
  captureCanvasNote,
  createCanvasNote,
  getCanvasNote,
  getProject,
  getTask,
  listCanvasNotes,
  updateCanvasNote,
} from "@agentos/db";
import {
  artifactsRoot,
  maxArtifactBytes,
  resolveArtifactPath,
  storeCanvasNoteImage,
} from "../artifact-files.js";
import type { ApiContext } from "../context.js";
import { parse } from "../http-errors.js";

/** La escena es JSON opaco de Excalidraw: se valida la forma mínima, no el contenido. */
const Scene = z.object({ elements: z.array(z.unknown()) }).catchall(z.unknown());

const ListQuery = z.object({
  project_id: z.string().optional(),
  status: CanvasNoteStatus.optional(),
});

const CreateBody = z.object({
  title: z.string().min(1).max(200).optional(),
  project_id: z.string().optional(),
});

const UpdateBody = z.object({
  title: z.string().min(1).max(200).optional(),
  scene: Scene.optional(),
  expected_version: z.number().int().positive().optional(),
});

const CaptureBody = z.object({
  /** PNG en base64 (con o sin prefijo data:). */
  image_base64: z.string().min(1),
  /** Opcional: ancla el PNG a una tarea y crea además su fila en `artifacts`. */
  task_id: z.string().optional(),
});

const DATA_URL_PREFIX = /^data:image\/png;base64,/i;

export function registerNoteRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const { db } = ctx;

  const personActor = (req: { session?: { personId: string } | undefined }): string =>
    `person:${req.session!.personId}`;

  app.get("/api/notes", async (req) => {
    const query = parse(ListQuery, req.query);
    const notes = await listCanvasNotes(db, {
      ...(query.project_id ? { projectId: query.project_id } : {}),
      ...(query.status ? { status: query.status } : {}),
    });
    return { notes };
  });

  /** Nace en borrador y con la escena vacía: escribir es el primer gesto, no rellenar un formulario. */
  app.post("/api/notes", async (req, reply) => {
    const body = parse(CreateBody, req.body);
    let orgId: string | null = null;
    if (body.project_id) {
      const project = await getProject(db, body.project_id);
      if (!project) throw errors.notFound("project", body.project_id);
      orgId = project.orgId;
    }
    const note = await createCanvasNote(db, {
      orgId,
      projectId: body.project_id ?? null,
      title: body.title?.trim() || "Notas sin título",
      scene: emptyCanvasScene(),
      status: "draft",
      createdByPersonId: req.session!.personId,
    });
    await appendAudit(db, {
      actor: personActor(req),
      source: "ui",
      action: "note.create",
      entityType: "canvas_note",
      entityId: note.id,
      after: { title: note.title, projectId: note.projectId },
    });
    reply.status(201);
    return { note };
  });

  app.get("/api/notes/:id", async (req) => {
    const { id } = req.params as { id: string };
    const note = await getCanvasNote(db, id);
    if (!note) throw errors.notFound("canvas_note", id);
    return { note };
  });

  /** Autoguardado del lienzo. Con `expected_version`, el conflicto es 409 y no se pierde nada. */
  app.patch("/api/notes/:id", async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(UpdateBody, req.body);
    const before = await getCanvasNote(db, id);
    if (!before) throw errors.notFound("canvas_note", id);
    if (body.title === undefined && body.scene === undefined) {
      throw errors.validation("Nada que guardar: manda `title`, `scene` o ambos");
    }

    const note = await updateCanvasNote(
      db,
      id,
      {
        ...(body.title !== undefined ? { title: body.title.trim() } : {}),
        ...(body.scene !== undefined
          ? { scene: body.scene as { elements: readonly unknown[] } }
          : {}),
      },
      body.expected_version,
    );
    await appendAudit(db, {
      actor: personActor(req),
      source: "ui",
      action: "note.update",
      entityType: "canvas_note",
      entityId: id,
      before: { version: before.version, title: before.title },
      after: { version: note.version, title: note.title, elements: note.scene.elements.length },
    });
    return { note };
  });

  /**
   * "Terminar notas": recibe el PNG ya exportado por el lienzo (escala 3, fondo
   * blanco, recortado al contenido) y lo guarda. La transcripción es fase 2:
   * aquí sólo queda la imagen lista y el estado en `captured`.
   */
  app.post("/api/notes/:id/capture", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parse(CaptureBody, req.body);
    const note = await getCanvasNote(db, id);
    if (!note) throw errors.notFound("canvas_note", id);

    const base64 = body.image_base64.replace(DATA_URL_PREFIX, "").trim();
    let data: Buffer;
    try {
      data = Buffer.from(base64, "base64");
    } catch {
      throw errors.validation("El PNG no es base64 válido");
    }
    if (data.byteLength === 0) throw errors.validation("La imagen está vacía");
    if (data.byteLength > maxArtifactBytes()) {
      return reply.status(413).send({
        error: {
          code: "file_too_large",
          message: `La imagen supera el límite de ${Math.round(maxArtifactBytes() / (1024 * 1024))} MB`,
        },
      });
    }

    const project = (note.projectId ? await getProject(db, note.projectId) : null) ?? null;
    const root = artifactsRoot(project);
    const stored = storeCanvasNoteImage({
      root,
      noteId: note.id,
      sequence: note.version,
      data,
    });

    // Sólo con tarea puede existir fila en `artifacts` (su task_id es NOT NULL).
    let artifactId: string | null = null;
    if (body.task_id) {
      const task = await getTask(db, body.task_id);
      if (!task) throw errors.notFound("task", body.task_id);
      const artifact = await attachArtifact(db, {
        id: newId(),
        taskId: task.id,
        kind: "file",
        title: note.title,
        content: null,
        path: stored.relativePath,
        meta: {
          originalName: `${note.title}.png`,
          mimeType: "image/png",
          bytes: stored.bytes,
          storage: "artifacts_root",
          canvasNoteId: note.id,
        },
        createdBy: personActor(req),
      });
      artifactId = artifact.id;
    }

    const captured = await captureCanvasNote(db, id, {
      imagePath: stored.relativePath,
      imageBytes: stored.bytes,
      imageArtifactId: artifactId,
    });
    await appendAudit(db, {
      actor: personActor(req),
      source: "ui",
      action: "note.capture",
      entityType: "canvas_note",
      entityId: id,
      before: { status: note.status },
      after: { status: captured.status, bytes: stored.bytes, artifactId },
    });
    reply.status(201);
    return { note: captured };
  });

  /** El PNG de la nota. Misma defensa contra path traversal que la descarga de artefactos. */
  app.get("/api/notes/:id/image", async (req, reply) => {
    const { id } = req.params as { id: string };
    const note = await getCanvasNote(db, id);
    if (!note) throw errors.notFound("canvas_note", id);
    if (!note.imagePath) throw errors.notFound("canvas_note_image", id);
    const project = (note.projectId ? await getProject(db, note.projectId) : null) ?? null;
    const absolute = resolveArtifactPath(artifactsRoot(project), note.imagePath);
    if (!fs.existsSync(absolute)) throw errors.notFound("canvas_note_image", id);
    reply.header("content-type", "image/png");
    return reply.send(fs.createReadStream(absolute));
  });
}
