/**
 * Tools de Módulos de Fase — `agentos.modules.*` (ARCHITECTURE §13.7, M4a).
 *
 * Reglas duras:
 * - Las versiones son INMUTABLES (CA-M1.2): `update` crea una versión DRAFT
 *   nueva vía createModuleVersion — jamás sobrescribe.
 * - `publish` es el momento B COMPLETO (§13.5): reglas puras + reglas con DB
 *   (`unknown_methodology`, `unknown_agent_slug`) — un solo issue rechaza con
 *   la lista completa. Viven en el repositorio (activateModuleVersion) para
 *   que el seed también las corra.
 * - `launch` exige `person_id`: DISPARAR ES SIEMPRE HUMANO (PRD §6). El perfil
 *   `ro` (el único expuesto a agentes) bloquea la mutación antes de validar
 *   argumentos — la regla se impone en la entrada.
 * - Convenciones de tools/projects.ts: idempotency_key + expected_version +
 *   reason + auditMutation before/after + errores AgentosError con código estable.
 */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  AgentosError,
  ErrorCodes,
  OrgKind,
  errors,
  validateBlueprint,
  type BlueprintIssue,
} from "@agentos/shared";
import {
  MODULES_DIR,
  activateModuleVersion,
  archiveModuleVersion,
  createModuleVersion,
  getActiveModule,
  getLaunch,
  getModuleVersion,
  getPerson,
  getPhaseModuleById,
  listLaunches,
  listPhaseModules,
  moduleBlueprintDbIssues,
  previewLaunch,
  serializeModuleMd,
  type AgentosDb,
  type LaunchOrgInput,
  type ModuleLaunch,
  type PhaseModule,
} from "@agentos/db";
import { launchModuleWithEvents, phaseClosureStatus } from "@agentos/core";
import { auditMutation, findIdempotentMutation, mustGetPerson } from "../context.js";
import { defineAdminTool as def, type AdminToolDefinition } from "../registry.js";
import { unifiedDiff } from "../diff.js";

const Reason = z.string().max(2000).optional();
const IdempotencyKey = z.string().min(1).max(200).optional();
const ModuleSlug = z.string().regex(/^[a-z][a-z0-9-]*$/, "slug en minúsculas");

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Resumen estable de una versión de módulo (sin blueprint ni body — livianas). */
function moduleSummary(m: PhaseModule): Record<string, unknown> {
  return {
    id: m.id,
    slug: m.slug,
    version: m.version,
    name: m.name,
    phase: m.phase,
    project_type: m.projectType,
    status: m.status,
    methodology: { slug: m.methodologySlug, version: m.methodologyVersion },
    templates_count: m.blueprint.templates.length,
    blueprint_hash: m.blueprintHash,
    changelog: m.changelog,
    created_by: m.createdBy,
    activated_at: m.activatedAt,
    created_at: m.createdAt,
  };
}

function moduleAuditFields(m: PhaseModule): Record<string, unknown> {
  return {
    slug: m.slug,
    version: m.version,
    status: m.status,
    blueprintHash: m.blueprintHash,
    name: m.name,
    phase: m.phase,
  };
}

/** Última versión del slug (draft/active/archived) — el "estado del catálogo". */
function latestModuleVersion(db: AgentosDb, slug: string): PhaseModule | undefined {
  return listPhaseModules(db, { slug })[0];
}

function mustGetModuleVersion(db: AgentosDb, slug: string, version: number): PhaseModule {
  const row = getModuleVersion(db, slug, version);
  if (!row) throw errors.notFound("phase_module", `${slug}@${version}`);
  return row;
}

/** Momento A/B en lectura: reglas puras + reglas con DB, sin escribir nada. */
function collectIssues(db: AgentosDb, blueprint: unknown): BlueprintIssue[] {
  const result = validateBlueprint(blueprint);
  const issues = [...result.issues];
  if (result.blueprint) issues.push(...moduleBlueprintDbIssues(db, result.blueprint));
  return issues;
}

/** Texto canónico de una versión para diff: blueprint JSON estable + body. */
function composeModuleText(m: PhaseModule): string {
  return `${JSON.stringify(m.blueprint, null, 2)}\n\n# body_md\n${m.bodyMd}`;
}

