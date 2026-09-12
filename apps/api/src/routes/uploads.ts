/**
 * Subida y descarga de imágenes para las descripciones de tarea.
 *
 * `POST /api/uploads/images` (multipart, campo `file`) guarda la imagen bajo la
 * raíz de artefactos y devuelve la URL que la interfaz pega en el Markdown;
 * `GET /api/uploads/:id` la sirve. Ambas viven bajo `/api`, así que las cubre
 * la guarda de sesión global de `server.ts` — NO están en `PUBLIC_PATHS`.
 */
import fs from "node:fs";
import type { FastifyInstance } from "fastify";
import { errors, newId } from "@agentos/shared";
import { appendAudit } from "@agentos/db";
import { safeFileName } from "../artifact-files.js";
import {
  maxUploadImageBytes,
  normalizeUploadMime,
  resolveUploadPath,
  storeUploadImage,
  uploadExtensionFor,
  uploadUrl,
  type UploadImageMime,
} from "../uploads.js";
import type { ApiContext } from "../context.js";

export function registerUploadRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const db = ctx.db;
  const personActor = (req: { session?: { personId: string } | undefined }): string =>
    `person:${req.session!.personId}`;

  /**
   * Sólo imágenes (PNG/JPEG/GIF/WebP) y como mucho 10 MB. Todo lo demás sale
   * como 400 `validation`: el límite se aplica ADEMÁS en el parser
   * (`limits.fileSize`), para no leer en memoria un archivo enorme antes de
   * rechazarlo.
   */
  app.post("/api/uploads/images", async (req, reply) => {
    const limit = maxUploadImageBytes();
    const megabytes = Math.max(1, Math.round(limit / (1024 * 1024)));
    const upload = await req.file({ limits: { fileSize: limit } });
    if (!upload) throw errors.validation("Falta la imagen (campo multipart `file`)");

    const mime = normalizeUploadMime(upload.mimetype);
    if (!uploadExtensionFor(mime)) {
      // Se drena el stream antes de responder: dejar la parte a medio leer
      // cuelga la conexión en algunos clientes.
      await upload.toBuffer().catch(() => undefined);
      throw errors.validation(
        "Sólo se aceptan imágenes PNG, JPEG, GIF o WebP",
        { mime: mime || null },
      );
    }

    let data: Buffer;
    try {
      data = await upload.toBuffer();
    } catch (err) {
      if ((err as { code?: string } | undefined)?.code === "FST_REQ_FILE_TOO_LARGE") {
        throw errors.validation(`La imagen supera el límite de ${megabytes} MB`, { limit });
      }
      throw err;
    }
    // `@fastify/multipart` trunca en silencio al llegar al límite y marca la
    // parte; se comprueban las dos señales.
    if (upload.file.truncated || data.byteLength > limit) {
      throw errors.validation(`La imagen supera el límite de ${megabytes} MB`, { limit });
    }
    if (data.byteLength === 0) throw errors.validation("La imagen está vacía");

    const id = newId();
    const name = safeFileName(upload.filename ?? "imagen");
    const stored = storeUploadImage({ id, mime: mime as UploadImageMime, data });
    await appendAudit(db, {
      actor: personActor(req),
      source: "ui",
      action: "upload.image",
      entityType: "upload",
      entityId: id,
      after: { name, mime, bytes: stored.bytes, path: stored.relativePath },
    });
    reply.status(201);
    return { id, url: uploadUrl(id), name, mime, bytes: stored.bytes };
  });

  /**
   * Sirve la imagen. El contenido es inmutable (el id no se reutiliza), así que
   * se cachea un año — `private` porque detrás hay sesión y no debe quedar en
   * cachés compartidas.
   */
  app.get("/api/uploads/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const found = await resolveUploadPath(id);
    if (!found) throw errors.notFound("upload", id);
    reply
      .header("content-type", found.mime)
      .header("cache-control", "private, max-age=31536000");
    return reply.send(fs.createReadStream(found.path));
  });
}
