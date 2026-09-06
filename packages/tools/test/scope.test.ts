/**
 * Guarda de scope por proyecto (docs/DISENO-SCOPE-GATEWAY-COPILOTO-BOARD.md §2, §6):
 * un agente solo toca objetos del proyecto de su run. Fail-closed: sin proyecto en
 * el ctx no hay escritura de tareas; fuera de scope se deniega ANTES del Gate 2 y
 * queda auditado con `target_project_id`.
 */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ErrorCodes, isAgentosError } from "@agentos/shared";
import {
  createProject,
  createTask,
  getApproval,
  getTask,
  listPendingApprovals,
  queryAudit,
  type Project,
  type Task,
} from "@agentos/db";
import { buildCatalog, defineTool } from "../src/catalog.js";
import type { ToolCallContext } from "../src/types.js";
import { toolsFixture, type ToolsFixture } from "./helpers.js";

async function codeOf(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
    return undefined;
  } catch (err) {
    if (isAgentosError(err)) return err.code;
    throw err;
  }
}

function ok<T>(res: unknown): T {
  expect(res).toMatchObject({ status: "ok" });
  return (res as { status: "ok"; result: T }).result;
}

/** Fixture base + segundo proyecto (B) con una tarea propia. */
async function scopeFixture(extra = [] as Parameters<typeof toolsFixture>[0]): Promise<
  ToolsFixture & { projectB: Project; taskB: Task; ctxA: ToolCallContext; ctxB: ToolCallContext; ctxNoProject: ToolCallContext }
> {
  const f = await toolsFixture(extra);
  const projectB = await createProject(f.db, { orgId: f.project.orgId, name: "Assessment Beta", type: "assessment" });
  const taskB = await createTask(f.db, {
    projectId: projectB.id,
    title: "Tarea del proyecto B",
    definitionOfDone: "Artefacto adjunto",
    stage: "ENTENDER",
    status: "READY",
    priority: "normal",
    assigneeAgentId: f.alex.id,
    orderKey: "m",
  });
  const ctxA = f.ctxFor(f.alex);
  return {
    ...f,
    projectB,
    taskB,
    ctxA,
    ctxB: { ...ctxA, project_id: projectB.id },
    ctxNoProject: { ...ctxA, project_id: null },
  };
}

async function createTaskInA(f: ToolsFixture, title = "Tarea del proyecto A"): Promise<Task> {
  const res = await f.runtime.execute(f.ctxFor(f.alex), "tasks.create", {
    project_id: f.project.id,
    title,
    stage: "ENTENDER",
    definition_of_done: "Notas en el Hub",
    assignee_agent_slug: "alex",
  });
  return ok<Task>(res);
}

describe("scope por proyecto — negativo principal", () => {
  it("tasks.move sobre tarea de otro proyecto → policy_denied, la tarea no cambia y queda auditado con target_project_id", async () => {
    const f = await scopeFixture();
    const before = (await getTask(f.db, f.taskB.id))!;

    expect(
      await codeOf(() =>
        f.runtime.execute(f.ctxA, "tasks.move", {
          task_id: f.taskB.id,
          to: "IN_PROGRESS",
          expected_version: before.version,
        }),
      ),
    ).toBe(ErrorCodes.POLICY_DENIED);

    const after = (await getTask(f.db, f.taskB.id))!;
    expect(after.status).toBe(before.status);
    expect(after.version).toBe(before.version);

    const rows = await queryAudit(f.db, { entityType: "tool", entityId: "tasks.move" });
    const denied = rows.find((a) => a.action === "tool.denied");
    expect(denied).toBeDefined();
    expect(denied!.after).toMatchObject({
      code: ErrorCodes.POLICY_DENIED,
      scope: "project",
      ctx_project_id: f.project.id,
      target_project_id: f.projectB.id,
      tool: "tasks.move",
      task_id: f.taskB.id,
    });
    // Ninguna fila de ejecución: el handler jamás corrió.
    expect(rows.some((a) => a.action === "tool.execute")).toBe(false);
  });
});

