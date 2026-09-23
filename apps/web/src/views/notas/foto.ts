/**
 * Foto de una pizarra/tablero: reducir el archivo a un tamaño manejable y
 * decidir dónde ponerla en el lienzo.
 *
 * Aparte de `Lienzo.tsx` por lo mismo que `transcripcion-elementos.ts`: es
 * geometría e IO del navegador puros (canvas, `createImageBitmap`), no toca
 * Excalidraw, así que `posicionFoto` se prueba sin cargar la librería.
 */

/** Lado mayor máximo del JPEG reducido, en píxeles. Nunca agranda la foto original. */
const LADO_MAXIMO_DEFECTO = 2000;
/** Calidad del JPEG exportado: suficiente para leer un tablero, sin pesar de más. */
const CALIDAD_JPEG = 0.85;
/** Separación entre el contenido existente y la foto nueva, en px de escena. */
const MARGEN_FOTO = 80;

export interface FotoReducida {
  dataURL: string;
  mimeType: "image/jpeg";
  width: number;
  height: number;
}

/**
 * Decodifica la foto respetando su rotación EXIF (una foto de celular en
 * vertical no debe llegar tumbada), la reduce si hace falta —nunca la
 * agranda— y la exporta a JPEG. Si el navegador no puede leerla (por ejemplo
 * un HEIC sin soporte en el escritorio), lanza un error en español claro en
 * vez de dejar pasar un fallo críptico.
 */
export async function reducirFoto(
  file: File,
  maxLado: number = LADO_MAXIMO_DEFECTO,
): Promise<FotoReducida> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new Error("No se pudo leer la imagen. Usa JPG o PNG.");
  }
  try {
    const escala = Math.min(1, maxLado / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * escala));
    const height = Math.max(1, Math.round(bitmap.height * escala));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("No se pudo leer la imagen. Usa JPG o PNG.");
    ctx.drawImage(bitmap, 0, 0, width, height);

    return { dataURL: canvas.toDataURL("image/jpeg", CALIDAD_JPEG), mimeType: "image/jpeg", width, height };
  } finally {
    bitmap.close();
  }
}

/** Forma mínima de un elemento de la escena que hace falta para ubicar la foto. */
export interface ElementoConCaja {
  x: number;
  y: number;
  width: number;
  height: number;
  isDeleted?: boolean;
}

/**
 * Dónde poner la foto en coordenadas de escena: sin nada dibujado, en el
 * origen; con contenido existente, a la derecha de todo lo que hay, alineada
 * arriba. El tamaño en escena es el de la imagen ya reducida.
 */
export function posicionFoto(
  elementos: readonly ElementoConCaja[],
  _ancho: number,
  _alto: number,
): { x: number; y: number } {
  const vivos = elementos.filter((el) => !el.isDeleted);
  if (vivos.length === 0) return { x: 0, y: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  for (const el of vivos) {
    if (el.x < minX) minX = el.x;
    if (el.y < minY) minY = el.y;
    if (el.x + el.width > maxX) maxX = el.x + el.width;
  }
  return { x: maxX + MARGEN_FOTO, y: minY };
}
