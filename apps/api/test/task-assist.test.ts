/**
 * Asistente de IA de la ficha de tarea (`POST /api/ai/task-assist`).
 *
 * Lo que se fija aquí:
 * - El contexto que ve el modelo es REAL: documentos del cliente y del
 *   proyecto, tareas hermanas, la tarea guardada y las imágenes locales que
 *   cita la descripción. Se comprueba sobre el doble del asistente, que recibe
 *   exactamente lo que se le manda (jamás sale una llamada de LLM de la suite).
 * - Las imágenes se reconocen por el PATHNAME: la interfaz escribe la URL
 *   absoluta en producción y relativa en desarrollo, y las dos son el mismo
 *   archivo. Lo externo (S3 de Notion) se cuenta y NO se descarga.
 * - `execution_prompt` nunca falla: con el proveedor caído responde 200 con la
 *   plantilla determinista (`model: "plantilla"`), porque "Copiar prompt" debe
 *   funcionar siempre. `enrich`, en cambio, responde 503 antes que inventar un
 *   campo — y el mensaje jamás menciona la clave del proveedor.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { attachArtifact, createTask, upsertDoc } from "@agentos/db";
import { errors } from "@agentos/shared";
import { makeFixture, type TestFixture } from "./helpers.js";
import type { TaskAssistInput, TaskAssistant } from "../src/tasks/assist.js";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

interface AssistDouble extends TaskAssistant {
  calls: TaskAssistInput[];
}

/** Doble que responde un texto fijo y guarda lo que se le mandó. */
function fakeAssistant(text = "TEXTO DEL MODELO"): AssistDouble {
  const calls: TaskAssistInput[] = [];
  return {
    calls,
    async complete(input) {
      calls.push(input);
      return {
        text,
        model: "claude-sonnet-5",
        usage: { tokensIn: 1000, tokensOut: 200, tokensCacheRead: null, tokensCacheWrite: null },
      };
    },
  };
}

/** Doble caído: simula el proveedor no disponible, ya normalizado. */
function brokenAssistant(): AssistDouble {
  const calls: TaskAssistInput[] = [];
  return {
    calls,
    async complete(input) {
      calls.push(input);
      throw errors.providerUnavailable(
        "No se pudo redactar con 'anthropic_api' (claude-sonnet-5): el proveedor rechazó las credenciales (revisa ANTHROPIC_API_KEY).",
        { slug: "anthropic_api", model: "claude-sonnet-5", causa: "auth" },
      );
    },
  };
}

