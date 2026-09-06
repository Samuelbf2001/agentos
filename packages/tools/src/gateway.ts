/**
 * Gateway único de ejecución de tools (ARCHITECTURE §4, patrón estrella de OpenBot):
 *
 *   resolver tool → evaluar política (allowlist del agente + flags + gates +
 *   kill switch) → escribir audit_log ANTES de ejecutar → handler →
 *   segunda fila de audit si falla.
 *
 * FAIL-CLOSED: tool desconocida, agente desconocido, allowlist vacía o regla
 * rota = rechazo. Una tool de efecto externo NO ejecuta: crea la aprobación
 * (Gate 2) y devuelve {status:'pending_approval', approval_id}.
 */
import path from "node:path";
import { AgentosError, ErrorCodes, errors, type AuditSource } from "@agentos/shared";
import {
  appendAudit,
  digestPayload,
  getAgent,
  getAgentBySlug,
  getApproval,
  getProjectSource,
  getTask,
  REPO_ROOT,
  type AgentosDb,
  type Agent,
} from "@agentos/db";
import { createBoardEngine, noopEventSink, actorKind, type BoardEngine, type EventSink } from "@agentos/core";
import { buildCatalog } from "./catalog.js";
import type {
  GatewayResult,
  ToolCallContext,
  ToolDefinition,
  ToolExecutionContext,
  ToolRuntime,
} from "./types.js";

export interface ToolRuntimeOptions {
  db: AgentosDb;
  sink?: EventSink;
  engine?: BoardEngine;
  /** Base para workspaces de proyecto sin workspace_path (default <repo>/data/workspaces). */
  workspaceRoot?: string;
  /** Tools adicionales a registrar (tests, extensiones). */
  extraTools?: ToolDefinition[];
  /** Conector WhatsAppHub (Fuentes del proyecto); sin él, sources.ingest falla legible. */
  whatsappHub?: import("@agentos/shared").WhatsAppHubConnector;
  /** Hook de avisos de responsables; la API lo inyecta y por defecto es off. */
  notifyAssignment?: import("./types.js").ToolExecutionContext["notifyAssignment"];
}

function auditSourceFor(actor: string): AuditSource {
  const kind = actorKind(actor);
  return kind === "agent" ? "agent" : kind === "human" ? "ui" : "system";
}

