/**
 * Tools de agentes y prompts (US-8 / ARCHITECTURE §7).
 *
 * Regla central: actualizar el prompt CREA una fila en prompt_versions y la
 * activa — NUNCA se sobrescribe una versión (CA-8.2). Rollback = activar una
 * versión anterior. `expected_version` obligatoria en toda mutación de agents.
 */
import { z } from "zod";
import {
  AgentAutonomy,
  AgentLayer,
  AgentosError,
  AgentRuntime,
  AgentStatus,
  errors,
  ErrorCodes,
} from "@agentos/shared";
import {
  activatePromptVersion,
  createAgent,
  createPromptVersion,
  getActivePrompt,
  getAgent,
  getAgentBySlug,
  getPromptVersion,
  listAgents,
  listPromptVersions,
  updateAgent,
  type Agent,
  type AgentosDb,
  type PromptVersion,
} from "@agentos/db";
import { assemblePrompt, assertNoCycle, computeOrgChainHealth, orgForCompany } from "@agentos/core";
import { auditMutation, findIdempotentMutation } from "../context.js";
import { defineAdminTool as def, type AdminToolDefinition } from "../registry.js";
import { resolveAgentRef, resolveProviderRef } from "../resolve.js";
import { unifiedDiff } from "../diff.js";

const Reason = z.string().max(2000).optional();
const IdempotencyKey = z.string().min(1).max(200).optional();

const PromptInput = z.object({
  stable: z.string().min(1),
  context: z.string().nullable().optional(),
  volatile_tpl: z.string().nullable().optional(),
  changelog: z.string().optional(),
});

/** Campos del agente que viajan en before/after de auditoría. */
function agentAuditFields(agent: Agent): Record<string, unknown> {
  return {
    slug: agent.slug,
    name: agent.name,
    model: agent.model,
    runtime: agent.runtime,
    autonomy: agent.autonomy,
    status: agent.status,
    reportsTo: agent.reportsTo,
    providerProfileId: agent.providerProfileId,
    toolsAllowlist: agent.toolsAllowlist,
    mcpAllowlist: agent.mcpAllowlist,
    limits: agent.limits,
    activePromptVersionId: agent.activePromptVersionId,
    version: agent.version,
  };
}

async function mustGetPromptVersionByNumber(
  db: AgentosDb,
  agent: Agent,
  version: number,
): Promise<PromptVersion> {
  const versions = await listPromptVersions(db, agent.id);
  const pv = versions.find((v) => v.version === version);
  if (!pv) throw errors.notFound("prompt_version", `${agent.slug} v${version}`);
  return pv;
}

function composePromptText(pv: PromptVersion): string {
  return [
    "# stable",
    pv.stable,
    "",
    "# context",
    pv.context ?? "",
    "",
    "# volatile_tpl",
    pv.volatileTpl ?? "",
  ].join("\n");
}

