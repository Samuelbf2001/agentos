/**
 * Interfaz de Tareas — REST de los endpoints nuevos: etiquetas (creación,
 * reemplazo, catálogo), filtros `label`/`mine`, búsqueda (ficha y comentarios)
 * y subida/descarga de artefactos por archivo, incluyendo la regla
 * anti-teatro (missing_artifact) al mover a DONE.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPerson, createTask, getTask } from "@agentos/db";
import { makeFixture, type TestFixture } from "./helpers.js";

describe("Tareas — etiquetas, filtros y búsqueda", () => {
  let fixtures: TestFixture[] = [];

  afterEach(async () => {
    for (const fixture of fixtures.splice(0)) await fixture.close();
  });

  async function fx(): Promise<TestFixture> {
    const fixture = await makeFixture();
    fixtures.push(fixture);
    return fixture;
  }

  it("POST /api/tasks acepta labels y las normaliza (minúsculas, sin duplicados, ordenadas)", async () => {
    const fixture = await fx();
    const created = await fixture.api.app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: fixture.authHeaders,
      payload: {
        project_id: fixture.project.id,
        title: "Tarea etiquetada",
        stage: "ENTENDER",
        labels: ["Cliente", "  cliente ", "URGENTE"],
      },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json() as { task: { labels: string[] } };
    expect(body.task.labels).toEqual(["cliente", "urgente"]);
  });

  it("POST /api/tasks sin labels devuelve un arreglo vacío (no undefined)", async () => {
    const fixture = await fx();
    const created = await fixture.api.app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: fixture.authHeaders,
      payload: { project_id: fixture.project.id, title: "Sin etiquetas", stage: "ENTENDER" },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json() as { task: { labels: string[] } };
    expect(body.task.labels).toEqual([]);
  });

  it("PUT /api/tasks/:id/labels reemplaza el conjunto completo sin consumir expected_version ni tocar version", async () => {
    const fixture = await fx();
    const task = createTask(fixture.db, {
      projectId: fixture.project.id,
      title: "Tarea sin etiquetas",
      stage: "ENTENDER",
      orderKey: "labels-1",
    });
    expect(task.version).toBe(1);

    const put1 = await fixture.api.app.inject({
      method: "PUT",
      url: `/api/tasks/${task.id}/labels`,
      headers: fixture.authHeaders,
      payload: { labels: ["Cliente", "  cliente ", "URGENTE"] },
    });
    expect(put1.statusCode).toBe(200);
    const body1 = put1.json() as { task: { version: number; labels: string[] }; labels: string[] };
    expect(body1.labels).toEqual(["cliente", "urgente"]);
    expect(body1.task.labels).toEqual(["cliente", "urgente"]);
    // Clasificar no es una transición de la máquina de estados: la versión no sube.
    expect(body1.task.version).toBe(1);

    // Reemplazo completo (no unión): "urgente" desaparece, "interno" aparece.
    const put2 = await fixture.api.app.inject({
      method: "PUT",
      url: `/api/tasks/${task.id}/labels`,
      headers: fixture.authHeaders,
      payload: { labels: ["interno"] },
    });
    expect(put2.statusCode).toBe(200);
    const body2 = put2.json() as { labels: string[] };
    expect(body2.labels).toEqual(["interno"]);
    expect(getTask(fixture.db, task.id)!.version).toBe(1);
  });

  it("GET /api/labels devuelve el catálogo con conteo, acotado por project_id", async () => {
    const fixture = await fx();
    const t1 = createTask(fixture.db, {
      projectId: fixture.project.id,
      title: "T1",
      stage: "ENTENDER",
      orderKey: "cat-1",
    });
    const t2 = createTask(fixture.db, {
      projectId: fixture.project.id,
      title: "T2",
      stage: "ENTENDER",
      orderKey: "cat-2",
    });
    await fixture.api.app.inject({
      method: "PUT",
      url: `/api/tasks/${t1.id}/labels`,
      headers: fixture.authHeaders,
      payload: { labels: ["cliente"] },
    });
    await fixture.api.app.inject({
      method: "PUT",
      url: `/api/tasks/${t2.id}/labels`,
      headers: fixture.authHeaders,
      payload: { labels: ["cliente", "urgente"] },
    });

    const res = await fixture.api.app.inject({
      method: "GET",
      url: `/api/labels?project_id=${fixture.project.id}`,
      headers: fixture.authHeaders,
    });
    expect(res.statusCode).toBe(200);
    const { labels } = res.json() as { labels: Array<{ label: string; count: number }> };
    expect(labels).toEqual(
      expect.arrayContaining([
        { label: "cliente", count: 2 },
        { label: "urgente", count: 1 },
      ]),
    );
  });

  it("GET /api/tasks?label= filtra por etiqueta y ?mine=1 sólo devuelve las tareas de la persona de la sesión", async () => {
    const fixture = await fx();
    const other = createPerson(fixture.db, {
      orgId: fixture.org.id,
      fullName: "Otra persona",
      isInternal: true,
      role: "Operadora",
    });

    const mine = await fixture.api.app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: fixture.authHeaders,
      payload: {
        project_id: fixture.project.id,
        title: "Mía",
        stage: "ENTENDER",
        assignee_person_ids: [fixture.person.id],
        primary_assignee_person_id: fixture.person.id,
        labels: ["cliente"],
      },
    });
    expect(mine.statusCode).toBe(201);
    const mineId = (mine.json() as { task: { id: string } }).task.id;

    const notMine = await fixture.api.app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: fixture.authHeaders,
      payload: {
        project_id: fixture.project.id,
        title: "De otra persona",
        stage: "ENTENDER",
        assignee_person_ids: [other.id],
        primary_assignee_person_id: other.id,
      },
    });
    expect(notMine.statusCode).toBe(201);
    const notMineId = (notMine.json() as { task: { id: string } }).task.id;

    const byLabel = await fixture.api.app.inject({
      method: "GET",
      url: `/api/tasks?project_id=${fixture.project.id}&label=cliente`,
      headers: fixture.authHeaders,
    });
    expect(byLabel.statusCode).toBe(200);
    const byLabelTasks = (byLabel.json() as { tasks: Array<{ id: string }> }).tasks;
    expect(byLabelTasks.map((t) => t.id)).toEqual([mineId]);

    const mineTasks = await fixture.api.app.inject({
      method: "GET",
      url: "/api/tasks?mine=1",
      headers: fixture.authHeaders,
    });
    expect(mineTasks.statusCode).toBe(200);
    const mineIds = (mineTasks.json() as { tasks: Array<{ id: string }> }).tasks.map((t) => t.id);
    expect(mineIds).toContain(mineId);
    expect(mineIds).not.toContain(notMineId);
  });

  it("GET /api/tasks/search: coincide en título/DoD con source=task y en un comentario con source=comment", async () => {
    const fixture = await fx();
    const created = await fixture.api.app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: fixture.authHeaders,
      payload: {
        project_id: fixture.project.id,
        title: "Mantenimiento preventivo de maquinaria industrial",
        stage: "ENTENDER",
        labels: ["cliente"],
      },
    });
    expect(created.statusCode).toBe(201);
    const taskId = (created.json() as { task: { id: string } }).task.id;

    const byTitle = await fixture.api.app.inject({
      method: "GET",
      url: "/api/tasks/search?q=maquinaria",
      headers: fixture.authHeaders,
    });
    expect(byTitle.statusCode).toBe(200);
    const titleBody = byTitle.json() as {
      query: string;
      hits: Array<{ id: string; source: string; project_name: string | null; labels: string[] }>;
    };
    expect(titleBody.query).toBe("maquinaria");
    const titleHit = titleBody.hits.find((h) => h.id === taskId);
    expect(titleHit?.source).toBe("task");
    expect(titleHit?.project_name).toBe(fixture.project.name);
    expect(titleHit?.labels).toEqual(["cliente"]);

    // Palabra inventada que sólo aparece en un comentario, nunca en la ficha.
    const commentWord = "vibracion482";
    const comment = await fixture.api.app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/comment`,
      headers: fixture.authHeaders,
      payload: { body: `Se detecto un ${commentWord} raro en el rodamiento.` },
    });
    expect(comment.statusCode).toBe(201);

    const byComment = await fixture.api.app.inject({
      method: "GET",
      url: `/api/tasks/search?q=${commentWord}`,
      headers: fixture.authHeaders,
    });
    expect(byComment.statusCode).toBe(200);
    const commentBody = byComment.json() as { hits: Array<{ id: string; source: string }> };
    const commentHit = commentBody.hits.find((h) => h.id === taskId);
    expect(commentHit?.source).toBe("comment");
  });

  it("GET /api/tasks/search respeta project_id y mine", async () => {
    const fixture = await fx();
    const otherProjectTask = await fixture.api.app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: fixture.authHeaders,
      payload: { project_id: fixture.project.id, title: "Auditoria energetica ACME", stage: "ENTENDER" },
    });
    expect(otherProjectTask.statusCode).toBe(201);

    const scoped = await fixture.api.app.inject({
      method: "GET",
      url: `/api/tasks/search?q=energetica&project_id=${fixture.project.id}`,
      headers: fixture.authHeaders,
    });
    expect(scoped.statusCode).toBe(200);
    expect((scoped.json() as { hits: unknown[] }).hits.length).toBeGreaterThan(0);

    const mineScoped = await fixture.api.app.inject({
      method: "GET",
      url: "/api/tasks/search?q=energetica&mine=1",
      headers: fixture.authHeaders,
    });
    expect(mineScoped.statusCode).toBe(200);
    // La tarea no tiene asignado a la persona de la sesión: mine=1 la excluye.
    expect((mineScoped.json() as { hits: unknown[] }).hits).toHaveLength(0);
  });
});

describe("Tareas — artefactos por archivo (multipart) y regla anti-teatro", () => {
  let fixtures: TestFixture[] = [];
  let artifactsDir: string;
  let previousArtifactsDir: string | undefined;

  beforeAll(() => {
    previousArtifactsDir = process.env.AGENTOS_ARTIFACTS_DIR;
    artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-art-"));
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

  function multipartBody(boundary: string, fileName: string, content: string): Buffer {
    return Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: text/plain\r\n\r\n`,
      ),
      Buffer.from(content),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
  }

  it("POST /api/tasks/:id/artifacts/upload guarda el archivo y GET /api/artifacts/:id/download lo devuelve", async () => {
    const fixture = await fx();
    const task = createTask(fixture.db, {
      projectId: fixture.project.id,
      title: "Con archivo",
      stage: "ENTENDER",
      orderKey: "art-1",
    });

    const boundary = "----agentosTest1";
    const content = "contenido del entregable";
    const res = await fixture.api.app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/artifacts/upload`,
      headers: { ...fixture.authHeaders, "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: multipartBody(boundary, "informe.txt", content),
    });
    expect(res.statusCode).toBe(201);
    const { artifact } = res.json() as {
      artifact: { id: string; kind: string; path: string; meta: { bytes: number } };
    };
    expect(artifact.kind).toBe("file");
    // Ruta relativa: nunca absoluta ni con salto de directorio.
    expect(path.isAbsolute(artifact.path)).toBe(false);
    expect(artifact.path).not.toContain("..");
    expect(artifact.meta.bytes).toBe(Buffer.byteLength(content));

    const download = await fixture.api.app.inject({
      method: "GET",
      url: `/api/artifacts/${artifact.id}/download`,
      headers: fixture.authHeaders,
    });
    expect(download.statusCode).toBe(200);
    expect(download.headers["content-disposition"]).toContain("attachment");
    expect(download.body).toBe(content);
  });

  it("mover a DONE sin artefacto → 422 missing_artifact; tras subir uno con /upload, la transición funciona", async () => {
    const fixture = await fx();
    const task = createTask(fixture.db, {
      projectId: fixture.project.id,
      title: "Sin evidencia todavia",
      definitionOfDone: "Entregable adjunto",
      stage: "ENTENDER",
      status: "IN_PROGRESS",
      orderKey: "art-2",
    });

    const blocked = await fixture.api.app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/move`,
      headers: fixture.authHeaders,
      payload: { to: "DONE", expected_version: task.version },
    });
    expect(blocked.statusCode).toBe(422);
    const blockedBody = blocked.json() as { error: { code: string; message: string } };
    expect(blockedBody.error.code).toBe("missing_artifact");
    expect(blockedBody.error.message).toMatch(/artefacto/i);
    expect(getTask(fixture.db, task.id)!.status).toBe("IN_PROGRESS");

    const boundary = "----agentosTest2";
    const upload = await fixture.api.app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/artifacts/upload`,
      headers: { ...fixture.authHeaders, "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: multipartBody(boundary, "evidencia.txt", "evidencia del cierre"),
    });
    expect(upload.statusCode).toBe(201);

    // Actor humano: IN_PROGRESS→DONE directo está permitido por la máquina.
    const done = await fixture.api.app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/move`,
      headers: fixture.authHeaders,
      payload: { to: "DONE", expected_version: task.version },
    });
    expect(done.statusCode).toBe(200);
    expect(getTask(fixture.db, task.id)!.status).toBe("DONE");
  });

  it("mover a REVIEW sin artefacto → 422 missing_artifact; tras subir uno, REVIEW y luego DONE funcionan", async () => {
    const fixture = await fx();
    const task = createTask(fixture.db, {
      projectId: fixture.project.id,
      title: "Revision con evidencia diferida",
      definitionOfDone: "Entregable revisado",
      stage: "ENTENDER",
      status: "IN_PROGRESS",
      orderKey: "art-3",
    });

    const blockedReview = await fixture.api.app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/move`,
      headers: fixture.authHeaders,
      payload: { to: "REVIEW", expected_version: task.version },
    });
    expect(blockedReview.statusCode).toBe(422);
    expect((blockedReview.json() as { error: { code: string } }).error.code).toBe("missing_artifact");

    const boundary = "----agentosTest3";
    const upload = await fixture.api.app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/artifacts/upload`,
      headers: { ...fixture.authHeaders, "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: multipartBody(boundary, "borrador.txt", "borrador para revision"),
    });
    expect(upload.statusCode).toBe(201);

    const toReview = await fixture.api.app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/move`,
      headers: fixture.authHeaders,
      payload: { to: "REVIEW", expected_version: task.version },
    });
    expect(toReview.statusCode).toBe(200);
    const reviewed = (toReview.json() as { task: { version: number } }).task;

    const toDone = await fixture.api.app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/approve`,
      headers: fixture.authHeaders,
      payload: { expected_version: reviewed.version },
    });
    expect(toDone.statusCode).toBe(200);
    expect(getTask(fixture.db, task.id)!.status).toBe("DONE");
  });
});
