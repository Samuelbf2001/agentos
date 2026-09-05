/**
 * End-to-end de la API **corriendo sobre Postgres** (rama feat/postgres-async).
 *
 * Es la prueba que faltaba: no verifica repositorios sueltos, verifica que la
 * aplicación entera —arranque, migraciones, seed, launch de Módulo de Fase,
 * motor del tablero, gate y persistencia— funciona con
 * `AGENTOS_DB_DRIVER=postgres`.
 *
 * **Se auto-omite sin `AGENTOS_PG_URL`**, igual que la suite de `packages/db`.
 * Para correrla:
 *
 *   docker run -d --name agentos-pg-dev -e POSTGRES_USER=agentos \
 *     -e POSTGRES_PASSWORD=agentos -e POSTGRES_DB=agentos \
 *     -p 5434:5432 pgvector/pgvector:pg17
 *   $env:AGENTOS_PG_URL="postgres://agentos:agentos@localhost:5434/agentos"
 *   pnpm --filter @agentos/api test
 *
 * ⚠️ La base a la que apunte `AGENTOS_PG_URL` se **trunca** al empezar: tiene
 * que ser desechable, nunca una de producción.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePgDb, openPgDb, PG_TABLE_ORDER, runPgMigrations } from "@agentos/db/pg";
import { getProject, listLaunches, listTasks, type AgentosDb } from "@agentos/db";
import { buildApi, type Api } from "../src/server.js";

const PG_URL = process.env.AGENTOS_PG_URL;
const describePg = describe.skipIf(!PG_URL);

const PASSWORD = "test-pg-e2e";

/** Inputs del módulo `consultoria` para un cliente distinto al del seed demo. */
const NOVA_INPUTS: Record<string, unknown> = {
  empresa: "Nova PG S.A.",
  alias: "NovaPG",
  industria: "manufactura",
  empleados: 40,
  sponsor: "Gerente General",
  objetivo: "Diagnóstico del ciclo Entender corriendo sobre Postgres.",
  areas: ["direccion", "operaciones", "ventas"],
  procesos_core: ["Producción", "Ventas → Facturación"],
  fecha_objetivo: "2026-12-15",
};

