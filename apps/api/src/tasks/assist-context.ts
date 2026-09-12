/**
 * Contexto que ve el asistente de IA de una tarea.
 *
 * Función pura y testeable (`buildTaskAssistContext`): recibe la DB y el cuerpo
 * de la petición y devuelve TODO lo que el modelo necesita saber — cliente,
 * proyecto, documentos del Context Hub, tareas hermanas, la tarea guardada con
 * sus últimos eventos y artefactos, y las imágenes locales de la descripción.
 * No sabe nada de Fastify ni del proveedor: eso lo pone la ruta.
 *
 * Reglas:
 * - Presupuesto de contexto acotado (12 documentos, ~1.500 caracteres cada uno,
 *   ~12.000 en total): un cliente con 300 documentos no revienta la petición.
 * - Las imágenes se leen SOLO del disco propio (`/api/uploads/<id>` y
 *   `/api/artifacts/<id>/download`). Las externas (S3 de Notion, etc.) se
 *   cuentan y se ignoran: nunca se descarga una URL que trae el contenido de
 *   una tarea (SSRF).
 * - Local se decide por el PATHNAME, no por el origen: la interfaz inserta la
 *   imagen con URL absoluta (`https://agentos.sixteam.pro/api/uploads/<id>`) o
 *   relativa (`/api/uploads/<id>`) según el entorno, y las dos son la misma.
 */
import fsp from "node:fs/promises";
import { z } from "zod";
import {
  getArtifact,
  getOrganization,
  getPerson,
  getProject,
  getTask,
  listArtifacts,
  listDocs,
  listTaskEvents,
  listTasks,
  type AgentosDb,
} from "@agentos/db";
import { artifactsRoot, resolveArtifactPath } from "../artifact-files.js";
import { isImageMime, normalizeUploadMime, resolveUploadPath } from "../uploads.js";

// ── Contrato HTTP ───────────────────────────────────────────────────────────

export const TaskAssistMode = z.enum(["enrich", "execution_prompt"]);
export const TaskAssistField = z.enum(["title", "description", "definition_of_done"]);

export const TaskAssistDraft = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  definition_of_done: z.string().optional(),
  project_id: z.string().optional(),
  priority: z.string().optional(),
  due_at: z.number().nullable().optional(),
  labels: z.array(z.string()).optional(),
  assignee_person_ids: z.array(z.string()).optional(),
});

/**
 * `field` es obligatorio en modo `enrich` (sin él no se sabe qué campo
 * mejorar) y se ignora en `execution_prompt`.
 */
export const TaskAssistBody = z
  .object({
    mode: TaskAssistMode,
    field: TaskAssistField.optional(),
    task_id: z.string().min(1).optional(),
    draft: TaskAssistDraft.optional(),
    instructions: z.string().optional(),
  })
  .refine((value) => value.mode !== "enrich" || value.field !== undefined, {
    message: "field es obligatorio cuando mode=enrich",
    path: ["field"],
  });

export type TaskAssistBodyT = z.infer<typeof TaskAssistBody>;
export type TaskAssistDraftT = z.infer<typeof TaskAssistDraft>;
export type TaskAssistFieldT = z.infer<typeof TaskAssistField>;

// ── Presupuesto de contexto ─────────────────────────────────────────────────

export const MAX_DOCS = 12;
export const MAX_DOC_CHARS = 1_500;
export const MAX_DOCS_TOTAL_CHARS = 12_000;
export const MAX_SIBLING_TASKS = 20;
export const MAX_TASK_EVENTS = 10;
export const MAX_IMAGES = 6;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_ARTIFACT_CONTENT_CHARS = 600;
const MAX_EVENT_TEXT_CHARS = 400;

// ── Forma del contexto ──────────────────────────────────────────────────────

export interface AssistOrg {
  id: string;
  name: string;
  industry: string | null;
  notes: string | null;
}

export interface AssistProject {
  id: string;
  name: string;
  type: string;
  stage: string;
}

export interface AssistDoc {
  id: string;
  title: string;
  kind: string;
  scope: "org" | "project";
  body_md: string;
  truncated: boolean;
}

