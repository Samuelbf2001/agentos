/**
 * Motor de launch de Módulos de Fase (ARCHITECTURE §13.3) — "el seed
 * generalizado": materializa un blueprint validado en org + proyecto + backlog
 * completo + presupuesto + fuentes + recibo inmutable, en UNA transacción
 * (`withTransaction` de la fachada: transacción de drizzle en Postgres, y en
 * SQLite `BEGIN IMMEDIATE` serializado por la cola de transacciones).
 *
 * Contrato:
 * - Pre-vuelo FUERA de la transacción (idempotencia, módulo activo, blueprint,
 *   inputs, plan, roster, metodología) — cualquier issue rechaza fail-closed.
 * - Idempotencia (CA-M2.6): misma key + mismos inputs devuelve lo ya creado;
 *   misma key + inputs distintos → `idempotency_conflict`.
 * - Módulo activo e idempotencia se RE-verifican DENTRO de la transacción
 *   (TOCTOU — §13.5 C).
 * - NM-1: cualquier throw dentro de la transacción revierte TODO.
 * - El motor NO publica eventos: devuelve `pendingEvents` para que la capa de
 *   core (`launchModuleWithEvents`) los publique POST-commit — publicar dentro
 *   dejaría eventos fantasma en rollback.
 */
import { createHash } from "node:crypto";
import {
  AgentosError,
  ErrorCodes,
  canonicalizeBlueprint,
  computeChainHealthFrom,
  errors,
  newId,
  nowMs,
  planLaunch,
  validateBlueprint,
  validateLaunchInputs,
  type LaunchPlan,
  type ModuleBlueprint,
  type OrgKind,
} from "@agentos/shared";
import { withTransaction, type AnyDb } from "../facade.js";
import type {
  Agent,
  Methodology,
  ModuleLaunch,
  Organization,
  PhaseModule,
  Project,
  Task,
} from "../types.js";
import {
  appendAudit,
  appendTaskEvent,
  countOpenTasksByAgent,
  createOrganization,
  createProject,
  createTask,
  findLaunchByIdempotencyKey,
  findLaunchByProjectAndPhase,
  getActiveModule,
  getLatestLaunchForProject,
  getLaunch,
  getMethodology,
  getModuleVersion,
  getOrganization,
  getOrganizationByName,
  getProject,
  getProjectByOrgAndName,
  getTask,
  getThreadBySessionKey,
  insertModuleLaunch,
  listAgents,
  listPhaseModules,
  setConfig,
  setThreadProject,
  updateProject,
  updateTask,
} from "../repos.js";

// ── Contrato de entrada/salida ──────────────────────────────────────────────

/** Organización destino: existente por id, o get-or-create por nombre exacto. */
export type LaunchOrgInput =
  | { orgId: string }
  | {
      name: string;
      kind?: OrgKind;
      industria?: string;
      employeeCount?: number;
      notes?: string;
    };

export interface LaunchModuleInput {
  moduleSlug: string;
  /** Sin versión explícita: la versión ACTIVA del slug. */
  moduleVersion?: number;
  org: LaunchOrgInput;
  inputs: Record<string, unknown>;
  toggles?: Record<string, boolean>;
  /**
   * Claves de plantillas `cadence` que el humano CONFIRMÓ en el wizard
   * (CA-M3.4, consent-first — M6a): las confirmadas SÍ entran al plan (primera
   * instancia); las no confirmadas quedan fuera, como hasta ahora.
   */
  cadencesConfirmed?: string[];
  /** `person:<id>` | `system:seed` — disparar jamás es `agent:*` (PRD §6). */
  actor: string;
  /** OBLIGATORIA (columna NOT NULL) — CA-M2.6. */
  idempotencyKey: string;
  /**
   * Encadenado de fases (US-M3): launch de la fase anterior. Si se pasa, el
   * launch apunta al MISMO proyecto de ese launch (CA-M3.3: mismo Context Hub;
   * solo cambian stage y backlog activo) — el nombre renderizado del módulo
   * nuevo NO crea proyecto aparte. Si no se pasa y el proyecto se reutiliza por
   * (org, nombre), el motor lo auto-completa con el último launch del proyecto.
   */
  previousLaunchId?: string;
  /** Epoch ms inyectable para determinismo de `{{hoy}}` y due_at. */
  now?: number;
}

/** Evento AG-UI pendiente de publicar POST-commit (lo hace core, no el motor). */
export interface LaunchPendingEvent {
  topic: string;
  event: { type: string; payload: Record<string, unknown>; runId: string | null };
}

export interface LaunchModuleResult {
  launch: ModuleLaunch;
  project: Project;
  organization: Organization;
  tasks: Task[];
  /** true = la misma idempotency_key con el mismo inputs_digest ya existía. */
  idempotent: boolean;
  durationMs: number;
  pendingEvents: LaunchPendingEvent[];
}

