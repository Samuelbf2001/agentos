import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ErrorCodes, isAgentosError } from "@agentos/shared";
import { getApproval, queryAudit } from "@agentos/db";
import { defineTool } from "../src/catalog.js";
import { toolsFixture } from "./helpers.js";

async function codeOf(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
    return undefined;
  } catch (err) {
    if (isAgentosError(err)) return err.code;
    throw err;
  }
}

describe("gateway fail-closed", () => {
  it("tool fuera de la allowlist se rechaza ANTES del handler (y se audita la denegación)", async () => {
    let executed = false;
    const spy = defineTool({
      name: "spy.audit",
      description: "spy",
      schema: z.object({}),
      flags: { read_only: true, external_effect: false, requires_approval: false },
      handler() {
        executed = true;
        return "ran";
      },
    });
    const f = toolsFixture([spy]);
    // quinn NO tiene spy.audit en su allowlist.
    expect(await codeOf(() => f.runtime.execute(f.ctxFor(f.quinn), "spy.audit", {}))).toBe(
      ErrorCodes.POLICY_DENIED,
    );
    expect(executed).toBe(false);
    const denials = queryAudit(f.db, { entityType: "tool", entityId: "spy.audit" });
    expect(denials.some((a) => a.action === "tool.denied")).toBe(true);
    // alex SÍ la tiene → ejecuta.
    const ok = await f.runtime.execute(f.ctxFor(f.alex), "spy.audit", {});
    expect(ok).toEqual({ status: "ok", result: "ran" });
    expect(executed).toBe(true);
  });

  it("tool desconocida → policy_denied (fail-closed), jamás undefined behavior", async () => {
    const f = toolsFixture();
    expect(await codeOf(() => f.runtime.execute(f.ctxFor(f.alex), "sql.raw", { q: "DROP TABLE tasks" }))).toBe(
      ErrorCodes.POLICY_DENIED,
    );
  });

  it("el audit se escribe ANTES de ejecutar el handler", async () => {
    let auditRowsAtExecution = -1;
    const spy = defineTool({
      name: "spy.audit",
      description: "verifica el orden audit→handler",
      schema: z.object({}),
      flags: { read_only: true, external_effect: false, requires_approval: false },
      handler(ctx) {
        auditRowsAtExecution = queryAudit(ctx.db, { entityType: "tool", entityId: "spy.audit" }).filter(
          (a) => a.action === "tool.execute",
        ).length;
        return null;
      },
    });
    const f = toolsFixture([spy]);
    await f.runtime.execute(f.ctxFor(f.alex), "spy.audit", {});
    // Al entrar el handler, la fila 'tool.execute' YA estaba escrita.
    expect(auditRowsAtExecution).toBe(1);
  });

  it("si el handler falla se escribe una segunda fila de audit (tool.error)", async () => {
    const boom = defineTool({
      name: "spy.fail",
      description: "explota",
      schema: z.object({}),
      flags: { read_only: false, external_effect: false, requires_approval: false },
      handler() {
        throw new Error("se rompió el handler");
      },
    });
    const f = toolsFixture([boom]);
    await expect(f.runtime.execute(f.ctxFor(f.alex), "spy.fail", {})).rejects.toThrow("se rompió el handler");
    const rows = queryAudit(f.db, { entityType: "tool", entityId: "spy.fail" });
    expect(rows.some((a) => a.action === "tool.execute")).toBe(true);
    expect(rows.some((a) => a.action === "tool.error")).toBe(true);
  });

  it("kill switch activo bloquea toda tool", async () => {
    const f = toolsFixture();
    f.engine.setKillSwitch(true, `person:${f.person.id}`);
    expect(await codeOf(() => f.runtime.execute(f.ctxFor(f.alex), "tasks.list", {}))).toBe(
      ErrorCodes.KILL_SWITCH_ACTIVE,
    );
  });

  it("agente pausado no ejecuta tools", async () => {
    const f = toolsFixture();
    f.db.$client.prepare(`UPDATE agents SET status = 'paused' WHERE id = ?`).run(f.alex.id);
    expect(await codeOf(() => f.runtime.execute(f.ctxFor(f.alex), "tasks.list", {}))).toBe(
      ErrorCodes.POLICY_DENIED,
    );
  });

  it("argumentos inválidos → validation_error sin tocar el handler", async () => {
    const f = toolsFixture();
    expect(
      await codeOf(() => f.runtime.execute(f.ctxFor(f.alex), "tasks.create", { title: 42 })),
    ).toBe(ErrorCodes.VALIDATION_ERROR);
  });
});

