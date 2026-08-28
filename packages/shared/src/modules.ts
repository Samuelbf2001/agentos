/**
 * Módulos de Fase (ARCHITECTURE §13) — piezas PURAS compartidas:
 * tipos + Zod del `ModuleBlueprint` (§13.2), validación fail-closed que
 * devuelve issues con código y path — nunca un booleano — (§13.5),
 * canonicalización + hash del blueprint (§13.1) y render de `{{variables}}`.
 *
 * Cero dependencias de DB: 100% testeable en aislamiento (§13.3). La capa de
 * datos (`@agentos/db`) y el MCP reutilizan estas piezas tal cual.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { AgentosError, ErrorCodes } from "./errors.js";
import { AgentLayer, ProjectType, Stage, TaskPriority } from "./schemas.js";

// ── Versionado del FORMATO (aparte del contenido — §13.2) ───────────────────

/** Versión del formato de blueprint que este código sabe validar y ejecutar. */
export const MODULE_SCHEMA_VERSION = 1;

/** Tope duro de instancias por launch (guardia NM-2 — §13.5 `too_many_tasks`). */
export const MAX_LAUNCH_TASKS = 40;

/** Variables built-in siempre permitidas en plantillas (§13.2). */
export const BLUEPRINT_BUILTIN_VARS: readonly string[] = [
  "cliente", // alias ?? empresa
  "sponsor",
  "hoy",
  "fecha_objetivo",
];

// ── Tipos + Zod del blueprint (§13.2) ───────────────────────────────────────

export const ModuleStatus = z.enum(["draft", "active", "archived"]);
export type ModuleStatus = z.infer<typeof ModuleStatus>;

export const ModuleInputType = z.enum([
  "text",
  "textarea",
  "number",
  "date",
  "multi_select",
  "list_text",
  "source_refs",
]);
export type ModuleInputType = z.infer<typeof ModuleInputType>;

export const ModuleInput = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9_]*$/, "key en snake_case"),
    label: z.string().min(1),
    type: ModuleInputType,
    required: z.boolean().optional(),
    /** Mínimo para inputs `number`. */
    min: z.number().optional(),
    min_items: z.number().int().nonnegative().optional(),
    max_items: z.number().int().positive().optional(),
    max_len: z.number().int().positive().optional(),
    /** Opciones válidas para `multi_select`. */
    options: z.array(z.string().min(1)).optional(),
    /** Si falta el valor, se copia del input indicado (p.ej. alias ← empresa). */
    default_from: z.string().optional(),
    /** Se redacta en el recibo del launch (inputs literales — §13.1). */
    sensitive: z.boolean().optional(),
  })
  .strict();
export type ModuleInput = z.infer<typeof ModuleInput>;

export const ModuleRosterEntry = z
  .object({
    /** Rol LÓGICO local al módulo (nunca ids de DB — §13.2). */
    role: z.string().regex(/^[a-z][a-z0-9_]*$/),
    /** Slug del agente preferido del roster real (`agents/*.md`). */
    agent: z.string().min(1),
    /** Capa de fallback si el preferido no es asignable (se valida contra AgentLayer). */
    layer: z.string().min(1),
    max_usd_per_run: z.number().positive().optional(),
    /** Participa siempre aunque ninguna plantilla lo asigne (Quinn). */
    always: z.boolean().optional(),
  })
  .strict();
export type ModuleRosterEntry = z.infer<typeof ModuleRosterEntry>;

export const ModuleBudget = z
  .object({
    phase_usd: z.number(),
    per_run_usd: z.number(),
    /**
     * Semáforos del PRD §2 ([SÍNTESIS] Codex): % del presupuesto de fase que
     * disparan aviso. Estrictamente creciente y en (0,100]. Default [70,90,100].
     */
    warning_thresholds_pct: z.array(z.number()).optional(),
  })
  .strict();
export type ModuleBudget = z.infer<typeof ModuleBudget>;

export const ModuleToggle = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9_]*$/),
    label: z.string().min(1),
    default: z.boolean().optional(),
    /** Claves de plantillas que este toggle enciende (deben existir). */
    enables_templates: z.array(z.string().min(1)).optional(),
    /** Kinds de closing_deliverables que este toggle enciende (deben existir). */
    enables_deliverables: z.array(z.string().min(1)).optional(),
    /** Metodología adicional que se activa con el toggle (p.ej. iso9001-prep). */
    methodology_add: z.string().optional(),
  })
  .strict();
