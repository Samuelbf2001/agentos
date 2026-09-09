/**
 * Segmentación de una escena de Excalidraw en renglones y bloques.
 *
 * Por qué existe: la escritura a mano son elementos `freedraw` (listas de
 * puntos), no texto. La lectura la hace un modelo de visión sobre la IMAGEN —
 * pero agrupar los trazos por geometría ANTES de leer da el orden de lectura
 * correcto y permite transcribir renglón por renglón en vez de tratar la
 * página como un borrón. Además separa lo escrito a mano de lo que YA es dato
 * (texto tecleado y figuras), que no hay que adivinar.
 *
 * Puerto a TypeScript del algoritmo de
 * `2brain/.claude/skills/escritura-a-texto/scripts/segmentar.mjs`; se mantiene
 * su comportamiento (misma holgura de renglón, mismo factor de bloque) para
 * que la skill y la plataforma lean una nota igual.
 */

/** Separación vertical, en múltiplos de la altura típica, que abre bloque nuevo. */
export const GAP_FACTOR_DEFAULT = 1.6;

/** Altura de referencia cuando la escena no tiene ni un trazo con alto medible. */
const ALTURA_TIPICA_FALLBACK = 20;

export interface Caja {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RenglonSegmentado {
  /** Índice global del renglón: es la clave del orden de lectura. */
  renglon: number;
  caja: Caja;
  trazos: number;
}

export interface BloqueSegmentado {
  bloque: number;
  caja: Caja;
  renglones: RenglonSegmentado[];
}

export interface TextoExistente {
  id: string | null;
  texto: string;
  caja: Caja;
}

export interface FiguraSegmentada {
  id: string | null;
  tipo: string;
  caja: Caja;
  /** Sólo en flechas con binding: de qué elemento sale y a cuál llega. */
  desde?: string;
  hacia?: string;
}

export interface ResumenSegmentacion {
  trazosAMano: number;
  renglones: number;
  bloques: number;
  textoYaEscrito: number;
  figuras: number;
  alturaTipica: number;
}

export interface SegmentacionNota {
  resumen: ResumenSegmentacion;
  bloques: BloqueSegmentado[];
  /** Lo que NO hay que adivinar: ya es dato. */
  textoExistente: TextoExistente[];
  figuras: FiguraSegmentada[];
}

/** Forma mínima que nos interesa de un elemento de Excalidraw (el resto es opaco). */
interface ElementoEscena {
  id?: unknown;
  type?: unknown;
  x?: unknown;
  y?: unknown;
  width?: unknown;
  height?: unknown;
  points?: unknown;
  text?: unknown;
  isDeleted?: unknown;
  startBinding?: unknown;
  endBinding?: unknown;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function esElemento(value: unknown): value is ElementoEscena {
  return typeof value === "object" && value !== null;
}

function bindingId(value: unknown): string | undefined {
  if (!esElemento(value)) return undefined;
  const id = (value as { elementId?: unknown }).elementId;
  return typeof id === "string" ? id : undefined;
}

/** Caja de un elemento. En `freedraw` los puntos son RELATIVOS a (x, y). */
export function bbox(el: ElementoEscena): Caja {
  const puntos = Array.isArray(el.points) ? el.points : null;
  if (el.type === "freedraw" && puntos && puntos.length > 0) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const punto of puntos) {
      const par = Array.isArray(punto) ? punto : [];
      const px = num(el.x) + num(par[0]);
      const py = num(el.y) + num(par[1]);
      if (px < minX) minX = px;
      if (py < minY) minY = py;
      if (px > maxX) maxX = px;
      if (py > maxY) maxY = py;
    }
    if (Number.isFinite(minX)) return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }
  return { x: num(el.x), y: num(el.y), w: num(el.width), h: num(el.height) };
}

interface Trazo {
  box: Caja;
}

interface RenglonEnCurso extends Caja {
  trazos: Trazo[];
}

/**
 * Agrupa trazos en renglones: dos trazos son del mismo renglón si sus rangos
 * verticales se solapan de verdad. La mediana de alturas hace de escala, para
 * que el umbral no dependa del zoom con el que se escribió.
 */
