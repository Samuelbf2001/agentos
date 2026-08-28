/**
 * Módulos de Fase — plan de launch PURO (ARCHITECTURE §13.3):
 * `validateLaunchInputs` (momento C, reglas `input_*`) y `planLaunch`
 * (expansión fan_out, poda por toggles, deps clave→instancias, orden
 * topológico estable, due_at determinista, READY/BACKLOG y política de
 * aprobación que SOLO sube). Sin DB ni reloj: `now` entra como parámetro.
 *
 * El motor transaccional que materializa este plan vive en @agentos/db (M2).
 */
import { computeRequiresApproval } from "./approval-policy.js";
import {
  MAX_LAUNCH_TASKS,
  type BlueprintIssue,
  type ModuleBlueprint,
  type ModuleInput,
  type ModuleTemplate,
  renderTemplate,
} from "./modules.js";
import type { Stage, TaskPriority } from "./schemas.js";
import { DAY_MS } from "./time.js";

// ── Validación de inputs de arranque (momento C — §13.5 `input_*`) ──────────

export interface LaunchInputsResult {
  ok: boolean;
  /** Claves de inputs requeridos que faltan (para el wizard CA-M2.1). */
  missing: string[];
  issues: BlueprintIssue[];
  /** Valores resueltos (con `default_from` aplicado), listos para planLaunch. */
  values: Record<string, unknown>;
  /** Toggles efectivos (defaults del blueprint + overrides del operador). */
  toggles: Record<string, boolean>;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isBlank(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === "string" && v.trim() === "");
}

/** `YYYY-MM-DD` → epoch ms a medianoche UTC (determinista, sin zona local). */
export function dateInputToEpochMs(v: unknown): number | null {
  if (typeof v !== "string" || !DATE_RE.test(v)) return null;
  const ms = Date.parse(`${v}T00:00:00.000Z`);
  return Number.isFinite(ms) ? ms : null;
}

function checkInputValue(
  input: ModuleInput,
  raw: unknown,
  issues: BlueprintIssue[],
): unknown {
  const path = `inputs.${input.key}`;
  const typeIssue = (details: Record<string, unknown>) =>
    issues.push({ code: "input_type_invalid", path, details: { type: input.type, ...details } });

  switch (input.type) {
    case "text":
    case "textarea": {
      if (typeof raw !== "string") return typeIssue({ found: typeof raw });
      if (input.max_len !== undefined && raw.length > input.max_len) {
        return typeIssue({ max_len: input.max_len, len: raw.length });
      }
      return raw;
    }
    case "number": {
      const n =
        typeof raw === "number"
          ? raw
          : typeof raw === "string" && /^-?\d+(\.\d+)?$/.test(raw.trim())
            ? Number(raw.trim())
            : NaN;
      if (!Number.isFinite(n)) return typeIssue({ found: raw });
      if (input.min !== undefined && n < input.min) return typeIssue({ min: input.min, found: n });
      return n;
    }
    case "date": {
      if (dateInputToEpochMs(raw) === null) return typeIssue({ found: raw, expected: "YYYY-MM-DD" });
      return raw;
    }
    case "multi_select": {
      if (!Array.isArray(raw) || raw.some((v) => typeof v !== "string")) {
        return typeIssue({ found: raw });
      }
      const values = raw as string[];
      const options = input.options ?? [];
      for (const v of values) {
        if (!options.includes(v)) {
          issues.push({ code: "input_option_not_allowed", path, details: { value: v, options } });
          return undefined;
        }
      }
      if (values.length < (input.min_items ?? 0)) {
        issues.push({ code: "input_min_items", path, details: { min_items: input.min_items, len: values.length } });
        return undefined;
      }
      if (input.max_items !== undefined && values.length > input.max_items) {
        return typeIssue({ max_items: input.max_items, len: values.length });
      }
      return values;
    }
    case "list_text": {
      if (!Array.isArray(raw) || raw.some((v) => typeof v !== "string" || v.trim() === "")) {
        return typeIssue({ found: raw });
      }
      const values = raw as string[];
      if (values.length < (input.min_items ?? 0)) {
        issues.push({ code: "input_min_items", path, details: { min_items: input.min_items, len: values.length } });
        return undefined;
      }
      if (input.max_items !== undefined && values.length > input.max_items) {
        return typeIssue({ max_items: input.max_items, len: values.length });
      }
      return values;
    }
    case "source_refs": {
      if (!Array.isArray(raw)) return typeIssue({ found: raw });
      return raw;
    }
  }
}

