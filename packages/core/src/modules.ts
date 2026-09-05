/**
 * Capa de core de los Módulos de Fase (ARCHITECTURE §13.3): el motor
 * transaccional vive en @agentos/db (`launchModule`) y NO publica nada; esta
 * capa publica sus `pendingEvents` AG-UI POST-commit por el `EventSink`
 * inyectable (mismo límite de propiedad que el motor del tablero: core no
 * conoce el bus real — apps/api inyecta `busSink`).
 *
 * Publicar dentro de la transacción dejaría eventos fantasma en rollback; por
 * eso el flush es estrictamente posterior al commit. Un retorno idempotente
 * llega con `pendingEvents` vacío y aquí no se re-publica nada.
 */
import {
  DAY_MS,
  cadencePeriodDays,
  computeRequiresApproval,
  errors,
  nowMs,
  renderTemplate,
  validateLaunchInputs,
  type KnowledgeKind,
  type ModuleBlueprint,
  type PlannedDeliverable,
  type Stage,
} from "@agentos/shared";
import {
  REDACTED,
  appendAudit,
  appendTaskEvent,
  countDocs,
  countOpenTasksByTemplateKey,
  countProcesses,
  countProjectArtifactsByKind,
  createTask,
  findLatestProjectArtifact,
  getActiveModule,
  getLatestLaunchForProject,
  getLaunch,
  getOrganization,
  getProject,
  getTask,
  launchModule,
  listPhaseModules,
  listTaskEvents,
  maxOrderKey,
  resolveRoleAgainstRoster,
  type AgentosDb,
  type LaunchModuleInput,
  type LaunchModuleResult,
  type ModuleLaunch,
  type PhaseModule,
  type Task,
} from "@agentos/db";
import type { EventSink } from "./events.js";

export async function launchModuleWithEvents(
  db: AgentosDb,
  sink: EventSink,
  input: LaunchModuleInput,
): Promise<LaunchModuleResult> {
  const result = await launchModule(db, input);
  for (const pending of result.pendingEvents) {
    await sink.publish(pending.topic, pending.event);
  }
  return result;
}

// ── Estado de cierre de fase (CA-M3.1 — §13.8) ─────────────────────────────

export interface PhaseClosureItem {
  kind: string;
  source: "knowledge_doc" | "process" | "artifact";
  required: number;
  found: number;
  /** Legible para la UI (es-ES); null cuando el mínimo está cubierto. */
  missing: string | null;
}

export interface PhaseClosureStatus {
  launchId: string | null;
  complete: boolean;
  items: PhaseClosureItem[];
  reason?: "no_launch";
}

const SOURCE_LABEL: Record<PhaseClosureItem["source"], string> = {
  knowledge_doc: "documento(s) en el Context Hub",
  process: "proceso(s) as-is mapeados",
  artifact: "artefacto(s) adjuntos a tareas del proyecto",
};

/**
 * Compara los `deliverables` EFECTIVOS del último launch del proyecto (recibo
 * `module_launches.result`, con `min_from_input` ya resuelto y toggles podados)
 * contra la realidad: knowledge_docs del proyecto por kind, processes as_is de
 * la organización, y artifacts por kind en tareas del proyecto. El gate de
 * fase no debe aprobarse con faltantes (CA-M3.1).
 */
export async function phaseClosureStatus(db: AgentosDb, projectId: string): Promise<PhaseClosureStatus> {
  const project = await getProject(db, projectId);
  if (!project) throw errors.notFound("project", projectId);

  const launch = await getLatestLaunchForProject(db, projectId);
  if (!launch) return { launchId: null, complete: false, items: [], reason: "no_launch" };

  const raw = (launch.result as { deliverables?: unknown }).deliverables;
  const deliverables: PlannedDeliverable[] = Array.isArray(raw)
    ? (raw as PlannedDeliverable[]).filter(
        (d) =>
          d !== null &&
          typeof d === "object" &&
          typeof d.kind === "string" &&
          (d.source === "knowledge_doc" || d.source === "process" || d.source === "artifact"),
      )
    : [];

  // El .map() original pasa a necesitar await por elemento: for…of explícito.
  const items: PhaseClosureItem[] = [];
  for (const d of deliverables) {
    const required = typeof d.min === "number" && Number.isFinite(d.min) && d.min > 0 ? d.min : 1;
    let found: number;
    switch (d.source) {
      case "knowledge_doc":
        // El deliverable declara el kind como string libre; countDocs lo tipa
        // fino (KnowledgeKind) pero el SQL original tampoco lo restringía.
        found = await countDocs(db, { projectId, kind: d.kind as KnowledgeKind });
        break;
      case "process":
        found = await countProcesses(db, { orgId: project.orgId, variant: "as_is" });
        break;
      case "artifact":
        found = await countProjectArtifactsByKind(db, projectId, d.kind);
        break;
    }
    const missing =
      found >= required
        ? null
        : `Falta(n) ${required - found} de ${required} "${d.kind}" — ${SOURCE_LABEL[d.source]}` +
          (d.producedBy ? ` (los produce la plantilla "${d.producedBy}")` : "");
    items.push({ kind: d.kind, source: d.source, required, found, missing });
  }

  return {
    launchId: launch.id,
    complete: items.every((i) => i.missing === null),
    items,
  };
}