function enRenglones(items: Trazo[]): { renglones: RenglonEnCurso[]; alturaTipica: number } {
  if (items.length === 0) return { renglones: [], alturaTipica: ALTURA_TIPICA_FALLBACK };
  const alturas = items
    .map((t) => t.box.h)
    .filter((h) => h > 0)
    .sort((a, b) => a - b);
  const alturaTipica = alturas.length
    ? alturas[Math.floor(alturas.length / 2)]!
    : ALTURA_TIPICA_FALLBACK;
  const orden = [...items].sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);

  const renglones: RenglonEnCurso[] = [];
  for (const t of orden) {
    const centro = t.box.y + t.box.h / 2;
    // Una tilde o el punto de una "i" no debe abrir renglón propio: se busca el
    // renglón cuyo rango vertical contiene el centro del trazo, con holgura.
    const holgura = Math.max(alturaTipica * 0.5, 4);
    const cabe = renglones.find((r) => centro >= r.y - holgura && centro <= r.y + r.h + holgura);
    if (cabe) {
      const maxY = Math.max(cabe.y + cabe.h, t.box.y + t.box.h);
      cabe.y = Math.min(cabe.y, t.box.y);
      cabe.h = maxY - cabe.y;
      const maxX = Math.max(cabe.x + cabe.w, t.box.x + t.box.w);
      cabe.x = Math.min(cabe.x, t.box.x);
      cabe.w = maxX - cabe.x;
      cabe.trazos.push(t);
    } else {
      renglones.push({ x: t.box.x, y: t.box.y, w: t.box.w, h: t.box.h, trazos: [t] });
    }
  }
  const fusionados = absorberDiacriticos(renglones, alturaTipica);
  for (const r of fusionados) r.trazos.sort((a, b) => a.box.x - b.box.x);
  fusionados.sort((a, b) => a.y - b.y || a.x - b.x);
  return { renglones: fusionados, alturaTipica };
}

/**
 * Segunda pasada: absorbe los trazos diacríticos (el punto de una "i", una
 * tilde, la barra de una "t") que quedaron en un renglón propio.
 *
 * El barrido de arriba abajo los ve ANTES que la palabra a la que pertenecen
 * —están más altos—, así que abren renglón y luego la palabra ya no cabe en
 * él. Un renglón mucho más bajo que la letra típica, pegado verticalmente a
 * otro y solapado con él en horizontal, no es un renglón: es un adorno de la
 * palabra que tiene debajo. (Añadido sobre el algoritmo de la skill
 * `escritura-a-texto`, que aquí partía la línea en dos.)
 */
function absorberDiacriticos(
  renglones: RenglonEnCurso[],
  alturaTipica: number,
): RenglonEnCurso[] {
  const esDiacritico = (r: RenglonEnCurso): boolean => r.h < alturaTipica * 0.4;
  const resultado = renglones.filter((r) => !esDiacritico(r));
  if (resultado.length === 0) return renglones;

  for (const pequeño of renglones.filter(esDiacritico)) {
    let destino: RenglonEnCurso | null = null;
    let mejorDistancia = Infinity;
    for (const candidato of resultado) {
      const solapeX =
        Math.min(pequeño.x + pequeño.w, candidato.x + candidato.w) -
        Math.max(pequeño.x, candidato.x);
      if (solapeX <= 0) continue;
      const distancia =
        pequeño.y > candidato.y + candidato.h
          ? pequeño.y - (candidato.y + candidato.h)
          : candidato.y > pequeño.y + pequeño.h
            ? candidato.y - (pequeño.y + pequeño.h)
            : 0;
      if (distancia < mejorDistancia) {
        mejorDistancia = distancia;
        destino = candidato;
      }
    }
    if (!destino || mejorDistancia > alturaTipica * 0.75) {
      // Lejos de todo: es un trazo suelto de verdad y conserva su renglón.
      resultado.push(pequeño);
      continue;
    }
    const maxY = Math.max(destino.y + destino.h, pequeño.y + pequeño.h);
    const maxX = Math.max(destino.x + destino.w, pequeño.x + pequeño.w);
    destino.y = Math.min(destino.y, pequeño.y);
    destino.h = maxY - destino.y;
    destino.x = Math.min(destino.x, pequeño.x);
    destino.w = maxX - destino.x;
    destino.trazos.push(...pequeño.trazos);
  }
  return resultado;
}