export type ModuleToggle = z.infer<typeof ModuleToggle>;

export const ModuleTemplate = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9_]*$/),
    title: z.string().min(1),
    description: z.string().optional(),
    /** DoD obligatoria en la práctica: su ausencia es issue `missing_dod`. */
    dod: z.string().optional(),
    stage: Stage,
    activity_type: z.string().min(1),
    priority: TaskPriority.optional(),
    assign: z.object({ role: z.string().min(1) }).strict(),
    /** Dependencias por CLAVE de plantilla (a fan_out = a TODAS sus instancias). */
    depends_on: z.array(z.string().min(1)).optional(),
    /** Kinds de entregable que esta plantilla produce (alimenta closing_deliverables). */
    produces: z.array(z.string().min(1)).optional(),
    /** Nombre del gate que arma esta plantilla (⇒ requires_approval sube). */
    gate: z.string().optional(),
    /** Solo existe si el toggle está encendido; deps hacia ella se PODAN (§13.5). */
    when_toggle: z.string().optional(),
    /** "Una entrevista por área": expande una instancia por elemento del input. */
    fan_out: z.object({ over: z.string().min(1), as: z.string().min(1) }).strict().optional(),
    due_offset_days: z.number().int().optional(),
    /** Input tipo date del que sale el due_at (combinable con due_offset_days). */
    due_from_input: z.string().optional(),
    /**
     * Plantilla de cadencia (US-M4/CA-M3.4): el launch la EXCLUYE del plan
     * salvo que el humano la CONFIRME en el wizard (`cadences_confirmed`, M6a).
     * Al cerrar una instancia confirmada, el hook de DONE del tablero crea la
     * siguiente (re-creación consent-first; sin dispatcher).
     */
    cadence: z.boolean().optional(),
    /**
     * Periodo de la cadencia en días (>0). Requerido EN LA PRÁCTICA para
     * confirmar una plantilla cadence: `planLaunch` rechaza la confirmación con
     * `cadence_missing_period` si falta (con fallback a `due_offset_days`).
     * NOTA: no se exige en validateBlueprint — blueprints v1 ya publicados
     * declaran cadence sin periodo y siguen siendo válidos (solo quedan
     * inconfirmables hasta declararlo).
     */
    cadence_period_days: z.number().positive().optional(),
  })
  .strict();
export type ModuleTemplate = z.infer<typeof ModuleTemplate>;

export const ModuleGate = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9_]*$/),
    when: z.enum(["phase_close", "deliverable"]),
    /** Claves de plantillas cuyo resultado alimenta el gate. */
    fed_by: z.array(z.string().min(1)).min(1),
    /** Etapa que este gate bloquea hasta aprobarse (gates de cierre de fase). */
    blocks_next_stage: Stage.optional(),
  })
  .strict();
export type ModuleGate = z.infer<typeof ModuleGate>;

export const ModuleClosingDeliverable = z
  .object({
    kind: z.string().min(1),
    source: z.enum(["knowledge_doc", "process", "artifact"]),
    min: z.number().int().positive().optional(),
    /** El mínimo sale del nº de elementos de un input (p.ej. una entrevista por área). */
    min_from_input: z.string().optional(),
    /** Clave de la plantilla que lo produce (vacío ⇒ deliverable_without_producer). */
    produced_by: z.string().optional(),
    when_toggle: z.string().optional(),
  })
  .strict();
export type ModuleClosingDeliverable = z.infer<typeof ModuleClosingDeliverable>;

export const ModuleMethodologyRef = z
  .object({
    slug: z.string().min(1),
    /** null = la versión más alta al momento de disparar (§13.1). */
    version: z.number().int().positive().nullable(),
  })
  .strict();
export type ModuleMethodologyRef = z.infer<typeof ModuleMethodologyRef>;

/**
 * El frontmatter de `modules/<slug>.md` ES el blueprint (§13.2): identidad del
 * módulo + todas las secciones. `schema_version` versiona el FORMATO aparte del
 * contenido; una versión no soportada se rechaza (`unsupported_schema_version`).
 */