describe("scope por proyecto — fail-closed sin proyecto en el ctx", () => {
  it("ctx sin project_id deniega TODA escritura de tareas", async () => {
    const f = await scopeFixture();
    const taskA = await createTaskInA(f);
    const calls: Array<[string, Record<string, unknown>]> = [
      ["tasks.create", { project_id: f.project.id, title: "x", stage: "ENTENDER" }],
      ["tasks.claim", { task_id: taskA.id }],
      ["tasks.move", { task_id: taskA.id, to: "READY", expected_version: taskA.version }],
      ["tasks.comment", { task_id: taskA.id, body: "hola" }],
      ["tasks.attach_artifact", { task_id: taskA.id, kind: "note", title: "n" }],
      ["tasks.assign_people", { task_id: taskA.id, assignee_person_ids: [f.person.id], expected_version: taskA.version }],
      ["tasks.set_due_date", { task_id: taskA.id, due_at: null, expected_version: taskA.version }],
      ["delegate", { tarea: "t", limites: "l", forma_de_buena_respuesta: "f", assignee: "quinn", parent_task_id: taskA.id }],
      ["ask_human", { kind: "question", title: "?", body: "?" }],
    ];
    for (const [name, args] of calls) {
      expect(await codeOf(() => f.runtime.execute(f.ctxNoProject, name, args)), name).toBe(ErrorCodes.POLICY_DENIED);
    }
    // La tarea A sigue intacta.
    const still = (await getTask(f.db, taskA.id))!;
    expect(still.version).toBe(taskA.version);
    expect(still.status).toBe(taskA.status);
  });

  it("un humano no pasa por la guarda (misma frontera que la allowlist)", async () => {
    const f = await scopeFixture();
    const res = await f.runtime.execute({ ...f.humanCtx(), project_id: null }, "tasks.comment", {
      task_id: f.taskB.id,
      body: "comentario humano en B",
    });
    expect(res.status).toBe("ok");
  });
});

