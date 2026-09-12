/**
 * 2brain › Conversaciones: cliente del proxy de solo lectura sobre los chats
 * de WhatsApp del agente 2brain y su registro de acciones
 * (`apps/api/src/routes/brain/conversaciones.ts`). Sin mutaciones.
 */
import { apiRequest } from "../api";

export interface ConversacionThread {
  phone: string;
  name?: string | null;
  lastBody?: string | null;
  lastAt?: string | null;
  count?: number | null;
}

export interface ConversacionMessage {
  id: number;
  direction: string;
  body?: string | null;
  created_at?: string | null;
}

export interface ConversacionAccion {
  id: number;
  status: string;
  action_type: string;
  created_at?: string | null;
  payload?: unknown;
  result?: unknown;
}

export interface ConversacionAccionesFiltro {
  limit?: number;
  status?: string;
}

export function fetchConversacionChats(): Promise<{ threads: ConversacionThread[] }> {
  return apiRequest<{ threads: ConversacionThread[] }>("/api/brain/conversaciones/chats");
}

export function fetchConversacionMessages(
  phone: string,
  limit = 200,
): Promise<{ phone: string; messages: ConversacionMessage[] }> {
  const qs = new URLSearchParams({ limit: String(limit) });
  return apiRequest<{ phone: string; messages: ConversacionMessage[] }>(
    `/api/brain/conversaciones/chats/${encodeURIComponent(phone)}/messages?${qs.toString()}`,
  );
}

export function fetchConversacionAcciones(
  filtro: ConversacionAccionesFiltro = {},
): Promise<{ actions: ConversacionAccion[] }> {
  const qs = new URLSearchParams({ limit: String(filtro.limit ?? 100) });
  if (filtro.status) qs.set("status", filtro.status);
  return apiRequest<{ actions: ConversacionAccion[] }>(`/api/brain/conversaciones/acciones?${qs.toString()}`);
}