export const REDACTED = "[redacted]";

// ── Helpers puros del motor ─────────────────────────────────────────────────

function sha256Hex(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** sha256 del JSON canónico de los inputs SIN redactar (idempotencia CA-M2.6). */
export function computeInputsDigest(inputs: Record<string, unknown>): string {
  return sha256Hex(canonicalizeBlueprint(inputs));
}

/** Copia literal de los inputs con los campos `sensitive` REDACTADOS (§13.1). */
function redactInputs(
  bp: ModuleBlueprint,
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const sensitiveKeys = new Set(bp.inputs.filter((i) => i.sensitive === true).map((i) => i.key));
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    out[key] = sensitiveKeys.has(key) && value !== undefined && value !== null ? REDACTED : value;
  }
  return out;
}

/**
 * Clave de orden fraccionaria secuencial, mismo patrón que el seed demo
 * (`a0`…`a9`, `b0`…): con el tope MAX_LAUNCH_TASKS=40 jamás pasa de `d9`.
 */
export function launchOrderKey(index: number): string {
  return `${String.fromCharCode(97 + Math.floor(index / 10))}${index % 10}`;
}

/** session_keys del/los inputs `source_refs`: strings o `{session_key}`. */
function collectSessionKeys(bp: ModuleBlueprint, values: Record<string, unknown>): string[] {
  const keys: string[] = [];
  for (const input of bp.inputs) {
    if (input.type !== "source_refs") continue;
    const value = values[input.key];
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (typeof item === "string" && item.trim() !== "") {
        keys.push(item);
      } else if (item !== null && typeof item === "object") {
        const sk =
          (item as Record<string, unknown>)["session_key"] ??
          (item as Record<string, unknown>)["sessionKey"];
        if (typeof sk === "string" && sk.trim() !== "") keys.push(sk);
      }
    }
  }
  return [...new Set(keys)];
}

function moduleNotActive(slug: string, version: number | null, status: string | null): never {
  throw new AgentosError(
    ErrorCodes.MODULE_NOT_ACTIVE,
    `El módulo ${slug}${version !== null ? `@${version}` : ""} no está activo` +
      `${status ? ` (status=${status})` : ""}: solo un módulo active puede dispararse (NM-4)`,
    { code: "module_not_active", slug, version, status },
  );
}

// ── Resolución contra la DB (pre-vuelo) ─────────────────────────────────────

async function resolveModule(
  db: AnyDb,
  slug: string,
  version: number | undefined,
): Promise<PhaseModule> {
  if (version !== undefined) {
    const row = await getModuleVersion(db, slug, version);
    if (!row) throw errors.notFound("phase_module", `${slug}@${version}`);
    if (row.status !== "active") moduleNotActive(slug, version, row.status);
    return row;
  }
  const active = await getActiveModule(db, slug);
  if (active) return active;
  const any = await listPhaseModules(db, { slug });
  if (any.length === 0) throw errors.notFound("phase_module", slug);
  moduleNotActive(slug, null, any[0]!.status);
}

interface ResolvedMethodology {
  main: Methodology;
  adds: Methodology[];
}

async function resolveMethodology(db: AnyDb, plan: LaunchPlan): Promise<ResolvedMethodology> {
  const { slug, version, adds } = plan.methodology;
  const main =
    version === null ? await getMethodology(db, slug) : await getMethodology(db, slug, version);
  if (!main) {
    throw errors.validation(`Metodología desconocida: ${slug}${version !== null ? `@${version}` : ""}`, [
      { code: "unknown_methodology", path: "methodology", details: { slug, version } },
    ]);
  }
  const addRows: Methodology[] = [];
  for (const addSlug of adds) {
    const row = await getMethodology(db, addSlug);
    if (!row) {
      throw errors.validation(`Metodología adicional desconocida: ${addSlug}`, [
        { code: "unknown_methodology", path: "toggles.methodology_add", details: { slug: addSlug } },
      ]);
    }
    addRows.push(row);
  }
  return { main, adds: addRows };
}

export interface ResolvedAssignment {
  agentId: string;
  agentSlug: string;
}

interface RosterResolutionContext {
  agents: Agent[];
  bySlug: Map<string, Agent>;
  isAssignable: (a: Agent) => boolean;
  openCounts: Map<string, number>;
}

async function rosterResolutionContext(db: AnyDb): Promise<RosterResolutionContext> {
  const agents = await listAgents(db);
  const byId = new Map(agents.map((a) => [a.id, a] as const));
  const bySlug = new Map(agents.map((a) => [a.slug, a] as const));
  const isAssignable = (a: Agent): boolean =>
    a.status === "active" && computeChainHealthFrom(a, (id) => byId.get(id)).status === "healthy";
  return { agents, bySlug, isAssignable, openCounts: await countOpenTasksByAgent(db) };
}