export interface AssistSiblingTask {
  id: string;
  title: string;
  status: string;
  due_at: number | null;
}

export interface AssistEvent {
  kind: string;
  actor: string;
  text: string | null;
  created_at: number;
}

export interface AssistArtifact {
  id: string;
  kind: string;
  title: string;
  content: string | null;
  url: string | null;
}

export interface AssistTask {
  id: string;
  title: string;
  description: string | null;
  definition_of_done: string | null;
  status: string;
  stage: string;
  priority: string;
  due_at: number | null;
}

export interface AssistImage {
  /** URL tal como aparecía en el Markdown (o el id del artefacto). */
  source: string;
  alt: string | null;
  mediaType: string;
  data: Buffer;
}

export interface TaskAssistContext {
  org: AssistOrg | null;
  project: AssistProject | null;
  docs: AssistDoc[];
  siblingTasks: AssistSiblingTask[];
  task: AssistTask | null;
  events: AssistEvent[];
  artifacts: AssistArtifact[];
  /** Nombres completos de las personas asignadas (las que se pudieron resolver). */
  assignees: string[];
  images: AssistImage[];
  /** Imágenes externas encontradas y NO descargadas (Notion, S3, …). */
  externalImages: string[];
}

// ── Imágenes del Markdown ───────────────────────────────────────────────────

export type ImagenRef =
  | { kind: "upload"; id: string }
  | { kind: "artifact"; id: string }
  | { kind: "external" };

/** `![alt](url "título")`, con o sin `<>` alrededor de la URL. */
const MARKDOWN_IMAGE_RE = /!\[([^\]]*)\]\(\s*<?([^)\s<>]+)>?[^)]*\)/g;

/**
 * ¿Esta URL apunta a un archivo NUESTRO? Se decide por el pathname, ignorando
 * el origen: la interfaz escribe `http://localhost:4300/api/uploads/<id>` en
 * desarrollo y `https://agentos.sixteam.pro/api/uploads/<id>` en producción, y
 * las dos son el mismo archivo local. Cualquier otro pathname es externo y no
 * se descarga jamás.
 */