describePg("API end-to-end sobre Postgres", () => {
  let api: Api;
  let db: AgentosDb;
  let token: string;
  let personId: string;

  beforeAll(async () => {
    // Base limpia. `runPgMigrations` puede quejarse si una corrida previa dejó
    // la columna `embedding` con otra dimensión: recrearla es barato.
    const raw = openPgDb(PG_URL);
    try {
      await runPgMigrations(raw);
    } catch (err) {
      if (!/dimensi/.test((err as Error).message)) throw err;
      await raw.$client.unsafe(`ALTER TABLE knowledge_docs DROP COLUMN IF EXISTS embedding`);
      await runPgMigrations(raw);
    }
    await raw.$client.unsafe(
      `TRUNCATE TABLE ${PG_TABLE_ORDER.map((t) => `"${t}"`).join(", ")} CASCADE`,
    );
    await closePgDb(raw);

    // La API abre Postgres, migra y hace el seed idempotente ella sola.
    api = await buildApi({
      dbDriver: "postgres",
      pgUrl: PG_URL,
      seedOnBoot: true,
      autoStartLoops: false,
      sharedPassword: PASSWORD,
      logger: false,
    });
    db = api.ctx.db;

    const people = await api.app.inject({ method: "GET", url: "/api/auth/people" });
    const lista = (people.json() as { people: { id: string; full_name?: string; fullName?: string }[] })
      .people;
    const ernesto = lista.find((p) => (p.full_name ?? p.fullName) === "Ernesto") ?? lista[0]!;
    personId = ernesto.id;
    const login = await api.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { password: PASSWORD, person_id: personId },
    });
    expect(login.statusCode).toBe(200);
    token = (login.json() as { token: string }).token;
  }, 180_000);

  afterAll(async () => {
    if (api) await api.close();
  });

  it("arranca, migra y seedea contra Postgres (25 tablas y el demo ACME)", async () => {
    const res = await api.app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    const health = res.json() as { counts: Record<string, number> };
    const counts = health.counts;
    expect(counts["tables"]).toBe(31);
    expect(counts["organizations"]).toBeGreaterThanOrEqual(2);
    expect(counts["agents"]).toBe(7);
    expect(counts["tasks"]).toBe(12); // el launch demo del seed (§13.6)
  });

  it("dispara el módulo Consultoría, crea y mueve una tarea y aprueba el Gate 1", async () => {
    const auth = { authorization: `Bearer ${token}` };

    // 1) Launch del Módulo de Fase sobre un cliente nuevo.
    const launchRes = await api.app.inject({
      method: "POST",
      url: "/api/modules/consultoria/launch",
      headers: auth,
      payload: {
        inputs: NOVA_INPUTS,
        toggles: { iso9001: true },
        idempotency_key: "pg-e2e:consultoria:nova",
      },
    });
    expect(launchRes.statusCode).toBe(201);
    const launched = launchRes.json() as {
      launch: { id: string; module_slug?: string; moduleSlug?: string };
      project: { id: string; name: string; stage: string; gate_state?: string; gateState?: string };
      tasks_count: number;
    };
    expect(launched.project.name).toBe("Assessment NovaPG");
    expect(launched.tasks_count).toBeGreaterThan(0);
    const projectId = launched.project.id;

    // Repetir la misma key es idempotente también en Postgres (CA-M2.6).
    const otraVez = await api.app.inject({
      method: "POST",
      url: "/api/modules/consultoria/launch",
      headers: auth,
      payload: {
        inputs: NOVA_INPUTS,
        toggles: { iso9001: true },
        idempotency_key: "pg-e2e:consultoria:nova",
      },
    });
    expect(otraVez.statusCode).toBe(200);
    expect((otraVez.json() as { idempotent: boolean }).idempotent).toBe(true);
    expect(await listTasks(db, { projectId })).toHaveLength(launched.tasks_count);

    // 2) Tarea nueva por REST sobre el proyecto recién materializado.
    const crear = async (titulo: string, stage: "ENTENDER" | "CONSTRUIR") => {
      const res = await api.app.inject({
        method: "POST",
        url: "/api/tasks",
        headers: auth,
        payload: {
          project_id: projectId,
          title: titulo,
          stage,
          definition_of_done: "La fila existe en Postgres tras reabrir la conexión.",
          assignee_agent_slug: "alex", // BACKLOG→READY exige asignado
        },
      });
      expect(res.statusCode, res.body).toBe(201);
      return (res.json() as { task: { id: string; status: string; version: number } }).task;
    };
    const mover = (id: string, to: string, expectedVersion: number) =>
      api.app.inject({
        method: "POST",
        url: `/api/tasks/${id}/move`,
        headers: auth,
        payload: { to, expected_version: expectedVersion },
      });

    const task = await crear("Verificar persistencia en Postgres", "ENTENDER");
    expect(task.status).toBe("BACKLOG");

    // 3) Movimiento por la máquina de estados (expected_version, task_events).
    const movida = await mover(task.id, "READY", task.version);
    expect(movida.statusCode, movida.body).toBe(200);
    const moved = (movida.json() as { task: { status: string; version: number } }).task;
    expect(moved.status).toBe("READY");
    expect(moved.version).toBe(task.version + 1);

    // El `expected_version` viejo ya no vale (nada de last-write-wins).
    const conflicto = await mover(task.id, "IN_PROGRESS", task.version);
    expect(conflicto.statusCode).toBe(409);

    // 4) Gate 1: una tarea de CONSTRUIR NO sale de BACKLOG con el proyecto en
    //    ENTENDER y el gate pendiente (la invariante no se relaja por motor).
    const construir = await crear("Tarea de CONSTRUIR (bloqueada por el gate)", "CONSTRUIR");
    const bloqueada = await mover(construir.id, "READY", construir.version);
    expect(bloqueada.statusCode).toBe(422);
    expect((bloqueada.json() as { error: { code: string } }).error.code).toBe("gate_not_passed");

    // Aprobar el gate (solo humano) desbloquea exactamente eso.
    const gate = await api.app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/gate`,
      headers: auth,
      payload: { gate: "g1_plan", decision: "approve", note: "plan revisado en la prueba PG" },
    });
    expect(gate.statusCode, gate.body).toBe(200);
    const proyecto = await getProject(db, projectId);
    expect(proyecto?.gateState).toBe("approved");

    const desbloqueada = await mover(construir.id, "READY", construir.version);
    expect(desbloqueada.statusCode, desbloqueada.body).toBe(200);

    // 5) Todo esto está REALMENTE en Postgres: se comprueba con una conexión
    //    nueva, independiente de la que abrió la API.
    const otra = openPgDb(PG_URL);
    try {
      const filas = (await otra.$client.unsafe(
        `SELECT
           (SELECT count(*) FROM tasks WHERE project_id = '${projectId}')::int        AS tareas,
           (SELECT count(*) FROM module_launches WHERE project_id = '${projectId}')::int AS launches,
           (SELECT gate_state FROM projects WHERE id = '${projectId}')                 AS gate,
           (SELECT status FROM tasks WHERE id = '${task.id}')                          AS estado,
           (SELECT count(*) FROM task_events WHERE task_id = '${task.id}')::int        AS eventos`,
      )) as unknown as {
        tareas: number;
        launches: number;
        gate: string;
        estado: string;
        eventos: number;
      }[];
      const fila = filas[0]!;
      expect(fila.tareas).toBe(launched.tasks_count + 2);
      expect(fila.launches).toBe(1);
      expect(fila.gate).toBe("approved");
      expect(fila.estado).toBe("READY");
      expect(fila.eventos).toBeGreaterThanOrEqual(2); // created + moved
    } finally {
      await closePgDb(otra);
    }

    // Y el recibo del launch sigue siendo único y consultable por la fachada.
    expect(await listLaunches(db, { projectId })).toHaveLength(1);
  }, 180_000);
});
