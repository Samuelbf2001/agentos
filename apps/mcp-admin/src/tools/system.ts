/**
 * Config (claves permitidas), kill switch (pause_all/resume_all via core),
 * health, people y auditoría (query + revert).
 *
 * NO existen tools de secretos, SQL arbitrario ni hard delete — a propósito
 * (ARCHITECTURE §7, riesgo 5: el MCP admin como superficie de escalada).
 */
import { z } from "zod";
import {
  errors,
  parseProjectBudget,
  projectIdFromBudgetKey,
  PROJECT_BUDGET_KEY_PREFIX,
} from "@agentos/shared";
import {
  ConfigKeys,
  countDomainTables,
  createPerson,
  getAuditEntry,
  getAgent,
  getConfig,
  getPersonByFullName,
  getProject,
  getProviderProfile,
  getTask,
  listAgents,
  listConfig,
  listPeople,
  listTasks,
  queryAudit,
  setConfig,
  sumRunCostForProject,
  updateAgent,
  updatePerson,
  updateProject,
  updateTask,
  upsertProviderProfile,
  type Agent,
  type Project,
  type Task,
} from "@agentos/db";
import { auditMutation, mustGetPerson, type AdminContext } from "../context.js";
import { defineAdminTool as def, type AdminToolDefinition } from "../registry.js";

const Reason = z.string().max(2000).optional();

/** Claves editables por config.set (kill switch va por system.pause_all/resume_all). */
export const ALLOWED_CONFIG_KEYS: ReadonlySet<string> = new Set([
  "agents_enabled",
  ConfigKeys.BUDGET_MAX_COST_PER_RUN_USD,
  ConfigKeys.BUDGET_MAX_COST_PER_DAY_USD,
  "semaphore_claude_code",
  "semaphore_ai_sdk",
]);

/** §13.4: `budget:project:<projectId>` — presupuesto de fase editable por humano vía MCP. */
export const PROJECT_BUDGET_KEY_RE = /^budget:project:\S+$/;

/** Shape exigido al valor de `budget:project:*` (validación fail-closed en config.set). */
export const ProjectBudgetValue = z.strictObject({
  phase_usd: z.number().positive(),
  per_run_usd: z.number().positive(),
  warning_thresholds_pct: z.array(z.number().gt(0).max(100)).min(1).optional(),
  launch_id: z.string().min(1).nullable().optional(),
});