describe("Gate 2 en el gateway (efecto externo)", () => {
  it("email.send NO ejecuta: crea approval y devuelve pending_approval", async () => {
    const f = toolsFixture();
    const args = { to: "cliente@acme.com", subject: "Informe", body: "Adjunto el informe." };
    const res = await f.runtime.execute(f.ctxFor(f.alex), "email.send", args);
    expect(res.status).toBe("pending_approval");
    if (res.status !== "pending_approval") throw new Error("unreachable");
    const approval = getApproval(f.db, res.approval_id)!;
    expect(approval.status).toBe("pending");
    expect(approval.kind).toBe("tool_call");
    expect(approval.payload).toEqual({ tool: "email.send", args });
  });

  it("flujo completo: pending → humano aprueba → executeApproved ejecuta el stub", async () => {
    const f = toolsFixture();
    const args = { to: "cliente@acme.com", subject: "Informe", body: "Hola" };
    const pending = await f.runtime.execute(f.ctxFor(f.alex), "email.send", args);
    if (pending.status !== "pending_approval") throw new Error("esperaba pending_approval");

    const decided = f.engine.decideApproval(pending.approval_id, "approved", f.person.id, "ok");
    expect(decided.executePayload).toEqual({ tool: "email.send", args });

    const executed = await f.runtime.executeApproved(f.ctxFor(f.alex), pending.approval_id);
    expect(executed.status).toBe("ok");
    if (executed.status !== "ok") throw new Error("unreachable");
    expect(executed.result).toMatchObject({ simulated: true, to: args.to });
  });

  it("executeApproved rechaza aprobaciones no aprobadas y digests manipulados", async () => {
    const f = toolsFixture();
    const pending = await f.runtime.execute(f.ctxFor(f.alex), "email.send", {
      to: "a@b.c",
      subject: "s",
      body: "b",
    });
    if (pending.status !== "pending_approval") throw new Error("esperaba pending_approval");

    // Aún pendiente → no ejecuta.
    expect(await codeOf(() => f.runtime.executeApproved(f.ctxFor(f.alex), pending.approval_id))).toBe(
      ErrorCodes.HUMAN_APPROVAL_REQUIRED,
    );

    f.engine.decideApproval(pending.approval_id, "approved", f.person.id);
    // Manipulación post-aprobación → digest mismatch → approval_invalidated.
    f.db.$client
      .prepare(`UPDATE approvals SET payload = ? WHERE id = ?`)
      .run(JSON.stringify({ tool: "email.send", args: { to: "evil@x.y", subject: "s", body: "b" } }), pending.approval_id);
    expect(await codeOf(() => f.runtime.executeApproved(f.ctxFor(f.alex), pending.approval_id))).toBe(
      ErrorCodes.APPROVAL_INVALIDATED,
    );
  });
});

describe("tools de dominio a través del gateway", () => {
  it("tasks.create + tasks.list + board.get funcionan de punta a punta", async () => {
    const f = toolsFixture();
    const created = await f.runtime.execute(f.ctxFor(f.alex), "tasks.create", {
      project_id: f.project.id,
      title: "Entrevista con dirección",
      stage: "ENTENDER",
      definition_of_done: "Notas registradas en el Context Hub",
      assignee_agent_slug: "alex",
    });
    expect(created.status).toBe("ok");
    const listed = await f.runtime.execute(f.ctxFor(f.alex), "tasks.list", { project_id: f.project.id });
    if (listed.status !== "ok") throw new Error("unreachable");
    expect((listed.result as unknown[]).length).toBe(1);
    const board = await f.runtime.execute(f.ctxFor(f.alex), "board.get", { project_id: f.project.id });
    if (board.status !== "ok") throw new Error("unreachable");
    expect((board.result as { total: number }).total).toBe(1);
  });

  it("artifacts.write escribe bajo el workspace y adjunta la fila (y bloquea path traversal)", async () => {
    const f = toolsFixture();
    const created = await f.runtime.execute(f.ctxFor(f.alex), "tasks.create", {
      project_id: f.project.id,
      title: "Informe",
      stage: "ENTENDER",
    });
    if (created.status !== "ok") throw new Error("unreachable");
    const taskId = (created.result as { id: string }).id;

    const written = await f.runtime.execute(f.ctxFor(f.alex), "artifacts.write", {
      task_id: taskId,
      filename: "informes/assessment.md",
      content: "# Informe\nHallazgos...",
    });
    if (written.status !== "ok") throw new Error("unreachable");
    const out = written.result as { path: string };
    expect(out.path).toContain("assessment.md");

    expect(
      await codeOf(() =>
        f.runtime.execute(f.ctxFor(f.alex), "artifacts.write", {
          task_id: taskId,
          filename: "../../fuera.md",
          content: "x",
        }),
      ),
    ).toBe(ErrorCodes.VALIDATION_ERROR);
  });

  it("ask_human crea una aprobación deliverable con la pregunta tipada", async () => {
    const f = toolsFixture();
    const res = await f.runtime.execute(f.ctxFor(f.alex), "ask_human", {
      kind: "question",
      title: "¿Alcance ISO?",
      body: "¿Incluimos la matriz de cláusulas ISO en esta fase?",
    });
    if (res.status !== "ok") throw new Error("unreachable");
    const result = res.result as { status: string; approval_id: string };
    expect(result.status).toBe("pending_approval");
    const approval = getApproval(f.db, result.approval_id)!;
    expect(approval.kind).toBe("deliverable");
    expect(approval.payload).toMatchObject({ type: "question", title: "¿Alcance ISO?" });
  });

  it("un humano pasa por el gateway sin allowlist de agente (atribución propia)", async () => {
    const f = toolsFixture();
    const res = await f.runtime.execute(f.humanCtx(), "methodology.list", {});
    expect(res.status).toBe("ok");
  });
});
