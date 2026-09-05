/**
 * Espejo Postgres de `task-labels-search.test.ts`: etiquetas de tarea y
 * búsqueda de tareas contra el motor PG, pero llamando SIEMPRE a la fachada
 * dual (`@agentos/db`), no a `pg/repositories/*` directamente. Es el contrato
 * que importa: el mismo código de `apps/api` tiene que dar el mismo resultado
 * con los dos motores.
 *
 * **Se auto-omite si no hay `AGENTOS_PG_URL`** — igual que el resto de la
 * suite PG, para que `pnpm -r test` siga verde sin Docker.
 */
import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { isAgentosError } from "@agentos/shared";
import {
  addTaskLabels,
  appendTaskEvent,
  createOrganization,
  createProject,
  createTask,
  getTask,
  listLabelCatalog,
  listLabelsForTasks,
  listTaskLabels,
  normalizeLabel,
  removeTaskLabel,
  replaceTaskLabels,
  searchTasks,
  updateTask,
} from "../src/index.js";
import { closePgDb, openPgDb, type AgentosPgDb } from "../src/pg/client-pg.js";
import { runPgMigrations } from "../src/pg/migrate-pg.js";
import { PG_TABLE_ORDER } from "../src/pg/schema-pg.js";

const PG_URL = process.env.AGENTOS_PG_URL;
const describePg = describe.skipIf(!PG_URL);