// ── Encadenado de fases (US-M3 / CA-M3.2 — §13.8, M6a) ─────────────────────

/** Cadena de fases: la fase del módulo actual determina la siguiente. */
const NEXT_PHASE: Record<Stage, Stage | null> = {
  ENTENDER: "CONSTRUIR",
  CONSTRUIR: "OPERAR",
  OPERAR: null,
};

export interface NextPhasePrefill {
  module: {
    id: string;
    slug: string;
    version: number;
    name: string;
    phase: Stage;
    projectType: string;
  };
  /**
   * Inputs pre-llenados. Incluye los DECLARADOS por el módulo siguiente que se
   * pudieron mapear, más las claves de identidad genéricas (empresa/alias/
   * industria/empleados/sponsor) aunque el módulo no las declare — el launch
   * ignora inputs no declarados, y así el wizard puede mostrarlas de contexto.
   */
  inputs: Record<string, unknown>;
  /** Inputs REQUERIDOS del módulo siguiente que el prefill NO cubrió. */
  missing_required: string[];
}

/**
 * Parsea el contenido de un artifact `roadmap` a lista de palancas: JSON array
 * de strings, o líneas de lista markdown (`- x`, `* x`, `1. x`). Si no es
 * parseable, devuelve [] — el humano las pega a mano (CA-M3.2: no inventar).
 */
export function parseRoadmapLevers(content: string | null | undefined): string[] {
  if (!content || content.trim() === "") return [];
  const text = content.trim();
  try {
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed) && parsed.every((v) => typeof v === "string")) {
      return (parsed as string[]).map((v) => v.trim()).filter((v) => v !== "");
    }
  } catch {
    /* no era JSON: probar lista markdown */
  }
  const levers: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:[-*•]|\d+[.)])\s+(.+?)\s*$/.exec(line);
    if (m) levers.push(m[1]!);
  }
  return levers;
}

/** Primer valor no-vacío y NO redactado (los sensibles llegan `[redacted]` del recibo). */
function firstUsable(...candidates: unknown[]): unknown {
  for (const v of candidates) {
    if (v === undefined || v === null) continue;
    if (typeof v === "string" && (v.trim() === "" || v === REDACTED)) continue;
    return v;
  }
  return undefined;
}

/** Claves que NO se arrastran entre fases: son decisiones nuevas por fase. */
const NON_CARRYOVER_INPUT_KEYS = new Set(["fecha_objetivo", "presupuesto_fase", "presupuesto_run"]);

/**
 * CA-M3.2: construye los inputs pre-llenados del módulo SIGUIENTE desde el
 * Context Hub y el recibo anterior, SIN persistir nada. Mapea lo obvio y
 * genérico — empresa/alias/industria/tamaño desde la organización y los inputs
 * del launch anterior (los NO redactados) — y, para el módulo con input
 * `palancas` (implementacion), las palancas desde el artifact `roadmap`
 * aprobado del proyecto (artifact kind='roadmap' en tarea DONE); si su
 * contenido no es parseable a lista, quedan vacías para que el humano las
 * pegue — nunca se inventa.
 */