export const ModuleBlueprint = z
  .object({
    schema_version: z.number().int(),
    slug: z.string().regex(/^[a-z][a-z0-9-]*$/),
    version: z.number().int().positive(),
    name: z.string().min(1),
    phase: Stage,
    project_type: ProjectType,
    status: ModuleStatus.optional(),
    project: z.object({ name_tpl: z.string().min(1), workspace_tpl: z.string().min(1) }).strict(),
    methodology: ModuleMethodologyRef,
    budget: ModuleBudget,
    roster: z.array(ModuleRosterEntry).min(1),
    inputs: z.array(ModuleInput),
    toggles: z.array(ModuleToggle).optional(),
    templates: z.array(ModuleTemplate).min(1),
    gates: z.array(ModuleGate).optional(),
    closing_deliverables: z.array(ModuleClosingDeliverable).optional(),
  })
  .strict();
export type ModuleBlueprint = z.infer<typeof ModuleBlueprint>;

// ── Issues de validación (§13.5: código + path, nunca booleano) ─────────────

export type BlueprintIssueCode =
  // Estructurales puras (momento A/B)
  | "schema_invalid"
  | "unsupported_schema_version"
  | "duplicate_template_key"
  | "unknown_dependency"
  | "circular_dependency"
  | "missing_dod"
  | "unknown_role"
  | "unknown_layer"
  | "undeclared_variable"
  | "fan_out_over_unknown_input"
  | "unknown_toggle_ref"
  | "deliverable_without_producer"
  | "gate_without_deliverable"
  | "stage_mismatch"
  | "budget_invalid"
  // Cadencia (M6a, CA-M3.4): las cadencias son independientes (sin deps) y su
  // re-render usa los inputs del RECIBO (que redacta sensibles) — fail-closed.
  | "cadence_with_dependencies"
  | "cadence_sensitive_variable"
  // De inputs y plan (momento C — launch)
  | "input_required_missing"
  | "input_type_invalid"
  | "input_option_not_allowed"
  | "input_min_items"
  | "too_many_tasks"
  | "fan_out_key_collision"
  | "cadence_unknown_key"
  | "cadence_missing_period"
  // Con DB (§13.5, momentos B y C) — las emiten @agentos/db, no este módulo
  | "unknown_methodology"
  | "unknown_agent_slug"
  | "agent_not_assignable"
  | "module_not_active";

export interface BlueprintIssue {
  code: BlueprintIssueCode;
  /** Ruta legible dentro del blueprint, p.ej. `templates[3].depends_on[1]`. */
  path: string;
  details?: Record<string, unknown>;
}

export interface ValidateBlueprintResult {
  ok: boolean;
  issues: BlueprintIssue[];
  /** Presente solo si el schema Zod pasó (aunque haya issues estructurales). */
  blueprint?: ModuleBlueprint;
}

const VAR_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/** Extrae los nombres de `{{variable}}` de un texto de plantilla. */
export function extractTemplateVars(tpl: string): string[] {
  const out: string[] = [];
  for (const m of tpl.matchAll(VAR_RE)) out.push(m[1]!);
  return out;
}

/**
 * Validación PURA fail-closed del blueprint (§13.5, momentos A y B).
 * Aplica TODAS las reglas estructurales; las reglas con DB (unknown_methodology,
 * unknown_agent_slug, agent_not_assignable, module_not_active) viven en @agentos/db.
 */