describePg("etiquetas y búsqueda de tareas en Postgres (vía fachada dual)", () => {
  let db: AgentosPgDb;
  let projectId: string;
  let otherProjectId: string;

  beforeAll(async () => {
    db = openPgDb(PG_URL);
    // `runPgMigrations` incluye `ensurePgSearch`: es lo que crea las columnas
    // `task_tsv` / `comment_tsv` generadas de las que vive `searchTasksPg`.
    // `enableVector: false`: esta suite no toca embeddings y así no pelea por la
    // dimensión de `knowledge_docs.embedding` con la suite que sí los prueba.
    await runPgMigrations(db, { enableVector: false });
  }, 180_000);

  afterAll(async () => {
    if (db) await closePgDb(db);
  });

  beforeEach(async () => {
    await db.execute(
      sql.raw(`TRUNCATE TABLE ${PG_TABLE_ORDER.map((t) => `"${t}"`).join(", ")} CASCADE`),
    );
    const org = await createOrganization(db, { name: "Org etiquetas PG", kind: "client" });
    const project = await createProject(db, {
      orgId: org.id,
      name: "Proyecto etiquetas PG",
      type: "assessment",
      stage: "ENTENDER",
    });
    const other = await createProject(db, {
      orgId: org.id,
      name: "Otro proyecto PG",
      type: "assessment",
      stage: "ENTENDER",
    });
    projectId = project.id;
    otherProjectId = other.id;
  });

  async function makeTask(
    targetProjectId: string,
    patch: Record<string, unknown> = {},
  ): Promise<{ id: string; version: number }> {
    return await createTask(db, {
      projectId: targetProjectId,
      title: "Tarea base",
      stage: "ENTENDER",
      status: "BACKLOG",
      priority: "normal",
      orderKey: "m",
      ...patch,
    } as Parameters<typeof createTask>[1]);
  }

  describe("task_labels", () => {
    it("reemplaza el conjunto completo, normaliza y NO toca la versión de la tarea", async () => {
      const task = await makeTask(projectId);
      const labels = await replaceTaskLabels(db, task.id, ["Cliente", " cliente ", "URGENTE"]);
      expect(labels).toEqual(["cliente", "urgente"]);
      expect(await listTaskLabels(db, task.id)).toEqual(["cliente", "urgente"]);
      expect((await getTask(db, task.id))!.version).toBe(task.version);

      await replaceTaskLabels(db, task.id, ["interno"]);
      expect(await listTaskLabels(db, task.id)).toEqual(["interno"]);
    });

    it("añade sin borrar y quita una sola etiqueta", async () => {
      const task = await makeTask(projectId);
      await replaceTaskLabels(db, task.id, ["cliente"]);
      expect(await addTaskLabels(db, task.id, ["urgente"])).toEqual(["cliente", "urgente"]);
      expect(await removeTaskLabel(db, task.id, "Cliente")).toEqual(["urgente"]);
    });

    it("falla con tarea inexistente en vez de crear filas huérfanas", async () => {
      await expect(replaceTaskLabels(db, "no-existe", ["x"])).rejects.toSatisfy((err: unknown) =>
        isAgentosError(err),
      );
      expect(await listTaskLabels(db, "no-existe")).toEqual([]);
    });

    it("carga las etiquetas de varias tareas en una sola consulta", async () => {
      const a = await makeTask(projectId, { title: "A" });
      const b = await makeTask(projectId, { title: "B" });
      await replaceTaskLabels(db, a.id, ["cliente"]);
      await replaceTaskLabels(db, b.id, ["interno", "urgente"]);
      const map = await listLabelsForTasks(db, [a.id, b.id, "inexistente"]);
      expect(map.get(a.id)).toEqual(["cliente"]);
      expect(map.get(b.id)).toEqual(["interno", "urgente"]);
      expect(map.get("inexistente")).toBeUndefined();
    });

    it("el catálogo cuenta usos y se puede acotar a un proyecto", async () => {
      const a = await makeTask(projectId, { title: "A" });
      const b = await makeTask(otherProjectId, { title: "B" });
      await replaceTaskLabels(db, a.id, ["cliente"]);
      await replaceTaskLabels(db, b.id, ["cliente", "urgente"]);
      expect(await listLabelCatalog(db)).toEqual([
        { label: "cliente", count: 2 },
        { label: "urgente", count: 1 },
      ]);
      expect(await listLabelCatalog(db, { projectId })).toEqual([{ label: "cliente", count: 1 }]);
      expect(normalizeLabel(" Cliente ")).toBe("cliente");
    });
  });

  describe("búsqueda de tareas (tsvector)", () => {
    it("encuentra por título, descripción y definición de terminado", async () => {
      await makeTask(projectId, { title: "Mapear cobranza", description: "Entrevistar a tesorería" });
      await makeTask(projectId, { title: "Otra cosa", definitionOfDone: "Diagrama SIPOC validado" });

      expect((await searchTasks(db, "cobranza")).map((h) => h.title)).toEqual(["Mapear cobranza"]);
      expect((await searchTasks(db, "tesorería")).map((h) => h.title)).toEqual(["Mapear cobranza"]);
      expect((await searchTasks(db, "SIPOC")).map((h) => h.title)).toEqual(["Otra cosa"]);
    });

    it("encuentra por comentario y lo marca como tal", async () => {
      const task = await makeTask(projectId, { title: "Sin pistas en la ficha" });
      await appendTaskEvent(db, {
        taskId: task.id,
        kind: "comment",
        actor: "person:p1",
        payload: { body: "El cliente pidió posponer la reunión de kickoff" },
      });
      const hits = await searchTasks(db, "kickoff");
      expect(hits).toHaveLength(1);
      expect(hits[0]!.id).toBe(task.id);
      expect(hits[0]!.source).toBe("comment");
    });

    it("una tarea aparece UNA sola vez aunque coincida en ficha y comentario", async () => {
      const task = await makeTask(projectId, { title: "Kickoff con el cliente" });
      await appendTaskEvent(db, {
        taskId: task.id,
        kind: "comment",
        actor: "person:p1",
        payload: { body: "kickoff movido a la semana siguiente" },
      });
      expect(await searchTasks(db, "kickoff")).toHaveLength(1);
    });

    it("acota por proyecto y respeta el límite", async () => {
      await makeTask(projectId, { title: "Auditoría de procesos" });
      await makeTask(otherProjectId, { title: "Auditoría de inventario" });
      expect(await searchTasks(db, "auditoría")).toHaveLength(2);
      expect((await searchTasks(db, "auditoría", { projectId })).map((h) => h.title)).toEqual([
        "Auditoría de procesos",
      ]);
      expect(await searchTasks(db, "auditoría", { limit: 1 })).toHaveLength(1);
    });

    it("una consulta vacía no devuelve todo el tablero", async () => {
      await makeTask(projectId, { title: "Cualquier cosa" });
      expect(await searchTasks(db, "   ")).toEqual([]);
    });

    it("el índice refleja los cambios de la ficha (columna generada)", async () => {
      const task = await makeTask(projectId, { title: "Título viejo" });
      await updateTask(db, task.id, { title: "Título flamante" }, task.version);
      expect(await searchTasks(db, "viejo")).toEqual([]);
      expect((await searchTasks(db, "flamante")).map((h) => h.id)).toEqual([task.id]);
    });
  });
});
