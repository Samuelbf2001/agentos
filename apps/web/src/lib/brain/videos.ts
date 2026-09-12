/**
 * Cliente del módulo Videos (2brain): ingesta por URL, cola de jobs
 * (`/api/brain/videos/jobs`, solo terminados: el hub los resuelve desde su
 * historial persistido), transcripción/análisis en Markdown y salud del
 * microservicio `video-ingest`. Mismo `apiRequest`/`ApiError` que el resto de
 * la app — no se toca `lib/api.ts`.
 */
import { apiRequest } from "../api";

export interface VideoJobError {
  stage: string;
  message: string;
}

export interface VideoJob {
  id: string;
  title: string | null;
  platform: string | null;
  url: string | null;
  duration: string | null;
  /** ISO 8601 (fecha en que terminó, o empezó si aún no termina). */
  date: string | null;
  status: string;
  error_count: number;
  errors: VideoJobError[];
  /** Ruta relativa a la API (`apiUrl(...)`), ya reescrita por el backend. */
  thumbnail_url: string | null;
  keyframe_urls: string[];
}

export interface VideoHealth {
  ok: boolean;
  reachable: boolean;
}

/** Encola la ingesta. El id que devuelve es el de la cola efímera del microservicio, no el `jobId` final. */
export function ingestVideo(url: string): Promise<{ id: string; status: string }> {
  return apiRequest("/api/brain/videos/ingest", { method: "POST", body: { url } });
}

/** Solo jobs ya terminados (completados, parciales o fallidos); tolera `{}` o listas vacías. */
export async function listVideoJobs(): Promise<VideoJob[]> {
  const data = await apiRequest<{ jobs?: VideoJob[] }>("/api/brain/videos/jobs");
  return Array.isArray(data.jobs) ? data.jobs : [];
}

export async function getVideoJob(id: string): Promise<VideoJob | null> {
  const data = await apiRequest<{ job?: VideoJob }>(`/api/brain/videos/jobs/${encodeURIComponent(id)}`);
  return data.job ?? null;
}

export async function getVideoTranscript(id: string): Promise<string> {
  const data = await apiRequest<{ markdown?: string }>(
    `/api/brain/videos/jobs/${encodeURIComponent(id)}/transcript`,
  );
  return data.markdown ?? "";
}

export async function getVideoAnalysis(id: string): Promise<string> {
  const data = await apiRequest<{ markdown?: string }>(
    `/api/brain/videos/jobs/${encodeURIComponent(id)}/analysis`,
  );
  return data.markdown ?? "";
}

/** Siempre 200 si el hub responde: `ok`/`reachable` narran si el microservicio en sí está vivo. */
export async function getVideoHealth(): Promise<VideoHealth> {
  const data = await apiRequest<Partial<VideoHealth>>("/api/brain/videos/health");
  return { ok: data.ok === true, reachable: data.reachable === true };
}

// ── Presentación de estado: un solo mapeo para toda la vista ────────────────

const STATUS_LABELS: Record<string, string> = {
  completed: "Completada",
  done: "Completada",
  partial: "Parcial",
  failed: "Fallida",
  running: "Procesando",
  queued: "En cola",
};

export function videoStatusLabel(status: string): string {
  return STATUS_LABELS[status] ?? "Desconocido";
}

/** Tonos del sistema de diseño (`components/system.tsx`): nada de color por categoría. */
export function videoStatusTone(status: string): "done" | "decide" | "broken" | "work" | "quiet" {
  if (status === "completed" || status === "done") return "done";
  if (status === "partial") return "decide";
  if (status === "failed") return "broken";
  if (status === "running" || status === "queued") return "work";
  return "quiet";
}

/** Si hay algún job sin terminar todavía vale la pena seguir refrescando la lista. */
export function isVideoJobInProgress(status: string): boolean {
  return status === "running" || status === "queued";
}
