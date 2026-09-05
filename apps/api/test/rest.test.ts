/**
 * REST: auth requerida (401 sin sesión), login, movimiento ilegal → error de
 * dominio con código estable, Gate 1 (gate_not_passed) y board snapshot.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPerson, createTask, getTask, updatePerson } from "@agentos/db";
import { makeFixture, TEST_PASSWORD, type TestFixture } from "./helpers.js";

let fx: TestFixture;

beforeAll(async () => {
  fx = await makeFixture();
});
afterAll(async () => {
  await fx.close();
});

describe("REST", () => {
  it("sin sesión → 401 con código estable; health y login son públicos", async () => {
    const noAuth = await fx.api.app.inject({ method: "GET", url: "/api/tasks" });
    expect(noAuth.statusCode).toBe(401);
    expect((noAuth.json() as { error: { code: string } }).error.code).toBe("unauthorized");

    const health = await fx.api.app.inject({ method: "GET", url: "/api/health" });
    expect(health.statusCode).toBe(200);
    const healthBody = health.json() as { ok: boolean; counts: { tables: number } };
    expect(healthBody.ok).toBe(true);
    expect(healthBody.counts.tables).toBe(26); // 23 existentes + task_assignees + task_notification_log + task_labels

    const people = await fx.api.app.inject({ method: "GET", url: "/api/auth/people" });
    expect(people.statusCode).toBe(200);

    const badLogin = await fx.api.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { password: "incorrecta", person_id: fx.person.id },
    });
    expect(badLogin.statusCode).toBe(401);

    const login = await fx.api.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { password: TEST_PASSWORD, person_id: fx.person.id },
    });
    expect(login.statusCode).toBe(200);
    expect(login.headers["set-cookie"]).toContain("agentos_session=");

    const me = await fx.api.app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { authorization: `Bearer ${(login.json() as { token: string }).token}` },
    });
    expect(me.statusCode).toBe(200);
    expect((me.json() as { session: { personId: string } }).session.personId).toBe(fx.person.id);
  });

  it("movimiento ilegal → 422 invalid_transition (error de dominio con código)", async () => {
    const task = createTask(fx.db, {
      projectId: fx.project.id,
      title: "Tarea en backlog",
      stage: "ENTENDER",
      status: "BACKLOG",
      orderKey: "z1",
    });
    const res = await fx.api.app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/move`,
      headers: fx.authHeaders,
      payload: { to: "DONE", expected_version: 1 },
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: { code: string } }).error.code).toBe("invalid_transition");
    expect(getTask(fx.db, task.id)!.status).toBe("BACKLOG");
  });

  it("Gate 1: tarea CONSTRUIR no sale de BACKLOG sin g1_plan → gate_not_passed", async () => {
    const task = createTask(fx.db, {
      projectId: fx.project.id,
      title: "Construir integración",
      definitionOfDone: "Integración desplegada",
      stage: "CONSTRUIR",
      status: "BACKLOG",
      assigneeAgentId: fx.sam.id,
      orderKey: "z2",
    });
    const res = await fx.api.app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/move`,
      headers: fx.authHeaders,
      payload: { to: "READY", expected_version: 1 },
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: { code: string } }).error.code).toBe("gate_not_passed");

    // Aprobar el gate lo desbloquea.
    const gate = await fx.api.app.inject({
      method: "POST",
      url: `/api/projects/${fx.project.id}/gate`,
      headers: fx.authHeaders,
      payload: { decision: "approve", note: "diagnóstico y roadmap aprobados" },
    });
    expect(gate.statusCode).toBe(200);

    const retry = await fx.api.app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/move`,
      headers: fx.authHeaders,
      payload: { to: "READY", expected_version: 1 },
    });
    expect(retry.statusCode).toBe(200);
    expect(getTask(fx.db, task.id)!.status).toBe("READY");
  });

  it("version_conflict → 409; board snapshot agrupa stage×status", async () => {
    const task = createTask(fx.db, {
      projectId: fx.project.id,
      title: "Tarea para conflicto",
      stage: "ENTENDER",
      status: "BACKLOG",
      orderKey: "z3",
    });
    const conflict = await fx.api.app.inject({
      method: "PATCH",
      url: `/api/tasks/${task.id}`,
      headers: fx.authHeaders,
      payload: { expected_version: 99, title: "no debería aplicar" },
    });
    expect(conflict.statusCode).toBe(409);
    expect((conflict.json() as { error: { code: string } }).error.code).toBe("version_conflict");

    const board = await fx.api.app.inject({
      method: "GET",
      url: `/api/board/${fx.project.id}`,
      headers: fx.authHeaders,
    });
    expect(board.statusCode).toBe(200);
    const snapshot = board.json() as {
      total: number;
      columns: Record<string, unknown[]>;
      cells: Record<string, Record<string, unknown[]>>;
    };
    expect(snapshot.total).toBeGreaterThan(0);
    expect(snapshot.cells.ENTENDER).toBeDefined();
    expect(Object.keys(snapshot.columns).length).toBeGreaterThan(0);
  });

  it("REVIEW→DONE de tarea con requires_approval la cierra un humano, no un agente", async () => {
    // Tarea en REVIEW con artefacto y requires_approval.
    const task = createTask(fx.db, {
      projectId: fx.project.id,
      title: "Informe con gate humano",
      definitionOfDone: "Informe aprobado",
      stage: "ENTENDER",
      status: "REVIEW",
      requiresApproval: true,
      assigneeAgentId: fx.sam.id,
      orderKey: "z4",
    });
    await fx.api.app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/artifacts`,
      headers: fx.authHeaders,
      payload: { kind: "document", title: "Informe v1", content: "..." },
    });

    const approve = await fx.api.app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/approve`,
      headers: fx.authHeaders,
      payload: { expected_version: 1, note: "aprobado" },
    });
    expect(approve.statusCode).toBe(200);
    expect(getTask(fx.db, task.id)!.status).toBe("DONE");
  });

  // Fix Q4: la firma + expiración del token no bastan — se revalida en cada
  // request que la persona siga existiendo y siendo interna.
  it("token de una persona deprovisionada (ya no interna) deja de valer", async () => {
    const temp = createPerson(fx.db, {
      orgId: fx.org.id,
      fullName: "Temporal QA",
      isInternal: true,
      role: "Auxiliar",
    });
    const login = await fx.api.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { password: TEST_PASSWORD, person_id: temp.id },
    });
    expect(login.statusCode).toBe(200);
    const headers = { authorization: `Bearer ${(login.json() as { token: string }).token}` };

    // Con la persona interna, el token vale.
    const ok = await fx.api.app.inject({ method: "GET", url: "/api/auth/me", headers });
    expect(ok.statusCode).toBe(200);

    // Se desactiva a la persona: el MISMO token deja de valer (fail-closed).
    updatePerson(fx.db, temp.id, { isInternal: false });
    const denied = await fx.api.app.inject({ method: "GET", url: "/api/agents", headers });
    expect(denied.statusCode).toBe(401);
    expect((denied.json() as { error: { code: string } }).error.code).toBe("unauthorized");
  });
});