/** Preferido por slug si asignable; si no, asignable de la capa con MENOS carga (desempate por slug). */
function pickAssignableAgent(
  ctx: RosterResolutionContext,
  preferredSlug: string,
  layer: string,
): Agent | undefined {
  const preferred = preferredSlug !== "" ? ctx.bySlug.get(preferredSlug) : undefined;
  if (preferred && ctx.isAssignable(preferred)) return preferred;
  return ctx.agents
    .filter((a) => a.layer === layer && ctx.isAssignable(a))
    .sort((a, b) => {
      const load = (ctx.openCounts.get(a.id) ?? 0) - (ctx.openCounts.get(b.id) ?? 0);
      return load !== 0 ? load : a.slug.localeCompare(b.slug);
    })[0];
}

/**
 * Capa/rol → roster real (§13.5): preferido `roster[role].agent` por slug si
 * existe, está activo y su cadena de mando está sana; si no, agente
 * activo+asignable de `roster[role].layer` con MENOS tareas abiertas
 * (desempate determinista por slug). Ninguno → `agent_not_assignable` y el
 * launch ENTERO se rechaza. La carga se incrementa en memoria según se asigna
 * dentro del propio plan, para repartir el fan-out dentro de una capa.
 */
async function resolveAssignments(
  db: AnyDb,
  plan: LaunchPlan,
): Promise<Map<string, ResolvedAssignment>> {
  const ctx = await rosterResolutionContext(db);
  const out = new Map<string, ResolvedAssignment>();
  for (const task of plan.tasks) {
    const chosen = pickAssignableAgent(ctx, task.agentSlug, task.layer);
    if (!chosen) {
      throw errors.notAssignable(task.agentSlug || task.layer, "roster_exhausted", {
        role: task.role,
        layer: task.layer,
        template: task.templateKey,
        instance: task.key,
      });
    }
    ctx.openCounts.set(chosen.id, (ctx.openCounts.get(chosen.id) ?? 0) + 1);
    out.set(task.key, { agentId: chosen.id, agentSlug: chosen.slug });
  }
  return out;
}

/**
 * Resolución de UN rol del roster contra el roster ACTUAL — misma regla del
 * launch (preferido → capa con menos carga → null). La usa la re-creación de
 * cadencias (M6a): si el agente cambió desde el launch, se re-resuelve; si
 * nadie es asignable, devuelve null y el llamador NO crea (fail-soft).
 */
export async function resolveRoleAgainstRoster(
  db: AnyDb,
  entry: { agentSlug: string; layer: string },
): Promise<ResolvedAssignment | null> {
  const ctx = await rosterResolutionContext(db);
  const chosen = pickAssignableAgent(ctx, entry.agentSlug, entry.layer);
  return chosen ? { agentId: chosen.id, agentSlug: chosen.slug } : null;
}

async function resolveOrganization(db: AnyDb, org: LaunchOrgInput): Promise<Organization> {
  if ("orgId" in org) {
    const existing = await getOrganization(db, org.orgId);
    if (!existing) throw errors.notFound("organization", org.orgId);
    return existing;
  }
  // Get-or-create por nombre exacto (§13.3), como el seed.
  return (
    (await getOrganizationByName(db, org.name)) ??
    (await createOrganization(db, {
      name: org.name,
      kind: org.kind ?? "client",
      industry: org.industria ?? null,
      employeeCount: org.employeeCount ?? null,
      notes: org.notes ?? null,
    }))
  );
}

// ── Motor ───────────────────────────────────────────────────────────────────

/**
 * Dispara un módulo de fase (CA-M2.2). UNA sola transacción para los dos
 * motores vía `withTransaction` (`BEGIN IMMEDIATE` en SQLite,
 * `db.transaction(async tx => …)` en Postgres): cualquier throw revierte TODO
 * (NM-1). En `facade.ts` está por qué abrir la transacción a mano es seguro en
 * SQLite con un callback asíncrono.
 */
