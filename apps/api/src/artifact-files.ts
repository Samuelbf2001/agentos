/**
 * Almacenamiento de artefactos subidos desde la interfaz.
 *
 * Regla dura: los archivos NUNCA se guardan dentro del árbol versionado. El
 * destino se resuelve, en este orden:
 *   1. `AGENTOS_ARTIFACTS_DIR` (ruta absoluta configurable en despliegue).
 *   2. `<workspace_path del proyecto>/artifacts`, cuando el proyecto tiene
 *      workspace propio Y ese workspace es una ruta absoluta FUERA del
 *      repositorio (el runner ya escribe ahí). `workspacePath` viene de datos
 *      de proyecto controlados por el cliente: nunca se usa tal cual como
 *      raíz de escritura si cae dentro del repo o es relativa.
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

/**
 * `workspacePath` es un dato de proyecto que, en última instancia, puede
 * llegar a estar bajo control de quien crea/edita el proyecto. Sólo se acepta
 * como raíz de artefactos si es una ruta absoluta y cae FUERA de este
 * repositorio (otra unidad en Windows cuenta como "fuera"); si no cumple eso,
 * se ignora y se cae a los demás niveles — nunca se escribe bajo una ruta
 * arbitraria dictada por el cliente.
 */
function isOutsideRepo(absolute: string): boolean {
  const relative = path.relative(REPO_ROOT, absolute);
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

/** Raíz de almacenamiento del proyecto (creada al vuelo, nunca dentro del repo git). */
export function artifactsRoot(project: Pick<Project, "workspacePath"> | null): string {
  const configured = process.env.AGENTOS_ARTIFACTS_DIR?.trim();
  if (configured) return path.resolve(configured);
  const workspace = project?.workspacePath?.trim();
  if (workspace && path.isAbsolute(workspace)) {
    const resolvedWorkspace = path.resolve(workspace);
    if (isOutsideRepo(resolvedWorkspace)) return path.resolve(resolvedWorkspace, "artifacts");
  }
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
 * Resuelve una ruta almacenada SIEMPRE relativa a su raíz — incluida una
 * `stored` que llegue absoluta, en cuyo caso `path.resolve` la trata como
 * destino final y el guard de abajo la rechaza si cae fuera de la raíz. Nunca
 * se confía en una ruta absoluta como válida sólo por serlo.
 */
export function resolveArtifactPath(root: string, stored: string): string {
  const normalizedRoot = path.resolve(root);
  const resolved = path.resolve(normalizedRoot, stored);
  const relative = path.relative(normalizedRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw errors.validation("Artefacto no disponible");
  }
  return resolved;
}

/**
 * Tipo MIME por extensión; deliberadamente corto y conservador. Se ignora
 * cualquier mimetype declarado por el cliente (cabecera de subida): no es de
 * fiar y no debe decidir cómo el navegador interpreta la descarga.
 */
export function guessContentType(fileName: string, _declared?: string | null): string {
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