export const configTools: AdminToolDefinition[] = [
  def({
    name: "agentos.config.get",
    description: "Lee app_config: una clave concreta o todas.",
    schema: z.object({ key: z.string().optional() }),
    readOnly: true,
    async handler(ctx, args) {
      if (args.key) return { key: args.key, value: (await getConfig(ctx.db, args.key)) ?? null };
      return await listConfig(ctx.db);
    },
  }),

  def({
    name: "agentos.config.set",
    description:
      `Escribe una clave PERMITIDA de app_config (${[...ALLOWED_CONFIG_KEYS].join(", ")}, ` +
      `${PROJECT_BUDGET_KEY_PREFIX}<projectId>). Las claves budget:project:* exigen ` +
      "{phase_usd>0, per_run_usd>0, warning_thresholds_pct?, launch_id?}. " +
      "El kill switch se maneja con system.pause_all/resume_all.",
    schema: z.object({
      key: z.string().min(1),
      value: z.union([
        z.boolean(),
        z.number(),
        z.string(),
        z.null(),
        z.record(z.string(), z.unknown()),
      ]),
      reason: Reason,
    }),
    readOnly: false,
    async handler(ctx, args) {
      const isBudgetKey = PROJECT_BUDGET_KEY_RE.test(args.key);
      if (!isBudgetKey && !ALLOWED_CONFIG_KEYS.has(args.key)) {
        throw errors.validation(
          `Clave de config no permitida: "${args.key}" ` +
            `(permitidas: ${[...ALLOWED_CONFIG_KEYS].join(", ")}, ${PROJECT_BUDGET_KEY_PREFIX}<projectId>)`,
          { key: args.key },
        );
      }
      let value: unknown = args.value;
      if (isBudgetKey) {
        // §13.4: shape del presupuesto validado fail-closed — un tope corrupto
        // escrito a mano jamás llega al despachador.
        const parsed = ProjectBudgetValue.safeParse(args.value);
        if (!parsed.success) {
          throw errors.validation(
            `Valor inválido para "${args.key}": se exige ` +
              "{phase_usd>0, per_run_usd>0, warning_thresholds_pct? (1..100), launch_id?}",
            parsed.error.issues,
          );
        }
        value = parsed.data;
      } else if (typeof args.value === "object" && args.value !== null) {
        throw errors.validation(
          `La clave "${args.key}" solo acepta valores escalares (boolean|number|string|null)`,
          { key: args.key },
        );
      }
      const before = { value: (await getConfig(ctx.db, args.key)) ?? null };
      await setConfig(ctx.db, args.key, value);
      await auditMutation(ctx, {
        action: "config.set",
        entityType: "app_config",
        entityId: args.key,
        before,
        after: { value },
        reason: args.reason,
      });
      return { key: args.key, value };
    },
  }),

  def({
    name: "agentos.system.pause_all",
    description:
      "Kill switch ON: ningún agente arranca trabajo nuevo (los runs vivos los corta la API). Core audita.",
    schema: z.object({ reason: Reason }),
    readOnly: false,
    async handler(ctx, args) {
      await ctx.engine.setKillSwitch(true, ctx.actor, args.reason);
      return { kill_switch: true };
    },
  }),

  def({
    name: "agentos.system.resume_all",
    description: "Kill switch OFF: los agentes vuelven a poder tomar trabajo. Core audita.",
    schema: z.object({ reason: Reason }),
    readOnly: false,
    async handler(ctx, args) {
      await ctx.engine.setKillSwitch(false, ctx.actor, args.reason);
      return { kill_switch: false };
    },
  }),

  def({
    name: "agentos.system.health",
    description:
      "Salud del sistema: DB ok, conteos básicos, kill switch, perfil activo y " +
      "presupuestos de fase activos por proyecto (budget:project:*, con gasto acumulado).",
    schema: z.object({}),
    readOnly: true,
    async handler(ctx) {
      const tables = await countDomainTables(ctx.db);
      // §13.4: presupuestos de proyecto declarados por launches (o editados por
      // humano). Cálculo de umbrales de aviso aquí — el "lugar natural", sin UI.
      const configRows = (await listConfig(ctx.db)).filter(
        (row) => projectIdFromBudgetKey(row.key) !== null,
      );
      const projectBudgets = [];
      for (const row of configRows) {
        const projectId = projectIdFromBudgetKey(row.key)!;
        const budget = parseProjectBudget(row.value);
        const spent = await sumRunCostForProject(ctx.db, projectId);
        const phaseUsd = budget?.phaseUsd ?? null;
        const pctUsed = phaseUsd !== null ? Math.round((spent / phaseUsd) * 100) : null;
        const thresholds = budget?.warningThresholdsPct ?? [];
        projectBudgets.push({
          project_id: projectId,
          phase_usd: phaseUsd,
          per_run_usd: budget?.perRunUsd ?? null,
          launch_id: budget?.launchId ?? null,
          spent_usd: spent,
          pct_used: pctUsed,
          warning_thresholds_pct: thresholds,
          warnings_reached: pctUsed !== null ? thresholds.filter((t) => pctUsed >= t) : [],
          exhausted: phaseUsd !== null && spent >= phaseUsd,
        });
      }
      const agents = await listAgents(ctx.db);
      const tasks = await listTasks(ctx.db);
      const pendingApprovals = await ctx.engine.listPendingApprovals();
      return {
        status: "ok",
        db_ok: tables > 0,
        tables,
        agents: agents.length,
        tasks: tasks.length,
        pending_approvals: pendingApprovals.length,
        kill_switch_active: await ctx.engine.isKillSwitchActive(),
        project_budgets: projectBudgets,
        profile: ctx.profile,
        actor: ctx.actor,
      };
    },
  }),
];