export async function launchModule(
  db: AnyDb,
  input: LaunchModuleInput,
): Promise<LaunchModuleResult> {
  const started = nowMs();
  const now = input.now ?? started;

  // ── Pre-vuelo FUERA de la transacción ─────────────────────────────────────

  if (!input.idempotencyKey || input.idempotencyKey.trim() === "") {
    throw errors.validation("idempotencyKey es obligatoria (CA-M2.6)");
  }
  if (!/^(person|system):[A-Za-z0-9_.-]+$/.test(input.actor)) {
    // PRD §6: disparar es siempre humano (o el seed del sistema) — jamás un agente.
    throw errors.validation(
      `actor inválido para launch: "${input.actor}" (se exige person:<id> | system:<comp>)`,
      { actor: input.actor },
    );
  }

  const inputsDigest = computeInputsDigest(input.inputs);

  // 1) Idempotencia (CA-M2.6)
  const prior = await findLaunchByIdempotencyKey(db, input.idempotencyKey);
  if (prior) return await idempotentResult(db, prior, inputsDigest, input.idempotencyKey);

  // 2) Módulo existe y está activo (NM-4)
  const module = await resolveModule(db, input.moduleSlug, input.moduleVersion);

  // 3) validateBlueprint COMPLETO (momento C re-ejecuta TODO — §13.5)
  const bpResult = validateBlueprint(module.blueprint);
  if (!bpResult.ok || !bpResult.blueprint) {
    throw errors.validation(
      `Blueprint inválido en ${module.slug}@${module.version}: el launch se rechaza fail-closed`,
      bpResult.issues,
    );
  }
  const bp = bpResult.blueprint;

  // 4) Inputs del formulario (CA-M2.1)
  const inputsResult = validateLaunchInputs(bp, input.inputs, input.toggles ?? {});
  if (!inputsResult.ok) {
    throw errors.validation(
      `Inputs de arranque inválidos para ${module.slug}@${module.version}` +
        (inputsResult.missing.length > 0 ? ` (faltan: ${inputsResult.missing.join(", ")})` : ""),
      inputsResult.issues,
    );
  }

  // 5) Plan (fan_out, poda, deps, orden, due, aprobación; too_many_tasks NM-2;
  //    cadencias confirmadas — CA-M3.4 M6a)
  const plan = planLaunch(
    bp,
    inputsResult.values,
    inputsResult.toggles,
    now,
    input.cadencesConfirmed ?? [],
  );
  if (!plan.ok) {
    throw errors.validation(
      `El plan de launch de ${module.slug}@${module.version} tiene issues`,
      plan.issues,
    );
  }

  // 5b) Encadenado (US-M3): el launch anterior debe existir — y define el
  //     proyecto destino (CA-M3.3: la nueva fase cae sobre el MISMO proyecto).
  const previousLaunch = input.previousLaunchId
    ? await getLaunch(db, input.previousLaunchId)
    : undefined;
  if (input.previousLaunchId && !previousLaunch) {
    throw errors.notFound("module_launch", input.previousLaunchId);
  }

  // 6) Asignaciones contra el roster real (agent_not_assignable rechaza entero)
  const assignments = await resolveAssignments(db, plan);

  // 7) Metodología pinneada (+ adds de toggles) — unknown_methodology
  const methodology = await resolveMethodology(db, plan);

  const redactedInputs = redactInputs(bp, input.inputs);
  const sessionKeys = collectSessionKeys(bp, inputsResult.values);
  const launchId = newId();

  // ── Transacción única (NM-1: cualquier throw revierte TODO) ──────────────

  type TxOutcome =
    | {
        kind: "created";
        launch: ModuleLaunch;
        project: Project;
        organization: Organization;
        tasks: Task[];
        /** stage anterior del proyecto si esta fase lo AVANZÓ (encadenado US-M3). */
        stageAdvancedFrom: string | null;
      }
    | { kind: "idempotent"; launch: ModuleLaunch };

  const outcome = await withTransaction(db, async (tx): Promise<TxOutcome> => {
    // RE-verificación TOCTOU (§13.5 C): idempotencia y módulo activo.
    const raced = await findLaunchByIdempotencyKey(tx, input.idempotencyKey);
    if (raced) {
      if (raced.inputsDigest !== inputsDigest) throw idempotencyConflict(input.idempotencyKey, raced);
      return { kind: "idempotent", launch: raced };
    }
    const fresh = await getModuleVersion(tx, module.slug, module.version);
    if (!fresh || fresh.status !== "active") {
      moduleNotActive(module.slug, module.version, fresh?.status ?? null);
    }

    // Organización: get-or-create (por orgId o por nombre exacto).
    const organization = await resolveOrganization(tx, input.org);

    // Proyecto destino:
    // - Encadenado (US-M3): con `previousLaunchId`, el proyecto ES el del launch
    //   anterior — CA-M3.3: mismo Context Hub, mismos procesos y decisiones;
    //   solo cambian stage y backlog activo. La org debe coincidir.
    // - Sin él: get-or-create por (org, name_tpl renderizado), como siempre.
    // En ambos casos, una fase solo se dispara UNA vez por proyecto —
    // uq(project_id, phase), error de dominio.
    let project: Project | undefined;
    if (previousLaunch) {
      const prior = await getLaunch(tx, previousLaunch.id); // re-lee DENTRO de la tx
      if (!prior) throw errors.notFound("module_launch", previousLaunch.id);
      project = await getProject(tx, prior.projectId);
      if (!project) throw errors.notFound("project", prior.projectId);
      if (project.orgId !== organization.id) {
        throw errors.validation(
          `previous_launch_id ${prior.id} pertenece a otra organización: el encadenado ` +
            `no cruza clientes (US-M3)`,
          { previousLaunchId: prior.id, launchOrgId: project.orgId, orgId: organization.id },
        );
      }
    } else {
      project = await getProjectByOrgAndName(tx, organization.id, plan.projectName);
    }
    let stageAdvancedFrom: string | null = null;
    if (project) {
      const samePhase = await findLaunchByProjectAndPhase(tx, project.id, module.phase);
      if (samePhase) {
        throw new AgentosError(
          ErrorCodes.CONFLICT,
          `La fase ${module.phase} ya se disparó sobre el proyecto "${project.name}" ` +
            `(launch ${samePhase.id}); el redo legítimo es un proyecto nuevo (§13.1)`,
          {
            code: "phase_already_launched",
            projectId: project.id,
            phase: module.phase,
            existingLaunchId: samePhase.id,
          },
        );
      }
      // Encadenado CA-M3.3: la fase nueva AVANZA el stage del proyecto y el
      // gate vuelve a 'pending'. Semántica de gate_state (verificada en el
      // motor del tablero): es el estado del gate de cierre de la FASE ACTUAL
      // del proyecto — 'approved' fue lo que habilitó disparar esta fase; al
      // entrar en ella, el gate vigente pasa a ser el de SU cierre, que nace
      // pendiente. Todo lo demás del proyecto se conserva (Context Hub,
      // procesos, decisiones, tareas de fases anteriores).
      if (project.stage !== module.phase) {
        stageAdvancedFrom = project.stage;
        const before = { stage: project.stage, gateState: project.gateState };
        project = await updateProject(
          tx,
          project.id,
          { stage: module.phase, gateState: "pending" },
          project.version,
        );
        await appendAudit(tx, {
          actor: input.actor,
          source: input.actor.startsWith("person:") ? "ui" : "system",
          action: "modules.phase_advanced",
          entityType: "project",
          entityId: project.id,
          before,
          after: { stage: project.stage, gateState: project.gateState, launchId },
          reason: `encadenado US-M3: launch de ${module.slug}@${module.version}`,
        });
      }
    } else {
      project = await createProject(tx, {
        orgId: organization.id,
        name: plan.projectName,
        type: module.projectType,
        stage: module.phase,
        gateState: "pending",
        workspacePath: plan.workspacePath,
      });
    }

    // Tareas del plan EN ORDEN (orderKey fraccionario secuencial como el seed).
    const taskByKey = new Map<string, Task>();
    for (const [i, pt] of plan.tasks.entries()) {
      const assignment = assignments.get(pt.key)!;
      const task = await createTask(tx, {
        projectId: project!.id,
        title: pt.title,
        description: pt.description,
        definitionOfDone: pt.definitionOfDone,
        stage: pt.stage,
        status: pt.status, // READY sin deps / BACKLOG con deps (CA-M2.3)
        activityType: pt.activityType,
        priority: pt.priority,
        assigneeAgentId: assignment.agentId,
        requiresApproval: pt.requiresApproval, // política que SOLO sube (NM-5)
        externalEffect: false,
        dueAt: pt.dueAt,
        orderKey: launchOrderKey(i),
      });
      taskByKey.set(pt.key, task);
      // El payload {launch_id, template_key} es el MAPEO tarea→plantilla que la
      // re-creación de cadencias (M6a) usa al cerrar la instancia; fan_out_value
      // viaja para poder re-renderizar instancias fan_out con su valor.
      await appendTaskEvent(tx, {
        taskId: task.id,
        kind: "created",
        toStatus: pt.status,
        actor: input.actor,
        payload: {
          launch_id: launchId,
          template_key: pt.templateKey,
          assignee: assignment.agentSlug,
          ...(pt.fanOutValue !== null ? { fan_out_value: pt.fanOutValue } : {}),
        },
      });
    }

    // Segunda pasada: depends_on de claves de instancia → ids reales.
    for (const pt of plan.tasks) {
      if (pt.dependsOn.length === 0) continue;
      const task = taskByKey.get(pt.key)!;
      const ids = pt.dependsOn.map((depKey) => taskByKey.get(depKey)!.id);
      taskByKey.set(pt.key, await updateTask(tx, task.id, { dependsOn: ids }, task.version));
    }

    // Presupuesto de fase (lo combina dispatcher.budgetFromLimits — §13.4).
    await setConfig(tx, `budget:project:${project.id}`, {
      phase_usd: plan.budget.phaseUsd,
      per_run_usd: plan.budget.perRunUsd,
      warning_thresholds_pct: plan.budget.warningThresholdsPct,
      launch_id: launchId,
    });

    // Fuentes: session_key → thread existente → projectId. (project_sources no
    // encaja aquí: su external_ref es meetingId/contactId de WhatsAppHub, no
    // session_key — la asociación rica sigue siendo el flujo de la rama fuentes.)
    const linkedThreadIds: string[] = [];
    for (const sessionKey of sessionKeys) {
      const thread = await getThreadBySessionKey(tx, sessionKey);
      if (!thread) continue;
      if (thread.projectId !== project.id) await setThreadProject(tx, thread.id, project.id);
      linkedThreadIds.push(thread.id);
    }

    const durationMs = Math.max(0, nowMs() - started);
    const phaseGate = plan.gates.find((g) => g.when === "phase_close") ?? null;

    // Recibo INMUTABLE del launch (triple candado NM-3: FK + snapshot + hash).
    const launch = await insertModuleLaunch(tx, {
      id: launchId,
      moduleId: fresh.id,
      moduleSlug: fresh.slug,
      moduleVersion: fresh.version,
      phase: fresh.phase,
      orgId: organization.id,
      projectId: project.id,
      blueprintSnapshot: fresh.blueprint,
      blueprintHash: fresh.blueprintHash,
      inputs: redactedInputs,
      inputsDigest,
      toggles: plan.toggles,
      methodologyId: methodology.main.id,
      result: {
        tasks: plan.tasks.map((pt) => ({
          key: pt.key,
          taskId: taskByKey.get(pt.key)!.id,
          assigneeSlug: assignments.get(pt.key)!.agentSlug,
          status: pt.status,
        })),
        gate: phaseGate
          ? { name: phaseGate.name, blocks_next_stage: phaseGate.blocksNextStage, state: "pending" }
          : null,
        gates: plan.gates,
        deliverables: plan.deliverables,
        budget: {
          phase_usd: plan.budget.phaseUsd,
          per_run_usd: plan.budget.perRunUsd,
          warning_thresholds_pct: plan.budget.warningThresholdsPct,
          config_key: `budget:project:${project.id}`,
        },
        methodology: {
          id: methodology.main.id,
          slug: methodology.main.slug,
          version: methodology.main.version,
          adds: methodology.adds.map((m) => ({ id: m.id, slug: m.slug, version: m.version })),
        },
        cadence_excluded: plan.cadenceExcluded,
        // Confirmadas por el humano (CA-M3.4): la re-creación al cerrar una
        // instancia consulta ESTA lista del recibo — consent-first de punta a punta.
        cadences_confirmed: plan.cadencesConfirmed,
        linked_threads: linkedThreadIds,
      },
      taskCount: plan.tasks.length,
      budgetPhaseUsd: plan.budget.phaseUsd,
      budgetPerRunUsd: plan.budget.perRunUsd,
      // Encadenado US-M3: explícito del llamador, o auto-completado con el
      // último launch del proyecto reutilizado ("lo pasan automáticamente").
      previousLaunchId:
        input.previousLaunchId ?? (await getLatestLaunchForProject(tx, project.id))?.id ?? null,
      idempotencyKey: input.idempotencyKey,
      actor: input.actor,
      durationMs,
      createdAt: now,
    });

    // Auditoría (NM-5: mismo helper de siempre, inputs redactados).
    await appendAudit(tx, {
      actor: input.actor,
      source: input.actor.startsWith("person:") ? "ui" : "system",
      action: "modules.launch",
      entityType: "module_launch",
      entityId: launchId,
      after: {
        idempotency_key: input.idempotencyKey,
        module: `${fresh.slug}@${fresh.version}`,
        module_id: fresh.id,
        org_id: organization.id,
        project_id: project.id,
        task_count: plan.tasks.length,
        inputs: redactedInputs,
        toggles: plan.toggles,
      },
    });

    return {
      kind: "created",
      launch,
      project,
      organization,
      tasks: plan.tasks.map((pt) => taskByKey.get(pt.key)!),
      stageAdvancedFrom,
    };
  });

  if (outcome.kind === "idempotent") {
    return await idempotentResult(db, outcome.launch, inputsDigest, input.idempotencyKey);
  }

  // Eventos AG-UI a publicar POST-commit (board:<project_id>, patrón del motor
  // del tablero: task.created por tarea + module.launched como cierre).
  const topic = `board:${outcome.project.id}`;
  const pendingEvents: LaunchPendingEvent[] = outcome.tasks.map((task) => ({
    topic,
    event: {
      type: "task.created",
      payload: { taskId: task.id, status: task.status, actor: input.actor, launchId },
      runId: null,
    },
  }));
  // Encadenado US-M3: el avance de fase del proyecto también se anuncia.
  if (outcome.stageAdvancedFrom !== null) {
    pendingEvents.push({
      topic,
      event: {
        type: "project.stage_changed",
        payload: {
          projectId: outcome.project.id,
          from: outcome.stageAdvancedFrom,
          to: outcome.project.stage,
          gateState: outcome.project.gateState,
          launchId,
          actor: input.actor,
        },
        runId: null,
      },
    });
  }
  pendingEvents.push({
    topic,
    event: {
      type: "module.launched",
      payload: {
        launchId,
        moduleSlug: outcome.launch.moduleSlug,
        moduleVersion: outcome.launch.moduleVersion,
        projectId: outcome.project.id,
        orgId: outcome.organization.id,
        taskCount: outcome.launch.taskCount,
        actor: input.actor,
      },
      runId: null,
    },
  });

  return {
    launch: outcome.launch,
    project: outcome.project,
    organization: outcome.organization,
    tasks: outcome.tasks,
    idempotent: false,
    durationMs: outcome.launch.durationMs,
    pendingEvents,
  };
}

