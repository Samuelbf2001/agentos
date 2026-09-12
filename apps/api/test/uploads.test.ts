/**
 * Subida de imágenes para las descripciones de tarea.
 *
 * Lo que se fija aquí:
 * - Sólo imágenes y sólo hasta el límite: cualquier otra cosa es 400
 *   `validation`, nunca un 500 ni un archivo escrito a medias.
 * - El binario vive bajo la raíz de artefactos (`AGENTOS_ARTIFACTS_DIR`), en
 *   `uploads/<yyyy-mm>/<id>.<ext>`: fuera del árbol versionado.
 * - Un id que no tiene forma de uuid responde 404 sin tocar el disco fuera de
 *   la raíz (el intento de path traversal ni siquiera llega a `fs`).
 * - Las dos rutas viven bajo `/api`: sin sesión, 401.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeFixture, type TestFixture } from "./helpers.js";

/** PNG 1×1 real (el más pequeño que un decodificador acepta). */
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function multipartBody(
  boundary: string,
  fileName: string,
  contentType: string,
  content: Buffer,
): Buffer {
  return Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${contentType}\r\n\r\n`,
    ),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
}

describe("Subida de imágenes — POST /api/uploads/images y GET /api/uploads/:id", () => {
  let fixtures: TestFixture[] = [];
  let artifactsDir: string;
  let previousArtifactsDir: string | undefined;

  beforeAll(() => {
    previousArtifactsDir = process.env.AGENTOS_ARTIFACTS_DIR;
    artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-uploads-"));
    process.env.AGENTOS_ARTIFACTS_DIR = artifactsDir;
  });

  afterAll(() => {
    fs.rmSync(artifactsDir, { recursive: true, force: true });
    if (previousArtifactsDir === undefined) delete process.env.AGENTOS_ARTIFACTS_DIR;
    else process.env.AGENTOS_ARTIFACTS_DIR = previousArtifactsDir;
  });

  afterEach(async () => {
    for (const fixture of fixtures.splice(0)) await fixture.close();
  });

  async function fx(): Promise<TestFixture> {
    const fixture = await makeFixture();
    fixtures.push(fixture);
    return fixture;
  }

  it("acepta un PNG, lo guarda fuera del repo y el GET lo sirve con su content-type", async () => {
    const fixture = await fx();
    const boundary = "----agentosUpload1";
    const res = await fixture.api.app.inject({
      method: "POST",
      url: "/api/uploads/images",
      headers: {
        ...fixture.authHeaders,
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      payload: multipartBody(boundary, "captura.png", "image/png", PNG_1X1),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      id: string;
      url: string;
      name: string;
      mime: string;
      bytes: number;
    };
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.url).toBe(`/api/uploads/${body.id}`);
    expect(body.mime).toBe("image/png");
    expect(body.name).toBe("captura.png");
    expect(body.bytes).toBe(PNG_1X1.byteLength);

    // El archivo está bajo <raíz>/uploads/<yyyy-mm>/<id>.png y en ningún otro sitio.
    const meses = fs.readdirSync(path.join(artifactsDir, "uploads"));
    expect(meses.some((mes) => /^\d{4}-\d{2}$/.test(mes))).toBe(true);
    const encontrado = meses
      .map((mes) => path.join(artifactsDir, "uploads", mes, `${body.id}.png`))
      .find((candidate) => fs.existsSync(candidate));
    expect(encontrado).toBeDefined();

    const get = await fixture.api.app.inject({
      method: "GET",
      url: body.url,
      headers: fixture.authHeaders,
    });
    expect(get.statusCode).toBe(200);
    expect(get.headers["content-type"]).toBe("image/png");
    expect(get.headers["cache-control"]).toBe("private, max-age=31536000");
    expect(Buffer.from(get.rawPayload).equals(PNG_1X1)).toBe(true);
  });

  it("rechaza lo que no es imagen con 400 validation y no escribe nada", async () => {
    const fixture = await fx();
    const antes = contarArchivos(path.join(artifactsDir, "uploads"));
    const boundary = "----agentosUpload2";
    const res = await fixture.api.app.inject({
      method: "POST",
      url: "/api/uploads/images",
      headers: {
        ...fixture.authHeaders,
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      payload: multipartBody(boundary, "malicioso.svg", "image/svg+xml", Buffer.from("<svg/>")),
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe("validation_error");
    expect(body.error.message).toMatch(/PNG, JPEG, GIF o WebP/);
    expect(contarArchivos(path.join(artifactsDir, "uploads"))).toBe(antes);
  });

  it("rechaza una imagen que supera el límite con 400 validation", async () => {
    const previous = process.env.AGENTOS_UPLOAD_IMAGE_MAX_BYTES;
    process.env.AGENTOS_UPLOAD_IMAGE_MAX_BYTES = "32";
    try {
      const fixture = await fx();
      const antes = contarArchivos(path.join(artifactsDir, "uploads"));
      const boundary = "----agentosUpload3";
      const res = await fixture.api.app.inject({
        method: "POST",
        url: "/api/uploads/images",
        headers: {
          ...fixture.authHeaders,
          "content-type": `multipart/form-data; boundary=${boundary}`,
        },
        // El PNG de prueba pesa bastante más de 32 bytes.
        payload: multipartBody(boundary, "grande.png", "image/png", PNG_1X1),
      });
      expect(res.statusCode).toBe(400);
      const body = res.json() as { error: { code: string; message: string } };
      expect(body.error.code).toBe("validation_error");
      expect(body.error.message).toMatch(/límite/i);
      expect(contarArchivos(path.join(artifactsDir, "uploads"))).toBe(antes);
    } finally {
      if (previous === undefined) delete process.env.AGENTOS_UPLOAD_IMAGE_MAX_BYTES;
      else process.env.AGENTOS_UPLOAD_IMAGE_MAX_BYTES = previous;
    }
  });

  it("un id que no es uuid responde 404 y jamás resuelve una ruta fuera de la raíz", async () => {
    const fixture = await fx();
    // Un archivo hermano de la raíz: si el id se usara como ruta, se serviría.
    const vecino = path.join(artifactsDir, "secreto.png");
    fs.writeFileSync(vecino, PNG_1X1);

    for (const id of ["..%2F..%2Fsecreto", "no-es-un-uuid", "../secreto.png", "SECRETO"]) {
      const res = await fixture.api.app.inject({
        method: "GET",
        url: `/api/uploads/${id}`,
        headers: fixture.authHeaders,
      });
      // Lo que importa: 404 y NINGÚN archivo servido, sólo un sobre de error.
      // (`../secreto.png` ni siquiera llega a la ruta: el router lo normaliza
      // a otro path y responde su propio 404.)
      expect(res.statusCode, `id: ${id}`).toBe(404);
      expect(res.headers["content-type"]).toMatch(/application\/json/);
      expect(Buffer.from(res.rawPayload).equals(PNG_1X1)).toBe(false);
    }

    // Un uuid con la forma correcta pero inexistente también es 404.
    const res = await fixture.api.app.inject({
      method: "GET",
      url: "/api/uploads/0199a3d1-0000-7000-8000-000000000000",
      headers: fixture.authHeaders,
    });
    expect(res.statusCode).toBe(404);
  });

  it("sin sesión, las dos rutas responden 401 (no están en PUBLIC_PATHS)", async () => {
    const fixture = await fx();
    const boundary = "----agentosUpload4";
    const post = await fixture.api.app.inject({
      method: "POST",
      url: "/api/uploads/images",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: multipartBody(boundary, "captura.png", "image/png", PNG_1X1),
    });
    expect(post.statusCode).toBe(401);

    const get = await fixture.api.app.inject({
      method: "GET",
      url: "/api/uploads/0199a3d1-0000-7000-8000-000000000000",
    });
    expect(get.statusCode).toBe(401);
  });
});

/** Cuenta archivos (recursivo) bajo una carpeta que puede no existir todavía. */
function contarArchivos(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? contarArchivos(full) : 1;
  }
  return total;
}