describe("POST /api/ai/task-assist", () => {
  let fixtures: TestFixture[] = [];
  let artifactsDir: string;
  let previousArtifactsDir: string | undefined;
  let previousPublicUrl: string | undefined;

  beforeAll(() => {
    previousArtifactsDir = process.env.AGENTOS_ARTIFACTS_DIR;
    previousPublicUrl = process.env.AGENTOS_PUBLIC_URL;
    artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-assist-"));
    process.env.AGENTOS_ARTIFACTS_DIR = artifactsDir;
    process.env.AGENTOS_PUBLIC_URL = "https://agentos.example.test";
  });

  afterAll(() => {
    fs.rmSync(artifactsDir, { recursive: true, force: true });
    if (previousArtifactsDir === undefined) delete process.env.AGENTOS_ARTIFACTS_DIR;
    else process.env.AGENTOS_ARTIFACTS_DIR = previousArtifactsDir;
    if (previousPublicUrl === undefined) delete process.env.AGENTOS_PUBLIC_URL;
    else process.env.AGENTOS_PUBLIC_URL = previousPublicUrl;
  });

  afterEach(async () => {
    for (const fixture of fixtures.splice(0)) await fixture.close();
  });

  async function fx(taskAssistant: TaskAssistant): Promise<TestFixture> {
    const fixture = await makeFixture({ taskAssistant });
    fixtures.push(fixture);
    return fixture;
  }

  /** Sube un PNG por la ruta real y devuelve su id y su URL relativa. */
  async function subirImagen(fixture: TestFixture): Promise<{ id: string; url: string }> {
    const boundary = "----agentosAssistImg";
    const res = await fixture.api.app.inject({
      method: "POST",
      url: "/api/uploads/images",
      headers: {
        ...fixture.authHeaders,
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      payload: Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="pantalla.png"\r\nContent-Type: image/png\r\n\r\n`,
        ),
        PNG_1X1,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string; url: string };
    return body;
  }

  it("enrich arma el contexto con docs de la org y del proyecto, tareas hermanas e imágenes locales", async () => {
    const assistant = fakeAssistant("## Contexto\nTexto mejorado por el modelo.");
    const fixture = await fx(assistant);

    await upsertDoc(fixture.db, {
      orgId: fixture.org.id,
      projectId: null,
      kind: "org_profile",
      title: "Perfil de ACME",
      bodyMd: "ACME vende repuestos industriales y factura por WhatsApp.",
      createdBy: `person:${fixture.person.id}`,
    });
    await upsertDoc(fixture.db, {
      orgId: fixture.org.id,
      projectId: fixture.project.id,
      kind: "finding",
      title: "Hallazgo del assessment",
      bodyMd: "El equipo de facturación repite el alta del cliente tres veces.",
      createdBy: `person:${fixture.person.id}`,
    });
    await createTask(fixture.db, {
      projectId: fixture.project.id,
      title: "Mapear el proceso de facturación",
      stage: "ENTENDER",
      orderKey: "a",
    });

    // Una imagen local (relativa) y otra externa que NO debe descargarse.
    const imagen = await subirImagen(fixture);
    const externa = "https://prod-files.notion-static.com/algo/captura.png";

    const res = await fixture.api.app.inject({
      method: "POST",
      url: "/api/ai/task-assist",
      headers: fixture.authHeaders,
      payload: {
        mode: "enrich",
        field: "description",
        draft: {
          project_id: fixture.project.id,
          title: "Arreglar el alta duplicada",
          description: `Pasa esto:\n\n![pantalla](${imagen.url})\n\n![externa](${externa})`,
          assignee_person_ids: [fixture.person.id],
        },
        instructions: "Hazlo corto, en 3 pasos.",
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      text: string;
      context: {
        org_name: string | null;
        project_name: string | null;
        docs: number;
        images: number;
        sibling_tasks: number;
        model: string;
        usage: { input_tokens: number; output_tokens: number; cost_usd: number | null } | null;
      };
    };
    expect(body.text).toBe("## Contexto\nTexto mejorado por el modelo.");
    expect(body.context.org_name).toBe(fixture.org.name);
    expect(body.context.project_name).toBe(fixture.project.name);
    expect(body.context.docs).toBe(2);
    expect(body.context.images).toBe(1); // la externa se cuenta aparte y no se lee
    expect(body.context.sibling_tasks).toBe(1);
    expect(body.context.model).toBe("claude-sonnet-5");
    // 1000 tokens de entrada + 200 de salida a la tarifa de claude-sonnet-5 (2/10 por Mtok).
    expect(body.context.usage).toEqual({ input_tokens: 1000, output_tokens: 200, cost_usd: 0.004 });

    // El doble recibió los bytes reales de la imagen local, una sola vez.
    expect(assistant.calls).toHaveLength(1);
    const call = assistant.calls[0]!;
    expect(call.images).toHaveLength(1);
    expect(call.images[0]!.mediaType).toBe("image/png");
    expect(call.images[0]!.data.equals(PNG_1X1)).toBe(true);

    // Y los textos: cliente, documentos, tarea hermana, borrador e indicación.
    expect(call.system).toMatch(/asistente de operaciones de la agencia Sixteam/);
    expect(call.system).toMatch(/Por confirmar/);
    expect(call.prompt).toContain("ACME S.A.");
    expect(call.prompt).toContain("Perfil de ACME");
    expect(call.prompt).toContain("Hallazgo del assessment");
    expect(call.prompt).toContain("Mapear el proceso de facturación");
    expect(call.prompt).toContain("Arreglar el alta duplicada");
    expect(call.prompt).toContain("Hazlo corto, en 3 pasos.");
    expect(call.prompt).toContain("Ernesto"); // responsable resuelto por nombre
    expect(call.prompt).toContain(externa); // se nombra, pero no se descarga
    expect(call.prompt).toMatch(/`description`/);
  });

  it("reconoce la imagen local tanto con URL absoluta como relativa, y no descarga la externa", async () => {
    const assistant = fakeAssistant();
    const fixture = await fx(assistant);
    const imagen = await subirImagen(fixture);

    for (const url of [
      imagen.url, // relativa: desarrollo
      `https://agentos.example.test${imagen.url}`, // absoluta: producción
      `http://localhost:4300${imagen.url}`, // absoluta: otra base
    ]) {
      assistant.calls.length = 0;
      const res = await fixture.api.app.inject({
        method: "POST",
        url: "/api/ai/task-assist",
        headers: fixture.authHeaders,
        payload: {
          mode: "enrich",
          field: "description",
          draft: {
            project_id: fixture.project.id,
            description: `![captura](${url})\n\n![fuera](https://example.com/a.png)`,
          },
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { context: { images: number } };
      expect(body.context.images, `url: ${url}`).toBe(1);
      expect(assistant.calls[0]!.images).toHaveLength(1);
      expect(assistant.calls[0]!.images[0]!.data.equals(PNG_1X1)).toBe(true);
    }
  });

  it("execution_prompt lleva título, DoD, cliente y referencias en absoluto", async () => {
    const assistant = fakeAssistant("# Tarea: lo que devuelva el modelo");
    const fixture = await fx(assistant);
    const imagen = await subirImagen(fixture);

    const task = await createTask(fixture.db, {
      projectId: fixture.project.id,
      title: "Rehacer el flujo de alta",
      description: `Ver la pantalla actual: ![pantalla](${imagen.url})`,
      definitionOfDone: "- El alta no duplica al cliente\n- Hay captura del antes y el después",
      stage: "ENTENDER",
      orderKey: "b",
    });
    await attachArtifact(fixture.db, {
      taskId: task.id,
      kind: "note",
      title: "Acuerdo con el cliente",
      content: "Se acordó tocar sólo el formulario de alta.",
      createdBy: `person:${fixture.person.id}`,
    });

    const res = await fixture.api.app.inject({
      method: "POST",
      url: "/api/ai/task-assist",
      headers: fixture.authHeaders,
      payload: { mode: "execution_prompt", task_id: task.id, draft: {} },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      context: { model: string; usage: { input_tokens: number; output_tokens: number; cost_usd: number | null } | null };
    };
    expect(body.context.model).toBe("claude-sonnet-5");
    expect(body.context.usage).toEqual({ input_tokens: 1000, output_tokens: 200, cost_usd: 0.004 });

    const call = assistant.calls[0]!;
    expect(call.system).toContain("# Tarea: <título>");
    expect(call.system).toContain("## Definición de terminado");
    expect(call.system).toContain("## Al terminar");
    // La metodología de trabajo va SIEMPRE, literal, en el sistema.
    expect(call.system).toContain("## Cómo trabajar");
    expect(call.system).toContain("/goal");
    expect(call.system).toContain("subagentes");
    expect(call.prompt).toContain("Rehacer el flujo de alta");
    expect(call.prompt).toContain("El alta no duplica al cliente");
    expect(call.prompt).toContain("ACME S.A.");
    expect(call.prompt).toContain("Acuerdo con el cliente");
    // La referencia local va en ABSOLUTO (AGENTOS_PUBLIC_URL), nunca relativa.
    expect(call.prompt).toContain(`https://agentos.example.test${imagen.url}`);
    expect(call.prompt).toContain(task.id);
    // Referencias fijas del contexto: tarea y proyecto, siempre absolutas.
    expect(call.prompt).toContain(`https://agentos.example.test/tareas?tarea=${task.id}`);
    expect(call.prompt).toContain(`https://agentos.example.test/proyectos/${fixture.project.id}/ruta`);
  });

  it("execution_prompt con el proveedor caído responde 200 con la plantilla determinista", async () => {
    const fixture = await fx(brokenAssistant());
    const imagen = await subirImagen(fixture);
    const task = await createTask(fixture.db, {
      projectId: fixture.project.id,
      title: "Rehacer el flujo de alta",
      description: `Pantalla actual: ![pantalla](${imagen.url})`,
      definitionOfDone: "- El alta no duplica al cliente",
      stage: "ENTENDER",
      orderKey: "c",
    });

    const res = await fixture.api.app.inject({
      method: "POST",
      url: "/api/ai/task-assist",
      headers: fixture.authHeaders,
      payload: { mode: "execution_prompt", task_id: task.id, draft: {} },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      text: string;
      context: { model: string; usage: { input_tokens: number; output_tokens: number; cost_usd: number | null } | null };
    };
    expect(body.context.model).toBe("plantilla");
    // Sin llamada al modelo: coste cero explícito, no "sin datos".
    expect(body.context.usage).toEqual({ input_tokens: 0, output_tokens: 0, cost_usd: 0 });
    expect(body.text).toContain("# Tarea: Rehacer el flujo de alta");
    expect(body.text).toContain("## Contexto del cliente");
    expect(body.text).toContain("ACME S.A.");
    expect(body.text).toContain("## Definición de terminado");
    expect(body.text).toContain("El alta no duplica al cliente");
    expect(body.text).toContain("## Referencias");
    expect(body.text).toContain(`https://agentos.example.test${imagen.url}`);
    expect(body.text).toContain("## Restricciones");
    expect(body.text).toContain("## Al terminar");
    expect(body.text).toContain(task.id);
    // La metodología de trabajo va SIEMPRE, literal, también en la plantilla.
    expect(body.text).toContain("## Cómo trabajar");
    expect(body.text).toContain("/goal");
    expect(body.text).toContain("subagentes");
    // Referencias fijas del contexto: tarea y proyecto, siempre absolutas.
    expect(body.text).toContain(`https://agentos.example.test/tareas?tarea=${task.id}`);
    expect(body.text).toContain(`https://agentos.example.test/proyectos/${fixture.project.id}/ruta`);
    // La plantilla no filtra nada del proveedor.
    expect(body.text).not.toMatch(/ANTHROPIC_API_KEY|credenciales/);
  });

  it("enrich con el proveedor caído responde 503 provider_unavailable sin filtrar la clave", async () => {
    const fixture = await fx(brokenAssistant());
    const res = await fixture.api.app.inject({
      method: "POST",
      url: "/api/ai/task-assist",
      headers: fixture.authHeaders,
      payload: {
        mode: "enrich",
        field: "title",
        draft: { project_id: fixture.project.id, title: "Algo" },
      },
    });
    expect(res.statusCode).toBe(503);
    const body = res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe("provider_unavailable");
    expect(body.error.message).toMatch(/No se pudo redactar/);
    // Se nombra la VARIABLE, jamás su valor.
    expect(body.error.message).toContain("ANTHROPIC_API_KEY");
    expect(body.error.message).not.toMatch(/sk-[A-Za-z0-9]/);
  });

  it("mode=enrich sin field es 400 validation", async () => {
    const fixture = await fx(fakeAssistant());
    const res = await fixture.api.app.inject({
      method: "POST",
      url: "/api/ai/task-assist",
      headers: fixture.authHeaders,
      payload: { mode: "enrich", draft: { title: "Sin campo" } },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe("validation_error");
  });

  it("sin sesión responde 401", async () => {
    const fixture = await fx(fakeAssistant());
    const res = await fixture.api.app.inject({
      method: "POST",
      url: "/api/ai/task-assist",
      payload: { mode: "enrich", field: "title", draft: {} },
    });
    expect(res.statusCode).toBe(401);
  });
});
