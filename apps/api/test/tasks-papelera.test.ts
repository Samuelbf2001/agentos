/**
 * Papelera de tareas — contrato REST que consume apps/web:
 * DELETE /api/tasks/:id (borrado suave), POST /api/tasks/:id/restore,
 * GET /api/tasks/deleted, campos `deleted_at`/`deleted_by`/`purge_at` en toda
 * respuesta de tarea, eventos del tablero y el reloj de purga (sin arrancar
 * temporizadores: reloj inyectado + `runOnce`).
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  claimTask,
  createTask,
  getTask,
  listTasks,
  softDeleteTask,
} from "@agentos/db";
import { makeFixture, type TestFixture } from "./helpers.js";
import {
  DAY_MS,
  createTaskPurgeScheduler,
  resolveTaskPurgeDays,
  resolveTaskPurgeDisabled,
} from "../src/task-trash.js";

const NINETY_DAYS = 90 * DAY_MS;

describe("Tareas — papelera (borrado suave)", () => {
  const fixtures: TestFixture[] = [];

  afterEach(async () => {
    for (const fixture of fixtures.splice(0)) await fixture.close();
  });

  async function fx(): Promise<TestFixture> {
    const fixture = await makeFixture();
    fixtures.push(fixture);
    return fixture;
  }

  async function seed(fixture: TestFixture, title: string, patch: Record<string, unknown> = {}) {
    return await createTask(fixture.db, {
      projectId: fixture.project.id,
      title,
      stage: "ENTENDER",
      orderKey: `k-${title}`,
      assigneePersonIds: [fixture.person.id],
      ...patch,
    } as Parameters<typeof createTask>[1]);
  }

  it("DELETE desactiva (200 con deleted_at, deleted_by, purge_at) y la tarea desaparece de todas las lecturas", async () => {
    const fixture = await fx();
    const keep = await seed(fixture, "Visible pimienta");
    const gone = await seed(fixture, "Borrable pimienta");
    const { app } = fixture.api;
    const h = fixture.authHeaders;

    // Una tarea activa ya expone los campos de papelera en null.
    const active = await app.inject({ method: "GET", url: `/api/tasks/${keep.id}`, headers: h });
    expect(active.json().task).toMatchObject({ deleted_at: null, deleted_by: null, purge_at: null });

    const del = await app.inject({
      method: "DELETE",
      url: `/api/tasks/${gone.id}`,
      headers: h,
      payload: { expected_version: gone.version },
    });
    expect(del.statusCode, del.body).toBe(200);
    const deleted = del.json().task as { deleted_at: number; deleted_by: string; purge_at: number; status: string };
    expect(typeof deleted.deleted_at).toBe("number");
    expect(deleted.deleted_by).toBe(fixture.person.id);
    expect(deleted.purge_at).toBe(deleted.deleted_at + NINETY_DAYS);
    expect(deleted.status).toBe("BACKLOG");

    const ids = (rows: { id: string }[]) => rows.map((r) => r.id);
    const list = await app.inject({ method: "GET", url: "/api/tasks", headers: h });
    expect(ids(list.json().tasks)).toEqual([keep.id]);
    const mine = await app.inject({ method: "GET", url: "/api/tasks?mine=1", headers: h });
    expect(ids(mine.json().tasks)).toEqual([keep.id]);
    const board = await app.inject({ method: "GET", url: `/api/board/${fixture.project.id}`, headers: h });
    expect(board.json().total).toBe(1);
    const search = await app.inject({ method: "GET", url: "/api/tasks/search?q=pimienta", headers: h });
    expect(ids(search.json().hits)).toEqual([keep.id]);
    const health = await app.inject({ method: "GET", url: "/api/health" });
    expect(health.json().counts.tasks).toBe(1);

    // La ficha sigue abriendo (para poder restaurar), con deleted_at.
    const card = await app.inject({ method: "GET", url: `/api/tasks/${gone.id}`, headers: h });
    expect(card.statusCode).toBe(200);
    expect(card.json().task.deleted_at).toBe(deleted.deleted_at);

    // Eventos del tablero: el cambio de ficha de siempre + uno explícito.
    const events = await fixture.api.ctx.bus.getSince(`board:${fixture.project.id}`, 0);
    const types = events.map((e) => e.type);
    expect(types).toContain("task.updated");
    expect(types).toContain("task.deleted");

    // Solo lectura hasta restaurar: 409 conflict task_deleted.
    const patch = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${gone.id}`,
      headers: h,
      payload: { expected_version: (card.json().task as { version: number }).version, title: "no" },
    });
    expect(patch.statusCode).toBe(409);
    expect(patch.json().error.details.reason).toBe("task_deleted");
    const comment = await app.inject({
      method: "POST",
      url: `/api/tasks/${gone.id}/comment`,
      headers: h,
      payload: { body: "hola" },
    });
    expect(comment.statusCode).toBe(409);
    const move = await app.inject({
      method: "POST",
      url: `/api/tasks/${gone.id}/move`,
      headers: h,
      payload: { to: "CANCELLED", expected_version: (card.json().task as { version: number }).version },
    });
    expect(move.statusCode).toBe(409);
  });

  it("DELETE responde 409 con versión vieja o con la tarea en ejecución", async () => {
    const fixture = await fx();
    const { app } = fixture.api;
    const t = await seed(fixture, "Versión vieja");
    const stale = await app.inject({
      method: "DELETE",
      url: `/api/tasks/${t.id}`,
      headers: fixture.authHeaders,
      payload: { expected_version: t.version + 3 },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe("version_conflict");

    const running = await seed(fixture, "Corriendo", { status: "READY", assigneeAgentId: fixture.sam.id });
    const claim = await claimTask(fixture.db, { taskId: running.id, agentId: fixture.sam.slug });
    expect(claim.claimed).toBe(true);
    const busy = await app.inject({
      method: "DELETE",
      url: `/api/tasks/${running.id}`,
      headers: fixture.authHeaders,
      payload: { expected_version: claim.task!.version },
    });
    expect(busy.statusCode).toBe(409);
    expect(busy.json().error.details.reason).toBe("task_running");
    expect((await getTask(fixture.db, running.id))!.deletedAt).toBeNull();
  });

  it("DELETE sin sesión → 401", async () => {
    const fixture = await fx();
    const t = await seed(fixture, "Sin sesión");
    const res = await fixture.api.app.inject({
      method: "DELETE",
      url: `/api/tasks/${t.id}`,
      payload: { expected_version: t.version },
    });
    expect(res.statusCode).toBe(401);
    expect((await getTask(fixture.db, t.id))!.deletedAt).toBeNull();
  });

  it("GET /api/tasks/deleted lista por deleted_at desc con filtros y POST restore la devuelve tal cual", async () => {
    const fixture = await fx();
    const { app } = fixture.api;
    const h = fixture.authHeaders;
    const a = await seed(fixture, "Informe alfa", { status: "READY", definitionOfDone: "x" });
    const b = await seed(fixture, "Otra cosa");
    await softDeleteTask(fixture.db, a.id, { actor: `person:${fixture.person.id}`, expectedVersion: a.version, now: 1_000 });
    await softDeleteTask(fixture.db, b.id, { actor: `person:${fixture.person.id}`, expectedVersion: b.version, now: 2_000 });

    const all = await app.inject({ method: "GET", url: "/api/tasks/deleted", headers: h });
    expect(all.statusCode, all.body).toBe(200);
    const rows = all.json().tasks as {
      id: string;
      deleted_at: number;
      purge_at: number;
      deleted_by: string;
      deleted_by_name: string | null;
      project_name: string | null;
    }[];
    expect(rows.map((r) => r.id)).toEqual([b.id, a.id]);
    expect(rows[0]).toMatchObject({
      deleted_at: 2_000,
      purge_at: 2_000 + NINETY_DAYS,
      deleted_by: fixture.person.id,
      deleted_by_name: "Ernesto",
      project_name: fixture.project.name,
    });
    const byText = await app.inject({ method: "GET", url: "/api/tasks/deleted?q=informe", headers: h });
    expect(byText.json().tasks.map((r: { id: string }) => r.id)).toEqual([a.id]);
    const byProject = await app.inject({
      method: "GET",
      url: `/api/tasks/deleted?project_id=${fixture.project.id}&org_id=${fixture.org.id}`,
      headers: h,
    });
    expect(byProject.json().tasks).toHaveLength(2);
    const otherOrg = await app.inject({ method: "GET", url: "/api/tasks/deleted?org_id=nadie", headers: h });
    expect(otherOrg.json().tasks).toEqual([]);

    const restored = await app.inject({ method: "POST", url: `/api/tasks/${a.id}/restore`, headers: h });
    expect(restored.statusCode, restored.body).toBe(200);
    expect(restored.json().task).toMatchObject({ id: a.id, status: "READY", deleted_at: null, purge_at: null });
    expect((await listTasks(fixture.db)).map((t) => t.id)).toContain(a.id);
    const events = await fixture.api.ctx.bus.getSince(`board:${fixture.project.id}`, 0);
    expect(events.map((e) => e.type)).toContain("task.restored");

    const again = await app.inject({ method: "POST", url: `/api/tasks/${a.id}/restore`, headers: h });
    expect(again.statusCode).toBe(409);
  });
});

describe("Tareas — reloj de purga de la papelera", () => {
  const fixtures: TestFixture[] = [];

  afterEach(async () => {
    for (const fixture of fixtures.splice(0)) await fixture.close();
  });

  it("en tests el reloj NO arranca (autoStartLoops: false)", async () => {
    const fixture = await makeFixture();
    fixtures.push(fixture);
    expect(fixture.api.ctx.taskPurge.running).toBe(false);
    expect(fixture.api.ctx.taskPurge.days).toBe(90);
  });

  it("runOnce purga solo lo que lleva más de N días, con reloj inyectado", async () => {
    const fixture = await makeFixture();
    fixtures.push(fixture);
    const now = 1_900_000_000_000;
    const old = await createTask(fixture.db, {
      projectId: fixture.project.id,
      title: "Vieja",
      stage: "ENTENDER",
      orderKey: "a",
    });
    const fresh = await createTask(fixture.db, {
      projectId: fixture.project.id,
      title: "Reciente",
      stage: "ENTENDER",
      orderKey: "b",
    });
    await softDeleteTask(fixture.db, old.id, { actor: "person:x", expectedVersion: old.version, now: now - 91 * DAY_MS });
    await softDeleteTask(fixture.db, fresh.id, { actor: "person:x", expectedVersion: fresh.version, now: now - 89 * DAY_MS });

    const logs: unknown[] = [];
    const scheduler = createTaskPurgeScheduler({
      db: fixture.db,
      days: 90,
      now: () => now,
      logger: { info: (obj) => logs.push(obj), warn: (obj) => logs.push(obj) },
    });
    const result = await scheduler.runOnce();
    expect(result.purged).toBe(1);
    expect(await getTask(fixture.db, old.id)).toBeUndefined();
    expect(await getTask(fixture.db, fresh.id)).toBeDefined();
    // El log lleva conteos, jamás contenido de las tareas.
    expect(JSON.stringify(logs)).not.toContain("Vieja");
    expect(logs).toEqual([{ purged: 1, filesRemoved: 0, days: 90 }]);
  });

  it("AGENTOS_TASK_PURGE_DISABLED=1 impide arrancar; AGENTOS_TASK_PURGE_DAYS se interpreta con default 90", async () => {
    expect(resolveTaskPurgeDays({})).toBe(90);
    expect(resolveTaskPurgeDays({ AGENTOS_TASK_PURGE_DAYS: "30" })).toBe(30);
    expect(resolveTaskPurgeDays({ AGENTOS_TASK_PURGE_DAYS: "basura" })).toBe(90);
    expect(resolveTaskPurgeDays({ AGENTOS_TASK_PURGE_DAYS: "0" })).toBe(90);
    expect(resolveTaskPurgeDisabled({ AGENTOS_TASK_PURGE_DISABLED: "1" })).toBe(true);
    expect(resolveTaskPurgeDisabled({})).toBe(false);

    const fixture = await makeFixture();
    fixtures.push(fixture);
    const scheduler = createTaskPurgeScheduler({ db: fixture.db, disabled: true });
    scheduler.start();
    expect(scheduler.running).toBe(false);
    scheduler.stop();
  });
});
