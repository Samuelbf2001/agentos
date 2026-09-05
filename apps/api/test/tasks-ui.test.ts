/**
 * Interfaz de Tareas — REST de los endpoints nuevos: etiquetas (creación,
 * reemplazo, catálogo), filtros `label`/`mine`, búsqueda (ficha y comentarios)
 * y subida/descarga de artefactos por archivo, incluyendo la regla
 * anti-teatro (missing_artifact) al mover a DONE.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  attachArtifact,
  createOrganization,
  createPerson,
  createProject,
  createTask,
  getTask,
  listTaskAssignees,
  listTaskNotificationLogs,
} from "@agentos/db";
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

  it("I3: personal interno se asigna a una tarea de OTRA organización; una persona externa de otra org sigue dando 400", async () => {
    const fixture = await fx();
    const otherOrg = createOrganization(fixture.db, { name: "Otra Org S.A.", kind: "client" });
    const otherOrgProject = createProject(fixture.db, {
      orgId: otherOrg.id,
      name: "Proyecto de otra organización",
      type: "assessment",
      stage: "ENTENDER",
      gateState: "pending",
    });

    // Persona interna (Sixteam), de una organización distinta a la del proyecto.
    const internalPerson = createPerson(fixture.db, {
      orgId: fixture.org.id,
      fullName: "Interno Sixteam",
      isInternal: true,
      role: "Consultor",
    });
    // Persona externa, también de otra organización que la del proyecto.
    const externalPerson = createPerson(fixture.db, {
      orgId: fixture.org.id,
      fullName: "Externo ACME",
      isInternal: false,
      role: "Cliente",
    });

    const taskForInternal = createTask(fixture.db, {
      projectId: otherOrgProject.id,
      title: "Tarea para interno",
      stage: "ENTENDER",
      orderKey: "i3-1",
    });
    const assignInternal = await fixture.api.app.inject({
      method: "POST",
      url: `/api/tasks/${taskForInternal.id}/assign`,
      headers: fixture.authHeaders,
      payload: {
        expected_version: taskForInternal.version,
        assignee_person_ids: [internalPerson.id],
        primary_assignee_person_id: internalPerson.id,
      },
    });
    expect(assignInternal.statusCode).toBe(200);

    const taskForExternal = createTask(fixture.db, {
      projectId: otherOrgProject.id,
      title: "Tarea para externo",
      stage: "ENTENDER",
      orderKey: "i3-2",
    });
    const assignExternal = await fixture.api.app.inject({
      method: "POST",
      url: `/api/tasks/${taskForExternal.id}/assign`,
      headers: fixture.authHeaders,
      payload: {
        expected_version: taskForExternal.version,
        assignee_person_ids: [externalPerson.id],
        primary_assignee_person_id: externalPerson.id,
      },
    });
    expect(assignExternal.statusCode).toBe(400);

    // El selector de personas asignables también debe ofrecer al interno.
    const people = await fixture.api.app.inject({
      method: "GET",
      url: `/api/projects/${otherOrgProject.id}/people`,
      headers: fixture.authHeaders,
    });
    expect(people.statusCode).toBe(200);
    const peopleIds = (people.json() as { people: Array<{ id: string }> }).people.map((p) => p.id);
    expect(peopleIds).toContain(internalPerson.id);
    expect(peopleIds).not.toContain(externalPerson.id);
  });

  it("POST /api/tasks con responsable interno en proyecto de OTRA organización crea la tarea, la asignación y el aviso (sin 400)", async () => {
    const fixture = await fx();
    const otherOrg = createOrganization(fixture.db, { name: "ACME Otra Org", kind: "client" });
    const otherOrgProject = createProject(fixture.db, {
      orgId: otherOrg.id,
      name: "Proyecto ACME",
      type: "assessment",
      stage: "ENTENDER",
      gateState: "pending",
    });
    const internalPerson = createPerson(fixture.db, {
      orgId: fixture.org.id,
      fullName: "Interno Sixteam con correo",
      email: "interno@sixteam.test",
      isInternal: true,
      role: "Consultor",
    });

    const created = await fixture.api.app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: fixture.authHeaders,
      payload: {
        project_id: otherOrgProject.id,
        title: "Tarea para interno con aviso",
        stage: "ENTENDER",
        assignee_person_ids: [internalPerson.id],
        primary_assignee_person_id: internalPerson.id,
      },
    });
    // El aviso ya no debe hacer fallar la petición: la tarea se creó y se
    // devuelve 201 aunque la persona sea de otra organización que el proyecto.
    expect(created.statusCode).toBe(201);
    const taskId = (created.json() as { task: { id: string } }).task.id;

    const assignees = listTaskAssignees(fixture.db, taskId);
    expect(assignees.map((row) => row.personId)).toEqual([internalPerson.id]);

    // Sin proveedor configurado en el fixture, el aviso queda auditado como
    // `suppressed`; con proveedor habría quedado `delivered`/`failed`.
    const logs = listTaskNotificationLogs(fixture.db, { taskId });
    expect(logs).toHaveLength(1);
    expect(logs[0]?.personId).toBe(internalPerson.id);
    expect(logs[0]?.status).toBe("suppressed");
  });

  it("si el adaptador de avisos lanza, la creación de la tarea sigue respondiendo éxito y el error queda en el log", async () => {
    const fixture = await fx();
    const other = createPerson(fixture.db, {
      orgId: fixture.org.id,
      fullName: "Persona con correo",
      email: "persona@acme.test",
      isInternal: true,
      role: "Operadora",
    });
    const warnSpy = vi.spyOn(fixture.api.app.log, "warn");
    vi.spyOn(fixture.api.ctx.notifications, "notifyAssignment").mockRejectedValueOnce(
      new Error("proveedor de correo caído"),
    );

    const created = await fixture.api.app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: fixture.authHeaders,
      payload: {
        project_id: fixture.project.id,
        title: "Tarea pese a fallo de aviso",
        stage: "ENTENDER",
        assignee_person_ids: [other.id],
        primary_assignee_person_id: other.id,
      },
    });
    expect(created.statusCode).toBe(201);
    const taskId = (created.json() as { task: { id: string } }).task.id;
    expect(listTaskAssignees(fixture.db, taskId).map((row) => row.personId)).toEqual([other.id]);
    expect(warnSpy).toHaveBeenCalled();
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

  it("I4.1: subida con filename de path traversal cae saneada DENTRO de la raíz de artefactos, nunca fuera", async () => {
    const fixture = await fx();
    const task = createTask(fixture.db, {
      projectId: fixture.project.id,
      title: "Con nombre malicioso",
      stage: "ENTENDER",
      orderKey: "art-traversal",
    });

    const boundary = "----agentosTestTraversal";
    const res = await fixture.api.app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/artifacts/upload`,
      headers: { ...fixture.authHeaders, "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: multipartBody(boundary, "../../evil.txt", "contenido malicioso"),
    });
    expect(res.statusCode).toBe(201);
    const { artifact } = res.json() as { artifact: { id: string; path: string } };
    expect(artifact.path).not.toContain("..");
    expect(path.basename(artifact.path)).toBe(`${artifact.id}-evil.txt`);

    const absolute = path.resolve(artifactsDir, artifact.path);
    expect(absolute.startsWith(path.resolve(artifactsDir) + path.sep)).toBe(true);
    expect(fs.existsSync(absolute)).toBe(true);
    // Ningún archivo se escribió fuera de la raíz de artefactos.
    expect(fs.existsSync(path.resolve(artifactsDir, "..", "evil.txt"))).toBe(false);
  });

  it("I4.2: content de un artefacto `link` debe ser http(s); la descarga exige meta.storage === 'artifacts_root'", async () => {
    const fixture = await fx();
    const task = createTask(fixture.db, {
      projectId: fixture.project.id,
      title: "Con enlace",
      stage: "ENTENDER",
      orderKey: "art-link",
    });

    const asPath = await fixture.api.app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/artifacts`,
      headers: fixture.authHeaders,
      payload: { kind: "link", title: "Intento de ruta absoluta", content: "C:\\Windows\\System32\\config\\SAM" },
    });
    expect(asPath.statusCode).toBe(400);

    const noScheme = await fixture.api.app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/artifacts`,
      headers: fixture.authHeaders,
      payload: { kind: "link", title: "Sin protocolo", content: "example.com/informe" },
    });
    expect(noScheme.statusCode).toBe(400);

    const okLink = await fixture.api.app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/artifacts`,
      headers: fixture.authHeaders,
      payload: { kind: "link", title: "Enlace válido", content: "https://example.com/informe" },
    });
    expect(okLink.statusCode).toBe(201);

    // Artefacto con `path` en la fila pero sin el meta que la ruta exige
    // (p.ej. fila heredada o escrita por otro camino que no sea el upload
    // de esta API): la descarga debe responder 404 sin revelar la ruta.
    const legacy = attachArtifact(fixture.db, {
      taskId: task.id,
      kind: "file",
      title: "Legado",
      content: null,
      path: "algo/legado-secreto.txt",
    });
    const download = await fixture.api.app.inject({
      method: "GET",
      url: `/api/artifacts/${legacy.id}/download`,
      headers: fixture.authHeaders,
    });
    expect(download.statusCode).toBe(404);
    const body = download.json() as { error: { code: string; message: string } };
    expect(body.error.message).not.toMatch(/legado-secreto/);
  });

  it("I4.3: subida que supera el límite configurado responde 413 con mensaje claro", async () => {
    const previousMax = process.env.AGENTOS_ARTIFACT_MAX_BYTES;
    process.env.AGENTOS_ARTIFACT_MAX_BYTES = "10";
    try {
      const fixture = await fx();
      const task = createTask(fixture.db, {
        projectId: fixture.project.id,
        title: "Archivo demasiado grande",
        stage: "ENTENDER",
        orderKey: "art-limit",
      });
      const boundary = "----agentosTestLimit";
      const res = await fixture.api.app.inject({
        method: "POST",
        url: `/api/tasks/${task.id}/artifacts/upload`,
        headers: { ...fixture.authHeaders, "content-type": `multipart/form-data; boundary=${boundary}` },
        payload: multipartBody(boundary, "grande.txt", "contenido que supera el limite de diez bytes"),
      });
      expect(res.statusCode).toBe(413);
      const body = res.json() as { error: { code: string; message: string } };
      expect(body.error.message).toMatch(/límite/i);
    } finally {
      if (previousMax === undefined) delete process.env.AGENTOS_ARTIFACT_MAX_BYTES;
      else process.env.AGENTOS_ARTIFACT_MAX_BYTES = previousMax;
    }
  });

  it("crear con un solo responsable (sin primary_assignee_person_id) permite BACKLOG→READY", async () => {
    const fixture = await fx();
    const created = await fixture.api.app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: fixture.authHeaders,
      payload: {
        project_id: fixture.project.id,
        title: "Un responsable sin marcar principal",
        stage: "ENTENDER",
        definition_of_done: "Checklist firmado por el cliente",
        assignee_person_ids: [fixture.person.id],
      },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json() as {
      task: { id: string; version: number; assigneePersonId: string | null };
      assignees?: { personId: string; isPrimary: boolean }[];
    };
    expect(body.task.assigneePersonId).toBe(fixture.person.id);
    const assignees = listTaskAssignees(fixture.db, body.task.id);
    expect(assignees).toMatchObject([{ personId: fixture.person.id, isPrimary: true }]);

    const moved = await fixture.api.app.inject({
      method: "POST",
      url: `/api/tasks/${body.task.id}/move`,
      headers: fixture.authHeaders,
      payload: { to: "READY", expected_version: body.task.version },
    });
    expect(moved.statusCode).toBe(200);
    expect(getTask(fixture.db, body.task.id)!.status).toBe("READY");
  });
});