// ── Preview (dry-run — CA-M2.1) ─────────────────────────────────────────────

export interface PreviewLaunchInput {
  moduleSlug: string;
  /**
   * Sin versión: la ACTIVA (igual que el launch). Con versión explícita se
   * permite previsualizar también un draft/archived (dry-run puro, nada se
   * escribe): sirve para ver el plan de un borrador antes de publicarlo.
   */
  moduleVersion?: number;
  inputs: Record<string, unknown>;
  toggles?: Record<string, boolean>;
  /** Cadencias confirmadas por el humano (CA-M3.4): entran al plan del dry-run. */
  cadencesConfirmed?: string[];
  /** Epoch ms inyectable para determinismo de `{{hoy}}` y due_at. */
  now?: number;
}

/** Issue de preview: los BlueprintIssue de shared más los de resolución con DB. */
export interface PreviewIssue {
  code: string;
  path: string;
  details?: Record<string, unknown> | undefined;
}

export interface PreviewTask {
  key: string;
  templateKey: string;
  fanOutValue: string | null;
  title: string;
  description: string | null;
  definitionOfDone: string | null;
  stage: string;
  activityType: string;
  priority: string;
  role: string;
  /** Asignación RESUELTA contra el roster actual (slug real del agente). */
  assigneeAgentSlug: string;
  assigneeAgentId: string;
  dependsOn: string[];
  produces: string[];
  gate: string | null;
  requiresApproval: boolean;
  status: "READY" | "BACKLOG";
  dueAt: number | null;
}