export function validateBlueprint(raw: unknown): ValidateBlueprintResult {
  const issues: BlueprintIssue[] = [];

  // 0) Versión del formato: se comprueba ANTES del schema para dar un código
  // específico (un formato futuro no debe reportarse como campos inválidos).
  if (typeof raw === "object" && raw !== null) {
    const sv = (raw as Record<string, unknown>)["schema_version"];
    if (sv !== MODULE_SCHEMA_VERSION) {
      return {
        ok: false,
        issues: [
          {
            code: "unsupported_schema_version",
            path: "schema_version",
            details: { found: sv ?? null, supported: MODULE_SCHEMA_VERSION },
          },
        ],
      };
    }
  }

  // 1) Schema Zod
  const parsed = ModuleBlueprint.safeParse(raw);
  if (!parsed.success) {
    for (const zi of parsed.error.issues) {
      issues.push({
        code: "schema_invalid",
        path: zi.path.map((p) => String(p)).join(".") || "$",
        details: { message: zi.message },
      });
    }
    return { ok: false, issues };
  }
  const bp = parsed.data;

  const inputByKey = new Map(bp.inputs.map((i) => [i.key, i]));
  const sensitiveInputKeys = new Set(bp.inputs.filter((i) => i.sensitive === true).map((i) => i.key));
  const toggleKeys = new Set((bp.toggles ?? []).map((t) => t.key));
  const rosterRoles = new Set(bp.roster.map((r) => r.role));
  const gateNames = new Set((bp.gates ?? []).map((g) => g.name));
  const deliverables = bp.closing_deliverables ?? [];
  const deliverableKinds = new Set(deliverables.map((d) => d.kind));

  // 2) duplicate_template_key
  const seenTpl = new Set<string>();
  const tplByKey = new Map<string, ModuleTemplate>();
  bp.templates.forEach((t, i) => {
    if (seenTpl.has(t.key)) {
      issues.push({ code: "duplicate_template_key", path: `templates[${i}].key`, details: { key: t.key } });
    }
    seenTpl.add(t.key);
    tplByKey.set(t.key, t);
  });

  // 3) Roster: capas conocidas (AgentLayer de shared)
  bp.roster.forEach((r, i) => {
    if (!AgentLayer.options.includes(r.layer as AgentLayer)) {
      issues.push({
        code: "unknown_layer",
        path: `roster[${i}].layer`,
        details: { layer: r.layer, known: AgentLayer.options },
      });
    }
  });

  // 4) Por plantilla: deps, rol, DoD, stage, toggle, fan_out, gate, variables
  bp.templates.forEach((t, i) => {
    (t.depends_on ?? []).forEach((dep, j) => {
      if (!tplByKey.has(dep)) {
        issues.push({ code: "unknown_dependency", path: `templates[${i}].depends_on[${j}]`, details: { dep } });
      }
    });
    if (!rosterRoles.has(t.assign.role)) {
      issues.push({
        code: "unknown_role",
        path: `templates[${i}].assign.role`,
        details: { role: t.assign.role, roles: [...rosterRoles] },
      });
    }
    if (!t.dod || t.dod.trim() === "") {
      issues.push({ code: "missing_dod", path: `templates[${i}].dod`, details: { key: t.key } });
    }
    if (t.stage !== bp.phase) {
      issues.push({
        code: "stage_mismatch",
        path: `templates[${i}].stage`,
        details: { stage: t.stage, phase: bp.phase },
      });
    }
    if (t.when_toggle && !toggleKeys.has(t.when_toggle)) {
      issues.push({ code: "unknown_toggle_ref", path: `templates[${i}].when_toggle`, details: { toggle: t.when_toggle } });
    }
    if (t.fan_out) {
      const over = inputByKey.get(t.fan_out.over);
      if (!over || (over.type !== "multi_select" && over.type !== "list_text")) {
        issues.push({
          code: "fan_out_over_unknown_input",
          path: `templates[${i}].fan_out.over`,
          details: { over: t.fan_out.over, type: over?.type ?? null },
        });
      }
    }
    if (t.gate && !gateNames.has(t.gate)) {
      issues.push({ code: "unknown_dependency", path: `templates[${i}].gate`, details: { gate: t.gate } });
    }
    if (t.due_from_input) {
      const src = inputByKey.get(t.due_from_input);
      if (!src || src.type !== "date") {
        issues.push({
          code: "unknown_dependency",
          path: `templates[${i}].due_from_input`,
          details: { input: t.due_from_input, type: src?.type ?? null },
        });
      }
    }
    // Cadencia (M6a, CA-M3.4): independiente por diseño — una plantilla cadence
    // con depends_on es issue (la re-creación al cerrar instancia no re-evalúa
    // grafos); y NO puede usar variables `sensitive` — la siguiente instancia se
    // re-renderiza con los inputs del RECIBO, que llegan redactados (§13.1).
    if (t.cadence === true) {
      if ((t.depends_on ?? []).length > 0) {
        issues.push({
          code: "cadence_with_dependencies",
          path: `templates[${i}].depends_on`,
          details: { key: t.key, depends_on: t.depends_on },
        });
      }
    }
    // undeclared_variable: inputs ∪ toggles ∪ var de fan_out (propia) ∪ built-ins
    const allowed = new Set<string>([
      ...inputByKey.keys(),
      ...toggleKeys,
      ...BLUEPRINT_BUILTIN_VARS,
      ...(t.fan_out ? [t.fan_out.as] : []),
    ]);
    for (const [field, text] of [
      ["title", t.title],
      ["description", t.description ?? ""],
      ["dod", t.dod ?? ""],
    ] as const) {
      for (const v of extractTemplateVars(text)) {
        if (!allowed.has(v)) {
          issues.push({ code: "undeclared_variable", path: `templates[${i}].${field}`, details: { variable: v } });
        }
        if (t.cadence === true && sensitiveInputKeys.has(v)) {
          issues.push({
            code: "cadence_sensitive_variable",
            path: `templates[${i}].${field}`,
            details: { key: t.key, variable: v },
          });
        }
      }
    }
  });

  // 4b) Variables de las plantillas de proyecto (sin fan_out var)
  const projectAllowed = new Set<string>([...inputByKey.keys(), ...toggleKeys, ...BLUEPRINT_BUILTIN_VARS]);
  for (const [field, text] of [
    ["name_tpl", bp.project.name_tpl],
    ["workspace_tpl", bp.project.workspace_tpl],
  ] as const) {
    for (const v of extractTemplateVars(text)) {
      if (!projectAllowed.has(v)) {
        issues.push({ code: "undeclared_variable", path: `project.${field}`, details: { variable: v } });
      }
    }
  }

  // 4c) default_from y min_from_input apuntan a inputs existentes
  bp.inputs.forEach((inp, i) => {
    if (inp.default_from && !inputByKey.has(inp.default_from)) {
      issues.push({ code: "unknown_dependency", path: `inputs[${i}].default_from`, details: { input: inp.default_from } });
    }
  });

  // 5) circular_dependency — Kahn sobre deps CONOCIDAS (las desconocidas ya se reportaron)
  const indeg = new Map<string, number>();
  const fwd = new Map<string, string[]>();
  for (const t of tplByKey.values()) {
    indeg.set(t.key, 0);
    fwd.set(t.key, []);
  }
  for (const t of tplByKey.values()) {
    for (const dep of t.depends_on ?? []) {
      if (!tplByKey.has(dep) || dep === t.key) continue;
      fwd.get(dep)!.push(t.key);
      indeg.set(t.key, (indeg.get(t.key) ?? 0) + 1);
    }
  }
  const queue = [...indeg.entries()].filter(([, d]) => d === 0).map(([k]) => k);
  let visited = 0;
  while (queue.length > 0) {
    const k = queue.shift()!;
    visited += 1;
    for (const next of fwd.get(k) ?? []) {
      const d = indeg.get(next)! - 1;
      indeg.set(next, d);
      if (d === 0) queue.push(next);
    }
  }
  if (visited < tplByKey.size) {
    const cycle = [...indeg.entries()].filter(([, d]) => d > 0).map(([k]) => k);
    issues.push({ code: "circular_dependency", path: "templates", details: { cycle } });
  }
  // Auto-dependencia: ciclo trivial que Kahn (con self-edges filtradas) no ve.
  bp.templates.forEach((t, i) => {
    if ((t.depends_on ?? []).includes(t.key)) {
      issues.push({ code: "circular_dependency", path: `templates[${i}].depends_on`, details: { cycle: [t.key] } });
    }
  });

  // 6) Toggles: referencias hacia plantillas/entregables existentes
  (bp.toggles ?? []).forEach((tg, i) => {
    (tg.enables_templates ?? []).forEach((k, j) => {
      if (!tplByKey.has(k)) {
        issues.push({ code: "unknown_dependency", path: `toggles[${i}].enables_templates[${j}]`, details: { key: k } });
      }
    });
    (tg.enables_deliverables ?? []).forEach((k, j) => {
      if (!deliverableKinds.has(k)) {
        issues.push({ code: "unknown_dependency", path: `toggles[${i}].enables_deliverables[${j}]`, details: { kind: k } });
      }
    });
  });

  // 7) closing_deliverables: productor declarado y coherente (CA-M1.3)
  deliverables.forEach((d, i) => {
    const producer = d.produced_by ? tplByKey.get(d.produced_by) : undefined;
    if (!d.produced_by || !producer || !(producer.produces ?? []).includes(d.kind)) {
      issues.push({
        code: "deliverable_without_producer",
        path: `closing_deliverables[${i}].produced_by`,
        details: { kind: d.kind, produced_by: d.produced_by ?? null },
      });
    }
    if (d.when_toggle && !toggleKeys.has(d.when_toggle)) {
      issues.push({ code: "unknown_toggle_ref", path: `closing_deliverables[${i}].when_toggle`, details: { toggle: d.when_toggle } });
    }
    if (d.min_from_input && !inputByKey.has(d.min_from_input)) {
      issues.push({ code: "unknown_dependency", path: `closing_deliverables[${i}].min_from_input`, details: { input: d.min_from_input } });
    }
  });

  // 8) gates: alimentados por plantillas que producen entregables de cierre
  (bp.gates ?? []).forEach((g, i) => {
    g.fed_by.forEach((k, j) => {
      const tpl = tplByKey.get(k);
      if (!tpl) {
        issues.push({ code: "unknown_dependency", path: `gates[${i}].fed_by[${j}]`, details: { key: k } });
        return;
      }
      const producesDeliverable = (tpl.produces ?? []).some((kind) => deliverableKinds.has(kind));
      if (!producesDeliverable) {
        issues.push({
          code: "gate_without_deliverable",
          path: `gates[${i}].fed_by[${j}]`,
          details: { gate: g.name, template: k },
        });
      }
    });
  });

  // 9) budget_invalid (§13.5 + semáforos [SÍNTESIS] Codex)
  if (bp.budget.phase_usd <= 0 || bp.budget.per_run_usd > bp.budget.phase_usd) {
    issues.push({
      code: "budget_invalid",
      path: "budget",
      details: { phase_usd: bp.budget.phase_usd, per_run_usd: bp.budget.per_run_usd },
    });
  }
  const thresholds = bp.budget.warning_thresholds_pct;
  if (thresholds !== undefined) {
    const increasing = thresholds.every((v, i) => (i === 0 ? true : v > thresholds[i - 1]!));
    const inRange = thresholds.every((v) => v > 0 && v <= 100);
    if (thresholds.length === 0 || !increasing || !inRange) {
      issues.push({
        code: "budget_invalid",
        path: "budget.warning_thresholds_pct",
        details: { warning_thresholds_pct: thresholds },
      });
    }
  }

  return { ok: issues.length === 0, issues, blueprint: bp };
}

