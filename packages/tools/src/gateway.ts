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

  function audit(
    ctx: ToolCallContext,
    action: string,
    toolName: string,
    detail: Record<string, unknown>,
  ): void {
    appendAudit(db, {
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
  function deny(ctx: ToolCallContext, toolName: string, code: (typeof ErrorCodes)[keyof typeof ErrorCodes], message: string): never {
    audit(ctx, "tool.denied", toolName, { code, message });
    throw new AgentosError(code, message, { tool: toolName });
  }

  function resolveAgent(ref: string): Agent | undefined {
    return getAgent(db, ref) ?? getAgentBySlug(db, ref);
  }

  /** Política previa a TODA ejecución. Devuelve la tool resuelta y el agente. */
  function checkPolicy(ctx: ToolCallContext, name: string): { tool: ToolDefinition; agent: Agent | null } {
    const tool = catalog.get(name);
    if (!tool) deny(ctx, name, ErrorCodes.POLICY_DENIED, `Tool desconocida: ${name} (fail-closed)`);

    // Kill switch global: nada ejecuta.
    if (engine.isKillSwitchActive()) {
      deny(ctx, name, ErrorCodes.KILL_SWITCH_ACTIVE, "Kill switch activo: ejecución de tools detenida");
    }

    // Los actores humanos/sistema pasan por gateway con su propia atribución;
    // la allowlist aplica a AGENTES (ARCHITECTURE §4).
    if (actorKind(ctx.actor) !== "agent") return { tool, agent: null };

    const agent = resolveAgent(ctx.agent_id);
    if (!agent) {
      deny(ctx, name, ErrorCodes.POLICY_DENIED, `Agente desconocido: ${ctx.agent_id} (fail-closed)`);
    }
    if (agent.status !== "active") {
      deny(ctx, name, ErrorCodes.POLICY_DENIED, `Agente ${agent.slug} está "${agent.status}": tools bloqueadas`);
    }
    const allowlist = agent.toolsAllowlist ?? [];
    if (!allowlist.includes(name)) {
      deny(
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
    audit(ctx, "tool.execute", tool.name, { args: args as Record<string, unknown> });
    try {
      const result = await tool.handler(execCtx(ctx), args as never);
      return { status: "ok", result };
    } catch (err) {
      // Segunda fila si falla (patrón §4).
      audit(ctx, "tool.error", tool.name, {
        error: err instanceof Error ? err.message : String(err),
        code: err instanceof AgentosError ? err.code : undefined,
      });
      throw err;
    }
  }

  async function execute(ctx: ToolCallContext, name: string, rawArgs: unknown): Promise<GatewayResult> {
    const { tool } = checkPolicy(ctx, name);

    const parsed = tool.schema.safeParse(rawArgs ?? {});
    if (!parsed.success) {
      throw errors.validation(`Argumentos inválidos para ${name}`, parsed.error.issues);
    }

    // Gate 2: tool de efecto externo NO ejecuta — crea approval y cede al humano.
    if (tool.flags.external_effect || tool.flags.requires_approval) {
      const approval = engine.requestApproval({
        kind: "tool_call",
        payload: { tool: name, args: parsed.data },
        runId: ctx.run_id ?? null,
        taskId: ctx.task_id ?? null,
        projectId: ctx.project_id ?? null,
        requestedBy: ctx.actor,
      });
      audit(ctx, "tool.pending_approval", name, { approvalId: approval.id, args: parsed.data });
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
    const approval = getApproval(db, approvalId);
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
      deny(ctx, payload.tool, ErrorCodes.POLICY_DENIED, `Tool desconocida en aprobación: ${payload.tool}`);
    }
    const parsed = tool.schema.safeParse(payload.args ?? {});
    if (!parsed.success) {
      throw errors.validation(`Argumentos aprobados inválidos para ${payload.tool}`, parsed.error.issues);
    }
    audit(ctx, "tool.execute_approved", tool.name, { approvalId, args: parsed.data });
    try {
      const result = await tool.handler(execCtx(ctx), parsed.data as never);
      return { status: "ok", result };
    } catch (err) {
      audit(ctx, "tool.error", tool.name, {
        approvalId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  return { catalog, engine, db, execute, executeApproved };
}