/**
 * Valida los inputs del formulario de arranque contra el blueprint.
 * Aplica `default_from` (en orden de declaración: `alias ← empresa`,
 * `procesos_core ← areas`) y los defaults de toggles. Fail-closed: cualquier
 * issue ⇒ `ok: false`. Los inputs NO declarados se ignoran (no llegan a render).
 */
export function validateLaunchInputs(
  bp: ModuleBlueprint,
  inputs: Record<string, unknown>,
  toggles: Record<string, boolean> = {},
): LaunchInputsResult {
  const issues: BlueprintIssue[] = [];
  const missing: string[] = [];
  const values: Record<string, unknown> = {};

  // Toggles efectivos: default del blueprint + override del operador.
  const effectiveToggles: Record<string, boolean> = {};
  const declaredToggles = new Set((bp.toggles ?? []).map((t) => t.key));
  for (const t of bp.toggles ?? []) {
    effectiveToggles[t.key] = toggles[t.key] ?? t.default ?? false;
  }
  for (const key of Object.keys(toggles)) {
    if (!declaredToggles.has(key)) {
      issues.push({ code: "unknown_toggle_ref", path: `toggles.${key}`, details: { toggle: key } });
    }
  }

  for (const input of bp.inputs) {
    let raw = inputs[input.key];
    if (isBlank(raw) && input.default_from !== undefined) {
      raw = values[input.default_from];
    }
    if (isBlank(raw)) {
      if (input.required) {
        missing.push(input.key);
        issues.push({ code: "input_required_missing", path: `inputs.${input.key}`, details: { key: input.key } });
      }
      continue;
    }
    const value = checkInputValue(input, raw, issues);
    if (value !== undefined) values[input.key] = value;
  }

  return { ok: issues.length === 0, missing, issues, values, toggles: effectiveToggles };
}

// ── Plan de launch (fan_out, poda, deps, orden, due, aprobación) ────────────

export interface PlannedTask {
  /** Clave de instancia: `kickoff` o `entrevista:direccion` (fan_out). */
  key: string;
  templateKey: string;
  /** Elemento del input que originó esta instancia (fan_out), o null. */
  fanOutValue: string | null;
  title: string;
  description: string | null;
  definitionOfDone: string | null;
  stage: Stage;
  activityType: string;
  priority: TaskPriority;
  /** Rol lógico del módulo + preferencia del roster (resolución a agente real en DB, M2). */
  role: string;
  agentSlug: string;
  layer: string;
  maxUsdPerRun: number | null;
  /** Claves de INSTANCIA de las que depende (dep a fan_out = todas sus instancias). */
  dependsOn: string[];
  produces: string[];
  gate: string | null;
  requiresApproval: boolean;
  /** READY si nace sin dependencias; BACKLOG si espera (CA-M2.3). */
  status: "READY" | "BACKLOG";
  dueAt: number | null;
}

export interface PlannedDeliverable {
  kind: string;
  source: "knowledge_doc" | "process" | "artifact";
  min: number;
  producedBy: string | null;
}

export interface PlannedGate {
  name: string;
  when: "phase_close" | "deliverable";
  /** Claves de PLANTILLA supervivientes a la poda (no instancias). */
  fedBy: string[];
  blocksNextStage: Stage | null;
}

/**
 * Propuesta de cadencia para el wizard (CA-M3.4, consent-first): plantilla
 * `cadence` activa (tras poda de toggles) con título renderizado y periodo.
 * El humano confirma cuáles activar vía `cadences_confirmed`.
 */
export interface CadenceProposal {
  key: string;
  title: string;
  description: string | null;
  activityType: string;
  role: string;
  /** Días entre instancias (`cadence_period_days` ?? `due_offset_days`); null = inconfirmable. */
  periodDays: number | null;
}

