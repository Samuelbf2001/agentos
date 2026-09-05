/**
 * El importador de Notion contra el motor **Postgres**, por la fachada dual de
 * `@agentos/db`: mismo `importNotionSnapshot`, mismo snapshot en disco, otra
 * base debajo. Es la prueba de que la migración de Notion no quedó atada a
 * SQLite (la escritura por tarea va dentro de `withTransaction`, que en PG es
 * una transacción de verdad).
 *
 * **Se auto-omite si no hay `AGENTOS_PG_URL`** — igual que el resto de la
 * suite PG, para que `pnpm -r test` siga verde sin Docker.
 *
 * Crea su PROPIA base (`<base>_notion_import`) y la recrea en cada corrida: la
 * suite PG de `packages/db` trunca la base principal y ambos paquetes corren a
 * la vez en `pnpm -r test`; compartirla sería pisarse.
 */
import { rm } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  applyMigrations,
  closeAnyDb,
  createOrganization,
  createPerson,
  getNotionOrigin,
  listNotionIdentityMappings,
  listNotionMigrationRuns,
  listNotionQuarantine,
  listProjects,
  listTaskAssignees,
  listTaskEvents,
  listTasks,
  openConfiguredDb,
  type AgentosDb,
} from "@agentos/db";
import { importNotionSnapshot } from "../src/importer.js";
import { SnapshotReader } from "../src/snapshot-reader.js";
import { projectPage, taskPage, writeSnapshotFixture } from "./fixtures.js";

const PG_URL = process.env.AGENTOS_PG_URL;
const describePg = describe.skipIf(!PG_URL);

/** `postgres://…/agentos` → `postgres://…/agentos_notion_import`. */
function withDatabase(url: string, name: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  return parsed.toString();
}

const TEST_DB = "agentos_notion_import";