export function clasificarImagenUrl(raw: string): ImagenRef {
  let pathname: string;
  try {
    pathname = new URL(raw, "http://local").pathname;
  } catch {
    return { kind: "external" };
  }
  const upload = /^\/api\/uploads\/([^/]+)$/.exec(pathname);
  if (upload) return { kind: "upload", id: safeDecode(upload[1]!) };
  const artifact = /^\/api\/artifacts\/([^/]+)\/download$/.exec(pathname);
  if (artifact) return { kind: "artifact", id: safeDecode(artifact[1]!) };
  return { kind: "external" };
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Todas las imágenes Markdown de un texto, en orden de aparición. */
export function extraerImagenesMarkdown(texto: string | null | undefined): {
  alt: string;
  url: string;
}[] {
  if (!texto) return [];
  const out: { alt: string; url: string }[] = [];
  for (const match of texto.matchAll(MARKDOWN_IMAGE_RE)) {
    const url = match[2]?.trim();
    if (url) out.push({ alt: (match[1] ?? "").trim(), url });
  }
  return out;
}

// ── Construcción del contexto ───────────────────────────────────────────────

export function recortar(texto: string, max: number): { text: string; truncated: boolean } {
  const limpio = texto.trim();
  if (limpio.length <= max) return { text: limpio, truncated: false };
  return { text: `${limpio.slice(0, max).trimEnd()}…`, truncated: true };
}

export async function buildTaskAssistContext(
  db: AgentosDb,
  body: TaskAssistBodyT,
): Promise<TaskAssistContext> {
  const draft = body.draft ?? {};
  const savedTask = body.task_id ? ((await getTask(db, body.task_id)) ?? null) : null;
  const projectId = draft.project_id?.trim() || savedTask?.projectId || null;
  const projectRow = projectId ? ((await getProject(db, projectId)) ?? null) : null;
  const orgRow = projectRow ? ((await getOrganization(db, projectRow.orgId)) ?? null) : null;

  const org: AssistOrg | null = orgRow
    ? {
        id: orgRow.id,
        name: orgRow.name,
        industry: orgRow.industry ?? null,
        notes: orgRow.notes ?? null,
      }
    : null;
  const project: AssistProject | null = projectRow
    ? {
        id: projectRow.id,
        name: projectRow.name,
        type: projectRow.type,
        stage: projectRow.stage,
      }
    : null;

  return {
    org,
    project,
    docs: await recogerDocs(db, org?.id ?? null, project?.id ?? null),
    siblingTasks: await recogerHermanas(db, project?.id ?? null, savedTask?.id ?? null),
    task: savedTask
      ? {
          id: savedTask.id,
          title: savedTask.title,
          description: savedTask.description ?? null,
          definition_of_done: savedTask.definitionOfDone ?? null,
          status: savedTask.status,
          stage: savedTask.stage,
          priority: savedTask.priority,
          due_at: savedTask.dueAt ?? null,
        }
      : null,
    events: savedTask ? await recogerEventos(db, savedTask.id) : [],
    artifacts: savedTask ? await recogerArtefactos(db, savedTask.id) : [],
    assignees: await recogerPersonas(db, draft.assignee_person_ids ?? [], savedTask?.assigneePersonId ?? null),
    ...(await recogerImagenes(db, {
      textos: [draft.description ?? null, savedTask?.description ?? null],
      taskId: savedTask?.id ?? null,
    })),
  };
}

/**
 * Documentos del Context Hub de la organización y del proyecto (sin duplicar),
 * los más recientes primero y con el presupuesto de caracteres aplicado.
 */
async function recogerDocs(
  db: AgentosDb,
  orgId: string | null,
  projectId: string | null,
): Promise<AssistDoc[]> {
  if (!orgId && !projectId) return [];
  const porId = new Map<string, { doc: Awaited<ReturnType<typeof listDocs>>[number]; scope: "org" | "project" }>();
  if (projectId) {
    for (const doc of await listDocs(db, { projectId })) porId.set(doc.id, { doc, scope: "project" });
  }
  if (orgId) {
    for (const doc of await listDocs(db, { orgId })) {
      if (!porId.has(doc.id)) {
        porId.set(doc.id, { doc, scope: doc.projectId ? "project" : "org" });
      }
    }
  }
  const ordenados = [...porId.values()].sort(
    (a, b) => (b.doc.updatedAt ?? b.doc.createdAt) - (a.doc.updatedAt ?? a.doc.createdAt),
  );
  const out: AssistDoc[] = [];
  let total = 0;
  for (const { doc, scope } of ordenados) {
    if (out.length >= MAX_DOCS || total >= MAX_DOCS_TOTAL_CHARS) break;
    const restante = Math.min(MAX_DOC_CHARS, MAX_DOCS_TOTAL_CHARS - total);
    const { text, truncated } = recortar(doc.bodyMd ?? "", restante);
    total += text.length;
    out.push({ id: doc.id, title: doc.title, kind: doc.kind, scope, body_md: text, truncated });
  }
  return out;
}

/** Últimas tareas del mismo proyecto: para que la IA entienda de qué va esto. */
async function recogerHermanas(
  db: AgentosDb,
  projectId: string | null,
  excludeTaskId: string | null,
): Promise<AssistSiblingTask[]> {
  if (!projectId) return [];
  const tasks = await listTasks(db, { projectId });
  return tasks
    .filter((task) => task.id !== excludeTaskId)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_SIBLING_TASKS)
    .map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      due_at: task.dueAt ?? null,
    }));
}

async function recogerEventos(db: AgentosDb, taskId: string): Promise<AssistEvent[]> {
  const events = await listTaskEvents(db, taskId);
  return events.slice(-MAX_TASK_EVENTS).map((event) => {
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    const bruto =
      typeof payload.text === "string"
        ? payload.text
        : typeof payload.note === "string"
          ? payload.note
          : typeof payload.message === "string"
            ? payload.message
            : null;
    return {
      kind: event.kind,
      actor: event.actor,
      text: bruto ? recortar(bruto, MAX_EVENT_TEXT_CHARS).text : null,
      created_at: event.createdAt,
    };
  });
}

