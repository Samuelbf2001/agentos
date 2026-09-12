/**
 * Imágenes subidas desde la descripción de una tarea (Markdown `![..](..)`).
 *
 * Reglas heredadas de `artifact-files.ts`:
 * - El binario NUNCA entra en la base ni en el árbol versionado: vive bajo la
 *   MISMA raíz de artefactos (`artifactsRoot`), en `<root>/uploads/<yyyy-mm>/`.
 * - No hay tabla nueva. El id del archivo ES la clave: `GET /api/uploads/:id`
 *   lo localiza buscando `<id><ext>` sólo entre las extensiones permitidas y
 *   sólo dentro de carpetas `yyyy-mm`. Con el id validado contra
 *   `^[0-9a-f-]{36}$` (uuid v7 de `newId()`) no hay forma de construir un
 *   salto de directorio: ni `/`, ni `\`, ni `..`.
 * - El mimetype que declara el cliente decide si ACEPTAMOS la subida, pero lo
 *   que se sirve al navegador sale de la extensión con la que guardamos, no de
 *   la cabecera del cliente.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { artifactsRoot } from "./artifact-files.js";

/** 10 MB: una captura de pantalla generosa, lejos de llenar un disco por error. */
export const DEFAULT_MAX_UPLOAD_IMAGE_BYTES = 10 * 1024 * 1024;

/** Carpeta (relativa a la raíz de artefactos) donde viven las imágenes. */
export const UPLOADS_DIR = "uploads";

/** Id de subida: uuid v7 en minúsculas con guiones, exactamente 36 caracteres. */
export const UPLOAD_ID_RE = /^[0-9a-f-]{36}$/;

/** Tipos aceptados en la subida. Cualquier otro mimetype es 400 `validation`. */
export const UPLOAD_IMAGE_MIMES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export type UploadImageMime = (typeof UPLOAD_IMAGE_MIMES)[number];

/** Extensión con la que se guarda cada mimetype aceptado. */
const EXT_BY_MIME: Record<UploadImageMime, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

/**
 * Extensiones que se buscan al resolver un id (incluye `.jpeg`, que nosotros
 * no escribimos, por si un archivo llegó de otra vía). Es la lista COMPLETA de
 * lo que la ruta se permite abrir: nada fuera de aquí se sirve.
 */
const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export function maxUploadImageBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.AGENTOS_UPLOAD_IMAGE_MAX_BYTES;
  const parsed = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : DEFAULT_MAX_UPLOAD_IMAGE_BYTES;
}

/** Normaliza la cabecera del cliente (`image/png; charset=...`) a un mimetype seco. */
export function normalizeUploadMime(declared: string | null | undefined): string {
  return (declared ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

/** Extensión con la que se guardará ese mimetype, o `null` si no es una imagen aceptada. */
export function uploadExtensionFor(mime: string): string | null {
  return EXT_BY_MIME[mime as UploadImageMime] ?? null;
}

/** ¿Es un mimetype de imagen que esta API sabe leer y servir? */
export function isImageMime(mime: string | null | undefined): boolean {
  const normalized = normalizeUploadMime(mime);
  return Object.values(MIME_BY_EXT).includes(normalized);
}

/** Raíz de las subidas: `<raíz de artefactos>/uploads`. Se resuelve en cada llamada. */
export function uploadsRoot(): string {
  return path.join(artifactsRoot(null), UPLOADS_DIR);
}

/** Carpeta por mes (`yyyy-mm`): mantiene los directorios pequeños y el barrido corto. */
export function uploadMonthFolder(at: Date = new Date()): string {
  const year = at.getUTCFullYear();
  const month = String(at.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

/** URL pública (relativa) de una imagen subida. Es lo que va en el Markdown. */
export function uploadUrl(id: string): string {
  return `/api/uploads/${id}`;
}

export interface StoredUpload {
  id: string;
  absolutePath: string;
  /** Ruta relativa a la raíz de artefactos (`uploads/yyyy-mm/<id><ext>`). */
  relativePath: string;
  mime: UploadImageMime;
  bytes: number;
}

/**
 * Escribe la imagen en `<root>/uploads/<yyyy-mm>/<id><ext>`. El id lo genera la
 * ruta con `newId()` (uuid v7, igual que el resto de ids del repo).
 */
export function storeUploadImage(input: {
  id: string;
  mime: UploadImageMime;
  data: Buffer;
  at?: Date;
}): StoredUpload {
  const ext = EXT_BY_MIME[input.mime];
  const month = uploadMonthFolder(input.at ?? new Date());
  const relativePath = path.posix.join(UPLOADS_DIR, month, `${input.id}${ext}`);
  const absolutePath = path.join(artifactsRoot(null), UPLOADS_DIR, month, `${input.id}${ext}`);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, input.data);
  return {
    id: input.id,
    absolutePath,
    relativePath,
    mime: input.mime,
    bytes: input.data.byteLength,
  };
}

/**
 * Localiza en disco la imagen de un id. Sin tabla: se prueba `<id><ext>` para
 * cada extensión permitida dentro de cada carpeta `yyyy-mm`.
 *
 * Devuelve `null` (nunca lanza) si el id no tiene la forma de uuid, si la raíz
 * no existe todavía o si el archivo no está. Lo reutiliza el asistente de IA
 * para leer del disco SOLO las imágenes locales de la descripción.
 */
export async function resolveUploadPath(
  id: string,
): Promise<{ path: string; mime: string } | null> {
  if (!UPLOAD_ID_RE.test(id)) return null;
  const root = uploadsRoot();
  let months: string[];
  try {
    months = await fsp.readdir(root);
  } catch {
    return null;
  }
  // Las más recientes primero: una imagen recién pegada se encuentra al primer intento.
  const folders = months.filter((name) => /^\d{4}-\d{2}$/.test(name)).sort().reverse();
  for (const month of folders) {
    for (const [ext, mime] of Object.entries(MIME_BY_EXT)) {
      const candidate = path.join(root, month, `${id}${ext}`);
      try {
        const stat = await fsp.stat(candidate);
        if (stat.isFile()) return { path: candidate, mime };
      } catch {
        // Siguiente extensión.
      }
    }
  }
  return null;
}