export interface LaunchPlan {
  ok: boolean;
  issues: BlueprintIssue[];
  tasks: PlannedTask[];
  gates: PlannedGate[];
  deliverables: PlannedDeliverable[];
  methodology: { slug: string; version: number | null; adds: string[] };
  budget: { phaseUsd: number; perRunUsd: number; warningThresholdsPct: number[] };
  toggles: Record<string, boolean>;
  /** Claves de plantillas `cadence` fuera del plan (activas pero NO confirmadas — consent-first). */
  cadenceExcluded: string[];
  /** Claves cadence CONFIRMADAS por el humano que SÍ entraron al plan (M6a). */
  cadencesConfirmed: string[];
  /** Todas las plantillas cadence activas, renderizadas para el resumen del wizard. */
  cadenceProposals: CadenceProposal[];
  projectName: string;
  workspacePath: string;
}

/**
 * Periodo efectivo de una plantilla cadence: `cadence_period_days` explícito,
 * o `due_offset_days` positivo como fallback (el SLA declara el ritmo). null =
 * sin periodo → la plantilla no puede confirmarse (`cadence_missing_period`).
 */
export function cadencePeriodDays(tpl: ModuleTemplate): number | null {
  if (typeof tpl.cadence_period_days === "number" && tpl.cadence_period_days > 0) {
    return tpl.cadence_period_days;
  }
  if (typeof tpl.due_offset_days === "number" && tpl.due_offset_days > 0) {
    return tpl.due_offset_days;
  }
  return null;
}

/** Clave estable y legible para instancias fan_out: minúsculas, sin acentos, `_`. */
export function slugifyFanOutValue(value: string): string {
  // NFD + \p{M}: descompone acentos y elimina las marcas combinantes (á → a).
  const slug = value
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug === "" ? "x" : slug;
}

interface Instance {
  key: string;
  tpl: ModuleTemplate;
  fanOutValue: string | null;
  dependsOn: string[];
}

/**
 * Construye el plan completo de un launch a partir del blueprint + valores
 * resueltos (de `validateLaunchInputs`) + toggles efectivos. Determinista:
 * `now` (epoch ms) entra como parámetro. Fail-closed: `ok: false` con issues
 * (`too_many_tasks` >40 instancias — NM-2; `fan_out_key_collision`).
 */