export const agentTools: AdminToolDefinition[] = [
  def({
    name: "agentos.agents.list",
    description: "Lista los agentes registrados (slug, runtime, modelo, estado, versión).",
    schema: z.object({ status: AgentStatus.optional() }),
    readOnly: true,
    async handler(ctx, args) {
      const all = await listAgents(ctx.db);
      return args.status ? all.filter((a) => a.status === args.status) : all;
    },
  }),

  def({
    name: "agentos.agents.get",
    description: "Devuelve un agente (por id o slug) con su prompt activo y el nº de versiones.",
    schema: z.object({ agent: z.string().min(1) }),
    readOnly: true,
    async handler(ctx, args) {
      const agent = await resolveAgentRef(ctx.db, args.agent);
      const active = await getActivePrompt(ctx.db, agent.id);
      const versions = await listPromptVersions(ctx.db, agent.id);
      return {
        agent,
        active_prompt: active ?? null,
        prompt_versions: versions.length,
      };
    },
  }),

  def({
    name: "agentos.agents.create",
    description:
      "Crea un agente nuevo. Si se incluye `prompt`, se crea como prompt_versions v1 y se activa.",
    schema: z.object({
      slug: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/, "slug en minúsculas"),
      name: z.string().min(1),
      layer: AgentLayer,
      runtime: AgentRuntime,
      model: z.string().optional(),
      provider_profile: z.string().optional(),
      tools_allowlist: z.array(z.string()).optional(),
      mcp_allowlist: z.array(z.string()).optional(),
      limits: z.record(z.string(), z.unknown()).optional(),
      autonomy: AgentAutonomy.optional(),
      prompt: PromptInput.optional(),
      reason: Reason,
      idempotency_key: IdempotencyKey,
    }),
    readOnly: false,
    async handler(ctx, args) {
      const previous = await findIdempotentMutation(ctx, "agents.create", args.idempotency_key);
      if (previous?.entityId) {
        const existing = await getAgent(ctx.db, previous.entityId);
        if (existing) return { agent: existing, idempotent: true };
      }
      if (await getAgentBySlug(ctx.db, args.slug)) {
        throw new AgentosError(ErrorCodes.CONFLICT, `Ya existe un agente con slug "${args.slug}"`);
      }
      const provider = args.provider_profile
        ? await resolveProviderRef(ctx.db, args.provider_profile)
        : undefined;
      const created = await createAgent(ctx.db, {
        slug: args.slug,
        name: args.name,
        layer: args.layer,
        runtime: args.runtime,
        model: args.model ?? null,
        providerProfileId: provider?.id ?? null,
        toolsAllowlist: args.tools_allowlist ?? [],
        mcpAllowlist: args.mcp_allowlist ?? [],
        limits: args.limits ?? null,
        autonomy: args.autonomy ?? "supervised",
        status: "active",
      });
      let promptVersion: PromptVersion | null = null;
      if (args.prompt) {
        promptVersion = await createPromptVersion(ctx.db, {
          agentId: created.id,
          stable: args.prompt.stable,
          context: args.prompt.context ?? null,
          volatileTpl: args.prompt.volatile_tpl ?? null,
          changelog: args.prompt.changelog ?? "Prompt inicial (agents.create via MCP)",
          createdBy: ctx.actor,
        });
      }
      const agent = (await getAgent(ctx.db, created.id))!;
      await auditMutation(ctx, {
        action: "agents.create",
        entityType: "agent",
        entityId: agent.id,
        before: null,
        after: agentAuditFields(agent),
        reason: args.reason,
        idempotencyKey: args.idempotency_key,
      });
      return { agent, prompt_version: promptVersion };
    },
  }),

  def({
    name: "agentos.agents.update",
    description:
      "Actualiza un agente con expected_version (conflicto → error explícito). " +
      "`patch` cubre model/runtime/allowlists/limits/autonomy/provider; `prompt` CREA " +
      "una versión nueva en prompt_versions y la activa — jamás sobrescribe.",
    schema: z.object({
      agent: z.string().min(1),
      expected_version: z.number().int().positive(),
      patch: z
        .object({
          name: z.string().min(1).optional(),
          model: z.string().nullable().optional(),
          runtime: AgentRuntime.optional(),
          autonomy: AgentAutonomy.optional(),
          provider_profile: z.string().nullable().optional(),
          tools_allowlist: z.array(z.string()).optional(),
          mcp_allowlist: z.array(z.string()).optional(),
          limits: z.record(z.string(), z.unknown()).nullable().optional(),
        })
        .optional(),
      prompt: PromptInput.optional(),
      reason: Reason,
    }),
    readOnly: false,
    async handler(ctx, args) {
      const agent = await resolveAgentRef(ctx.db, args.agent);
      if (agent.version !== args.expected_version) {
        throw errors.versionConflict("agent", agent.id, args.expected_version);
      }
      const hasPatch = args.patch !== undefined && Object.keys(args.patch).length > 0;
      if (!hasPatch && !args.prompt) {
        throw errors.validation("agents.update sin `patch` ni `prompt`: nada que hacer");
      }
      const before = agentAuditFields(agent);

      if (hasPatch) {
        const p = args.patch!;
        const patch: Partial<Agent> = {};
        if (p.name !== undefined) patch.name = p.name;
        if (p.model !== undefined) patch.model = p.model;
        if (p.runtime !== undefined) patch.runtime = p.runtime;
        if (p.autonomy !== undefined) patch.autonomy = p.autonomy;
        if (p.tools_allowlist !== undefined) patch.toolsAllowlist = p.tools_allowlist;
        if (p.mcp_allowlist !== undefined) patch.mcpAllowlist = p.mcp_allowlist;
        if (p.limits !== undefined) patch.limits = p.limits;
        if (p.provider_profile !== undefined) {
          patch.providerProfileId =
            p.provider_profile === null ? null : (await resolveProviderRef(ctx.db, p.provider_profile)).id;
        }
        await updateAgent(ctx.db, agent.id, patch, args.expected_version);
      }

      let promptVersion: PromptVersion | null = null;
      if (args.prompt) {
        promptVersion = await createPromptVersion(ctx.db, {
          agentId: agent.id,
          stable: args.prompt.stable,
          context: args.prompt.context ?? null,
          volatileTpl: args.prompt.volatile_tpl ?? null,
          changelog: args.prompt.changelog ?? `Actualización de prompt via MCP (${ctx.actor})`,
          createdBy: ctx.actor,
        });
      }

      const updated = (await getAgent(ctx.db, agent.id))!;
      await auditMutation(ctx, {
        action: "agents.update",
        entityType: "agent",
        entityId: agent.id,
        before,
        after: {
          ...agentAuditFields(updated),
          ...(promptVersion
            ? { promptVersionId: promptVersion.id, promptVersionNumber: promptVersion.version }
            : {}),
        },
        reason: args.reason,
      });
      return { agent: updated, prompt_version: promptVersion };
    },
  }),

  def({
    name: "agentos.agents.set_status",
    description: "Cambia el estado de un agente (active|paused|disabled) con expected_version.",
    schema: z.object({
      agent: z.string().min(1),
      status: AgentStatus,
      expected_version: z.number().int().positive(),
      reason: Reason,
    }),
    readOnly: false,
    async handler(ctx, args) {
      const agent = await resolveAgentRef(ctx.db, args.agent);
      const before = { status: agent.status, version: agent.version };
      const updated = await updateAgent(ctx.db, agent.id, { status: args.status }, args.expected_version);
      await auditMutation(ctx, {
        action: "agents.set_status",
        entityType: "agent",
        entityId: agent.id,
        before,
        after: { status: updated.status, version: updated.version },
        reason: args.reason,
      });
      return updated;
    },
  }),

  def({
    name: "agentos.agents.set_manager",
    description:
      "Fija el manager de un agente en el organigrama (Fase 2): `manager` = slug/id de otro " +
      "agente, o null para hacerlo raíz. Rechaza ciclos (agent_not_assignable, reason=cycle) y " +
      "exige expected_version. La salud de la cadena resultante gobierna la asignabilidad.",
    schema: z.object({
      agent: z.string().min(1),
      manager: z.string().min(1).nullable(),
      expected_version: z.number().int().positive(),
      reason: Reason,
    }),
    readOnly: false,
    async handler(ctx, args) {
      const agent = await resolveAgentRef(ctx.db, args.agent);
      if (agent.version !== args.expected_version) {
        throw errors.versionConflict("agent", agent.id, args.expected_version);
      }
      const managerId =
        args.manager === null ? null : (await resolveAgentRef(ctx.db, args.manager)).id;
      // Anti-ciclo ANTES de escribir (fail-closed): jamás se persiste un organigrama roto.
      await assertNoCycle(ctx.db, agent.id, managerId);
      const before = { reportsTo: agent.reportsTo, version: agent.version };
      const updated = await updateAgent(ctx.db, agent.id, { reportsTo: managerId }, args.expected_version);
      await auditMutation(ctx, {
        action: "agents.set_manager",
        entityType: "agent",
        entityId: agent.id,
        before,
        after: { reportsTo: updated.reportsTo, version: updated.version },
        reason: args.reason,
      });
      return { agent: updated, chain_health: await computeOrgChainHealth(ctx.db, updated.id) };
    },
  }),

  def({
    name: "agentos.agents.org",
    description:
      "Organigrama de la empresa (Fase 2) como bosque agrupado por manager, más la salud de la " +
      "cadena de cada agente (healthy | terminated_ancestor | missing_manager | cycle).",
    schema: z.object({}),
    readOnly: true,
    async handler(ctx) {
      const agents = await listAgents(ctx.db);
      const health = [];
      for (const a of agents) {
        health.push({
          slug: a.slug,
          status: a.status,
          reportsTo: a.reportsTo,
          chain: await computeOrgChainHealth(ctx.db, a.id),
        });
      }
      return {
        tree: await orgForCompany(ctx.db),
        health,
      };
    },
  }),

  def({
    name: "agentos.agents.clone",
    description:
      "Clona un agente con slug nuevo; el prompt activo del origen se copia como v1 del clon.",
    schema: z.object({
      agent: z.string().min(1),
      new_slug: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/, "slug en minúsculas"),
      new_name: z.string().min(1).optional(),
      reason: Reason,
      idempotency_key: IdempotencyKey,
    }),
    readOnly: false,
    async handler(ctx, args) {
      const previous = await findIdempotentMutation(ctx, "agents.clone", args.idempotency_key);
      if (previous?.entityId) {
        const existing = await getAgent(ctx.db, previous.entityId);
        if (existing) return { agent: existing, idempotent: true };
      }
      const source = await resolveAgentRef(ctx.db, args.agent);
      if (await getAgentBySlug(ctx.db, args.new_slug)) {
        throw new AgentosError(ErrorCodes.CONFLICT, `Ya existe un agente con slug "${args.new_slug}"`);
      }
      const clone = await createAgent(ctx.db, {
        slug: args.new_slug,
        name: args.new_name ?? `${source.name} (clon)`,
        layer: source.layer,
        runtime: source.runtime,
        model: source.model,
        providerProfileId: source.providerProfileId,
        toolsAllowlist: source.toolsAllowlist,
        mcpAllowlist: source.mcpAllowlist,
        limits: source.limits,
        autonomy: source.autonomy,
        status: source.status,
      });
      const activePrompt = await getActivePrompt(ctx.db, source.id);
      let promptVersion: PromptVersion | null = null;
      if (activePrompt) {
        promptVersion = await createPromptVersion(ctx.db, {
          agentId: clone.id,
          stable: activePrompt.stable,
          context: activePrompt.context,
          volatileTpl: activePrompt.volatileTpl,
          changelog: `Clonado de ${source.slug} v${activePrompt.version} via MCP`,
          createdBy: ctx.actor,
        });
      }
      const agent = (await getAgent(ctx.db, clone.id))!;
      await auditMutation(ctx, {
        action: "agents.clone",
        entityType: "agent",
        entityId: agent.id,
        before: null,
        after: { ...agentAuditFields(agent), clonedFrom: source.id },
        reason: args.reason,
        idempotencyKey: args.idempotency_key,
      });
      return { agent, prompt_version: promptVersion, cloned_from: source.slug };
    },
  }),

  def({
    name: "agentos.agents.test",
    description:
      "DRY-RUN sandbox: ensambla el prompt de 3 capas (stable/context/volatile) del agente " +
      "con @agentos/core y lo devuelve SIN llamar a ningún LLM.",
    schema: z.object({
      agent: z.string().min(1),
      project_id: z.string().optional(),
      task_id: z.string().optional(),
      methodology_slug: z.string().optional(),
    }),
    readOnly: true,
    async handler(ctx, args) {
      const agent = await resolveAgentRef(ctx.db, args.agent);
      const assembled = await assemblePrompt(ctx.db, {
        agent,
        project: args.project_id ?? null,
        task: args.task_id ?? null,
        methodologySlug: args.methodology_slug,
      });
      return {
        dry_run: true,
        note: "DRY-RUN: prompt ensamblado por packages/core. NO se llamó a ningún LLM y no se creó ningún run.",
        agent: { id: agent.id, slug: agent.slug, runtime: agent.runtime, model: agent.model },
        layers: {
          stable: assembled.stable,
          context: assembled.context,
          volatile: assembled.volatile,
        },
        full: assembled.full,
      };
    },
  }),
];

