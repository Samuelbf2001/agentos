/**
 * Cómo se convierte una transcripción por regiones en elementos del lienzo.
 *
 * Vive aparte de `Lienzo.tsx` porque es geometría y marcado puros: no toca
 * Excalidraw (ahí sólo se pasa por `convertToExcalidrawElements`), así que se
 * prueba sin cargar la librería y el doble del lienzo en los tests puede usar
 * exactamente las mismas reglas.
 *
 * Reglas:
 * - El texto va DEBAJO de la región (no encima): el trazo tiene que seguir
 *   viéndose y el texto tiene que poder borrarse si está mal.
 * - Cada elemento lleva `customData.agentos.transcripcion = true`: repetir la
 *   transcripción REEMPLAZA los anteriores en vez de apilarlos. Nada que no
 *   lleve esa marca (los trazos, sobre todo) se toca jamás.
 */
import type { TranscripcionBloque } from "../../lib/types";

/** Separación entre el borde inferior de la región y el texto, en px de escena. */
export const TRANSCRIPCION_SEPARACION = 8;
/** Gris para distinguir el texto leído del trazo (que suele ser negro). */
export const TRANSCRIPCION_COLOR = "#5c5c5c";
export const TRANSCRIPCION_FONT_MIN = 14;
export const TRANSCRIPCION_FONT_MAX = 40;

/** Forma mínima del skeleton de texto que acepta `convertToExcalidrawElements`. */
export interface TextoTranscripcionSkeleton {
  type: "text";
  text: string;
  x: number;
  y: number;
  fontSize: number;
  fontFamily: 1;
  strokeColor: string;
  customData: { agentos: { transcripcion: true; bloque: number } };
}

/** ¿Es un elemento puesto por la transcripción (y por tanto reemplazable)? */
export function esElementoTranscripcion(el: unknown): boolean {
  if (typeof el !== "object" || el === null) return false;
  const custom = (el as { customData?: unknown }).customData;
  if (typeof custom !== "object" || custom === null) return false;
  const agentos = (custom as { agentos?: unknown }).agentos;
  return (
    typeof agentos === "object" &&
    agentos !== null &&
    (agentos as { transcripcion?: unknown }).transcripcion === true
  );
}

/** Los elementos que se conservan al insertar una transcripción nueva. */
export function sinTranscripcionPrevia<T>(elements: readonly T[]): T[] {
  return elements.filter((el) => !esElementoTranscripcion(el));
}

/** Tamaño de letra proporcional al trazo, acotado para que siempre se lea. */
export function tamanoTexto(alturaTipica: number): number {
  const base = Number.isFinite(alturaTipica) ? Math.round(alturaTipica * 0.8) : 0;
  return Math.min(TRANSCRIPCION_FONT_MAX, Math.max(TRANSCRIPCION_FONT_MIN, base));
}

/** Un skeleton de texto por bloque con texto; los vacíos (regiones fusionadas) no pintan nada. */
export function skeletonsTranscripcion(
  bloques: readonly TranscripcionBloque[],
  alturaTipica: number,
): TextoTranscripcionSkeleton[] {
  const fontSize = tamanoTexto(alturaTipica);
  return bloques
    .filter((b) => b.texto.trim().length > 0)
    .map((b) => ({
      type: "text",
      text: b.texto.trim(),
      x: b.caja.x,
      y: b.caja.y + b.caja.h + TRANSCRIPCION_SEPARACION,
      fontSize,
      fontFamily: 1,
      strokeColor: TRANSCRIPCION_COLOR,
      customData: { agentos: { transcripcion: true, bloque: b.bloque } },
    }));
}