export async function prefillNextPhaseInputs(
  db: AgentosDb,
  projectId: string,
  nextModuleSlug: string,
): Promise<NextPhasePrefill> {
  const project = await getProject(db, projectId);
  if (!project) throw errors.notFound("project", projectId);
  const organization = await getOrganization(db, project.orgId);
  const module = await getActiveModule(db, nextModuleSlug);
  if (!module) throw errors.notFound("phase_module(active)", nextModuleSlug);
  const bp = module.blueprint as ModuleBlueprint;

  const previous = await getLatestLaunchForProject(db, projectId);
  const prev: Record<string, unknown> = (previous?.inputs as Record<string, unknown>) ?? {};

  // Identidad genérica (org + recibo anterior). `cliente` sigue la convención
  // del render: alias ?? empresa ?? cliente (§13.2).
  const generic: Record<string, unknown> = {};
  const put = (key: string, value: unknown): void => {
    if (value !== undefined) generic[key] = value;
  };
  put("empresa", firstUsable(prev["empresa"], organization?.name));
  put("alias", firstUsable(prev["alias"], prev["cliente"]));
  put("cliente", firstUsable(prev["alias"], prev["empresa"], prev["cliente"], organization?.name));
  put("industria", firstUsable(prev["industria"], organization?.industry));
  put("empleados", firstUsable(prev["empleados"], organization?.employeeCount));
  put("sponsor", firstUsable(prev["sponsor"]));
  // El proyecto de origen ES este proyecto: su nombre es dato, no invención.
  put("proyecto_origen", project.name);

  const inputs: Record<string, unknown> = { ...generic };

  for (const input of bp.inputs) {
    if (inputs[input.key] !== undefined) continue;
    if (NON_CARRYOVER_INPUT_KEYS.has(input.key)) continue; // decisión nueva por fase
    if (input.type === "source_refs") continue; // los hilos ya viven en el proyecto

    if (input.key === "palancas" && input.type === "list_text") {
      // CA-M3.2: cada palanca priorizada del roadmap APROBADO alimenta CONSTRUIR.
      const artifact = await findLatestProjectArtifact(db, projectId, "roadmap", { taskStatus: "DONE" });
      const levers = parseRoadmapLevers(artifact?.content);
      const fits =
        levers.length > 0 &&
        levers.length >= (input.min_items ?? 0) &&
        (input.max_items === undefined || levers.length <= input.max_items);
      if (fits) inputs[input.key] = levers;
      continue;
    }

    // Arrastre genérico por MISMA clave desde el recibo anterior (no redactado).
    const carried = firstUsable(prev[input.key]);
    if (carried !== undefined) inputs[input.key] = carried;
  }

  // missing_required con el MISMO validador del launch (default_from incluido).
  const check = validateLaunchInputs(bp, inputs);
  return {
    module: {
      id: module.id,
      slug: module.slug,
      version: module.version,
      name: module.name,
      phase: module.phase,
      projectType: module.projectType,
    },
    inputs,
    missing_required: check.missing,
  };
}

export type NextPhaseStatus =
  | {
      available: false;
      reason:
        | "no_launch"
        | "no_next_phase"
        | "phase_incomplete"
        | "gate_pending"
        | "no_active_module";
      /** Detalle del cierre cuando la razón es phase_incomplete. */
      closure?: PhaseClosureStatus;
      next_phase?: Stage | null;
    }
  | {
      available: true;
      next_phase: Stage;
      next_module: NextPhasePrefill["module"];
      prefilled: { inputs: Record<string, unknown>; missing_required: string[] };
      /** Launch de la fase actual: el launch nuevo debe llevarlo (US-M3). */
      previous_launch_id: string;
    };

/**
 * CA-M3.2: ¿puede dispararse la SIGUIENTE fase sobre este proyecto? Disponible
 * sii el cierre de fase está completo (phaseClosureStatus) Y el gate del
 * proyecto está aprobado. La cadena va por la fase del módulo actual:
 * ENTENDER→implementacion, CONSTRUIR→operacion, OPERAR→null (módulo siguiente
 * = el ACTIVO de esa fase). El REST y el MCP exponen esto tal cual.
 */
export async function nextPhaseStatus(db: AgentosDb, projectId: string): Promise<NextPhaseStatus> {
  const project = await getProject(db, projectId);
  if (!project) throw errors.notFound("project", projectId);

  const launch = await getLatestLaunchForProject(db, projectId);
  if (!launch) return { available: false, reason: "no_launch" };

  const nextPhase = NEXT_PHASE[launch.phase];
  if (nextPhase === null) return { available: false, reason: "no_next_phase", next_phase: null };

  const closure = await phaseClosureStatus(db, projectId);
  if (!closure.complete) {
    return { available: false, reason: "phase_incomplete", closure, next_phase: nextPhase };
  }
  if (project.gateState !== "approved") {
    return { available: false, reason: "gate_pending", next_phase: nextPhase };
  }

  const activeModules = await listPhaseModules(db, { status: "active" });
  const nextModule = activeModules.find((m: PhaseModule) => m.phase === nextPhase);
  if (!nextModule) {
    return { available: false, reason: "no_active_module", next_phase: nextPhase };
  }

  const prefill = await prefillNextPhaseInputs(db, projectId, nextModule.slug);
  return {
    available: true,
    next_phase: nextPhase,
    next_module: prefill.module,
    prefilled: { inputs: prefill.inputs, missing_required: prefill.missing_required },
    previous_launch_id: launch.id,
  };
}