describe("scope por proyecto — antes del engine y antes del Gate 2", () => {
  it("tasks.create con project_id ajeno se deniega sin tocar el engine", async () => {
    const f = await scopeFixture();
    const spy = vi.spyOn(f.engine, "createTask");
    expect(
      await codeOf(() =>
        f.runtime.execute(f.ctxA, "tasks.create", { project_id: f.projectB.id, title: "Intrusa", stage: "ENTENDER" }),
      ),
    ).toBe(ErrorCodes.POLICY_DENIED);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("tool con efecto externo fuera de scope → denegada ANTES del Gate 2 (sin aprobación creada)", async () => {
    let executed = false;
    const external = defineTool({
      name: "spy.audit",
      description: "efecto externo con scope por proyecto",
      schema: z.object({ project_id: z.string().min(1) }),
      flags: { read_only: false, external_effect: true, requires_approval: true },
      projectScope: { by: "project", arg: "project_id" },
      handler() {
        executed = true;
        return "sent";
      },
    });
    const f = await scopeFixture([external]);
    const pendingBefore = (await listPendingApprovals(f.db)).length;
    expect(await codeOf(() => f.runtime.execute(f.ctxA, "spy.audit", { project_id: f.projectB.id }))).toBe(
      ErrorCodes.POLICY_DENIED,
    );
    expect((await listPendingApprovals(f.db)).length).toBe(pendingBefore);
    expect(executed).toBe(false);
    const rows = await queryAudit(f.db, { entityType: "tool", entityId: "spy.audit" });
    expect(rows.some((a) => a.action === "tool.pending_approval")).toBe(false);
    expect(rows.some((a) => a.action === "tool.denied")).toBe(true);
  });

  it("executeApproved re-valida el scope: aprobación creada en A, reanudada con ctx de B → denegada", async () => {
    let executed = false;
    const external = defineTool({
      name: "spy.audit",
      description: "efecto externo con scope por proyecto",
      schema: z.object({ project_id: z.string().min(1) }),
      flags: { read_only: false, external_effect: true, requires_approval: true },
      projectScope: { by: "project", arg: "project_id" },
      handler() {
        executed = true;
        return "sent";
      },
    });
    const f = await scopeFixture([external]);
    const pending = await f.runtime.execute(f.ctxA, "spy.audit", { project_id: f.project.id });
    if (pending.status !== "pending_approval") throw new Error("esperaba pending_approval");
    await f.engine.decideApproval(pending.approval_id, "approved", f.person.id, "ok");

    expect(await codeOf(() => f.runtime.executeApproved(f.ctxB, pending.approval_id))).toBe(ErrorCodes.POLICY_DENIED);
    expect(executed).toBe(false);
    const rows = await queryAudit(f.db, { entityType: "tool", entityId: "spy.audit" });
    expect(rows.some((a) => a.action === "tool.execute_approved")).toBe(false);

    // Con el ctx correcto sí ejecuta.
    const done = await f.runtime.executeApproved(f.ctxA, pending.approval_id);
    expect(done).toEqual({ status: "ok", result: "sent" });
    expect(executed).toBe(true);
  });
});

describe("scope por proyecto — delegate y ask_human", () => {
  it("delegate hereda el proyecto del padre y rechaza padres ajenos", async () => {
    const f = await scopeFixture();
    const parentA = await createTaskInA(f, "Madre en A");
    const child = ok<Task>(
      await f.runtime.execute(f.ctxA, "delegate", {
        tarea: "Inventario de sistemas",
        limites: "solo ERP y CRM",
        forma_de_buena_respuesta: "tabla con sistema, dueño y uso",
        assignee: "quinn",
        parent_task_id: parentA.id,
      }),
    );
    expect(child.projectId).toBe(f.project.id);
    expect(child.parentTaskId).toBe(parentA.id);

    expect(
      await codeOf(() =>
        f.runtime.execute(f.ctxA, "delegate", {
          tarea: "Intrusa",
          limites: "l",
          forma_de_buena_respuesta: "f",
          assignee: "quinn",
          parent_task_id: f.taskB.id,
        }),
      ),
    ).toBe(ErrorCodes.POLICY_DENIED);
    expect((await getTask(f.db, f.taskB.id))!.version).toBe(f.taskB.version);

    // Sin parent_task_id el fallback es la tarea del run: si es ajena, también se deniega.
    expect(
      await codeOf(() =>
        f.runtime.execute({ ...f.ctxA, task_id: f.taskB.id }, "delegate", {
          tarea: "Intrusa 2",
          limites: "l",
          forma_de_buena_respuesta: "f",
          assignee: "quinn",
        }),
      ),
    ).toBe(ErrorCodes.POLICY_DENIED);
  });

  it("ask_human sin task_id usa ctx.project_id; con task_id ajeno se deniega", async () => {
    const f = await scopeFixture();
    const res = ok<{ approval_id: string }>(
      await f.runtime.execute(f.ctxA, "ask_human", { kind: "question", title: "¿Alcance?", body: "¿Todo o comercial?" }),
    );
    const approval = (await getApproval(f.db, res.approval_id))!;
    expect(approval.projectId).toBe(f.project.id);
    expect(approval.taskId).toBeNull();

    const pendingBefore = (await listPendingApprovals(f.db)).length;
    expect(
      await codeOf(() =>
        f.runtime.execute(f.ctxA, "ask_human", { kind: "question", title: "?", body: "?", task_id: f.taskB.id }),
      ),
    ).toBe(ErrorCodes.POLICY_DENIED);
    expect((await listPendingApprovals(f.db)).length).toBe(pendingBefore);
  });

  it("ask_human (humano, sin guarda) no cuelga la aprobación de otro proyecto: valida la coherencia tarea↔ctx", async () => {
    const f = await scopeFixture();
    expect(
      await codeOf(() =>
        f.runtime.execute(f.humanCtx(), "ask_human", { kind: "question", title: "?", body: "?", task_id: f.taskB.id }),
      ),
    ).toBe(ErrorCodes.VALIDATION_ERROR);
  });
});

describe("scope por proyecto — catálogo y lectura", () => {
  it("toda tool no read_only declara projectScope (guarda anti-agujero)", () => {
    const catalog = buildCatalog();
    const missing = [...catalog.values()]
      .filter((t) => t.flags.read_only === false && t.projectScope === undefined)
      .map((t) => t.name);
    expect(missing).toEqual([]);
    // Y las que sí tienen proyecto lo resuelven por objetivo, no por "none" a la ligera.
    const writers = [...catalog.values()].filter((t) => t.flags.read_only === false);
    expect(writers.length).toBeGreaterThanOrEqual(16);
    const byTarget = writers.filter((t) => t.projectScope !== "none" && t.projectScope !== "ctx");
    expect(byTarget.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        "tasks.create",
        "tasks.claim",
        "tasks.move",
        "tasks.comment",
        "tasks.attach_artifact",
        "tasks.assign_people",
        "tasks.set_due_date",
        "delegate",
        "ask_human",
        "artifacts.write",
        "projects.update",
        "knowledge.upsert_doc",
        "sources.ingest",
      ]),
    );
  });

  it("tasks.list ignora un project_id ajeno y filtra por el del ctx", async () => {
    const f = await scopeFixture();
    const taskA = await createTaskInA(f);
    const listed = ok<Array<{ id: string; projectId: string }>>(
      await f.runtime.execute(f.ctxA, "tasks.list", { project_id: f.projectB.id }),
    );
    expect(listed.map((t) => t.id)).toEqual([taskA.id]);
    expect(listed.every((t) => t.projectId === f.project.id)).toBe(true);
    // Un humano sí puede listar B.
    const human = ok<Array<{ id: string }>>(await f.runtime.execute(f.humanCtx(), "tasks.list", { project_id: f.projectB.id }));
    expect(human.map((t) => t.id)).toEqual([f.taskB.id]);
  });

  it("board.get y tasks.get también respetan el scope (lectura que descubre ids)", async () => {
    const f = await scopeFixture();
    expect(await codeOf(() => f.runtime.execute(f.ctxA, "board.get", { project_id: f.projectB.id }))).toBe(
      ErrorCodes.POLICY_DENIED,
    );
    expect(await codeOf(() => f.runtime.execute(f.ctxA, "tasks.get", { task_id: f.taskB.id }))).toBe(
      ErrorCodes.POLICY_DENIED,
    );
    const board = ok<{ project_id: string }>(await f.runtime.execute(f.ctxA, "board.get", { project_id: f.project.id }));
    expect(board.project_id).toBe(f.project.id);
  });
});