export const promptTools: AdminToolDefinition[] = [
  def({
    name: "agentos.prompts.list",
    description: "Lista las versiones de prompt de un agente (la activa marcada).",
    schema: z.object({ agent: z.string().min(1) }),
    readOnly: true,
    async handler(ctx, args) {
      const agent = await resolveAgentRef(ctx.db, args.agent);
      const versions = await listPromptVersions(ctx.db, agent.id);
      return {
        agent: { id: agent.id, slug: agent.slug },
        active_prompt_version_id: agent.activePromptVersionId,
        versions: versions.map((v) => ({
          id: v.id,
          version: v.version,
          changelog: v.changelog,
          created_by: v.createdBy,
          created_at: v.createdAt,
          active: v.id === agent.activePromptVersionId,
        })),
      };
    },
  }),

  def({
    name: "agentos.prompts.get",
    description: "Devuelve una versión de prompt completa: por id, o por (agent, version).",
    schema: z.object({
      prompt_version_id: z.string().optional(),
      agent: z.string().optional(),
      version: z.number().int().positive().optional(),
    }),
    readOnly: true,
    async handler(ctx, args) {
      if (args.prompt_version_id) {
        const pv = await getPromptVersion(ctx.db, args.prompt_version_id);
        if (!pv) throw errors.notFound("prompt_version", args.prompt_version_id);
        return pv;
      }
      if (!args.agent || args.version === undefined) {
        throw errors.validation("prompts.get exige prompt_version_id, o agent + version");
      }
      const agent = await resolveAgentRef(ctx.db, args.agent);
      return await mustGetPromptVersionByNumber(ctx.db, agent, args.version);
    },
  }),

  def({
    name: "agentos.prompts.diff",
    description:
      "Diff unificado entre dos versiones de prompt de un agente (capas stable/context/volatile_tpl).",
    schema: z.object({
      agent: z.string().min(1),
      from_version: z.number().int().positive(),
      to_version: z.number().int().positive(),
      context_lines: z.number().int().min(0).max(20).optional(),
    }),
    readOnly: true,
    async handler(ctx, args) {
      const agent = await resolveAgentRef(ctx.db, args.agent);
      const from = await mustGetPromptVersionByNumber(ctx.db, agent, args.from_version);
      const to = await mustGetPromptVersionByNumber(ctx.db, agent, args.to_version);
      const unified = unifiedDiff(composePromptText(from), composePromptText(to), {
        fromLabel: `${agent.slug}/prompt v${from.version}`,
        toLabel: `${agent.slug}/prompt v${to.version}`,
        context: args.context_lines,
      });
      return {
        agent: agent.slug,
        from_version: from.version,
        to_version: to.version,
        identical: unified === "",
        unified,
      };
    },
  }),

  def({
    name: "agentos.prompts.rollback",
    description:
      "Rollback: activa una versión ANTERIOR del prompt (nada se borra ni sobrescribe). " +
      "expected_version protege contra carreras sobre el agente.",
    schema: z.object({
      agent: z.string().min(1),
      to_version: z.number().int().positive(),
      expected_version: z.number().int().positive(),
      reason: Reason,
    }),
    readOnly: false,
    async handler(ctx, args) {
      const agent = await resolveAgentRef(ctx.db, args.agent);
      if (agent.version !== args.expected_version) {
        throw errors.versionConflict("agent", agent.id, args.expected_version);
      }
      const target = await mustGetPromptVersionByNumber(ctx.db, agent, args.to_version);
      const before = { activePromptVersionId: agent.activePromptVersionId };
      const updated = await activatePromptVersion(ctx.db, agent.id, target.id);
      await auditMutation(ctx, {
        action: "prompts.rollback",
        entityType: "agent",
        entityId: agent.id,
        before,
        after: { activePromptVersionId: updated.activePromptVersionId, toVersion: target.version },
        reason: args.reason,
      });
      return { agent: updated, activated: target };
    },
  }),
];