// ── Cadencia consent-first: re-creación al cerrar instancia (CA-M3.4 — M6a) ─

/**
 * Mapeo tarea→plantilla ELEGIDO (documentado): el task_event `created` de cada
 * tarea de launch lleva `{launch_id, template_key}` en su payload (lo escribe
 * el motor de launch; las instancias re-creadas escriben el mismo shape). Es
 * más robusto que extender `module_launches.result` porque el recibo es
 * INMUTABLE por contrato (append-only, NM-3) y porque la cadena de re-creación
 * (instancia n → n+1 → n+2…) queda mapeada sin mutar nada: cada instancia
 * nueva nace con su propio evento `created` con la misma template_key.
 */
interface CadenceOrigin {
  launchId: string;
  templateKey: string;
  fanOutValue: string | null;
}

async function cadenceOriginOf(db: AgentosDb, taskId: string): Promise<CadenceOrigin | null> {
  // listTaskEvents ya viene ordenado por created_at y con el payload parseado.
  const events = await listTaskEvents(db, taskId);
  const created = events.find((e) => e.kind === "created");
  const payload = created?.payload;
  if (!payload) return null;
  const launchId = payload["launch_id"];
  const templateKey = payload["template_key"];
  if (typeof launchId !== "string" || typeof templateKey !== "string") return null;
  const fanOutValue = payload["fan_out_value"];
  return {
    launchId,
    templateKey,
    fanOutValue: typeof fanOutValue === "string" ? fanOutValue : null,
  };
}

/** Guarda-raíl anti-bucle: ¿existe ya una instancia ABIERTA de la plantilla en el proyecto? */
async function hasOpenInstance(db: AgentosDb, projectId: string, templateKey: string): Promise<boolean> {
  return (await countOpenTasksByTemplateKey(db, projectId, templateKey)) > 0;
}

/** Clave de orden al FINAL de READY (mismo algoritmo que el motor del tablero). */
async function readyOrderKey(db: AgentosDb, projectId: string): Promise<string> {
  const last = await maxOrderKey(db, projectId, "READY");
  if (!last) return "m";
  const tail = last.charCodeAt(last.length - 1);
  if (tail < "z".charCodeAt(0)) return last.slice(0, -1) + String.fromCharCode(tail + 1);
  return `${last}m`;
}

async function skipCadence(
  db: AgentosDb,
  doneTask: Task,
  origin: CadenceOrigin,
  reason: string,
  details: Record<string, unknown>,
  runId: string | null,
): Promise<null> {
  // Aviso fail-soft (CA-M3.4): la cadencia NO renace, pero queda rastro en el
  // timeline de la instancia cerrada y en audit_log — nadie la pierde en silencio.
  await appendTaskEvent(db, {
    taskId: doneTask.id,
    runId,
    kind: "comment",
    actor: "system:cadence",
    payload: {
      body:
        `La cadencia "${origin.templateKey}" no se re-creó (${reason}). ` +
        `Revisa el roster o crea la siguiente instancia a mano.`,
      cadence_skipped: true,
      template_key: origin.templateKey,
      reason,
      ...details,
    },
  });
  await appendAudit(db, {
    actor: "system:cadence",
    source: "system",
    action: "modules.cadence_skipped",
    entityType: "task",
    entityId: doneTask.id,
    after: { template_key: origin.templateKey, launch_id: origin.launchId, reason, ...details },
    reason: `re-creación de cadencia omitida: ${reason}`,
    runId,
  });
  return null;
}

/**
 * CA-M3.4 (M6a) — re-creación consent-first al cerrar instancia. Se invoca
 * desde el hook de DONE del motor del tablero (junto a promoteUnblockedTasks,
 * mismo patrón fail-soft; la cadencia NO va por el tick del dispatcher).
 *
 * Si la tarea cerrada corresponde a una plantilla `cadence` CONFIRMADA en el
 * recibo de su launch (`result.cadences_confirmed`), crea la SIGUIENTE
 * instancia: título/DoD re-renderizados con los inputs del recibo (redactados
 * — por eso validateBlueprint prohíbe vars sensibles en cadencias), asignado
 * por rol RE-resuelto contra el roster actual, due_at = due de la cerrada +
 * periodo (o now + periodo si no tenía), status READY (las cadencias no llevan
 * deps), requiresApproval por política. Guarda-raíl anti-bucle: si ya hay una
 * instancia ABIERTA (no DONE/CANCELLED) de esa plantilla en el proyecto, no se
 * crea otra. Devuelve la tarea creada o null (nada que hacer / skip avisado).
 */