export function createToolRuntime(opts: ToolRuntimeOptions): ToolRuntime {
  const db = opts.db;
  const sink = opts.sink ?? noopEventSink;
  const engine = opts.engine ?? createBoardEngine({ db, sink });
  const workspaceRoot = opts.workspaceRoot ?? path.join(REPO_ROOT, "data", "workspaces");
  const catalog = buildCatalog(opts.extraTools ?? []);

  function execCtx(ctx: ToolCallContext): ToolExecutionContext {
    return {
      ...ctx,
      db,
      sink,
      engine,
      workspaceRoot,
      whatsappHub: opts.whatsappHub,
      ...(opts.notifyAssignment ? { notifyAssignment: opts.notifyAssignment } : {}),
    };
  }

  async function audit(
    ctx: ToolCallContext,
    action: string,
    toolName: string,
    detail: Record<string, unknown>,
  ): Promise<void> {
    await appendAudit(db, {
      actor: ctx.actor,
      source: auditSourceFor(ctx.actor),
      action,
      entityType: "tool",
      entityId: toolName,
      after: detail,
      runId: ctx.run_id ?? null,
    });
  }

  /** Rechaza auditando SIEMPRE la denegación (la política también deja huella). */
  async function deny(
    ctx: ToolCallContext,
    toolName: string,
    code: (typeof ErrorCodes)[keyof typeof ErrorCodes],
    message: string,
    detail: Record<string, unknown> = {},
  ): Promise<never> {
    await audit(ctx, "tool.denied", toolName, { code, message, ...detail });
    throw new AgentosError(code, message, { tool: toolName, ...detail });
  }

  /**
   * Guarda de scope por proyecto (DISENO-SCOPE-GATEWAY §2, fail-closed): un
   * agente solo toca objetos del proyecto de su run. Va DESPUÉS del parse y
   * ANTES del Gate 2 (una llamada fuera de scope ni siquiera crea aprobación).
   * Humanos, sistema y admin no pasan por aquí (misma frontera que la allowlist).
   */
  async function checkProjectScope(ctx: ToolCallContext, tool: ToolDefinition, args: unknown): Promise<void> {
    if (actorKind(ctx.actor) !== "agent") return;
    const scope = tool.projectScope;
    if (!scope || scope === "none") return;

    const argOf = (key: string): string | undefined => {
      const value = (args as Record<string, unknown> | null | undefined)?.[key];
      return typeof value === "string" && value.length > 0 ? value : undefined;
    };

    let target: string | null = null;
    let taskId: string | null = null;
    if (scope !== "ctx") {
      if (scope.by === "task") {
        const id = argOf(scope.arg) ?? (scope.fallback === "ctx.task_id" ? ctx.task_id ?? undefined : undefined);
        if (id) {
          const task = await getTask(db, id);
          if (!task) throw errors.notFound("task", id);
          target = task.projectId;
          taskId = task.id;
        }
      } else if (scope.by === "project") {
        target = argOf(scope.arg) ?? null;
      } else {
        const id = argOf(scope.arg);
        if (id) {
          const source = await getProjectSource(db, id);
          if (!source) throw errors.notFound("project_source", id);
          target = source.projectId;
        }
      }
    }

    const ctxProject = ctx.project_id ?? null;
    if (ctxProject && (target === null || target === ctxProject)) return;

    const reason = !ctxProject
      ? "el run no tiene proyecto activo (elige uno antes de escribir en el tablero)"
      : `apunta al proyecto ${target} y el run opera en ${ctxProject}`;
    await deny(ctx, tool.name, ErrorCodes.POLICY_DENIED, `Fuera del scope de proyecto: ${tool.name} ${reason} (fail-closed)`, {
      scope: "project",
      ctx_project_id: ctxProject,
      target_project_id: target,
      tool: tool.name,
      task_id: taskId,
    });
  }

  async function resolveAgent(ref: string): Promise<Agent | undefined> {
    return (await getAgent(db, ref)) ?? (await getAgentBySlug(db, ref));
  }

  /** Política previa a TODA ejecución. Devuelve la tool resuelta y el agente. */
  async function checkPolicy(ctx: ToolCallContext, name: string): Promise<{ tool: ToolDefinition; agent: Agent | null }> {
    const tool = catalog.get(name);
    if (!tool) return await deny(ctx, name, ErrorCodes.POLICY_DENIED, `Tool desconocida: ${name} (fail-closed)`);

    // Kill switch global: nada ejecuta.
    if (await engine.isKillSwitchActive()) {
      await deny(ctx, name, ErrorCodes.KILL_SWITCH_ACTIVE, "Kill switch activo: ejecución de tools detenida");
    }

    // Los actores humanos/sistema pasan por gateway con su propia atribución;
    // la allowlist aplica a AGENTES (ARCHITECTURE §4).
    if (actorKind(ctx.actor) !== "agent") return { tool, agent: null };

    const agent = await resolveAgent(ctx.agent_id);
    if (!agent) {
      return await deny(ctx, name, ErrorCodes.POLICY_DENIED, `Agente desconocido: ${ctx.agent_id} (fail-closed)`);
    }
    if (agent.status !== "active") {
      await deny(ctx, name, ErrorCodes.POLICY_DENIED, `Agente ${agent.slug} está "${agent.status}": tools bloqueadas`);
    }
    const allowlist = agent.toolsAllowlist ?? [];
    if (!allowlist.includes(name)) {
      await deny(
        ctx,
        name,
        ErrorCodes.POLICY_DENIED,
        `Tool "${name}" fuera de la allowlist del agente ${agent.slug} (fail-closed)`,
      );
    }
    return { tool, agent };
  }

  async function runHandler(ctx: ToolCallContext, tool: ToolDefinition, args: unknown): Promise<GatewayResult> {
    // Audit ANTES de ejecutar (si el proceso muere a mitad, la intención quedó escrita).
    await audit(ctx, "tool.execute", tool.name, { args: args as Record<string, unknown> });
    try {
      const result = await tool.handler(execCtx(ctx), args as never);
      return { status: "ok", result };
    } catch (err) {
      // Segunda fila si falla (patrón §4).
      await audit(ctx, "tool.error", tool.name, {
        error: err instanceof Error ? err.message : String(err),
        code: err instanceof AgentosError ? err.code : undefined,
      });
      throw err;
    }
  }

  async function execute(ctx: ToolCallContext, name: string, rawArgs: unknown): Promise<GatewayResult> {
    const { tool } = await checkPolicy(ctx, name);

    const parsed = tool.schema.safeParse(rawArgs ?? {});
    if (!parsed.success) {
      throw errors.validation(`Argumentos inválidos para ${name}`, parsed.error.issues);
    }

    // Scope de proyecto ANTES del Gate 2: fuera de scope no se crea ni aprobación.
    await checkProjectScope(ctx, tool, parsed.data);

    // Gate 2: tool de efecto externo NO ejecuta — crea approval y cede al humano.
    if (tool.flags.external_effect || tool.flags.requires_approval) {
      const approval = await engine.requestApproval({
        kind: "tool_call",
        payload: { tool: name, args: parsed.data },
        runId: ctx.run_id ?? null,
        taskId: ctx.task_id ?? null,
        projectId: ctx.project_id ?? null,
        requestedBy: ctx.actor,
      });
      await audit(ctx, "tool.pending_approval", name, { approvalId: approval.id, args: parsed.data });
      return { status: "pending_approval", approval_id: approval.id };
    }

    return runHandler(ctx, tool, parsed.data);
  }

  /**
   * Reanudación tras Gate 2 (la llama el despachador B4): ejecuta el payload
   * LITERAL de una aprobación tool_call aprobada. El digest debe seguir
   * coincidiendo — cambiar argumentos invalida la aprobación.
   */
  async function executeApproved(ctx: ToolCallContext, approvalId: string): Promise<GatewayResult> {
    const approval = await getApproval(db, approvalId);
    if (!approval) throw errors.notFound("approval", approvalId);
    if (approval.kind !== "tool_call") {
      throw errors.validation(`La aprobación ${approvalId} no es de tipo tool_call`);
    }
    if (approval.status !== "approved") {
      throw new AgentosError(
        ErrorCodes.HUMAN_APPROVAL_REQUIRED,
        `La aprobación ${approvalId} está "${approval.status}": no se ejecuta`,
        { approvalId, status: approval.status },
      );
    }
    if (digestPayload(approval.payload) !== approval.actionDigest) {
      throw new AgentosError(
        ErrorCodes.APPROVAL_INVALIDATED,
        "El payload no coincide con el digest aprobado: ejecución rechazada",
        { approvalId },
      );
    }
    const payload = approval.payload as { tool?: string; args?: unknown };
    if (!payload.tool || typeof payload.tool !== "string") {
      throw errors.validation(`Payload de aprobación sin tool: ${approvalId}`);
    }
    const tool = catalog.get(payload.tool);
    if (!tool) {
      return await deny(ctx, payload.tool, ErrorCodes.POLICY_DENIED, `Tool desconocida en aprobación: ${payload.tool}`);
    }
    const parsed = tool.schema.safeParse(payload.args ?? {});
    if (!parsed.success) {
      throw errors.validation(`Argumentos aprobados inválidos para ${payload.tool}`, parsed.error.issues);
    }
    // Una aprobación vieja tampoco ejecuta fuera del scope del ctx que reanuda.
    await checkProjectScope(ctx, tool, parsed.data);
    await audit(ctx, "tool.execute_approved", tool.name, { approvalId, args: parsed.data });
    try {
      const result = await tool.handler(execCtx(ctx), parsed.data as never);
      return { status: "ok", result };
    } catch (err) {
      await audit(ctx, "tool.error", tool.name, {
        approvalId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  return { catalog, engine, db, execute, executeApproved };
}
