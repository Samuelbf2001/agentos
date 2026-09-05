import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeDb,
  createOrganization,
  createPerson,
  getProject,
  getTask,
  listNotionIdentityMappings,
  listNotionMigrationRuns,
  listNotionQuarantine,
  listProjects,
  listTaskAssignees,
  listTasks,
  openDb,
  runMigrations,
  getNotionOrigin,
  type AgentosDb,
} from "@agentos/db";
import { importNotionSnapshot } from "../src/importer.js";
import { INBOX_PROJECT_NAME } from "../src/field-map.js";
import { SnapshotReader } from "../src/snapshot-reader.js";
import { projectPage, taskPage, writeSnapshotFixture } from "./fixtures.js";

const temporary: string[] = [];
let db: AgentosDb;
let dbDirectory: string;
let organizationId: string;

/** DB temporal SIEMPRE: `data/agentos.db` nunca se toca desde la suite. */
beforeEach(async () => {
  dbDirectory = await mkdtemp(path.join(os.tmpdir(), "agentos-notion-import-db-"));
  temporary.push(dbDirectory);
  db = openDb(path.join(dbDirectory, "test.db"));
  runMigrations(db);
  const org = createOrganization(db, { name: "Sixteam", kind: "internal" });
  organizationId = org.id;
  createPerson(db, {
    orgId: org.id,
    fullName: "Ernesto",
    email: "ernesto@sixteam.pro",
    isInternal: true,
  });
});

