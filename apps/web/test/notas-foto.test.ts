/**
 * Foto de una pizarra/tablero: dónde se ubica en el lienzo y cómo se reduce
 * el archivo. `posicionFoto` es geometría pura. `reducirFoto` usa APIs del
 * navegador que jsdom no implementa (`createImageBitmap`, canvas real): se
 * simulan aquí para probar NUESTRA lógica (escala, orientación EXIF, el
 * error en español si no se puede leer), no el decodificador del navegador.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { posicionFoto, reducirFoto } from "../src/views/notas/foto";

describe("posicionFoto", () => {
  it("lienzo vacío: la foto va al origen", () => {
    expect(posicionFoto([], 300, 200)).toEqual({ x: 0, y: 0 });
    // Los elementos borrados no cuentan como contenido.
    expect(posicionFoto([{ x: 10, y: 10, width: 50, height: 50, isDeleted: true }], 300, 200)).toEqual({
      x: 0,
      y: 0,
    });
  });

  it("con contenido: a la derecha de todo lo existente, alineada arriba", () => {
    const elementos = [
      { x: 0, y: 0, width: 100, height: 20 },
      { x: 0, y: 150, width: 90, height: 20 },
    ];
    // maxX = 100, margen 80 → x = 180; minY = 0 (el renglón más alto).
    expect(posicionFoto(elementos, 300, 200)).toEqual({ x: 180, y: 0 });
  });
});

describe("reducirFoto", () => {
  /** Doble de `ImageBitmap`: sólo lo que usa `reducirFoto`. */
  function bitmap(width: number, height: number) {
    return { width, height, close: vi.fn() };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function mockCanvas() {
    const crearOriginal = document.createElement.bind(document);
    const drawImage = vi.fn();
    const toDataURL = vi.fn(() => "data:image/jpeg;base64,reducida");
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      if (tag !== "canvas") return crearOriginal(tag);
      return {
        width: 0,
        height: 0,
        getContext: () => ({ drawImage }),
        toDataURL,
      } as unknown as HTMLCanvasElement;
    });
    return { drawImage, toDataURL };
  }

  it("reduce el lado mayor a maxLado sin agrandar y exporta JPEG 0.85", async () => {
    const { drawImage, toDataURL } = mockCanvas();
    const bmp = bitmap(4000, 2000);
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async (_file: File, opts?: { imageOrientation?: string }) => {
        expect(opts).toMatchObject({ imageOrientation: "from-image" });
        return bmp as unknown as ImageBitmap;
      }),
    );

    const foto = await reducirFoto(new File([new Uint8Array([1])], "pizarra.jpg"), 2000);

    expect(foto).toEqual({ dataURL: "data:image/jpeg;base64,reducida", mimeType: "image/jpeg", width: 2000, height: 1000 });
    expect(drawImage).toHaveBeenCalledWith(bmp, 0, 0, 2000, 1000);
    expect(toDataURL).toHaveBeenCalledWith("image/jpeg", 0.85);
    expect(bmp.close).toHaveBeenCalledTimes(1);
  });

  it("una foto más pequeña que maxLado no se agranda", async () => {
    mockCanvas();
    const bmp = bitmap(500, 300);
    vi.stubGlobal("createImageBitmap", vi.fn(async () => bmp as unknown as ImageBitmap));

    const foto = await reducirFoto(new File([new Uint8Array([1])], "nota.jpg"));

    expect(foto.width).toBe(500);
    expect(foto.height).toBe(300);
  });

  it("si el navegador no puede decodificarla, un error en español claro", async () => {
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => {
        throw new Error("no soportado");
      }),
    );

    await expect(reducirFoto(new File([new Uint8Array([1])], "foto.heic"))).rejects.toThrow(
      "No se pudo leer la imagen. Usa JPG o PNG.",
    );
  });
});