export const peopleTools: AdminToolDefinition[] = [
  def({
    name: "agentos.people.list",
    description: "Lista personas (opcionalmente por organización).",
    schema: z.object({ org_id: z.string().optional() }),
    readOnly: true,
    async handler(ctx, args) {
      return await listPeople(ctx.db, args.org_id);
    },
  }),

  def({
    name: "agentos.people.upsert",
    description:
      "Crea o actualiza una persona: por id, o por nombre completo (crear exige org_id).",
    schema: z.object({
      id: z.string().optional(),
      org_id: z.string().optional(),
      full_name: z.string().min(1),
      email: z.string().email().nullable().optional(),
      role: z.string().nullable().optional(),
      is_internal: z.boolean().optional(),
      reason: Reason,
    }),
    readOnly: false,
    async handler(ctx, args) {
      const existing = args.id
        ? await mustGetPerson(ctx.db, args.id)
        : await getPersonByFullName(ctx.db, args.full_name);
      if (existing) {
        const before = {
          fullName: existing.fullName,
          email: existing.email,
          role: existing.role,
          isInternal: existing.isInternal,
        };
        const updated = await updatePerson(ctx.db, existing.id, {
          fullName: args.full_name,
          ...(args.email !== undefined ? { email: args.email } : {}),
          ...(args.role !== undefined ? { role: args.role } : {}),
          ...(args.is_internal !== undefined ? { isInternal: args.is_internal } : {}),
        });
        await auditMutation(ctx, {
          action: "people.upsert",
          entityType: "person",
          entityId: updated.id,
          before,
          after: {
            fullName: updated.fullName,
            email: updated.email,
            role: updated.role,
            isInternal: updated.isInternal,
          },
          reason: args.reason,
        });
        return { person: updated, created: false };
      }
      if (!args.org_id) {
        throw errors.validation("people.upsert: crear una persona nueva exige org_id");
      }
      const person = await createPerson(ctx.db, {
        orgId: args.org_id,
        fullName: args.full_name,
        email: args.email ?? null,
        role: args.role ?? null,
        isInternal: args.is_internal ?? false,
      });
      await auditMutation(ctx, {
        action: "people.upsert",
        entityType: "person",
        entityId: person.id,
        before: null,
        after: {
          fullName: person.fullName,
          email: person.email,
          role: person.role,
          isInternal: person.isInternal,
        },
        reason: args.reason,
      });
      return { person, created: true };
    },
  }),
];

// ── Auditoría ───────────────────────────────────────────────────────────────

/** Campos revertibles por entidad — un revert es un patch de DATOS, jamás un salto de máquina de estados. */
const REVERTIBLE_FIELDS: Record<string, readonly string[]> = {
  agent: [
    "name",
    "model",
    "runtime",
    "autonomy",
    "status",
    "providerProfileId",
    "toolsAllowlist",
    "mcpAllowlist",
    "limits",
    "activePromptVersionId",
  ],
  task: [
    "title",
    "description",
    "definitionOfDone",
    "activityType",
    "priority",
    "assigneeAgentId",
    "assigneePersonId",
    "orderKey",
  ],
  project: ["name", "stage", "gateState", "workspacePath"],
  provider_profile: [
    "name",
    "kind",
    "baseUrl",
    "apiKeyEnv",
    "costInputPerMtok",
    "costOutputPerMtok",
    "isDefault",
  ],
};

function pickRevertible(
  entityType: string,
  before: Record<string, unknown>,
): { applied: Record<string, unknown>; ignored: string[] } {
  const allowed = REVERTIBLE_FIELDS[entityType] ?? [];
  const applied: Record<string, unknown> = {};
  const ignored: string[] = [];
  for (const [key, value] of Object.entries(before)) {
    if (allowed.includes(key)) applied[key] = value;
    else ignored.push(key);
  }
  return { applied, ignored };
}

