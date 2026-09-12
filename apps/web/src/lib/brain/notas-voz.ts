/**
 * 2brain › Notas de voz + Grabadora: cliente del proxy sobre las notas de voz
 * transcritas y enrutadas a Notion/LLM Wiki
 * (`apps/api/src/routes/brain/notas-voz.ts`). Los dos módulos comparten este
 * cliente porque comparten datos: la Grabadora solo escribe (`enviarNotaVoz`),
 * Notas de voz además lista/lee/audita.
 *
 * Las imágenes ya llegan con la ruta propia de AgentOS
 * (`/api/brain/notas-voz/media/...`); para pintarlas en un `<img>` se envuelven
 * con `apiUrl()`.
 */
import { apiRequest } from "../api";

export interface NotaVozImagen {
  url?: string | null;
  caption?: string | null;
  mimetype?: string | null;
}

export interface NotaVozNotionTask {
  text: string;
  ok: boolean;
  url?: string | null;
  error?: string | null;
}

export interface NotaVozRuteo {
  wikiNoteId?: string | number | null;
  notionTasks?: NotaVozNotionTask[];
}

export interface NotaVozActionItem {
  text: string;
  due?: string | null;
}

export interface NotaVozResumen {
  id: string;
  title?: string | null;
  summary?: string | null;
  category?: string | null;
  source?: string | null;
  duration_sec?: number | null;
  created_at?: string | null;
  routed?: NotaVozRuteo;
}

export interface NotaVozDetalle extends NotaVozResumen {
  transcript?: string | null;
  action_items?: NotaVozActionItem[];
  ideas?: string[];
  images?: NotaVozImagen[];
}

export interface NotaVozAuditoriaItem {
  id: string;
  title?: string | null;
  category?: string | null;
  createdAt?: string | null;
  durationSec?: number | null;
  hasTranscript?: boolean;
  summary?: string | null;
  imagesCount?: number;
  wikiNoteId?: string | number | null;
  notionTasks?: NotaVozNotionTask[];
  actionItemsCount?: number;
  createdBy?: string | null;
  source?: string | null;
}

export interface NotaVozStatus {
  transcription: boolean;
  vision: boolean;
  router_llm: boolean;
  notion: boolean;
}

export interface NotaVozImagenEntrada {
  /** Data URL (con prefijo `data:image/...;base64,`) o base64 puro. */
  dataUrl?: string;
  base64?: string;
  caption?: string;
}

export interface NotaVozEnvio {
  transcript?: string;
  audioBase64?: string | null;
  mimetype?: string | null;
  durationSec?: number;
  images?: NotaVozImagenEntrada[];
}

export interface NotaVozResultado {
  ok?: boolean;
  voiceNoteId?: string | number;
  title?: string | null;
  summary?: string | null;
  category?: string | null;
  model?: string | null;
  action_items?: NotaVozActionItem[];
  ideas?: string[];
  images?: NotaVozImagen[];
  notionTasks?: NotaVozNotionTask[];
  notionTasks_pending?: number;
  wikiNoteId?: string | number | null;
}

export function fetchNotasVoz(): Promise<{ notes: NotaVozResumen[] }> {
  return apiRequest<{ notes: NotaVozResumen[] }>("/api/brain/notas-voz");
}

export function fetchNotaVozStatus(): Promise<NotaVozStatus> {
  return apiRequest<NotaVozStatus>("/api/brain/notas-voz/status");
}

export function fetchNotasVozAuditoria(
  limit = 50,
): Promise<{ page?: number; limit?: number; total?: number; totalPages?: number; notes: NotaVozAuditoriaItem[] }> {
  return apiRequest(`/api/brain/notas-voz/audit?limit=${encodeURIComponent(String(limit))}`);
}

export function fetchNotaVoz(id: string): Promise<{ note: NotaVozDetalle }> {
  return apiRequest<{ note: NotaVozDetalle }>(`/api/brain/notas-voz/${encodeURIComponent(id)}`);
}

export function retryNotaVozNotion(id: string): Promise<{ ok: boolean; notionTasks: NotaVozNotionTask[] }> {
  return apiRequest(`/api/brain/notas-voz/${encodeURIComponent(id)}/retry-notion`, { method: "POST" });
}

/** La única ruta que escribe: la usa la Grabadora (y el borrador reintentado). */
export function enviarNotaVoz(body: NotaVozEnvio): Promise<NotaVozResultado> {
  return apiRequest<NotaVozResultado>("/api/brain/notas-voz/voice", {
    method: "POST",
    body: { ...body, source: "agentos" },
  });
}