export function planLaunch(
  bp: ModuleBlueprint,
  values: Record<string, unknown>,
  toggles: Record<string, boolean>,
  now: number,
  /** Claves de plantillas `cadence` que el humano CONFIRMÓ en el wizard (M6a). */
  cadencesConfirmed: string[] = [],
): LaunchPlan {
  const issues: BlueprintIssue[] = [];

  // Toggles efectivos (por si llegan sin pasar por validateLaunchInputs).
  const effectiveToggles: Record<string, boolean> = {};
  for (const t of bp.toggles ?? []) effectiveToggles[t.key] = toggles[t.key] ?? t.default ?? false;

  // Variables de render: inputs resueltos ∪ toggles ∪ built-ins (§13.2).
  const vars: Record<string, unknown> = { ...values };
  for (const [k, v] of Object.entries(effectiveToggles)) vars[k] = v;
  const cliente = values["alias"] ?? values["empresa"] ?? values["cliente"];
  if (cliente !== undefined) vars["cliente"] = cliente;
  vars["hoy"] = new Date(now).toISOString().slice(0, 10);
  // sponsor y fecha_objetivo ya vienen de values si el módulo los declara.

  // 1) Poda: toggles apagados fuera; cadencia fuera del plan SALVO confirmación
  //    explícita del humano (consent-first, CA-M3.4 / M6a).
  const active = bp.templates.filter((t) => !t.when_toggle || effectiveToggles[t.when_toggle]);
  const activeKeys = new Set(active.map((t) => t.key));

  // 1b) cadences_confirmed: cada clave debe ser una plantilla cadence ACTIVA con
  //     periodo declarado — cualquier otra cosa es issue fail-closed.
  const confirmed = new Set<string>();
  for (const key of cadencesConfirmed) {
    const declared = bp.templates.find((t) => t.key === key);
    if (!declared || declared.cadence !== true) {
      issues.push({
        code: "cadence_unknown_key",
        path: `cadences_confirmed.${key}`,
        details: { key, reason: !declared ? "unknown_template" : "not_a_cadence_template" },
      });
      continue;
    }
    if (!activeKeys.has(key)) {
      issues.push({
        code: "cadence_unknown_key",
        path: `cadences_confirmed.${key}`,
        details: { key, reason: "disabled_by_toggle", toggle: declared.when_toggle ?? null },
      });
      continue;
    }
    if (cadencePeriodDays(declared) === null) {
      issues.push({
        code: "cadence_missing_period",
        path: `templates.${key}.cadence_period_days`,
        details: { key },
      });
      continue;
    }
    confirmed.add(key);
  }

  const cadenceExcluded = active.filter((t) => t.cadence === true && !confirmed.has(t.key)).map((t) => t.key);
  const planned = active.filter((t) => t.cadence !== true || confirmed.has(t.key));
  const plannedKeys = new Set(planned.map((t) => t.key));

  // 1c) Propuestas para el resumen del wizard: TODAS las cadence activas, con
  //     título renderizado y periodo (el humano marca cuáles confirmar).
  const cadenceProposals: CadenceProposal[] = active
    .filter((t) => t.cadence === true)
    .map((t) => {
      // fan_out en cadencia es teórico (ningún módulo real lo usa): para la
      // propuesta, la var de fan_out se rinde con la lista completa del input.
      const localVars = t.fan_out ? { ...vars, [t.fan_out.as]: values[t.fan_out.over] ?? "…" } : vars;
      return {
        key: t.key,
        title: renderTemplate(t.title, localVars),
        description: t.description !== undefined ? renderTemplate(t.description, localVars) : null,
        activityType: t.activity_type,
        role: t.assign.role,
        periodDays: cadencePeriodDays(t),
      };
    });

  // 2) Expansión fan_out → instancias con clave única.
  const instances: Instance[] = [];
  const byTemplate = new Map<string, string[]>();
  for (const tpl of planned) {
    const keys: string[] = [];
    if (tpl.fan_out) {
      const items = values[tpl.fan_out.over];
      const list = Array.isArray(items) ? (items as string[]) : [];
      const seen = new Set<string>();
      for (const item of list) {
        const key = `${tpl.key}:${slugifyFanOutValue(item)}`;
        if (seen.has(key)) {
          issues.push({
            code: "fan_out_key_collision",
            path: `templates.${tpl.key}.fan_out`,
            details: { key, value: item },
          });
          continue;
        }
        seen.add(key);
        keys.push(key);
        instances.push({ key, tpl, fanOutValue: item, dependsOn: [] });
      }
    } else {
      keys.push(tpl.key);
      instances.push({ key: tpl.key, tpl, fanOutValue: null, dependsOn: [] });
    }
    byTemplate.set(tpl.key, keys);
  }

  // 3) Deps clave de plantilla → claves de instancia. Dep a plantilla podada
  //    (toggle apagado o cadencia) se PODA — no es error (§13.5).
  for (const inst of instances) {
    const deps: string[] = [];
    for (const dep of inst.tpl.depends_on ?? []) {
      if (!plannedKeys.has(dep)) continue; // podada
      deps.push(...(byTemplate.get(dep) ?? []));
    }
    inst.dependsOn = deps;
  }

  // 4) Guardia NM-2: tope duro de instancias por launch.
  if (instances.length > MAX_LAUNCH_TASKS) {
    issues.push({
      code: "too_many_tasks",
      path: "templates",
      details: { count: instances.length, max: MAX_LAUNCH_TASKS },
    });
  }

  // 5) Orden topológico ESTABLE: respeta el orden de declaración entre
  //    independientes (O(n²) — irrelevante con ≤40 instancias).
  const ordered: Instance[] = [];
  const emitted = new Set<string>();
  const pending = [...instances];
  while (pending.length > 0) {
    const idx = pending.findIndex((i) => i.dependsOn.every((d) => emitted.has(d)));
    if (idx === -1) {
      // Ciclo: validateBlueprint ya lo reporta; aquí solo cerramos fail-closed.
      issues.push({
        code: "circular_dependency",
        path: "templates",
        details: { cycle: pending.map((i) => i.key) },
      });
      ordered.push(...pending);
      break;
    }
    const [inst] = pending.splice(idx, 1);
    ordered.push(inst!);
    emitted.add(inst!.key);
  }

  // 6) Tareas planificadas.
  const rosterByRole = new Map(bp.roster.map((r) => [r.role, r]));
  const tasks: PlannedTask[] = ordered.map((inst) => {
    const tpl = inst.tpl;
    const localVars = tpl.fan_out ? { ...vars, [tpl.fan_out.as]: inst.fanOutValue } : vars;
    const roster = rosterByRole.get(tpl.assign.role);
    // Cadencia confirmada sin due propio: la primera instancia vence a un
    // periodo de hoy (due_at = now + period — CA-M3.4).
    let dueAt = computeDueAt(tpl, values, now);
    if (dueAt === null && tpl.cadence === true) {
      const period = cadencePeriodDays(tpl);
      if (period !== null) dueAt = now + period * DAY_MS;
    }
    // Política que SOLO sube: la determinista, O un gate armado por la plantilla.
    const requiresApproval =
      computeRequiresApproval({ externalEffect: false, activityType: tpl.activity_type }) ||
      tpl.gate !== undefined;
    return {
      key: inst.key,
      templateKey: tpl.key,
      fanOutValue: inst.fanOutValue,
      title: renderTemplate(tpl.title, localVars),
      description: tpl.description !== undefined ? renderTemplate(tpl.description, localVars) : null,
      definitionOfDone: tpl.dod !== undefined ? renderTemplate(tpl.dod, localVars) : null,
      stage: tpl.stage,
      activityType: tpl.activity_type,
      priority: tpl.priority ?? "normal",
      role: tpl.assign.role,
      agentSlug: roster?.agent ?? "",
      layer: roster?.layer ?? "",
      maxUsdPerRun: roster?.max_usd_per_run ?? null,
      dependsOn: inst.dependsOn,
      produces: tpl.produces ?? [],
      gate: tpl.gate ?? null,
      requiresApproval,
      status: inst.dependsOn.length === 0 ? "READY" : "BACKLOG",
      dueAt,
    };
  });

  // 7) Gates y entregables efectivos tras la poda.
  const gates: PlannedGate[] = (bp.gates ?? []).map((g) => ({
    name: g.name,
    when: g.when,
    fedBy: g.fed_by.filter((k) => plannedKeys.has(k)),
    blocksNextStage: g.blocks_next_stage ?? null,
  }));
  const deliverables: PlannedDeliverable[] = (bp.closing_deliverables ?? [])
    .filter((d) => !d.when_toggle || effectiveToggles[d.when_toggle])
    .map((d) => {
      const fromInput = d.min_from_input ? values[d.min_from_input] : undefined;
      const min = Array.isArray(fromInput) ? fromInput.length : (d.min ?? 1);
      return { kind: d.kind, source: d.source, min, producedBy: d.produced_by ?? null };
    });

  // 8) Metodología (+ adds de toggles encendidos) y presupuesto.
  const adds = (bp.toggles ?? [])
    .filter((t) => effectiveToggles[t.key] && t.methodology_add !== undefined)
    .map((t) => t.methodology_add!);
  // Convención: inputs `presupuesto_fase`/`presupuesto_run` (si el módulo los
  // declara como number) sobreescriben los defaults del blueprint (PRD §4).
  const phaseUsd = overrideBudget(bp, values, "presupuesto_fase") ?? bp.budget.phase_usd;
  const perRunUsd = overrideBudget(bp, values, "presupuesto_run") ?? bp.budget.per_run_usd;

  return {
    ok: issues.length === 0,
    issues,
    tasks,
    gates,
    deliverables,
    methodology: { slug: bp.methodology.slug, version: bp.methodology.version, adds },
    budget: {
      phaseUsd,
      perRunUsd,
      warningThresholdsPct: bp.budget.warning_thresholds_pct ?? [70, 90, 100],
    },
    toggles: effectiveToggles,
    cadenceExcluded,
    cadencesConfirmed: planned.filter((t) => t.cadence === true).map((t) => t.key),
    cadenceProposals,
    projectName: renderTemplate(bp.project.name_tpl, vars),
    workspacePath: renderTemplate(bp.project.workspace_tpl, vars),
  };
}

function computeDueAt(
  tpl: ModuleTemplate,
  values: Record<string, unknown>,
  now: number,
): number | null {
  if (tpl.due_from_input !== undefined) {
    const base = dateInputToEpochMs(values[tpl.due_from_input]);
    if (base === null) return null;
    return base + (tpl.due_offset_days ?? 0) * DAY_MS;
  }
  if (tpl.due_offset_days !== undefined) return now + tpl.due_offset_days * DAY_MS;
  return null;
}

function overrideBudget(
  bp: ModuleBlueprint,
  values: Record<string, unknown>,
  key: string,
): number | null {
  const declared = bp.inputs.some((i) => i.key === key && i.type === "number");
  const v = values[key];
  return declared && typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}
