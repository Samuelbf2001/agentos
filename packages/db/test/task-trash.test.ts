/**
 * Papelera de tareas (borrado suave + purga) contra LOS DOS motores, siempre
 * por la fachada dual (`@agentos/db`): es el contrato que consumen api, core y
 * mcp-admin. La suite Postgres se auto-omite sin `AGENTOS_PG_URL`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { emptyCanvasScene, isAgentosError, ErrorCodes } from "@agentos/shared";
import {
  addTaskLabels,
  appendTaskEvent,
  attachArtifact,
  boardTasks,
  claimTask,
  countOpenTasksByAgent,
  createAgent,
  createApproval,
  createCanvasNote,
  createNotionMigrationRun,
  createOrganization,
  createPerson,
  createProject,
  upsertProviderProfile,
  createRun,
  createTask,
  createTaskNotificationLog,
  domainCounts,
  findNotionImportLink,
  getApproval,
  getCanvasNote,
  getRun,
  getTask,
  listDeletedTasks,
  listDispatchableTasks,
  listLabelCatalog,
  listPendingTaskNotifications,
  listTaskEvents,
  listTasks,
  listTasksWithAssignees,
  purgeDeletedTasks,
  queryAudit,
  restoreTask,
  searchTasks,
  softDeleteTask,
  transitionTaskStatus,
  updateTask,
  upsertNotionImportLink,
  type AgentosDb,
} from "../src/index.js";
import { openDb, type AgentosSqliteDb } from "../src/client.js";
import { runMigrations } from "../src/migrate.js";
import { closePgDb, openPgDb, type AgentosPgDb } from "../src/pg/client-pg.js";
import { runPgMigrations } from "../src/pg/migrate-pg.js";
import { PG_TABLE_ORDER } from "../src/pg/schema-pg.js";

const PG_URL = process.env.AGENTOS_PG_URL;
const DAY = 86_400_000;
const NINETY_DAYS = 90 * DAY;

interface Engine {
  name: string;
  skip: boolean;
  open(): Promise<AgentosDb>;
  reset(db: AgentosDb): Promise<AgentosDb>;
  close(db: AgentosDb): Promise<void>;
}

const engines: Engine[] = [
  {
    name: "SQLite",
    skip: false,
    async open() {
      const db = openDb(":memory:");
      runMigrations(db);
      return db;
    },
    async reset(db) {
      (db as AgentosSqliteDb).$client.close();
      const fresh = openDb(":memory:");
      runMigrations(fresh);
      return fresh;
    },
    async close(db) {
      (db as AgentosSqliteDb).$client.close();
    },
  },
  {
    name: "Postgres",
    skip: !PG_URL,
    async open() {
      const db = openPgDb(PG_URL);
      await runPgMigrations(db, { enableVector: false });
      return db;
    },
    async reset(db) {
      await (db as AgentosPgDb).execute(
        sql.raw(`TRUNCATE TABLE ${PG_TABLE_ORDER.map((t) => `"${t}"`).join(", ")} CASCADE`),
      );
      return db;
    },
    async close(db) {
      await closePgDb(db as AgentosPgDb);
    },
  },
];

async function expectCode(promise: Promise<unknown>, code: string, reason?: string): Promise<void> {
  try {
    await promise;
  } catch (err) {
    expect(isAgentosError(err), String(err)).toBe(true);
    expect((err as { code: string }).code).toBe(code);
    if (reason) expect((err as { details?: { reason?: string } }).details?.reason).toBe(reason);
    return;
  }
  throw new Error(`se esperaba ${code}`);
}

for (const engine of engines) {
  describe.skipIf(engine.skip)(`papelera de tareas — ${engine.name}`, () => {
    let db: AgentosDb;
    let projectId: string;
    let orgId: string;
    let personId: string;
    let agentId: string;

    beforeAll(async () => {
      db = await engine.open();
    }, 180_000);

    afterAll(async () => {
      if (db) await engine.close(db);
    });

    beforeEach(async () => {
      db = await engine.reset(db);
      const org = await createOrganization(db, { name: "Org papelera", kind: "client" });
      orgId = org.id;
      const project = await createProject(db, {
        orgId: org.id,
        name: "Proyecto papelera",
        type: "assessment",
        stage: "ENTENDER",
      });
      projectId = project.id;
      const person = await createPerson(db, { orgId: org.id, fullName: "Ana Papelera", email: "ana@example.com" });
      personId = person.id;
      const provider = await upsertProviderProfile(db, { slug: "p", name: "P", kind: "anthropic_api" });
      const agent = await createAgent(db, {
        slug: "tester",
        name: "Tester",
        layer: "meta",
        runtime: "ai_sdk",
        providerProfileId: provider.id,
        model: "test-1",
        toolsAllowlist: [],
        mcpAllowlist: [],
      });
      agentId = agent.id;
    });

    async function makeTask(patch: Record<string, unknown> = {}) {
      return await createTask(db, {
        projectId,
        title: "Tarea papelera",
        stage: "ENTENDER",
        status: "BACKLOG",
        priority: "normal",
        orderKey: "m",
        ...patch,
      } as Parameters<typeof createTask>[1]);
    }

    it("desactiva conservando el estado, en cascada con el MISMO deleted_at, y restaura tal cual", async () => {
      const parent = await makeTask({ title: "Madre", status: "READY" });
      const child = await makeTask({ title: "Hija", parentTaskId: parent.id });
      const grandChild = await makeTask({ title: "Nieta", parentTaskId: child.id });

      const { task, subtaskIds } = await softDeleteTask(db, parent.id, {
        actor: `person:${personId}`,
        expectedVersion: parent.version,
        now: 1_000_000,
      });
      expect(task.deletedAt).toBe(1_000_000);
      expect(task.deletedBy).toBe(personId);
      expect(task.status).toBe("READY");
      expect(task.version).toBe(parent.version + 1);
      expect(new Set(subtaskIds)).toEqual(new Set([child.id, grandChild.id]));
      expect((await getTask(db, grandChild.id))!.deletedAt).toBe(1_000_000);

      const audit = await queryAudit(db, { entityId: parent.id, action: "task.deleted" });
      expect(audit).toHaveLength(1);

      const restored = await restoreTask(db, parent.id, { actor: `person:${personId}` });
      expect(restored.task.deletedAt).toBeNull();
      expect(restored.task.deletedBy).toBeNull();
      expect(restored.task.status).toBe("READY");
      expect((await getTask(db, grandChild.id))!.deletedAt).toBeNull();
      expect(await queryAudit(db, { entityId: parent.id, action: "task.restored" })).toHaveLength(1);
      expect((await listTaskEvents(db, parent.id)).map((e) => e.kind)).toEqual(
        expect.arrayContaining(["deleted", "restored"]),
      );
    });

    it("restaurar la madre NO resucita una subtarea desactivada antes por separado", async () => {
      const parent = await makeTask({ title: "Madre" });
      const child = await makeTask({ title: "Hija", parentTaskId: parent.id });
      await softDeleteTask(db, child.id, { actor: "person:x", expectedVersion: child.version, now: 100 });
      const p = (await getTask(db, parent.id))!;
      await softDeleteTask(db, parent.id, { actor: "person:x", expectedVersion: p.version, now: 200 });
      await restoreTask(db, parent.id, { actor: "person:x" });
      expect((await getTask(db, child.id))!.deletedAt).toBe(100);
    });

    it("conflictos: versión vieja, ya desactivada, en ejecución y modificar una desactivada", async () => {
      const t = await makeTask();
      await expectCode(
        softDeleteTask(db, t.id, { actor: "person:x", expectedVersion: t.version + 5 }),
        ErrorCodes.VERSION_CONFLICT,
      );

      // Claim vigente (lease) → no se desactiva.
      const running = await makeTask({ status: "READY", assigneeAgentId: agentId });
      const claimed = await claimTask(db, { taskId: running.id, agentId: "tester", leaseMs: 60_000 });
      expect(claimed.claimed).toBe(true);
      await expectCode(
        softDeleteTask(db, running.id, { actor: "person:x", expectedVersion: claimed.task!.version }),
        ErrorCodes.CONFLICT,
        "task_running",
      );

      // Run en curso de una SUBTAREA → tampoco se desactiva la madre.
      const parent = await makeTask({ title: "Madre con hija corriendo" });
      const child = await makeTask({ parentTaskId: parent.id });
      await createRun(db, { taskId: child.id, trigger: "dispatcher", runtime: "ai_sdk", status: "running" });
      await expectCode(
        softDeleteTask(db, parent.id, { actor: "person:x", expectedVersion: parent.version }),
        ErrorCodes.CONFLICT,
        "task_running",
      );

      const deleted = await softDeleteTask(db, t.id, { actor: "person:x", expectedVersion: t.version });
      await expectCode(
        softDeleteTask(db, t.id, { actor: "person:x", expectedVersion: deleted.task.version }),
        ErrorCodes.CONFLICT,
        "task_already_deleted",
      );
      await expectCode(
        updateTask(db, t.id, { title: "no" }, deleted.task.version),
        ErrorCodes.CONFLICT,
        "task_deleted",
      );
      expect(
        await transitionTaskStatus(db, {
          taskId: t.id,
          from: "BACKLOG",
          to: "READY",
          expectedVersion: deleted.task.version,
        }),
      ).toBe(false);
      await expectCode(restoreTask(db, running.id, { actor: "person:x" }), ErrorCodes.CONFLICT, "task_not_deleted");
    });

    it("una desactivada no aparece en listados, tablero, búsqueda, etiquetas, conteos, avisos ni despachador", async () => {
      const visible = await makeTask({ title: "Visible cebolla", status: "READY", assigneeAgentId: agentId });
      const hidden = await makeTask({
        title: "Oculta cebolla",
        status: "READY",
        assigneeAgentId: agentId,
        assigneePersonIds: [personId],
      });
      await addTaskLabels(db, hidden.id, ["solo-oculta"], "person:x");
      await appendTaskEvent(db, { taskId: hidden.id, kind: "comment", actor: "person:x", payload: { body: "zanahoria" } });
      await createTaskNotificationLog(db, { taskId: hidden.id, personId, kind: "assignment", scheduledAt: 1 });
      await softDeleteTask(db, hidden.id, { actor: "person:x", expectedVersion: hidden.version });

      const ids = (rows: { id: string }[]) => rows.map((r) => r.id);
      expect(ids(await listTasks(db))).toEqual([visible.id]);
      expect(ids(await listTasks(db, { projectId }))).toEqual([visible.id]);
      expect(ids(await listTasks(db, { includeDeleted: true })).sort()).toEqual([visible.id, hidden.id].sort());
      expect(ids(await boardTasks(db, projectId))).toEqual([visible.id]);
      expect(ids(await listTasksWithAssignees(db, { personId }))).toEqual([]);
      expect(ids(await searchTasks(db, "cebolla"))).toEqual([visible.id]);
      expect(ids(await searchTasks(db, "zanahoria"))).toEqual([]);
      expect((await listLabelCatalog(db)).map((l) => l.label)).not.toContain("solo-oculta");
      expect((await listLabelCatalog(db, { projectId })).map((l) => l.label)).not.toContain("solo-oculta");
      expect((await domainCounts(db)).tasks).toBe(1);
      expect(await listPendingTaskNotifications(db, Date.now())).toEqual([]);
      expect(ids(await listDispatchableTasks(db, Date.now(), 10))).toEqual([visible.id]);
      expect((await countOpenTasksByAgent(db)).get(agentId)).toBe(1);
      expect((await claimTask(db, { taskId: hidden.id, agentId: "tester" })).claimed).toBe(false);

      // getTask por id sigue devolviéndola (ficha y restaurar).
      expect((await getTask(db, hidden.id))!.deletedAt).not.toBeNull();
    });

    it("listDeletedTasks filtra por proyecto, cliente y texto, ordenada por deleted_at desc", async () => {
      const otherOrg = await createOrganization(db, { name: "Otra org", kind: "client" });
      const otherProject = await createProject(db, {
        orgId: otherOrg.id,
        name: "Otro",
        type: "assessment",
        stage: "ENTENDER",
      });
      const a = await makeTask({ title: "Informe Alfa" });
      const b = await makeTask({ title: "Informe beta" });
      const c = await makeTask({ title: "Gamma", projectId: otherProject.id });
      await softDeleteTask(db, a.id, { actor: "person:x", expectedVersion: a.version, now: 10 });
      await softDeleteTask(db, b.id, { actor: "person:x", expectedVersion: b.version, now: 30 });
      await softDeleteTask(db, c.id, { actor: "person:x", expectedVersion: c.version, now: 20 });

      expect((await listDeletedTasks(db)).map((t) => t.id)).toEqual([b.id, c.id, a.id]);
      expect((await listDeletedTasks(db, { projectId })).map((t) => t.id)).toEqual([b.id, a.id]);
      expect((await listDeletedTasks(db, { orgId: otherOrg.id })).map((t) => t.id)).toEqual([c.id]);
      expect((await listDeletedTasks(db, { orgId, q: "INFORME" })).map((t) => t.id)).toEqual([b.id, a.id]);
    });

    it("purga definitiva: resuelve cada FK, marca el enlace de Notion y audita sin contenido", async () => {
      const now = 1_800_000_000_000;
      const old = await makeTask({
        title: "Vieja con TODO colgando",
        description: "![foto](/api/uploads/0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee) y ![compartida](/api/uploads/0190aaaa-bbbb-7ccc-8ddd-ffffffffffff)",
        assigneePersonIds: [personId],
      });
      const child = await makeTask({ title: "Hija restaurada", parentTaskId: old.id });
      const dependent = await makeTask({ title: "Depende de la vieja", dependsOn: [old.id] });
      const recent = await makeTask({ title: "Recién desactivada", description: "/api/uploads/0190aaaa-bbbb-7ccc-8ddd-ffffffffffff" });

      await addTaskLabels(db, old.id, ["purga"], "person:x");
      await appendTaskEvent(db, { taskId: old.id, kind: "comment", actor: "person:x", payload: { body: "secreto" } });
      await createTaskNotificationLog(db, { taskId: old.id, personId, kind: "assignment", scheduledAt: 1 });
      const run = await createRun(db, { taskId: old.id, trigger: "dispatcher", runtime: "ai_sdk", status: "succeeded" });
      const approval = await createApproval(db, { kind: "tool_call", taskId: old.id, payload: { a: 1 } });
      const fileArtifact = await attachArtifact(db, {
        taskId: old.id,
        kind: "file",
        title: "adjunto",
        path: "p/t/a/adjunto.pdf",
        meta: { storage: "artifacts_root" },
      });
      const noteArtifact = await attachArtifact(db, {
        taskId: old.id,
        kind: "file",
        title: "imagen de nota",
        path: "p/t/a/nota.png",
        meta: { storage: "artifacts_root" },
      });
      const note = await createCanvasNote(db, {
        projectId,
        title: "Nota",
        scene: emptyCanvasScene(),
        imageArtifactId: noteArtifact.id,
        imagePath: "p/t/a/nota.png",
      });
      const migrationRun = await createNotionMigrationRun(db, {
        sourceSchemaVersion: "v",
        capturedAt: 1,
        manifestHash: "h",
        snapshotRunId: "s",
        mode: "full",
        status: "completed",
        immutable: true,
      });
      await upsertNotionImportLink(db, {
        migrationRunId: migrationRun.id,
        sourceKind: "task",
        notionPageId: "page-vieja",
        agentosObjectKind: "task",
        agentosObjectId: old.id,
        importStatus: "imported",
      });

      const oldNow = (await getTask(db, old.id))!;
      await softDeleteTask(db, old.id, { actor: "person:x", expectedVersion: oldNow.version, now: now - 91 * DAY });
      await restoreTask(db, child.id, { actor: "person:x" }).catch(() => undefined);
      // La hija se desactivó en cascada: se restaura sola (sigue viva tras la purga).
      expect((await getTask(db, child.id))!.deletedAt).toBeNull();
      await softDeleteTask(db, recent.id, { actor: "person:x", expectedVersion: recent.version, now: now - 10 * DAY });

      const result = await purgeDeletedTasks(db, { olderThanMs: NINETY_DAYS, now });
      expect(result.purged).toBe(1);
      expect(result.taskIds).toEqual([old.id]);
      expect(result.artifactFiles.map((f) => f.artifactId)).toEqual([fileArtifact.id]);
      // La compartida sigue citada por una tarea viva (aunque esté en la papelera).
      expect(result.uploadIds).toEqual(["0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee"]);

      expect(await getTask(db, old.id)).toBeUndefined();
      expect((await getTask(db, recent.id))!.deletedAt).not.toBeNull();
      expect((await getTask(db, child.id))!.parentTaskId).toBeNull();
      const dep = (await getTask(db, dependent.id))!;
      expect(dep.dependsOn).toEqual([]);
      expect(dep.version).toBe(dependent.version + 1);
      expect((await getRun(db, run.id))!.taskId).toBeNull();
      expect((await getApproval(db, approval.id))!.taskId).toBeNull();
      expect((await getCanvasNote(db, note.id))!.imageArtifactId).toBeNull();
      expect((await findNotionImportLink(db, "task", "page-vieja"))!.importStatus).toBe("deleted_in_agentos");

      const [purgeAudit] = await queryAudit(db, { action: "task.purged" });
      expect(purgeAudit!.after).toEqual({ count: 1, taskIds: [old.id], cutoff: now - NINETY_DAYS });
      expect(JSON.stringify(purgeAudit)).not.toContain("Vieja con TODO");

      // Idempotente: nada más que purgar.
      expect((await purgeDeletedTasks(db, { olderThanMs: NINETY_DAYS, now })).purged).toBe(0);
    });
  });
}

describe("migración 0014 frente al orden de merge con feat/organigrama-vivo (SQLite)", () => {
  it("las columnas existen aunque una migración con `when` posterior se aplicara antes", () => {
    const folder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "drizzle");
    const db = openDb(":memory:");
    const all = readMigrationFiles({ migrationsFolder: folder });
    const prior = all.filter((m) => m.folderMillis <= 1788300000000);
    db.$client.exec(
      `CREATE TABLE IF NOT EXISTS __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)`,
    );
    const insert = db.$client.prepare(`INSERT INTO __drizzle_migrations ("hash", "created_at") VALUES (?, ?)`);
    for (const m of prior) {
      for (const stmt of m.sql) db.$client.exec(stmt);
      insert.run(m.hash, m.folderMillis);
    }
    // Simula 0013_conexiones de la otra rama ya aplicada (when 1788420000000).
    insert.run("organigrama-vivo-0013", 1788420000000);
    runMigrations(db);
    const cols = (db.$client.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(["deleted_at", "deleted_by"]));
    const idx = db.$client.prepare("PRAGMA index_list(tasks)").all() as { name: string }[];
    expect(idx.map((i) => i.name)).toContain("idx_tasks_deleted_at");
    db.$client.close();
  });
});