export interface PreviewLaunchResult {
  ok: boolean;
  module: {
    id: string;
    slug: string;
    version: number;
    name: string;
    phase: string;
    projectType: string;
    status: string;
  };
  /** Claves de inputs requeridos que faltan (el wizard deshabilita Disparar). */
  missing: string[];
  issues: PreviewIssue[];
  plan: {
    projectName: string;
    workspacePath: string;
    tasks: PreviewTask[];
    gates: LaunchPlan["gates"];
    deliverables: LaunchPlan["deliverables"];
    methodology: LaunchPlan["methodology"];
    budget: LaunchPlan["budget"];
    toggles: Record<string, boolean>;
    cadenceExcluded: string[];
    cadencesConfirmed: string[];
    /** Propuestas de cadencia para el resumen del wizard (CA-M3.4 — M6a). */
    cadenceProposals: LaunchPlan["cadenceProposals"];
  } | null;
}

/**
 * Dry-run del launch (CA-M2.1): ejecuta EXACTAMENTE el pre-vuelo del motor
 * (blueprint → inputs → plan → asignaciones contra el roster real →
 * metodología) sin escribir NADA. Devuelve las tareas que se crearían con
 * título renderizado, asignación por rol resuelta, deps, due, gates y
 * entregables efectivos — o `{ok:false, missing, issues}` fail-closed.
 */