async function applyRevert(
  ctx: AdminContext,
  entityType: string,
  entityId: string,
  before: Record<string, unknown>,
): Promise<{ applied: Record<string, unknown>; ignored: string[] }> {
  const { applied, ignored } = pickRevertible(entityType, before);

  switch (entityType) {
    case "agent": {
      const agent = await getAgent(ctx.db, entityId);
      if (!agent) throw errors.notFound("agent", entityId);
      if (Object.keys(applied).length === 0) break;
      await updateAgent(ctx.db, agent.id, applied as Partial<Agent>, agent.version);
      break;
    }
    case "task": {
      const task = await getTask(ctx.db, entityId);
      if (!task) throw errors.notFound("task", entityId);
      if (Object.keys(applied).length === 0) break;
      await updateTask(ctx.db, task.id, applied as Partial<Task>, task.version);
      break;
    }
    case "project": {
      const project = await getProject(ctx.db, entityId);
      if (!project) throw errors.notFound("project", entityId);
      if (Object.keys(applied).length === 0) break;
      await updateProject(ctx.db, project.id, applied as Partial<Project>, project.version);
      break;
    }
    case "provider_profile": {
      const profile = await getProviderProfile(ctx.db, entityId);
      if (!profile) throw errors.notFound("provider_profile", entityId);
      await upsertProviderProfile(ctx.db, { ...profile, ...applied, slug: profile.slug });
      break;
    }
    case "app_config": {
      if (entityId === ConfigKeys.KILL_SWITCH) {
        // El estado anterior del kill switch se restaura por el camino auditado de core.
        await ctx.engine.setKillSwitch(before.active === true, ctx.actor, "audit.revert");
        return { applied: { active: before.active === true }, ignored: [] };
      }
      if (!ALLOWED_CONFIG_KEYS.has(entityId) && !PROJECT_BUDGET_KEY_RE.test(entityId)) {
        throw errors.validation(`audit.revert: clave de config no permitida: "${entityId}"`);
      }
      await setConfig(ctx.db, entityId, before.value ?? null);
      return { applied: { value: before.value ?? null }, ignored: [] };
    }
    default:
      throw errors.validation(
        `audit.revert no soporta entity_type "${entityType}" ` +
          `(soportados: ${[...Object.keys(REVERTIBLE_FIELDS), "app_config"].join(", ")})`,
      );
  }
  return { applied, ignored };
}

export const auditTools: AdminToolDefinition[] = [
  def({
    name: "agentos.audit.query",
    description:
      "Consulta el audit_log (append-only) con filtros: entidad, acción, actor, desde, límite.",
    schema: z.object({
      entity_type: z.string().optional(),
      entity_id: z.string().optional(),
      action: z.string().optional(),
      actor: z.string().optional(),
      since_ms: z.number().int().nonnegative().optional(),
      limit: z.number().int().positive().max(500).optional(),
    }),
    readOnly: true,
    async handler(ctx, args) {
      return await queryAudit(ctx.db, {
        entityType: args.entity_type,
        entityId: args.entity_id,
        action: args.action,
        actor: args.actor,
        sinceMs: args.since_ms,
        limit: args.limit,
      });
    },
  }),

  def({
    name: "agentos.audit.revert",
    description:
      "Aplica el `before` de una fila de auditoría como NUEVA mutación auditada (nunca borra historial). " +
      "Solo revierte datos — jamás salta la máquina de estados.",
    schema: z.object({ audit_id: z.string().min(1), reason: Reason }),
    readOnly: false,
    async handler(ctx, args) {
      const entry = await getAuditEntry(ctx.db, args.audit_id);
      if (!entry) throw errors.notFound("audit_entry", args.audit_id);
      if (!entry.before || Object.keys(entry.before).length === 0) {
        throw errors.validation(
          `La fila de auditoría ${entry.id} (${entry.action}) no tiene \`before\`: nada que revertir`,
        );
      }
      if (!entry.entityId) {
        throw errors.validation(`La fila de auditoría ${entry.id} no referencia una entidad`);
      }
      const { applied, ignored } = await applyRevert(ctx, entry.entityType, entry.entityId, entry.before);
      const audit = await auditMutation(ctx, {
        action: "audit.revert",
        entityType: entry.entityType,
        entityId: entry.entityId,
        before: entry.after,
        after: { ...applied, revertedAuditId: entry.id },
        reason: args.reason ?? `Revert de ${entry.action} (${entry.id})`,
      });
      return {
        reverted_audit_id: entry.id,
        entity_type: entry.entityType,
        entity_id: entry.entityId,
        applied,
        ignored_fields: ignored,
        audit_id: audit.id,
      };
    },
  }),
];
