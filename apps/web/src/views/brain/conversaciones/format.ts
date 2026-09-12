/**
 * Formato propio del módulo Conversaciones (reimplementación en TS de
 * `WhatsAppHub/web/src/lib/format.js`: `formatDate`/`compactDate`/
 * `formatPhone`/`jsonText`). No se toca `lib/format.js` del hub ni se importa
 * desde WhatsAppHub — vive aquí para no acoplar AgentOS a ese repo.
 */

/** Fecha larga (fecha + hora) para cabeceras y filas de tabla. */
export function formatDate(value: string | null | undefined): string {
  if (!value) return "sin fecha";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "sin fecha";
  return new Intl.DateTimeFormat("es-CO", { dateStyle: "short", timeStyle: "short" }).format(date);
}

/** Fecha compacta (hora + día/mes) para la burbuja de cada mensaje. */
export function compactDate(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("es-CO", {
    hour: "2-digit",
    minute: "2-digit",
    day: "2-digit",
    month: "2-digit",
  }).format(date);
}

/** `+<dígitos>`; nunca inventa un número si no hay teléfono. */
export function formatPhone(phone: string | null | undefined): string {
  const digits = String(phone ?? "").replace(/\D/g, "");
  return digits ? `+${digits}` : "Sin teléfono";
}

/** Texto legible del payload/resultado de una acción (puede ser string, objeto o null). */
export function jsonText(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
