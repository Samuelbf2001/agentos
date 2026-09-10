/**
 * Escala de exportación del PNG de una nota.
 *
 * A 3x una nota pequeña queda nítida (~1500 px), pero una nota que ocupa medio
 * lienzo se va a >4000 px de lado y varios MB: el POST de captura devolvía
 * 413. El modelo de visión no gana nada por encima de ~4000 px, así que la
 * escala baja sola con el tamaño de la escena y nunca cae por debajo de 1x
 * (el tamaño real de lo dibujado).
 */
export const EXPORT_SCALE_MAX = 3;
export const EXPORT_SCALE_MIN = 1;
/** Lado mayor máximo del PNG exportado, en píxeles. */
export const EXPORT_MAX_LONG_SIDE_PX = 4000;

export interface CajaEscena {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Caja que envuelve a todos los elementos (en unidades de escena). */
export function cajaDeEscena(elements: readonly CajaEscena[]): { w: number; h: number } {
  if (elements.length === 0) return { w: 0, h: 0 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const el of elements) {
    if (el.x < minX) minX = el.x;
    if (el.y < minY) minY = el.y;
    if (el.x + el.width > maxX) maxX = el.x + el.width;
    if (el.y + el.height > maxY) maxY = el.y + el.height;
  }
  return { w: Math.max(0, maxX - minX), h: Math.max(0, maxY - minY) };
}

/**
 * Escala para que el lado mayor (más el margen) no supere `maxLongSidePx`,
 * acotada a [1, 3] y redondeada a décimas para que el PNG sea reproducible.
 */
export function escalaDeExportacion(
  caja: { w: number; h: number },
  padding: number,
  maxLongSidePx: number = EXPORT_MAX_LONG_SIDE_PX,
): number {
  const lado = Math.max(caja.w, caja.h) + padding * 2;
  if (lado <= 0) return EXPORT_SCALE_MAX;
  const escala = Math.floor((maxLongSidePx / lado) * 10) / 10;
  return Math.min(EXPORT_SCALE_MAX, Math.max(EXPORT_SCALE_MIN, escala));
}
