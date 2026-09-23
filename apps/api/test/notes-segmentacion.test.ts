/**
 * Segmentación de la escena de una nota: agrupar trazos en renglones y
 * renglones en bloques. Es la pieza que le da al modelo de visión el ORDEN DE
 * LECTURA, así que los dos casos que la rompen en la vida real —el punto de
 * una "i" y un salto de párrafo— están fijados aquí.
 */
import { describe, expect, it } from "vitest";
import { segmentarEscena } from "../src/notes/segmentacion.js";

/** Trazo recto: los puntos son RELATIVOS a (x, y), como los guarda Excalidraw. */
function trazo(id: string, x: number, y: number, ancho: number, alto: number) {
  return {
    id,
    type: "freedraw",
    x,
    y,
    points: [
      [0, 0],
      [ancho, alto],
    ],
  };
}

describe("Segmentación de notas manuscritas", () => {
  it("el punto de una «i» no abre renglón propio: cae en el renglón de la palabra", () => {
    const seg = segmentarEscena({
      elements: [
        trazo("palabra", 0, 0, 120, 20),
        // Punto diminuto POR ENCIMA de la línea: su centro cae dentro de la
        // holgura del renglón, así que pertenece a él.
        trazo("punto-i", 40, -6, 2, 2),
      ],
    });

    expect(seg.resumen.trazosAMano).toBe(2);
    expect(seg.resumen.renglones).toBe(1);
    expect(seg.resumen.bloques).toBe(1);
    expect(seg.bloques[0]!.renglones[0]!.trazos).toBe(2);
  });

  it("un salto vertical grande abre bloque nuevo; uno pequeño no", () => {
    const seg = segmentarEscena({
      elements: [
        trazo("linea-1", 0, 0, 120, 20),
        // Renglón siguiente pegado (salto de 5px): mismo bloque.
        trazo("linea-2", 0, 25, 110, 20),
        // Párrafo aparte, muy abajo (salto de 105px > 1.6 × 20): bloque nuevo.
        trazo("linea-3", 0, 150, 90, 20),
      ],
    });

    expect(seg.resumen.renglones).toBe(3);
    expect(seg.resumen.bloques).toBe(2);
    expect(seg.bloques[0]!.renglones.map((r) => r.renglon)).toEqual([0, 1]);
    expect(seg.bloques[1]!.renglones.map((r) => r.renglon)).toEqual([2]);
    // El orden de lectura es de arriba abajo, siempre.
    expect(seg.bloques[0]!.caja.y).toBeLessThan(seg.bloques[1]!.caja.y);
  });

  it("el texto tecleado y las figuras salen aparte: ya son dato, no se adivinan", () => {
    const seg = segmentarEscena({
      elements: [
        trazo("a-mano", 0, 0, 100, 20),
        { id: "t1", type: "text", x: 200, y: 0, width: 80, height: 24, text: "Presupuesto" },
        {
          id: "f1",
          type: "arrow",
          x: 120,
          y: 10,
          width: 60,
          height: 0,
          startBinding: { elementId: "caja-1" },
          endBinding: { elementId: "t1" },
        },
        // Los borrados no cuentan para nada.
        { ...trazo("borrado", 0, 400, 100, 20), isDeleted: true },
      ],
    });

    expect(seg.resumen.trazosAMano).toBe(1);
    expect(seg.textoExistente).toEqual([
      { id: "t1", texto: "Presupuesto", caja: { x: 200, y: 0, w: 80, h: 24 } },
    ]);
    expect(seg.figuras).toHaveLength(1);
    expect(seg.figuras[0]).toMatchObject({ tipo: "arrow", desde: "caja-1", hacia: "t1" });
  });

  it("una escena vacía no revienta ni inventa renglones", () => {
    const seg = segmentarEscena({ elements: [] });
    expect(seg.resumen).toMatchObject({ trazosAMano: 0, renglones: 0, bloques: 0 });
    expect(seg.bloques).toEqual([]);
  });
});

describe("Fotos pegadas en el lienzo (pizarra, cuaderno)", () => {
  /** Una imagen tal como la guarda Excalidraw: type "image", con su bbox propia. */
  function imagen(id: string, x: number, y: number, ancho: number, alto: number) {
    return { id, type: "image", x, y, width: ancho, height: alto, fileId: `file-${id}` };
  }

  it("una sola foto: un bloque marcado esFoto, caja = su bbox, alturaTipica no da 0/NaN", () => {
    const seg = segmentarEscena({ elements: [imagen("foto-1", 10, 20, 300, 200)] });

    expect(seg.resumen.bloques).toBe(1);
    expect(seg.bloques).toEqual([
      { bloque: 0, caja: { x: 10, y: 20, w: 300, h: 200 }, renglones: [], esFoto: true },
    ]);
    // Sin ningún trazo, `enRenglones` cae al fallback: nunca 0 ni NaN.
    expect(seg.resumen.alturaTipica).toBeGreaterThan(0);
    expect(Number.isNaN(seg.resumen.alturaTipica)).toBe(false);
  });

  it("trazos + foto se ordenan de arriba abajo, sin importar el tipo de elemento", () => {
    const seg = segmentarEscena({
      elements: [
        // La foto queda ABAJO de todo, aunque en la escena venga primero.
        imagen("foto-abajo", 0, 300, 200, 150),
        trazo("linea-arriba", 0, 0, 120, 20),
      ],
    });

    expect(seg.resumen.bloques).toBe(2);
    expect(seg.bloques[0]!.esFoto).toBeUndefined();
    expect(seg.bloques[0]).toMatchObject({ bloque: 0 });
    expect(seg.bloques[0]!.caja.y).toBe(0);
    expect(seg.bloques[1]).toMatchObject({ bloque: 1, esFoto: true });
    expect(seg.bloques[1]!.caja.y).toBe(300);
  });

  it("una foto borrada (isDeleted) no cuenta para nada", () => {
    const seg = segmentarEscena({
      elements: [
        trazo("linea", 0, 0, 100, 20),
        { ...imagen("foto-borrada", 0, 200, 300, 200), isDeleted: true },
      ],
    });

    expect(seg.resumen.bloques).toBe(1);
    expect(seg.bloques.some((b) => b.esFoto)).toBe(false);
  });
});