afterEach(async () => {
  closeDb(db);
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixtureReader(options: Parameters<typeof writeSnapshotFixture>[0]): Promise<SnapshotReader> {
  const fixture = await writeSnapshotFixture(options);
  temporary.push(path.dirname(fixture.root));
  return new SnapshotReader(fixture.root);
}

function baseFixture() {
  return {
    projects: [projectPage({ id: "proj-1", name: "Cliente Alfa", fase: "Implementacion" })],
    tasks: [
      taskPage({
        id: "task-1",
        title: "Primera",
        estado: "Realizando",
        priority: "ALTO",
        due: { start: "2026-09-05" },
        people: [{ id: "user-ernesto", email: "ernesto@sixteam.pro" }],
        projectIds: ["proj-1"],
      }),
      taskPage({
        id: "task-2",
        title: "Segunda",
        estado: "Sin empezar",
        projectIds: ["proj-1"],
        blockedByIds: ["task-1"],
      }),
    ],
  };
}

describe("importador idempotente", () => {
  it("importa entidades, relaciones, responsables y linaje en una sola corrida", async () => {
    const reader = await fixtureReader(baseFixture());
    const report = await importNotionSnapshot({ db, reader });

    expect(report.imported.projects_created).toBe(1);
    expect(report.imported.tasks_created).toBe(2);
    expect(report.relations.task_project_links).toBe(2);
    expect(report.relations.depends_on_edges).toBe(1);
    expect(report.identities.confirmed_email).toBe(1);
    expect(report.identities.assignments_written).toBe(1);
    expect(report.destination_counts).toEqual({ projects: 1, tasks: 2 });

    const project = listProjects(db).find((item) => item.name === "Cliente Alfa");
    expect(project).toBeDefined();
    expect(project?.type).toBe("ops");
    expect(project?.stage).toBe("OPERAR");

    const tasks = listTasks(db, { projectId: project!.id });
    expect(tasks).toHaveLength(2);
    const primera = tasks.find((task) => task.title === "Primera")!;
    expect(primera.status).toBe("IN_PROGRESS");
    expect(primera.priority).toBe("high");
    expect(primera.stage).toBe("OPERAR");
    expect(primera.dueAt).toBe(Date.parse("2026-09-05"));
    expect(listTaskAssignees(db, primera.id)).toHaveLength(1);

    const runs = listNotionMigrationRuns(db);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.manifestHash).toBe("hash-de-prueba");
    expect(runs[0]?.snapshotRunId).toBe("notion-fixture-run");
  });

  it("dos corridas seguidas dan los mismos conteos: nada se duplica", async () => {
    const fixture = baseFixture();
    const first = await importNotionSnapshot({ db, reader: await fixtureReader(fixture) });
    const projectsAfterFirst = listProjects(db).length;
    const tasksAfterFirst = listTasks(db).length;

    const second = await importNotionSnapshot({ db, reader: await fixtureReader(fixture) });

    expect(listProjects(db)).toHaveLength(projectsAfterFirst);
    expect(listTasks(db)).toHaveLength(tasksAfterFirst);
    expect(second.destination_counts).toEqual(first.destination_counts);
    expect(second.imported.projects_created).toBe(0);
    expect(second.imported.projects_updated).toBe(1);
    expect(second.imported.tasks_created).toBe(0);
    expect(second.imported.tasks_updated).toBe(2);
    // Las asignaciones tampoco se duplican: siguen siendo una por tarea.
    const primera = listTasks(db).find((task) => task.title === "Primera")!;
    expect(listTaskAssignees(db, primera.id)).toHaveLength(1);
    expect(listNotionMigrationRuns(db)).toHaveLength(2);
  });

  it("--dry-run no escribe ni una fila", async () => {
    const reader = await fixtureReader(baseFixture());
    const report = await importNotionSnapshot({ db, reader, dryRun: true });
    expect(report.mode).toBe("dry_run");
    expect(report.source_counts).toEqual({ projects: 1, tasks: 2 });
    expect(listProjects(db)).toHaveLength(0);
    expect(listTasks(db)).toHaveLength(0);
    expect(listNotionMigrationRuns(db)).toHaveLength(0);
  });
});

describe("bandeja de Notion", () => {
  it("las tareas sin proyecto van al contenedor, no a cuarentena silenciosa", async () => {
    const reader = await fixtureReader({
      projects: [projectPage({ id: "proj-1", name: "Cliente Alfa" })],
      tasks: [
        taskPage({ id: "task-1", title: "Con proyecto", projectIds: ["proj-1"] }),
        taskPage({ id: "task-huerfana", title: "Sin proyecto" }),
      ],
    });
    const report = await importNotionSnapshot({ db, reader });

    expect(report.relations.inbox_tasks).toBe(1);
    expect(report.imported.inbox_projects).toBe(1);
    const inbox = listProjects(db).find((project) => project.name === INBOX_PROJECT_NAME);
    expect(inbox).toBeDefined();
    const inboxTasks = listTasks(db, { projectId: inbox!.id });
    expect(inboxTasks.map((task) => task.title)).toEqual(["Sin proyecto"]);
    // No se pierde: sigue teniendo su archivo y su enlace de origen.
    const origin = getNotionOrigin(db, "task", inboxTasks[0]!.id);
    expect(origin?.link.notionPageId).toBe("task-huerfana");
  });

  it("reutiliza la misma bandeja en una segunda corrida", async () => {
    const fixture = {
      projects: [],
      tasks: [taskPage({ id: "task-huerfana", title: "Sin proyecto" })],
    };
    await importNotionSnapshot({ db, reader: await fixtureReader(fixture) });
    await importNotionSnapshot({ db, reader: await fixtureReader(fixture) });
    expect(listProjects(db).filter((project) => project.name === INBOX_PROJECT_NAME)).toHaveLength(1);
    expect(listTasks(db)).toHaveLength(1);
  });
});

describe("cuarentena", () => {
  it("registra identidad no confirmada, estado desconocido y multi-proyecto", async () => {
    const reader = await fixtureReader({
      projects: [
        projectPage({ id: "proj-1", name: "Cliente Alfa" }),
        projectPage({ id: "proj-2", name: "Cliente Beta" }),
      ],
      tasks: [
        taskPage({
          id: "task-1",
          title: "Rara",
          estado: "Estado inventado",
          priority: "CRITICO",
          people: [{ id: "user-desconocido", email: "nadie@example.test" }],
          projectIds: ["proj-1", "proj-2"],
        }),
      ],
    });
    const report = await importNotionSnapshot({ db, reader });

    const reasons = report.quarantine.by_reason;
    expect(reasons.estado_desconocido).toBe(1);
    expect(reasons.prioridad_desconocida).toBe(1);
    expect(reasons.tarea_con_varios_proyectos).toBe(1);
    expect(reasons.identidad_no_confirmada_por_correo).toBe(1);

    const rows = listNotionQuarantine(db, {});
    expect(rows.length).toBe(report.quarantine.total);
    expect(rows.every((row) => row.resolutionState === "open")).toBe(true);
    // La tarea existe igualmente, con el estado por defecto y sin responsable inventado.
    const task = listTasks(db)[0]!;
    expect(task.status).toBe("BACKLOG");
    expect(listTaskAssignees(db, task.id)).toHaveLength(0);
    expect(listNotionMigrationRuns(db)[0]?.status).toBe("completed_with_exceptions");
  });

  it("dos responsables sin resolver en la MISMA tarea son dos filas, no una", async () => {
    const reader = await fixtureReader({
      projects: [projectPage({ id: "proj-1", name: "Cliente Alfa" })],
      tasks: [
        taskPage({
          id: "task-1",
          title: "T",
          people: [
            { id: "user-a", email: "a@example.test" },
            { id: "user-b", email: "b@example.test" },
          ],
          projectIds: ["proj-1"],
        }),
      ],
    });
    const report = await importNotionSnapshot({ db, reader });
    expect(report.quarantine.by_reason.identidad_no_confirmada_por_correo).toBe(2);
    const rows = listNotionQuarantine(db, { sourceKind: "identity" });
    expect(rows).toHaveLength(2);
    // El informe y las filas coinciden: nada se colapsa por la clave única.
    expect(rows.map((row) => row.rawReference).sort()).toEqual(["user-a", "user-b"]);
  });

  it("una identidad sin correo queda sin resolver y anotada en el mapa", async () => {
    const reader = await fixtureReader({
      projects: [projectPage({ id: "proj-1", name: "Cliente Alfa" })],
      tasks: [
        taskPage({
          id: "task-1",
          title: "T",
          people: [{ id: "user-sin-correo", name: "Ernesto", email: null }],
          projectIds: ["proj-1"],
        }),
      ],
    });
    await importNotionSnapshot({ db, reader });
    const mappings = listNotionIdentityMappings(db);
    expect(mappings).toHaveLength(1);
    expect(mappings[0]?.matchMethod).toBe("unresolved");
    expect(mappings[0]?.validationState).toBe("pending_review");
    expect(mappings[0]?.agentosPersonId).toBeNull();
  });

  it("acepta la decisión explícita del administrador como método de emparejado", async () => {
    // El caso real: la persona existe en AgentOS pero sin correo registrado.
    const person = createPerson(db, {
      orgId: organizationId,
      fullName: "Jorge",
      isInternal: true,
    });
    const reader = await fixtureReader({
      projects: [projectPage({ id: "proj-1", name: "Cliente Alfa" })],
      tasks: [
        taskPage({
          id: "task-1",
          title: "T",
          people: [{ id: "user-jorge", email: "jorge@example.test" }],
          projectIds: ["proj-1"],
        }),
      ],
    });
    const report = await importNotionSnapshot({
      db,
      reader,
      adminDecisions: new Map([["user-jorge", person.id]]),
    });
    expect(report.identities.admin_decision).toBe(1);
    expect(report.identities.assignments_written).toBe(1);
    expect(listNotionIdentityMappings(db)[0]?.matchMethod).toBe("admin_decision");
  });
});

describe("segunda pasada de relaciones", () => {
  it("resuelve depends_on solo cuando ambos extremos están importados", async () => {
    const reader = await fixtureReader({
      projects: [projectPage({ id: "proj-1", name: "Cliente Alfa" })],
      tasks: [
        taskPage({ id: "task-1", title: "Base", projectIds: ["proj-1"] }),
        taskPage({ id: "task-2", title: "Dependiente", projectIds: ["proj-1"], blockedByIds: ["task-1"] }),
      ],
    });
    await importNotionSnapshot({ db, reader });
    const base = listTasks(db).find((task) => task.title === "Base")!;
    const dependiente = listTasks(db).find((task) => task.title === "Dependiente")!;
    expect(dependiente.dependsOn).toEqual([base.id]);
    expect(base.dependsOn).toEqual([]);
  });

  it("una dependencia fuera del lote va a cuarentena y no se inventa un id", async () => {
    const reader = await fixtureReader({
      projects: [projectPage({ id: "proj-1", name: "Cliente Alfa" })],
      tasks: [
        taskPage({ id: "task-2", title: "Dependiente", projectIds: ["proj-1"], blockedByIds: ["task-fuera"] }),
      ],
    });
    const report = await importNotionSnapshot({ db, reader });
    expect(report.quarantine.by_reason.dependencia_fuera_del_lote).toBe(1);
    expect(listTasks(db)[0]?.dependsOn).toEqual([]);
  });

  it("reejecutar no vuelve a escribir la misma arista", async () => {
    const fixture = {
      projects: [projectPage({ id: "proj-1", name: "Cliente Alfa" })],
      tasks: [
        taskPage({ id: "task-1", title: "Base", projectIds: ["proj-1"] }),
        taskPage({ id: "task-2", title: "Dependiente", projectIds: ["proj-1"], blockedByIds: ["task-1"] }),
      ],
    };
    await importNotionSnapshot({ db, reader: await fixtureReader(fixture) });
    const before = listTasks(db).find((task) => task.title === "Dependiente")!;
    await importNotionSnapshot({ db, reader: await fixtureReader(fixture) });
    const after = listTasks(db).find((task) => task.title === "Dependiente")!;
    expect(after.dependsOn).toEqual(before.dependsOn);
    expect(after.id).toBe(before.id);
  });
});

describe("piloto", () => {
  it("--pilot limita el lote por cobertura y deja constancia del resto", async () => {
    const reader = await fixtureReader({
      projects: [
        projectPage({ id: "proj-1", name: "Alfa" }),
        projectPage({ id: "proj-2", name: "Beta" }),
      ],
      tasks: [
        taskPage({ id: "task-1", title: "Uno", projectIds: ["proj-1"] }),
        taskPage({ id: "task-2", title: "Dos", projectIds: ["proj-2"] }),
        taskPage({ id: "task-3", title: "Tres", projectIds: ["proj-1"] }),
      ],
    });
    const report = await importNotionSnapshot({ db, reader, pilot: { tasks: 2, projects: 1 } });
    expect(report.mode).toBe("pilot");
    expect(report.source_counts).toEqual({ projects: 2, tasks: 3 });
    expect(report.selected_counts).toEqual({ projects: 1, tasks: 2 });
    expect(listTasks(db)).toHaveLength(2);
    // `task-2` apuntaba a un proyecto fuera del piloto: bandeja + excepción.
    expect(report.quarantine.by_reason.proyecto_no_importado_en_este_lote).toBe(1);
    expect(report.relations.inbox_tasks).toBe(1);
  });
});

describe("archivo histórico", () => {
  it("guarda el origen íntegro y lo expone por el enlace de linaje", async () => {
    const reader = await fixtureReader(baseFixture());
    await importNotionSnapshot({ db, reader });
    const task = listTasks(db).find((item) => item.title === "Primera")!;
    const origin = getNotionOrigin(db, "task", task.id)!;

    expect(origin.link.notionPageId).toBe("task-1");
    expect(origin.archive?.originalUrl).toBe("https://notion.example/task-1");
    expect(origin.archive?.rawPageUri).toBe("tasks/pages/task-1.page.json");
    const payload = origin.archive?.payload as { page: { properties: Record<string, unknown> } };
    // Los campos sin columna nativa siguen enteros en el archivo.
    expect(payload.page.properties["Tags"]).toBeDefined();
    expect(payload.page.properties["HH estimadas"]).toBeDefined();
    expect(origin.archive?.payloadHash).toMatch(/^[0-9a-f]{64}$/u);

    const project = getProject(db, task.projectId)!;
    expect(getNotionOrigin(db, "project", project.id)?.link.notionPageId).toBe("proj-1");
    expect(getTask(db, task.id)?.title).toBe("Primera");
  });
});