/** Recibo del launch con el nombre resuelto si el actor es person:<id> (CA-M2.4). */
function launchReceipt(db: AgentosDb, launch: ModuleLaunch): Record<string, unknown> {
  let actorName: string | null = null;
  if (launch.actor.startsWith("person:")) {
    actorName = getPerson(db, launch.actor.slice("person:".length))?.fullName ?? null;
  }
  const moduleName = getPhaseModuleById(db, launch.moduleId)?.name ?? launch.moduleSlug;
  return {
    launch,
    actor_name: actorName,
    module_name: moduleName,
    label: `Disparado desde ${moduleName} v${launch.moduleVersion} por ${actorName ?? launch.actor}`,
  };
}

// ── Tools ───────────────────────────────────────────────────────────────────

export const moduleTools: AdminToolDefinition[] = [
  def({
    name: "agentos.modules.list",
    description:
      "Lista los módulos de fase (slug, versión, fase, project_type, nº de plantillas, status, " +
      "hash del blueprint). Sin filtros devuelve TODAS las versiones (slug asc, versión desc).",
    schema: z.object({
      slug: z.string().optional(),
      status: z.enum(["draft", "active", "archived"]).optional(),
    }),
    readOnly: true,
    handler(ctx, args) {
      const rows = listPhaseModules(ctx.db, {
        ...(args.slug ? { slug: args.slug } : {}),
        ...(args.status ? { status: args.status } : {}),
      });
      return { modules: rows.map(moduleSummary) };
    },
  }),

  def({
    name: "agentos.modules.get",
    description:
      "Devuelve una versión de módulo completa: blueprint + body_md + hash. Sin `version` " +
      "resuelve la ACTIVA (o la última si ninguna está activa). Un draft incluye además " +
      "`issues` de validación (momento A/B: reglas puras + reglas con DB).",
    schema: z.object({ slug: ModuleSlug, version: z.number().int().positive().optional() }),
    readOnly: true,
    handler(ctx, args) {
      const row =
        args.version !== undefined
          ? mustGetModuleVersion(ctx.db, args.slug, args.version)
          : (getActiveModule(ctx.db, args.slug) ?? latestModuleVersion(ctx.db, args.slug));
      if (!row) throw errors.notFound("phase_module", args.slug);
      return {
        module: moduleSummary(row),
        blueprint: row.blueprint,
        body_md: row.bodyMd,
        blueprint_hash: row.blueprintHash,
        ...(row.status === "draft" ? { issues: collectIssues(ctx.db, row.blueprint) } : {}),
      };
    },
  }),

  def({
    name: "agentos.modules.diff",
    description:
      "Diff unificado entre dos versiones del MISMO módulo (blueprint canónico + body_md).",
    schema: z.object({
      slug: ModuleSlug,
      from_version: z.number().int().positive(),
      to_version: z.number().int().positive(),
      context_lines: z.number().int().min(0).max(20).optional(),
    }),
    readOnly: true,
    handler(ctx, args) {
      const from = mustGetModuleVersion(ctx.db, args.slug, args.from_version);
      const to = mustGetModuleVersion(ctx.db, args.slug, args.to_version);
      const unified = unifiedDiff(composeModuleText(from), composeModuleText(to), {
        fromLabel: `${args.slug}@${from.version}`,
        toLabel: `${args.slug}@${to.version}`,
        ...(args.context_lines !== undefined ? { context: args.context_lines } : {}),
      });
      return {
        slug: args.slug,
        from_version: from.version,
        to_version: to.version,
        identical: unified === "",
        unified,
      };
    },
  }),

  def({
    name: "agentos.modules.validate",
    description:
      "Valida un blueprint CANDIDATO sin escribir nada: reglas puras (§13.5) + reglas con DB " +
      "(unknown_methodology, unknown_agent_slug). Devuelve issues con código y path — nunca " +
      "un booleano a secas.",
    schema: z.object({ blueprint: z.record(z.string(), z.unknown()) }),
    readOnly: true,
    handler(ctx, args) {
      const issues = collectIssues(ctx.db, args.blueprint);
      return { ok: issues.length === 0, issues };
    },
  }),

  def({
    name: "agentos.modules.preview",
    description:
      "DRY-RUN del launch (CA-M2.1): valida inputs+toggles y devuelve las tareas que se " +
      "crearían — título renderizado, asignación por rol resuelta contra el roster ACTUAL, " +
      "dependencias, due, gates y entregables efectivos. NO escribe nada. Con inputs " +
      "incompletos devuelve {ok:false, missing, issues}. Sin `version` usa la activa; con " +
      "`version` explícita permite previsualizar un draft.",
    schema: z.object({
      slug: ModuleSlug,
      version: z.number().int().positive().optional(),
      inputs: z.record(z.string(), z.unknown()),
      toggles: z.record(z.string(), z.boolean()).optional(),
    }),
    readOnly: true,
    handler(ctx, args) {
      return previewLaunch(ctx.db, {
        moduleSlug: args.slug,
        ...(args.version !== undefined ? { moduleVersion: args.version } : {}),
        inputs: args.inputs,
        ...(args.toggles ? { toggles: args.toggles } : {}),
      });
    },
  }),

  def({
    name: "agentos.modules.launches_list",
    description:
      "Lista recibos de launch (CA-M2.4), opcionalmente por proyecto o por slug de módulo. " +
      "Los inputs sensibles ya viajan redactados en el recibo.",
    schema: z.object({
      project_id: z.string().optional(),
      module_slug: z.string().optional(),
    }),
    readOnly: true,
    handler(ctx, args) {
      const rows = listLaunches(ctx.db, {
        ...(args.project_id ? { projectId: args.project_id } : {}),
        ...(args.module_slug ? { moduleSlug: args.module_slug } : {}),
      });
      return { launches: rows.map((l) => launchReceipt(ctx.db, l)) };
    },
  }),

  def({
    name: "agentos.modules.launches_get",
    description:
      "Devuelve el recibo COMPLETO de un launch (CA-M2.4): módulo+versión, snapshot del " +
      "blueprint, inputs (redactados), toggles, resultado (tareas/gate/budget), actor y " +
      "nombre de la persona si el actor es person:<id>.",
    schema: z.object({ launch_id: z.string().min(1) }),
    readOnly: true,
    handler(ctx, args) {
      const launch = getLaunch(ctx.db, args.launch_id);
      if (!launch) throw errors.notFound("module_launch", args.launch_id);
      return launchReceipt(ctx.db, launch);
    },
  }),

  def({
    name: "agentos.modules.phase_status",
    description:
      "Estado de cierre de fase de un proyecto (CA-M3.1): entregables de cierre del último " +
      "launch vs. la realidad (Context Hub, procesos as-is, artefactos). El gate de fase no " +
      "debe aprobarse con faltantes.",
    schema: z.object({ project_id: z.string().min(1) }),
    readOnly: true,
    handler(ctx, args) {
      return phaseClosureStatus(ctx.db, args.project_id);
    },
  }),

  // ── Mutaciones (solo perfil rw) ───────────────────────────────────────────

  def({
    name: "agentos.modules.create",
    description:
      "Crea un módulo NUEVO como versión draft desde blueprint + body_md (momento A §13.5): " +
      "el draft se guarda aunque tenga issues estructurales (se devuelven para iterar), pero " +
      "queda inactivable hasta que publish pase limpio. El slug no debe existir.",
    schema: z.object({
      blueprint: z.record(z.string(), z.unknown()),
      body_md: z.string(),
      changelog: z.string().optional(),
      reason: Reason,
      idempotency_key: IdempotencyKey,
    }),
    readOnly: false,
    handler(ctx, args) {
      const previous = findIdempotentMutation(ctx, "modules.create", args.idempotency_key);
      if (previous?.entityId) {
        const existing = getPhaseModuleById(ctx.db, previous.entityId);
        if (existing) return { module: moduleSummary(existing), idempotent: true };
      }
      // El schema Zod debe pasar (sin él no hay slug/name/phase que persistir);
      // los issues ESTRUCTURALES no bloquean el draft (momento A).
      const result = validateBlueprint(args.blueprint);
      if (!result.blueprint) {
        throw errors.validation(
          "modules.create: el blueprint no cumple el schema — ni siquiera como draft",
          result.issues,
        );
      }
      const bp = result.blueprint;
      if (latestModuleVersion(ctx.db, bp.slug)) {
        throw new AgentosError(
          ErrorCodes.CONFLICT,
          `Ya existe el módulo "${bp.slug}" — usa agentos.modules.update para crear una versión nueva`,
          { slug: bp.slug },
        );
      }
      const module = createModuleVersion(ctx.db, {
        slug: bp.slug,
        version: bp.version,
        name: bp.name,
        phase: bp.phase,
        projectType: bp.project_type,
        methodologySlug: bp.methodology.slug,
        methodologyVersion: bp.methodology.version,
        blueprint: args.blueprint,
        bodyMd: args.body_md,
        changelog: args.changelog ?? `Creado via MCP (${ctx.actor})`,
        createdBy: ctx.actor,
      });
      auditMutation(ctx, {
        action: "modules.create",
        entityType: "phase_module",
        entityId: module.id,
        before: null,
        after: moduleAuditFields(module),
        reason: args.reason,
        idempotencyKey: args.idempotency_key,
      });
      return { module: moduleSummary(module), issues: collectIssues(ctx.db, module.blueprint) };
    },
  }),

  def({
    name: "agentos.modules.update",
    description:
      "Crea una versión DRAFT nueva del módulo — NUNCA sobrescribe (CA-M1.2). " +
      "`expected_version` = última versión existente del slug (conflicto → error). Si envías " +
      "`blueprint`, su `version` debe ser exactamente expected_version+1 (sin auto-bump, " +
      "como el seed §13.5 A); si solo cambias `body_md`, el blueprint se hereda con la " +
      "versión subida. La activa no se toca hasta publish.",
    schema: z.object({
      slug: ModuleSlug,
      expected_version: z.number().int().positive(),
      blueprint: z.record(z.string(), z.unknown()).optional(),
      body_md: z.string().optional(),
      changelog: z.string().min(1),
      reason: Reason,
      idempotency_key: IdempotencyKey,
    }),
    readOnly: false,
    handler(ctx, args) {
      const previous = findIdempotentMutation(ctx, "modules.update", args.idempotency_key);
      if (previous?.entityId) {
        const existing = getPhaseModuleById(ctx.db, previous.entityId);
        if (existing) return { module: moduleSummary(existing), idempotent: true };
      }
      const latest = latestModuleVersion(ctx.db, args.slug);
      if (!latest) throw errors.notFound("phase_module", args.slug);
      if (latest.version !== args.expected_version) {
        throw errors.versionConflict("phase_module", args.slug, args.expected_version);
      }
      if (args.blueprint === undefined && args.body_md === undefined) {
        throw errors.validation("modules.update sin `blueprint` ni `body_md`: nada que hacer");
      }
      const nextVersion = latest.version + 1;

      let rawBlueprint: unknown;
      if (args.blueprint !== undefined) {
        const result = validateBlueprint(args.blueprint);
        if (!result.blueprint) {
          throw errors.validation(
            "modules.update: el blueprint no cumple el schema — ni siquiera como draft",
            result.issues,
          );
        }
        if (result.blueprint.slug !== args.slug) {
          throw errors.validation(
            `modules.update: blueprint.slug "${result.blueprint.slug}" no coincide con "${args.slug}"`,
          );
        }
        if (result.blueprint.version !== nextVersion) {
          throw errors.validation(
            `modules.update: blueprint.version debe ser ${nextVersion} (las versiones son ` +
              `inmutables y no hay auto-bump — CA-M1.2)`,
            { found: result.blueprint.version, expected: nextVersion },
          );
        }
        rawBlueprint = args.blueprint;
      } else {
        // Solo cambia el body: heredamos el blueprint activo/último con la versión subida.
        rawBlueprint = { ...latest.blueprint, version: nextVersion };
      }
      const parsed = validateBlueprint(rawBlueprint).blueprint!;
      const module = createModuleVersion(ctx.db, {
        slug: args.slug,
        version: nextVersion,
        name: parsed.name,
        phase: parsed.phase,
        projectType: parsed.project_type,
        methodologySlug: parsed.methodology.slug,
        methodologyVersion: parsed.methodology.version,
        blueprint: rawBlueprint,
        bodyMd: args.body_md ?? latest.bodyMd,
        changelog: args.changelog,
        createdBy: ctx.actor,
      });
      auditMutation(ctx, {
        action: "modules.update",
        entityType: "phase_module",
        entityId: module.id,
        before: moduleAuditFields(latest),
        after: moduleAuditFields(module),
        reason: args.reason,
        idempotencyKey: args.idempotency_key,
      });
      return { module: moduleSummary(module), issues: collectIssues(ctx.db, module.blueprint) };
    },
  }),

  def({
    name: "agentos.modules.publish",
    description:
      "Publica una versión: draft → active (momento B COMPLETO §13.5: reglas puras + reglas " +
      "con DB — un solo issue rechaza con la lista completa). Archiva la activa anterior. " +
      "`expected_version` = versión ACTUALMENTE activa del slug (0 si ninguna) — protege " +
      "contra publishes concurrentes.",
    schema: z.object({
      slug: ModuleSlug,
      version: z.number().int().positive(),
      expected_version: z.number().int().nonnegative(),
      reason: Reason,
    }),
    readOnly: false,
    handler(ctx, args) {
      const target = mustGetModuleVersion(ctx.db, args.slug, args.version);
      const active = getActiveModule(ctx.db, args.slug);
      const activeVersion = active?.version ?? 0;
      if (activeVersion !== args.expected_version) {
        throw errors.versionConflict("phase_module(active)", args.slug, args.expected_version);
      }
      if (target.status === "active") {
        return { module: moduleSummary(target), already_active: true };
      }
      const published = activateModuleVersion(ctx.db, args.slug, args.version);
      auditMutation(ctx, {
        action: "modules.publish",
        entityType: "phase_module",
        entityId: published.id,
        before: {
          status: target.status,
          activeVersion: active ? active.version : null,
        },
        after: { ...moduleAuditFields(published), archivedVersion: active ? active.version : null },
        reason: args.reason,
      });
      return {
        module: moduleSummary(published),
        archived_version: active ? active.version : null,
      };
    },
  }),

  def({
    name: "agentos.modules.rollback",
    description:
      "Rollback: reactiva una versión ANTERIOR re-validándola con el momento B completo " +
      "(nada se borra — la activa actual queda archivada). `reason` es obligatoria.",
    schema: z.object({
      slug: ModuleSlug,
      target_version: z.number().int().positive(),
      reason: z.string().min(1).max(2000),
    }),
    readOnly: false,
    handler(ctx, args) {
      const target = mustGetModuleVersion(ctx.db, args.slug, args.target_version);
      if (target.status === "active") {
        throw new AgentosError(
          ErrorCodes.CONFLICT,
          `${args.slug}@${args.target_version} ya es la versión activa: nada que reactivar`,
          { slug: args.slug, version: args.target_version },
        );
      }
      const active = getActiveModule(ctx.db, args.slug);
      const reactivated = activateModuleVersion(ctx.db, args.slug, args.target_version);
      auditMutation(ctx, {
        action: "modules.rollback",
        entityType: "phase_module",
        entityId: reactivated.id,
        before: { activeVersion: active ? active.version : null },
        after: { ...moduleAuditFields(reactivated), archivedVersion: active ? active.version : null },
        reason: args.reason,
      });
      return { module: moduleSummary(reactivated), archived_version: active ? active.version : null };
    },
  }),

  def({
    name: "agentos.modules.archive",
    description:
      "Archiva una versión (por defecto la ACTIVA del slug): deja de ser disparable. Los " +
      "proyectos ya lanzados no se tocan (el recibo es un snapshot — NM-3).",
    schema: z.object({
      slug: ModuleSlug,
      version: z.number().int().positive().optional(),
      reason: Reason,
    }),
    readOnly: false,
    handler(ctx, args) {
      let target: PhaseModule;
      if (args.version !== undefined) {
        target = mustGetModuleVersion(ctx.db, args.slug, args.version);
      } else {
        const active = getActiveModule(ctx.db, args.slug);
        if (!active) {
          throw errors.validation(
            `modules.archive: ${args.slug} no tiene versión activa — indica \`version\` explícita`,
          );
        }
        target = active;
      }
      const before = moduleAuditFields(target);
      const archived = archiveModuleVersion(ctx.db, args.slug, target.version);
      auditMutation(ctx, {
        action: "modules.archive",
        entityType: "phase_module",
        entityId: archived.id,
        before,
        after: moduleAuditFields(archived),
        reason: args.reason,
      });
      return { module: moduleSummary(archived) };
    },
  }),

  def({
    name: "agentos.modules.export",
    description:
      "Exporta una versión (por defecto la activa) a `modules/<slug>.md` desde la DB — el " +
      "formato frontmatter YAML (= blueprint) + cuerpo del seed §13.2, listo para commitear. " +
      "`dir` opcional para escribir en otra carpeta.",
    schema: z.object({
      slug: ModuleSlug,
      version: z.number().int().positive().optional(),
      dir: z.string().optional(),
      reason: Reason,
    }),
    readOnly: false,
    handler(ctx, args) {
      const row =
        args.version !== undefined
          ? mustGetModuleVersion(ctx.db, args.slug, args.version)
          : getActiveModule(ctx.db, args.slug);
      if (!row) throw errors.notFound("phase_module(active)", args.slug);
      const content = serializeModuleMd(row.blueprint, row.bodyMd);
      const dir = args.dir ?? MODULES_DIR;
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${args.slug}.md`);
      fs.writeFileSync(file, content, "utf8");
      auditMutation(ctx, {
        action: "modules.export",
        entityType: "phase_module",
        entityId: row.id,
        before: null,
        after: { slug: row.slug, version: row.version, file, blueprintHash: row.blueprintHash },
        reason: args.reason,
      });
      return { file, slug: row.slug, version: row.version, bytes: Buffer.byteLength(content, "utf8") };
    },
  }),

  def({
    name: "agentos.modules.launch",
    description:
      "DISPARA un módulo de fase (CA-M2.2). Disparar es SIEMPRE un acto humano (PRD §6): " +
      "`person_id` es obligatorio y el actor del launch es person:<id> — ningún agente puede " +
      "invocarla (el perfil ro la bloquea en la entrada). Materializa org + proyecto + " +
      "backlog + presupuesto + recibo inmutable en una transacción; idempotente por " +
      "`idempotency_key` (misma key + mismos inputs devuelve lo ya creado).",
    schema: z.object({
      module_slug: ModuleSlug,
      version: z.number().int().positive().optional(),
      person_id: z.string().min(1),
      org: z.object({
        org_id: z.string().min(1).optional(),
        name: z.string().min(1).optional(),
        kind: OrgKind.optional(),
        industria: z.string().optional(),
        employee_count: z.number().int().positive().optional(),
        notes: z.string().optional(),
      }),
      inputs: z.record(z.string(), z.unknown()),
      toggles: z.record(z.string(), z.boolean()).optional(),
      idempotency_key: z.string().min(1).max(200),
      previous_launch_id: z.string().optional(),
      reason: Reason,
    }),
    readOnly: false,
    handler(ctx, args) {
      const person = mustGetPerson(ctx.db, args.person_id);
      let org: LaunchOrgInput;
      if (args.org.org_id) {
        org = { orgId: args.org.org_id };
      } else if (args.org.name) {
        org = {
          name: args.org.name,
          ...(args.org.kind ? { kind: args.org.kind } : {}),
          ...(args.org.industria ? { industria: args.org.industria } : {}),
          ...(args.org.employee_count !== undefined
            ? { employeeCount: args.org.employee_count }
            : {}),
          ...(args.org.notes ? { notes: args.org.notes } : {}),
        };
      } else {
        throw errors.validation("modules.launch: `org` exige org_id o name");
      }
      // La auditoría del launch la escribe el MOTOR dentro de su transacción
      // (NM-5) — aquí no se duplica. Los eventos AG-UI salen POST-commit por
      // el sink del contexto (tabla events — la API los recoge por since_seq).
      const result = launchModuleWithEvents(ctx.db, ctx.sink, {
        moduleSlug: args.module_slug,
        ...(args.version !== undefined ? { moduleVersion: args.version } : {}),
        org,
        inputs: args.inputs,
        ...(args.toggles ? { toggles: args.toggles } : {}),
        actor: `person:${person.id}`,
        idempotencyKey: args.idempotency_key,
        ...(args.previous_launch_id ? { previousLaunchId: args.previous_launch_id } : {}),
      });
      return {
        launch: result.launch,
        project: result.project,
        organization: result.organization,
        tasks_count: result.tasks.length,
        idempotent: result.idempotent,
        duration_ms: result.durationMs,
      };
    },
  }),
];