// ── Canonicalización + hash (§13.1: blueprint JSON canónico + sha256) ───────

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) out[k] = sortKeysDeep(src[k]);
    return out;
  }
  return value;
}

/**
 * JSON canónico del blueprint: claves ordenadas recursivamente (los arrays
 * conservan su orden — es semántico). Misma estructura ⇒ mismo string ⇒ mismo hash.
 */
export function canonicalizeBlueprint(raw: unknown): string {
  return JSON.stringify(sortKeysDeep(raw));
}

/**
 * sha256 hex del blueprint canónico. Acepta el objeto (lo canonicaliza) o un
 * string que YA es el JSON canónico (se hashea tal cual).
 */
export function blueprintHash(raw: unknown): string {
  const canonical = typeof raw === "string" ? raw : canonicalizeBlueprint(raw);
  return createHash("sha256").update(canonical).digest("hex");
}

// ── Render de plantillas {{variable}} ───────────────────────────────────────

function formatTemplateVar(value: unknown): string {
  if (Array.isArray(value)) return value.map(formatTemplateVar).join(", ");
  if (typeof value === "boolean") return value ? "sí" : "no";
  return String(value);
}

/**
 * Sustituye `{{variable}}` con los valores dados. Una variable sin valor lanza
 * (código `undeclared_variable` en details) — NUNCA se renderiza vacío (§13.2).
 */
export function renderTemplate(tpl: string, vars: Record<string, unknown>): string {
  return tpl.replace(VAR_RE, (_m, name: string) => {
    const value = vars[name];
    if (value === undefined || value === null) {
      throw new AgentosError(
        ErrorCodes.VALIDATION_ERROR,
        `Variable no declarada en plantilla: {{${name}}}`,
        { code: "undeclared_variable", variable: name, tpl },
      );
    }
    return formatTemplateVar(value);
  });
}