export async function respawnCadenceInstance(
  db: AgentosDb,
  doneTaskId: string,
  ctx: { runId?: string | null; now?: number } = {},
): Promise<Task | null> {
  const runId = ctx.runId ?? null;
  const now = ctx.now ?? nowMs();

  const doneTask = await getTask(db, doneTaskId);
  if (!doneTask || doneTask.status !== "DONE") return null;

  const origin = await cadenceOriginOf(db, doneTaskId);
  if (!origin) return null; // tarea sin launch (manual/delegada): no hay cadencia

  const launch: ModuleLaunch | undefined = await getLaunch(db, origin.launchId);
  if (!launch || launch.projectId !== doneTask.projectId) return null;

  const confirmedRaw = (launch.result as { cadences_confirmed?: unknown }).cadences_confirmed;
  const confirmed = Array.isArray(confirmedRaw) ? (confirmedRaw as string[]) : [];
  if (!confirmed.includes(origin.templateKey)) return null; // consent-first: solo confirmadas

  const bp = launch.blueprintSnapshot as ModuleBlueprint;
  const tpl = bp.templates.find((t) => t.key === origin.templateKey && t.cadence === true);
  if (!tpl) return null;

  // Guarda-raíl anti-bucle: una instancia abierta ya cubre la cadencia.
  if (await hasOpenInstance(db, doneTask.projectId, origin.templateKey)) return null;

  const period = cadencePeriodDays(tpl);
  if (period === null) {
    return skipCadence(db, doneTask, origin, "sin_periodo", {}, runId);
  }

  // Asignado por rol re-resuelto contra el roster ACTUAL (si cambió, cambia).
  const rosterEntry = bp.roster.find((r) => r.role === tpl.assign.role);
  const assignment = rosterEntry
    ? await resolveRoleAgainstRoster(db, { agentSlug: rosterEntry.agent, layer: rosterEntry.layer })
    : null;
  if (!assignment) {
    return skipCadence(db, doneTask, origin, "agent_not_assignable", {
      role: tpl.assign.role,
      layer: rosterEntry?.layer ?? null,
    }, runId);
  }

  // Re-render con los inputs del RECIBO (mismas vars del plan: inputs ∪ toggles
  // ∪ built-ins; fan_out_value si la instancia original era fan_out).
  const vars: Record<string, unknown> = { ...(launch.inputs as Record<string, unknown>) };
  for (const [k, v] of Object.entries((launch.toggles as Record<string, boolean>) ?? {})) vars[k] = v;
  const cliente = vars["alias"] ?? vars["empresa"] ?? vars["cliente"];
  if (cliente !== undefined) vars["cliente"] = cliente;
  vars["hoy"] = new Date(now).toISOString().slice(0, 10);
  if (tpl.fan_out && origin.fanOutValue !== null) vars[tpl.fan_out.as] = origin.fanOutValue;

  let title: string;
  let description: string | null;
  let definitionOfDone: string | null;
  try {
    title = renderTemplate(tpl.title, vars);
    description = tpl.description !== undefined ? renderTemplate(tpl.description, vars) : null;
    definitionOfDone = tpl.dod !== undefined ? renderTemplate(tpl.dod, vars) : null;
  } catch (err) {
    return skipCadence(db, doneTask, origin, "render_failed", {
      error: err instanceof Error ? err.message : String(err),
    }, runId);
  }

  const dueAt = (doneTask.dueAt ?? now) + period * DAY_MS;
  const requiresApproval =
    computeRequiresApproval({ externalEffect: false, activityType: tpl.activity_type }) ||
    tpl.gate !== undefined;

  const created = await createTask(db, {
    projectId: doneTask.projectId,
    title,
    description,
    definitionOfDone,
    stage: tpl.stage,
    status: "READY", // sin deps por validación: entra directo a la cola
    activityType: tpl.activity_type,
    priority: tpl.priority ?? "normal",
    assigneeAgentId: assignment.agentId,
    requiresApproval,
    externalEffect: false,
    dueAt,
    orderKey: await readyOrderKey(db, doneTask.projectId),
  });
  await appendTaskEvent(db, {
    taskId: created.id,
    runId,
    kind: "created",
    toStatus: "READY",
    actor: "system:cadence",
    payload: {
      launch_id: origin.launchId,
      template_key: origin.templateKey,
      assignee: assignment.agentSlug,
      cadence: true,
      respawn_of: doneTask.id,
      ...(origin.fanOutValue !== null ? { fan_out_value: origin.fanOutValue } : {}),
    },
  });
  return created;
}
