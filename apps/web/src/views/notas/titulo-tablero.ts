/**
 * Título automático de la nota que se crea al fotografiar un tablero desde el
 * Inicio del celular: «Tablero <día> <mes abreviado>, <hora>:<minuto>» en
 * español (es-CO), hora sin cero a la izquierda, minuto siempre a dos
 * dígitos. Función pura (recibe la fecha) para poder probarla sin reloj real.
 */
const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"] as const;

export function tituloTablero(fecha: Date): string {
  const dia = fecha.getDate();
  const mes = MESES[fecha.getMonth()];
  const hora = fecha.getHours();
  const minuto = String(fecha.getMinutes()).padStart(2, "0");
  return `Tablero ${dia} ${mes}, ${hora}:${minuto}`;
}
