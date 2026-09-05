/**
 * Etiquetas de tarea y búsqueda de tareas en el motor SQLite.
 *
 * La búsqueda vive en `search.ts` porque es específica de FTS5; aquí se fija el
 * CONTRATO que el espejo Postgres (`pg/search-pg.ts`) tiene que respetar: rank
 * ascendente = mejores primero, una fila por tarea y `source` diciendo si el
 * match cayó en la ficha o en un comentario.
 */
import { describe, expect, it } from "vitest";
import { isAgentosError } from "@agentos/shared";
import { openDb, type AgentosDb } from "../src/client.js";
import { runMigrations } from "../src/migrate.js";
import { createOrganization } from "../src/repositories/organizations-people.js";
import { createProject } from "../src/repositories/projects.js";
import { appendTaskEvent, createTask, updateTask } from "../src/repositories/tasks.js";
import {
  addTaskLabels,
  listLabelCatalog,
  listLabelsForTasks,
  listTaskLabels,
  normalizeLabel,
  normalizeLabels,
  removeTaskLabel,
  replaceTaskLabels,
} from "../src/repositories/task-labels.js";
import { searchTasks } from "../src/search.js";

function freshDb(): AgentosDb {
  const db = openDb(":memory:");
  runMigrations(db);
  return db;
}

function fixture(db: AgentosDb) {
  const org = createOrganization(db, { name: "Org etiquetas", kind: "client" });
  const project = createProject(db, {
    orgId: org.id,
    name: "Proyecto etiquetas",
    type: "assessment",
    stage: "ENTENDER",
  });
  const otherProject = createProject(db, {
    orgId: org.id,
    name: "Otro proyecto",
    type: "assessment",
    stage: "ENTENDER",
  });
  return { org, project, otherProject };
}

function makeTask(
  db: AgentosDb,
  projectId: string,
  patch: Partial<Parameters<typeof createTask>[1]> = {},
) {
  return createTask(db, {
    projectId,
    title: "Tarea base",
    stage: "ENTENDER",
    status: "BACKLOG",
    priority: "normal",
    orderKey: "m",
    ...patch,
  });
}

describe("normalización de etiquetas", () => {
  it("baja a minúsculas, colapsa espacios y deduplica de forma determinista", () => {
    expect(normalizeLabel("  Cliente   Clave ")).toBe("cliente clave");
    expect(normalizeLabels(["URGENTE", "urgente ", " Cliente"])).toEqual(["cliente", "urgente"]);
  });

  it("descarta cadenas vacías sin inventar una etiqueta", () => {
    expect(normalizeLabels(["", "   ", "ok"])).toEqual(["ok"]);
  });

  it("rechaza etiquetas absurdamente largas y listas desbordadas", () => {
    expect(() => normalizeLabels(["x".repeat(41)])).toThrow();
    try {
      normalizeLabels(Array.from({ length: 21 }, (_, i) => `etiqueta-${i}`));
      throw new Error("debería haber lanzado");
    } catch (err) {
      expect(isAgentosError(err) && err.code).toBe("validation_error");
    }
  });
});

describe("repositorio task_labels", () => {
  it("reemplaza el conjunto completo y NO toca la versión de la tarea", () => {
    const db = freshDb();
    const { project } = fixture(db);
    const task = makeTask(db, project.id);
    const versionBefore = task.version;

    expect(replaceTaskLabels(db, task.id, ["Cliente", "urgente"], "person:p1")).toEqual([
      "cliente",
      "urgente",
    ]);
    expect(listTaskLabels(db, task.id)).toEqual(["cliente", "urgente"]);

    // Clasificar no es una transición: la ficha abierta del humano sigue válida.
    const reloaded = updateTask(db, task.id, { title: "Tarea base" }, versionBefore);
    expect(reloaded.version).toBe(versionBefore + 1);

    replaceTaskLabels(db, task.id, ["cliente"]);
    expect(listTaskLabels(db, task.id)).toEqual(["cliente"]);
  });

  it("añade sin borrar y quita una sola etiqueta", () => {
    const db = freshDb();
    const { project } = fixture(db);
    const task = makeTask(db, project.id);
    replaceTaskLabels(db, task.id, ["cliente"]);
    expect(addTaskLabels(db, task.id, ["Urgente"])).toEqual(["cliente", "urgente"]);
    expect(removeTaskLabel(db, task.id, "URGENTE")).toEqual(["cliente"]);
  });

  it("falla con tarea inexistente en vez de crear filas huérfanas", () => {
    const db = freshDb();
    expect(() => replaceTaskLabels(db, "no-existe", ["x"])).toThrow();
  });

  it("carga las etiquetas de varias tareas en una sola consulta", () => {
    const db = freshDb();
    const { project } = fixture(db);
    const a = makeTask(db, project.id, { title: "A" });
    const b = makeTask(db, project.id, { title: "B" });
    replaceTaskLabels(db, a.id, ["cliente"]);
    replaceTaskLabels(db, b.id, ["interno", "cliente"]);
    const map = listLabelsForTasks(db, [a.id, b.id]);
    expect(map.get(a.id)).toEqual(["cliente"]);
    expect(map.get(b.id)).toEqual(["cliente", "interno"]);
    expect(listLabelsForTasks(db, []).size).toBe(0);
  });

  it("el catálogo cuenta usos y se puede acotar a un proyecto", () => {
    const db = freshDb();
    const { project, otherProject } = fixture(db);
    const a = makeTask(db, project.id, { title: "A" });
    const b = makeTask(db, otherProject.id, { title: "B" });
    replaceTaskLabels(db, a.id, ["cliente"]);
    replaceTaskLabels(db, b.id, ["cliente", "otro"]);

    expect(listLabelCatalog(db)).toEqual([
      { label: "cliente", count: 2 },
      { label: "otro", count: 1 },
    ]);
    expect(listLabelCatalog(db, { projectId: project.id })).toEqual([{ label: "cliente", count: 1 }]);
  });
});

