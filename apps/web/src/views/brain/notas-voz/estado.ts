/**
 * Notas de voz: el hub no persiste un estado explícito por nota — se deriva
 * de sus tareas de Notion, igual que hacía la vista original de WhatsAppHub.
 * Un solo lugar para esa regla, reutilizado por la lista y el detalle.
 */
import type { Tone } from "../../../components/system";
import type { NotaVozRuteo } from "../../../lib/brain/notas-voz";

export type EstadoRuteo = "sin_tareas" | "pendiente" | "fallida" | "completada";

export function estadoRuteo(routed: NotaVozRuteo | undefined): EstadoRuteo {
  const tasks = routed?.notionTasks ?? [];
  if (tasks.length === 0) return "sin_tareas";
  const algunaFallida = tasks.some((t) => !t.ok);
  const algunaOk = tasks.some((t) => t.ok);
  if (algunaFallida) return algunaOk ? "pendiente" : "fallida";
  return "completada";
}

export const ESTADO_TONE: Record<EstadoRuteo, Tone> = {
  sin_tareas: "quiet",
  pendiente: "work",
  fallida: "broken",
  completada: "done",
};

export const ESTADO_LABEL: Record<EstadoRuteo, string> = {
  sin_tareas: "sin tareas",
  pendiente: "pendiente",
  fallida: "fallida",
  completada: "completada",
};

/** Fecha legible es-CO; `null`/inválida → "—" (nunca inventa una fecha). */
export function fechaLegible(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("es-CO", { dateStyle: "medium", timeStyle: "short" }).format(date);
}