/** Un salto vertical grande entre renglones = bloque nuevo (párrafo, columna, nota al margen). */
function enBloques(
  renglones: RenglonEnCurso[],
  alturaTipica: number,
  gapFactor: number,
): { caja: Caja; renglones: RenglonEnCurso[] }[] {
  const bloques: { caja: Caja; renglones: RenglonEnCurso[] }[] = [];
  let actual: { caja: Caja; renglones: RenglonEnCurso[] } | null = null;
  for (const r of renglones) {
    const salto = actual ? r.y - (actual.caja.y + actual.caja.h) : 0;
    if (!actual || salto > alturaTipica * gapFactor) {
      actual = { caja: { x: r.x, y: r.y, w: r.w, h: r.h }, renglones: [r] };
      bloques.push(actual);
    } else {
      const maxY = Math.max(actual.caja.y + actual.caja.h, r.y + r.h);
      const maxX = Math.max(actual.caja.x + actual.caja.w, r.x + r.w);
      actual.caja.x = Math.min(actual.caja.x, r.x);
      actual.caja.w = maxX - actual.caja.x;
      actual.caja.h = maxY - actual.caja.y;
      actual.renglones.push(r);
    }
  }
  return bloques;
}

function redondear(c: Caja): Caja {
  return { x: Math.round(c.x), y: Math.round(c.y), w: Math.round(c.w), h: Math.round(c.h) };
}

/**
 * Segmenta la escena guardada de una nota. No lee la imagen: sólo geometría.
 * Devuelve el orden de lectura (bloques → renglones) y, aparte, el texto ya
 * tecleado y las figuras.
 */
export function segmentarEscena(
  scene: { elements?: readonly unknown[] } | null | undefined,
  options: { gapFactor?: number } = {},
): SegmentacionNota {
  const gapFactor =
    Number.isFinite(options.gapFactor) && (options.gapFactor as number) > 0
      ? (options.gapFactor as number)
      : GAP_FACTOR_DEFAULT;
  const elements = (scene?.elements ?? []).filter(
    (el): el is ElementoEscena => esElemento(el) && el.isDeleted !== true,
  );

  const trazos: Trazo[] = elements
    .filter((el) => el.type === "freedraw")
    .map((el) => ({ box: bbox(el) }));
  const textos = elements.filter((el) => el.type === "text");
  const figuras = elements.filter((el) => el.type !== "freedraw" && el.type !== "text");

  const { renglones, alturaTipica } = enRenglones(trazos);
  const bloques = enBloques(renglones, alturaTipica, gapFactor);

  return {
    resumen: {
      trazosAMano: trazos.length,
      renglones: renglones.length,
      bloques: bloques.length,
      textoYaEscrito: textos.length,
      figuras: figuras.length,
      alturaTipica: Math.round(alturaTipica),
    },
    bloques: bloques.map((b, bi) => ({
      bloque: bi,
      caja: redondear(b.caja),
      renglones: b.renglones.map((r) => ({
        renglon: renglones.indexOf(r),
        caja: redondear(r),
        trazos: r.trazos.length,
      })),
    })),
    textoExistente: textos.map((t) => ({
      id: str(t.id),
      texto: typeof t.text === "string" ? t.text : "",
      caja: redondear(bbox(t)),
    })),
    figuras: figuras.map((f) => {
      const desde = f.type === "arrow" ? bindingId(f.startBinding) : undefined;
      const hacia = f.type === "arrow" ? bindingId(f.endBinding) : undefined;
      return {
        id: str(f.id),
        tipo: typeof f.type === "string" ? f.type : "desconocido",
        caja: redondear(bbox(f)),
        ...(desde ? { desde } : {}),
        ...(hacia ? { hacia } : {}),
      };
    }),
  };
}