export async function previewLaunch(
  db: AnyDb,
  input: PreviewLaunchInput,
): Promise<PreviewLaunchResult> {
  const now = input.now ?? nowMs();

  // Módulo: activa por defecto; una versión explícita se acepta en cualquier
  // status (preview de borradores) — el launch real seguirá exigiendo active.
  let module: PhaseModule;
  if (input.moduleVersion !== undefined) {
    const row = await getModuleVersion(db, input.moduleSlug, input.moduleVersion);
    if (!row) throw errors.notFound("phase_module", `${input.moduleSlug}@${input.moduleVersion}`);
    module = row;
  } else {
    const active = await getActiveModule(db, input.moduleSlug);
    if (!active) {
      const any = await listPhaseModules(db, { slug: input.moduleSlug });
      if (any.length === 0) throw errors.notFound("phase_module", input.moduleSlug);
      moduleNotActive(input.moduleSlug, null, any[0]!.status);
    }
    module = active!;
  }

  const moduleInfo = {
    id: module.id,
    slug: module.slug,
    version: module.version,
    name: module.name,
    phase: module.phase,
    projectType: module.projectType,
    status: module.status,
  };
  const fail = (missing: string[], issues: PreviewIssue[]): PreviewLaunchResult => ({
    ok: false,
    module: moduleInfo,
    missing,
    issues,
    plan: null,
  });

  const bpResult = validateBlueprint(module.blueprint);
  if (!bpResult.ok || !bpResult.blueprint) return fail([], bpResult.issues);
  const bp = bpResult.blueprint;

  const inputsResult = validateLaunchInputs(bp, input.inputs, input.toggles ?? {});
  if (!inputsResult.ok) return fail(inputsResult.missing, inputsResult.issues);

  const plan = planLaunch(
    bp,
    inputsResult.values,
    inputsResult.toggles,
    now,
    input.cadencesConfirmed ?? [],
  );
  if (!plan.ok) return fail([], plan.issues);

  // Asignaciones y metodología contra la DB real: los errores de dominio se
  // devuelven como issues (el wizard los muestra; nada que "lanzar" en un dry-run).
  const issues: PreviewIssue[] = [];
  let assignments: Map<string, { agentId: string; agentSlug: string }> = new Map();
  try {
    assignments = await resolveAssignments(db, plan);
  } catch (err) {
    if (err instanceof AgentosError && err.code === ErrorCodes.AGENT_NOT_ASSIGNABLE) {
      issues.push({
        code: "agent_not_assignable",
        path: "roster",
        details: (err.details ?? {}) as Record<string, unknown>,
      });
    } else {
      throw err;
    }
  }
  try {
    await resolveMethodology(db, plan);
  } catch (err) {
    if (err instanceof AgentosError && err.code === ErrorCodes.VALIDATION_ERROR) {
      const detailIssues = Array.isArray(err.details) ? (err.details as PreviewIssue[]) : [];
      issues.push(
        ...(detailIssues.length > 0
          ? detailIssues
          : [{ code: "unknown_methodology", path: "methodology" }]),
      );
    } else {
      throw err;
    }
  }
  if (issues.length > 0) return fail([], issues);

  return {
    ok: true,
    module: moduleInfo,
    missing: [],
    issues: [],
    plan: {
      projectName: plan.projectName,
      workspacePath: plan.workspacePath,
      tasks: plan.tasks.map((pt) => {
        const a = assignments.get(pt.key)!;
        return {
          key: pt.key,
          templateKey: pt.templateKey,
          fanOutValue: pt.fanOutValue,
          title: pt.title,
          description: pt.description,
          definitionOfDone: pt.definitionOfDone,
          stage: pt.stage,
          activityType: pt.activityType,
          priority: pt.priority,
          role: pt.role,
          assigneeAgentSlug: a.agentSlug,
          assigneeAgentId: a.agentId,
          dependsOn: pt.dependsOn,
          produces: pt.produces,
          gate: pt.gate,
          requiresApproval: pt.requiresApproval,
          status: pt.status,
          dueAt: pt.dueAt,
        };
      }),
      gates: plan.gates,
      deliverables: plan.deliverables,
      methodology: plan.methodology,
      budget: plan.budget,
      toggles: plan.toggles,
      cadenceExcluded: plan.cadenceExcluded,
      cadencesConfirmed: plan.cadencesConfirmed,
      cadenceProposals: plan.cadenceProposals,
    },
  };
}

