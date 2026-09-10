/** Escala de exportación: baja sola con el tamaño de la nota, nunca por debajo de 1x. */
import { describe, expect, it } from "vitest";
import { cajaDeEscena, escalaDeExportacion } from "../src/views/notas/export-scale";

describe("escalaDeExportacion", () => {
  it("una nota pequeña se exporta a 3x", () => {
    expect(escalaDeExportacion({ w: 500, h: 480 }, 24)).toBe(3);
  });

  it("una nota que a 3x superaría 4000 px baja de escala para no pasarse", () => {
    const escala = escalaDeExportacion({ w: 2000, h: 900 }, 24);
    expect(escala).toBeLessThan(3);
    expect((2000 + 48) * escala).toBeLessThanOrEqual(4000);
  });

  it("nunca baja de 1x aunque la nota sea enorme", () => {
    expect(escalaDeExportacion({ w: 9000, h: 3000 }, 24)).toBe(1);
  });

  it("sin elementos devuelve la escala máxima", () => {
    expect(escalaDeExportacion(cajaDeEscena([]), 24)).toBe(3);
  });

  it("cajaDeEscena envuelve todos los elementos", () => {
    const caja = cajaDeEscena([
      { x: 100, y: 50, width: 200, height: 30 },
      { x: -40, y: 400, width: 10, height: 10 },
    ]);
    expect(caja).toEqual({ w: 340, h: 360 });
  });
});