describePg("importador de Notion sobre Postgres", () => {
  let db: AgentosDb;
  const temporary: string[] = [];

  beforeAll(async () => {
    // Base desechable propia, recreada desde cero: aislada de la suite PG de
    // `packages/db`, que trunca la base principal en paralelo.
    const { closePgDb, openPgDb } = await import("@agentos/db/pg");
    const admin = openPgDb(PG_URL!, { max: 1 });
    try {
      await admin.$client.unsafe(`DROP DATABASE IF EXISTS "${TEST_DB}" WITH (FORCE)`);
      await admin.$client.unsafe(`CREATE DATABASE "${TEST_DB}"`);
    } finally {
      await closePgDb(admin);
    }
    db = await openConfiguredDb({ driver: "postgres", pgUrl: withDatabase(PG_URL!, TEST_DB) });
    await applyMigrations(db);
  }, 180_000);

  afterAll(async () => {
    if (db) await closeAnyDb(db);
  });

  beforeEach(async () => {
    const { PG_TABLE_ORDER } = await import("@agentos/db/pg");
    const client = (db as unknown as { $client: { unsafe(q: string): Promise<unknown> } }).$client;
    await client.unsafe(`TRUNCATE TABLE ${PG_TABLE_ORDER.map((t) => `"${t}"`).join(", ")} CASCADE`);
    const org = await createOrganization(db, { name: "Sixteam", kind: "internal" });
    await createPerson(db, {
      orgId: org.id,
      fullName: "Ernesto",
      email: "ernesto@sixteam.pro",
      isInternal: true,
    });
  });

  afterEach(async () => {
    await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function fixtureReader(
    options: Parameters<typeof writeSnapshotFixture>[0],
  ): Promise<SnapshotReader> {
    const fixture = await writeSnapshotFixture(options);
    temporary.push(path.dirname(fixture.root));
    return new SnapshotReader(fixture.root);
  }

  function baseFixture(lastEditedTime?: string) {
    return {
      projects: [
        projectPage({ id: "proj-1", name: "Cliente Alfa", fase: "Implementacion", lastEditedTime }),
      ],
      tasks: [
        taskPage({
          id: "task-1",
          title: "Primera",
          estado: "Realizando",
          priority: "ALTO",
          due: { start: "2026-09-05" },
          people: [{ id: "user-ernesto", email: "ernesto@sixteam.pro" }],
          projectIds: ["proj-1"],
          lastEditedTime,
        }),
        taskPage({
          id: "task-2",
          title: "Segunda",
          estado: "Sin empezar",
          projectIds: ["proj-1"],
          blockedByIds: ["task-1"],
          lastEditedTime,
        }),
      ],
    };
  }

  it("importa entidades, relaciones, responsables y linaje en una sola corrida", async () => {
    const report = await importNotionSnapshot({ db, reader: await fixtureReader(baseFixture()) });

    expect(report.imported.projects_created).toBe(1);
    expect(report.imported.tasks_created).toBe(2);
    expect(report.relations.task_project_links).toBe(2);
    expect(report.relations.depends_on_edges).toBe(1);
    expect(report.identities.confirmed_email).toBe(1);
    expect(report.identities.assignments_written).toBe(1);
    expect(report.destination_counts).toEqual({ projects: 1, tasks: 2 });

    const project = (await listProjects(db)).find((item) => item.name === "Cliente Alfa");
    expect(project).toBeDefined();
    expect(project!.type).toBe("ops");
    expect(project!.stage).toBe("OPERAR");

    const tasks = await listTasks(db, { projectId: project!.id });
    expect(tasks).toHaveLength(2);
    const primera = tasks.find((task) => task.title === "Primera")!;
    expect(primera.status).toBe("IN_PROGRESS");
    expect(primera.priority).toBe("high");
    expect(primera.dueAt).toBe(Date.parse("2026-09-05"));
    expect(await listTaskAssignees(db, primera.id)).toHaveLength(1);
    // B3: toda tarea importada deja constancia en su línea de tiempo.
    expect((await listTaskEvents(db, primera.id)).some((e) => e.kind === "imported")).toBe(true);

    const runs = await listNotionMigrationRuns(db);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.manifestHash).toBe("hash-de-prueba");
    expect(runs[0]!.status).toBe("completed");

    // El linaje se lee igual que en SQLite: enlace + archivo íntegro.
    const origen = (await getNotionOrigin(db, "task", primera.id))!;
    expect(origen.link.notionPageId).toBe("task-1");
    expect(origen.archive?.payloadHash).toHaveLength(64);
  });

  it("dos corridas seguidas dan los mismos conteos: nada se duplica (idempotencia)", async () => {
    const first = await importNotionSnapshot({ db, reader: await fixtureReader(baseFixture()) });
    const projectsAfterFirst = (await listProjects(db)).length;
    const tasksAfterFirst = (await listTasks(db)).length;

    const second = await importNotionSnapshot({
      db,
      reader: await fixtureReader(baseFixture("2026-02-03T00:00:00.000Z")),
    });

    expect(await listProjects(db)).toHaveLength(projectsAfterFirst);
    expect(await listTasks(db)).toHaveLength(tasksAfterFirst);
    expect(second.destination_counts).toEqual(first.destination_counts);
    expect(second.imported.projects_created).toBe(0);
    expect(second.imported.tasks_created).toBe(0);
  });

  it("una identidad que no resuelve va a cuarentena y la tarea se importa igual", async () => {
    const report = await importNotionSnapshot({
      db,
      reader: await fixtureReader({
        projects: [projectPage({ id: "proj-1", name: "Cliente Alfa" })],
        tasks: [
          taskPage({
            id: "task-1",
            title: "Sin responsable resoluble",
            people: [{ id: "user-desconocido", email: "nadie@ejemplo.test" }],
            projectIds: ["proj-1"],
          }),
        ],
      }),
    });

    expect(report.identities.unresolved).toBe(1);
    expect(report.imported.tasks_created).toBe(1);
    const cuarentena = await listNotionQuarantine(db, {});
    expect(cuarentena.length).toBeGreaterThan(0);
    expect(cuarentena.some((row) => row.sourceKind === "identity")).toBe(true);
    const mappings = await listNotionIdentityMappings(db);
    expect(mappings.some((row) => row.validationState === "pending_review")).toBe(true);
  });

  it("dry-run no escribe ni una fila en Postgres", async () => {
    const report = await importNotionSnapshot({
      db,
      reader: await fixtureReader(baseFixture()),
      dryRun: true,
    });
    expect(report.mode).toBe("dry_run");
    expect(report.imported.tasks_created).toBe(2);
    expect(await listNotionMigrationRuns(db)).toHaveLength(0);
    expect(await listTasks(db)).toHaveLength(0);
    expect(await listProjects(db)).toHaveLength(0);
  });
});