// ── Idempotencia ────────────────────────────────────────────────────────────

function idempotencyConflict(key: string, existing: ModuleLaunch): AgentosError {
  return new AgentosError(
    ErrorCodes.IDEMPOTENCY_CONFLICT,
    `La idempotency_key "${key}" ya se usó con inputs DISTINTOS (launch ${existing.id}); ` +
      `un reintento debe llevar exactamente los mismos inputs (CA-M2.6)`,
    { idempotencyKey: key, existingLaunchId: existing.id, existingDigest: existing.inputsDigest },
  );
}

/**
 * Retorno idempotente: reconstruye el resultado desde el recibo. Sin
 * `pendingEvents` — no se creó nada nuevo y re-publicar duplicaría el stream.
 */
async function idempotentResult(
  db: AnyDb,
  existing: ModuleLaunch,
  inputsDigest: string,
  idempotencyKey: string,
): Promise<LaunchModuleResult> {
  if (existing.inputsDigest !== inputsDigest) throw idempotencyConflict(idempotencyKey, existing);
  const project = await getProject(db, existing.projectId);
  const organization = await getOrganization(db, existing.orgId);
  if (!project || !organization) {
    // Un recibo sin proyecto/org sería corrupción de datos: fail-closed.
    throw errors.notFound("module_launch materialization", existing.id);
  }
  const resultTasks = (existing.result as { tasks?: { taskId: string }[] }).tasks ?? [];
  const tasks: Task[] = [];
  for (const t of resultTasks) {
    const row = await getTask(db, t.taskId);
    if (row) tasks.push(row);
  }
  return {
    launch: existing,
    project,
    organization,
    tasks,
    idempotent: true,
    durationMs: existing.durationMs,
    pendingEvents: [],
  };
}
