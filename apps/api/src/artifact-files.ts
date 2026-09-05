/**
 * Almacenamiento de artefactos subidos desde la interfaz.
 *
 * Regla dura: los archivos NUNCA se guardan dentro del árbol versionado. El
 * destino se resuelve, en este orden:
 *   1. `AGENTOS_ARTIFACTS_DIR` (ruta absoluta configurable en despliegue).
 *   2. `<workspace_path del proyecto>/artifacts`, cuando el proyecto tiene
 *      workspace propio (el runner ya escribe ahí).
 *   3. `<repo>/data/artifacts`, junto a la base local — `data/` está en
 *      .gitignore, así que nunca entra en un commit.
 *
 * La fila `artifacts.path` guarda una ruta RELATIVA a esa raíz. Así una base
 * copiada entre máquinas sigue resolviendo, y la descarga puede comprobar que
 * la ruta pedida cae dentro de la raíz (defensa contra path traversal).
 */
import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT, type Project } from "@agentos/db";
import { errors } from "@agentos/shared";

/** 25 MB: suficiente para un entregable real, lejos de llenar un disco por error. */
export const DEFAULT_MAX_ARTIFACT_BYTES = 25 * 1024 * 1024;

export function maxArtifactBytes(): number {
  const raw = process.env.AGENTOS_ARTIFACT_MAX_BYTES;
  const parsed = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_MAX_ARTIFACT_BYTES;
}

/** Raíz de almacenamiento del proyecto (creada al vuelo, nunca dentro del repo git). */
export function artifactsRoot(project: Pick<Project, "workspacePath"> | null): string {
  const configured = process.env.AGENTOS_ARTIFACTS_DIR?.trim();
  if (configured) return path.resolve(configured);
  const workspace = project?.workspacePath?.trim();
  if (workspace) return path.resolve(workspace, "artifacts");
  return path.resolve(REPO_ROOT, "data", "artifacts");
}

/**
 * Nombre de archivo seguro: sin separadores, sin `..`, sin caracteres que
 * Windows rechaza. Conserva la extensión para que el navegador la reconozca.
 */
export function safeFileName(original: string): string {
  const base = original.replace(/\\/g, "/").split("/").pop() ?? "";
  const cleaned = base
    // Caracteres prohibidos en Windows, espacios y controles. Letras,
    // dígitos, acentos, guiones y el punto de la extensión se conservan.
    .replace(/[<>:"|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 120);
  return cleaned || "archivo";
}

export interface StoredArtifactFile {
  /** Ruta relativa a la raíz; es lo que se guarda en `artifacts.path`. */
  relativePath: string;
  absolutePath: string;
  bytes: number;
}

/**
 * Escribe el contenido bajo `<root>/<projectId>/<taskId>/<id>-<nombre>`.
 * El id del artefacto va en el nombre para que dos subidas del mismo archivo
 * no se pisen y para que borrar una fila identifique su archivo sin ambigüedad.
 */
export function storeArtifactFile(input: {
  root: string;
  projectId: string;
  taskId: string;
  artifactId: string;
  fileName: string;
  data: Buffer;
}): StoredArtifactFile {
  const relativeDir = path.join(input.projectId, input.taskId);
  const fileName = `${input.artifactId}-${safeFileName(input.fileName)}`;
  const relativePath = path.join(relativeDir, fileName);
  const absolutePath = path.join(input.root, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, input.data);
  return { relativePath: relativePath.split(path.sep).join("/"), absolutePath, bytes: input.data.byteLength };
}

/**
 * Resuelve una ruta almacenada contra su raíz rechazando cualquier salto fuera
 * de ella. Las rutas absolutas heredadas (artefactos que escribió un runner en
 * el workspace) se aceptan tal cual: no vienen de una petición HTTP.
 */
export function resolveArtifactPath(root: string, stored: string): string {
  if (path.isAbsolute(stored)) return stored;
  const resolved = path.resolve(root, stored);
  const normalizedRoot = path.resolve(root);
  const relative = path.relative(normalizedRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw errors.validation("La ruta del artefacto sale del directorio de artefactos", { path: stored });
  }
  return resolved;
}

/** Tipo MIME por extensión; deliberadamente corto y conservador. */
export function guessContentType(fileName: string, declared?: string | null): string {
  if (declared && declared !== "application/octet-stream") return declared;
  const ext = path.extname(fileName).toLowerCase();
  const map: Record<string, string> = {
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".csv": "text/csv; charset=utf-8",
    ".json": "application/json",
    ".zip": "application/zip",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  };
  return map[ext] ?? "application/octet-stream";
}