async function recogerArtefactos(db: AgentosDb, taskId: string): Promise<AssistArtifact[]> {
  const artifacts = await listArtifacts(db, taskId);
  return artifacts.map((artifact) => ({
    id: artifact.id,
    kind: artifact.kind,
    title: artifact.title,
    content: artifact.content ? recortar(artifact.content, MAX_ARTIFACT_CONTENT_CHARS).text : null,
    url: artifact.path ? `/api/artifacts/${artifact.id}/download` : null,
  }));
}

async function recogerPersonas(
  db: AgentosDb,
  personIds: string[],
  fallbackPersonId: string | null,
): Promise<string[]> {
  const ids = personIds.length > 0 ? personIds : fallbackPersonId ? [fallbackPersonId] : [];
  const nombres: string[] = [];
  for (const id of [...new Set(ids)]) {
    const person = await getPerson(db, id);
    if (person) nombres.push(person.fullName);
  }
  return nombres;
}

/**
 * Imágenes que se le pasan al modelo con visión. Sólo se abre el disco propio;
 * lo externo se cuenta y se deja fuera. Como mucho 6 imágenes de 5 MB.
 */
async function recogerImagenes(
  db: AgentosDb,
  input: { textos: (string | null)[]; taskId: string | null },
): Promise<{ images: AssistImage[]; externalImages: string[] }> {
  const images: AssistImage[] = [];
  const externalImages: string[] = [];
  const vistos = new Set<string>();

  for (const texto of input.textos) {
    for (const { alt, url } of extraerImagenesMarkdown(texto)) {
      if (vistos.has(url)) continue;
      vistos.add(url);
      const ref = clasificarImagenUrl(url);
      if (ref.kind === "external") {
        externalImages.push(url);
        continue;
      }
      if (images.length >= MAX_IMAGES) continue;
      const cargada =
        ref.kind === "upload"
          ? await leerUpload(ref.id)
          : await leerArtefactoImagen(db, ref.id);
      if (cargada) images.push({ source: url, alt: alt || null, ...cargada });
    }
  }

  // Artefactos de archivo con mime de imagen adjuntos a la tarea guardada:
  // evidencia que puede no estar citada en la descripción.
  if (input.taskId) {
    for (const artifact of await listArtifacts(db, input.taskId)) {
      if (images.length >= MAX_IMAGES) break;
      const url = `/api/artifacts/${artifact.id}/download`;
      if (vistos.has(url)) continue;
      vistos.add(url);
      const cargada = await leerArtefactoImagen(db, artifact.id);
      if (cargada) images.push({ source: url, alt: artifact.title, ...cargada });
    }
  }

  return { images, externalImages };
}

async function leerUpload(id: string): Promise<{ mediaType: string; data: Buffer } | null> {
  const found = await resolveUploadPath(id);
  if (!found) return null;
  return leerArchivo(found.path, found.mime);
}

async function leerArtefactoImagen(
  db: AgentosDb,
  id: string,
): Promise<{ mediaType: string; data: Buffer } | null> {
  const artifact = await getArtifact(db, id);
  if (!artifact?.path) return null;
  const meta = (artifact.meta ?? {}) as { storage?: string | null; mimeType?: string | null };
  // Misma guarda que la descarga: sólo binarios que ESTA API escribió.
  if (meta.storage !== "artifacts_root") return null;
  const mime = normalizeUploadMime(meta.mimeType);
  if (!isImageMime(mime)) return null;
  const task = await getTask(db, artifact.taskId);
  const project = (task ? await getProject(db, task.projectId) : null) ?? null;
  let absolute: string;
  try {
    absolute = resolveArtifactPath(artifactsRoot(project), artifact.path);
  } catch {
    return null; // Ruta fuera de la raíz: se ignora, nunca se lee.
  }
  return leerArchivo(absolute, mime);
}

async function leerArchivo(
  absolute: string,
  mediaType: string,
): Promise<{ mediaType: string; data: Buffer } | null> {
  try {
    const stat = await fsp.stat(absolute);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_IMAGE_BYTES) return null;
    return { mediaType, data: await fsp.readFile(absolute) };
  } catch {
    return null;
  }
}