describe("búsqueda de tareas (FTS5)", () => {
  it("encuentra por título, descripción y definición de terminado", () => {
    const db = freshDb();
    const { project } = fixture(db);
    makeTask(db, project.id, { title: "Mapear cobranza", description: "Entrevistar a tesorería" });
    makeTask(db, project.id, { title: "Otra cosa", definitionOfDone: "Diagrama SIPOC validado" });

    expect(searchTasks(db, "cobranza").map((h) => h.title)).toEqual(["Mapear cobranza"]);
    expect(searchTasks(db, "tesorería").map((h) => h.title)).toEqual(["Mapear cobranza"]);
    expect(searchTasks(db, "SIPOC").map((h) => h.title)).toEqual(["Otra cosa"]);
  });

  it("encuentra por comentario y lo marca como tal", () => {
    const db = freshDb();
    const { project } = fixture(db);
    const task = makeTask(db, project.id, { title: "Sin pistas en la ficha" });
    appendTaskEvent(db, {
      taskId: task.id,
      kind: "comment",
      actor: "person:p1",
      payload: { body: "El cliente pidió posponer la reunión de kickoff" },
    });

    const hits = searchTasks(db, "kickoff");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.id).toBe(task.id);
    expect(hits[0]!.source).toBe("comment");
    expect(hits[0]!.snippet).toContain("kickoff");
  });

  it("una tarea aparece UNA sola vez aunque coincida en ficha y comentario", () => {
    const db = freshDb();
    const { project } = fixture(db);
    const task = makeTask(db, project.id, { title: "Kickoff con el cliente" });
    appendTaskEvent(db, {
      taskId: task.id,
      kind: "comment",
      actor: "person:p1",
      payload: { body: "kickoff movido a la semana siguiente" },
    });
    const hits = searchTasks(db, "kickoff");
    expect(hits).toHaveLength(1);
  });

  it("acota por proyecto y respeta el límite", () => {
    const db = freshDb();
    const { project, otherProject } = fixture(db);
    makeTask(db, project.id, { title: "Auditoría de procesos" });
    makeTask(db, otherProject.id, { title: "Auditoría de inventario" });

    expect(searchTasks(db, "auditoría")).toHaveLength(2);
    expect(searchTasks(db, "auditoría", { projectId: project.id }).map((h) => h.title)).toEqual([
      "Auditoría de procesos",
    ]);
    expect(searchTasks(db, "auditoría", { limit: 1 })).toHaveLength(1);
  });

  it("una consulta vacía o sólo de símbolos no devuelve todo el tablero", () => {
    const db = freshDb();
    const { project } = fixture(db);
    makeTask(db, project.id, { title: "Cualquier cosa" });
    expect(searchTasks(db, "   ")).toEqual([]);
    expect(searchTasks(db, '""')).toEqual([]);
  });

  it("el índice refleja los cambios de la ficha (triggers espejo)", () => {
    const db = freshDb();
    const { project } = fixture(db);
    const task = makeTask(db, project.id, { title: "Título viejo" });
    updateTask(db, task.id, { title: "Título flamante" }, task.version);
    expect(searchTasks(db, "viejo")).toEqual([]);
    expect(searchTasks(db, "flamante").map((h) => h.id)).toEqual([task.id]);
  });
});
