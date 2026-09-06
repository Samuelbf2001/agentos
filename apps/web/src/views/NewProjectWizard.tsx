/**
 * Wizard "Nuevo proyecto" (US-M2, CA-M2.1): módulo → inputs → resumen →
 * Disparar. El formulario se GENERA desde la definición del módulo
 * (GET /api/modules/:slug) y se valida en vivo con POST preview (debounce):
 * con inputs incompletos el botón está DESHABILITADO y se listan los campos
 * faltantes. Disparar hace POST launch con idempotency_key estable por
 * intento (doble click no duplica — CA-M2.6) y navega al tablero creado.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import type {
  ModuleDetail,
  ModuleInputDef,
  ModuleSummary,
  PreviewIssue,
  PreviewResult,
  Stage,
} from "../lib/types";
import { useStore } from "../state/store";
import { EmptyState, ErrorBox, Spinner } from "../components/ui";
import { paths } from "../lib/paths";

/** Debounce del preview en vivo (CA-M2.1). Corto para que el test lo espere. */
const PREVIEW_DEBOUNCE_MS = 350;

const STAGE_LABEL: Record<Stage, string> = {
  ENTENDER: "Entender",
  CONSTRUIR: "Construir",
  OPERAR: "Operar",
};

/** Estado crudo del formulario: lo que hay en los controles, sin convertir. */
type FormValues = Record<string, string | string[]>;

/** Convierte el estado crudo del form al payload de inputs de la API. */
export function buildInputsPayload(
  defs: ModuleInputDef[],
  values: FormValues,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const def of defs) {
    const raw = values[def.key];
    if (raw === undefined) continue;
    switch (def.type) {
      case "multi_select": {
        const arr = Array.isArray(raw) ? raw : [];
        if (arr.length > 0) out[def.key] = arr;
        break;
      }
      case "list_text":
      case "source_refs": {
        // Textarea por líneas → array de strings no vacíos.
        const text = Array.isArray(raw) ? raw.join("\n") : raw;
        const lines = text
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l !== "");
        if (lines.length > 0) out[def.key] = lines;
        break;
      }
      default: {
        // text/textarea/number/date: string tal cual; vacío se omite para que
        // el backend lo cuente como faltante (isBlank) y no como tipo inválido.
        const text = Array.isArray(raw) ? raw.join("\n") : raw;
        if (text.trim() !== "") out[def.key] = text;
      }
    }
  }
  return out;
}

/** Texto legible es-ES de un issue del preview. */
function issueText(issue: PreviewIssue, defs: ModuleInputDef[]): string {
  const key = issue.path.startsWith("inputs.") ? issue.path.slice("inputs.".length) : null;
  const label = key ? (defs.find((d) => d.key === key)?.label ?? key) : issue.path;
  switch (issue.code) {
    case "input_required_missing":
      return `Falta «${label}»`;
    case "input_min_items": {
      const min = (issue.details as { min_items?: number } | undefined)?.min_items ?? 1;
      return `«${label}»: mínimo ${min} elemento(s)`;
    }
    case "input_type_invalid":
      return `«${label}»: valor inválido`;
    case "input_option_not_allowed":
      return `«${label}»: opción no permitida`;
    case "agent_not_assignable":
      return "No hay agente activo asignable para un rol del módulo (roster agotado)";
    case "unknown_methodology":
      return "El módulo referencia una metodología desconocida";
    case "too_many_tasks":
      return "El plan supera el tope de tareas por launch (40)";
    default:
      return `${issue.code} en ${issue.path}`;
  }
}

/** Mensaje claro para errores de dominio del launch (409/422…). */
function launchErrorMessage(err: unknown): string {
  if (!(err instanceof ApiError)) {
    return err instanceof Error ? err.message : "No se pudo disparar el módulo";
  }
  const detailCode = (err.details as { code?: string } | undefined)?.code;
  if (err.code === "conflict" && detailCode === "phase_already_launched") {
    return "Esta fase ya se disparó sobre ese proyecto: el redo legítimo es un proyecto nuevo (cambia el nombre o alias del cliente).";
  }
  if (err.code === "idempotency_conflict") {
    return "Este intento ya se usó con inputs distintos. Vuelve al formulario y revisa los datos antes de reintentar.";
  }
  if (err.code === "agent_not_assignable") {
    return "No hay agente activo asignable para un rol del módulo: revisa el roster en Admin.";
  }
  if (err.code === "module_not_active") {
    return "El módulo ya no está activo: recarga el wizard para ver el catálogo vigente.";
  }
  if (err.code === "validation_error") {
    return `Inputs inválidos: ${err.message}`;
  }
  return `${err.code}: ${err.message}`;
}

/** Primer párrafo del body del módulo, para la card del paso 1. */
function bodyExcerpt(bodyMd: string | undefined): string | null {
  if (!bodyMd) return null;
  const para = bodyMd
    .split(/\n\s*\n/)
    .map((p) => p.replace(/^#+\s*/gm, "").trim())
    .find((p) => p !== "");
  if (!para) return null;
  return para.length > 180 ? `${para.slice(0, 177)}…` : para;
}

// ── Controles del formulario generado ───────────────────────────────────────

function FieldShell({
  def,
  children,
}: {
  def: ModuleInputDef;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label htmlFor={`inp-${def.key}`} className="block text-small font-medium text-ink-2">
        {def.label}
        {def.required ? <span className="ml-0.5 text-broken">*</span> : null}
      </label>
      {children}
      <div className="mt-0.5 flex gap-2 text-label text-faint">
        {def.min_items ? <span>mínimo {def.min_items}</span> : null}
        {def.max_len ? <span>máx. {def.max_len} caracteres</span> : null}
        {def.sensitive ? <span>se redacta en el recibo</span> : null}
        {def.default_from ? <span>si se deja vacío, se copia de «{def.default_from}»</span> : null}
      </div>
    </div>
  );
}

const INPUT_CLS =
  "mt-1 w-full rounded-tight border border-line bg-surface px-2 py-1.5 text-body focus:border-muted focus:outline-none";

function InputField({
  def,
  value,
  onChange,
}: {
  def: ModuleInputDef;
  value: string | string[] | undefined;
  onChange: (v: string | string[]) => void;
}) {
  switch (def.type) {
    case "textarea":
      return (
        <FieldShell def={def}>
          <textarea
            id={`inp-${def.key}`}
            rows={3}
            value={typeof value === "string" ? value : ""}
            onChange={(e) => onChange(e.target.value)}
            className={INPUT_CLS}
          />
        </FieldShell>
      );
    case "number":
      return (
        <FieldShell def={def}>
          <input
            id={`inp-${def.key}`}
            type="number"
            {...(def.min !== undefined ? { min: def.min } : {})}
            value={typeof value === "string" ? value : ""}
            onChange={(e) => onChange(e.target.value)}
            className={INPUT_CLS}
          />
        </FieldShell>
      );
    case "date":
      return (
        <FieldShell def={def}>
          <input
            id={`inp-${def.key}`}
            type="date"
            value={typeof value === "string" ? value : ""}
            onChange={(e) => onChange(e.target.value)}
            className={INPUT_CLS}
          />
        </FieldShell>
      );
    case "multi_select": {
      const selected = Array.isArray(value) ? value : [];
      return (
        <div>
          <p className="text-small font-medium text-ink-2">
            {def.label}
            {def.required ? <span className="ml-0.5 text-broken">*</span> : null}
            {def.min_items ? (
              <span className="ml-1 font-normal text-faint">(mínimo {def.min_items})</span>
            ) : null}
          </p>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
            {(def.options ?? []).map((opt) => (
              <label key={opt} className="flex items-center gap-1.5 text-body text-ink-2">
                <input
                  type="checkbox"
                  checked={selected.includes(opt)}
                  onChange={(e) =>
                    onChange(
                      e.target.checked ? [...selected, opt] : selected.filter((v) => v !== opt),
                    )
                  }
                  className="h-3.5 w-3.5 rounded border-line"
                />
                {opt}
              </label>
            ))}
          </div>
        </div>
      );
    }
    case "list_text":
    case "source_refs":
      return (
        <FieldShell def={def}>
          <textarea
            id={`inp-${def.key}`}
            rows={3}
            placeholder={
              def.type === "source_refs" ? "Una session key por línea" : "Un elemento por línea"
            }
            value={typeof value === "string" ? value : ""}
            onChange={(e) => onChange(e.target.value)}
            className={INPUT_CLS}
          />
        </FieldShell>
      );
    default:
      // text
      return (
        <FieldShell def={def}>
          <input
            id={`inp-${def.key}`}
            type="text"
            value={typeof value === "string" ? value : ""}
            onChange={(e) => onChange(e.target.value)}
            className={INPUT_CLS}
          />
        </FieldShell>
      );
  }
}

function ToggleSwitch({
  id,
  label,
  hint,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  hint?: string | undefined;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label htmlFor={id} className="flex cursor-pointer items-center gap-2 text-body text-ink-2">
      <span className="relative inline-flex">
        <input
          id={id}
          role="switch"
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          className="peer sr-only"
        />
        <span className="h-5 w-9 rounded-full bg-line transition-colors peer-checked:bg-done" />
        <span className="absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-surface shadow-rest transition-transform peer-checked:translate-x-4" />
      </span>
      {label}
      {hint ? <span className="text-label text-faint">{hint}</span> : null}
    </label>
  );
}

// ── Pasos ───────────────────────────────────────────────────────────────────

function StepHeader({ step }: { step: 1 | 2 | 3 }) {
  const items = ["Módulo", "Datos", "Resumen"] as const;
  return (
    <ol className="flex items-center gap-2 text-small">
      {items.map((label, i) => {
        const n = (i + 1) as 1 | 2 | 3;
        const active = n === step;
        const done = n < step;
        return (
          <li key={label} className="flex items-center gap-2">
            {i > 0 ? <span className="text-line">→</span> : null}
            <span
              className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 font-medium ${
                active
                  ? "bg-ink text-surface"
                  : done
                    ? "bg-done-bg text-done"
                    : "bg-line-soft text-faint"
              }`}
            >
              <span>{done ? "✓" : n}</span>
              {label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export default function NewProjectWizard() {
  const navigate = useNavigate();
  const [search] = useSearchParams();
  /** La Ruta manda aqui la fase siguiente: el catalogo se acota a esa fase. */
  const phaseHint = search.get("fase") as Stage | null;
  /** Activo Sixteam manda aquí el módulo que se quiere lanzar directamente. */
  const moduloHint = search.get("modulo");
  const originProjectId = search.get("proyecto");
  const projects = useStore((s) => s.projects);
  const originProject = originProjectId ? projects.find((p) => p.id === originProjectId) : undefined;
  const pushToast = useStore((s) => s.pushToast);
  const loadProjects = useStore((s) => s.loadProjects);
  const setActiveProject = useStore((s) => s.setActiveProject);

  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [modules, setModules] = useState<ModuleSummary[] | null>(null);
  const [modulesError, setModulesError] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, ModuleDetail>>({});
  const [selected, setSelected] = useState<ModuleDetail | null>(null);

  const [values, setValues] = useState<FormValues>({});
  const [toggles, setToggles] = useState<Record<string, boolean>>({});
  /** Claves de plantillas cadence confirmadas por el humano (CA-M3.4 — M6a). */
  const [confirmedCadences, setConfirmedCadences] = useState<Set<string>>(new Set());

  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const [launching, setLaunching] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);
  /** Estable por INTENTO (se regenera al entrar al resumen), no por click. */
  const idempotencyKey = useRef<string>(crypto.randomUUID());

  // Catálogo + detalle de cada módulo (el detalle trae body_md e inputs).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { modules: list } = await api.modules();
        if (cancelled) return;
        setModules(list);
        const settled = await Promise.allSettled(list.map((m) => api.module(m.slug)));
        if (cancelled) return;
        const map: Record<string, ModuleDetail> = {};
        for (const r of settled) {
          if (r.status === "fulfilled") map[r.value.module.slug] = r.value.module;
        }
        setDetails(map);
      } catch (err) {
        if (!cancelled) {
          setModulesError(
            err instanceof ApiError ? `${err.code}: ${err.message}` : "No se pudieron cargar los módulos",
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const inputsPayload = useMemo(
    () => (selected ? buildInputsPayload(selected.inputs, values) : {}),
    [selected, values],
  );

  /** Array estable (para dependencias/payload) del set de cadencias confirmadas. */
  const confirmedCadencesList = useMemo(() => [...confirmedCadences], [confirmedCadences]);

  // Validación en vivo: POST preview con debounce (CA-M2.1). Marcar/desmarcar
  // una cadencia (paso 3) reusa el mismo debounce/guard anti-stale (CA-M3.4).
  const previewSeq = useRef(0);
  useEffect(() => {
    if (!selected) return;
    const seq = ++previewSeq.current;
    setPreviewLoading(true);
    const t = setTimeout(async () => {
      try {
        const res = await api.previewModule(selected.slug, {
          inputs: inputsPayload,
          toggles,
          cadences_confirmed: confirmedCadencesList,
        });
        if (previewSeq.current === seq) setPreview(res);
      } catch (err) {
        if (previewSeq.current === seq) {
          setPreview(null);
          pushToast(
            "error",
            err instanceof ApiError ? `${err.code}: ${err.message}` : "No se pudo validar el formulario",
          );
        }
      } finally {
        if (previewSeq.current === seq) setPreviewLoading(false);
      }
    }, PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [selected, inputsPayload, toggles, confirmedCadencesList, pushToast]);

  const selectModule = useCallback(
    async (summary: ModuleSummary) => {
      let detail = details[summary.slug];
      if (!detail) {
        try {
          detail = (await api.module(summary.slug)).module;
          setDetails((d) => ({ ...d, [summary.slug]: detail! }));
        } catch (err) {
          pushToast(
            "error",
            err instanceof ApiError ? `${err.code}: ${err.message}` : "No se pudo abrir el módulo",
          );
          return;
        }
      }
      setSelected(detail);
      setValues({});
      const defaults: Record<string, boolean> = {};
      for (const t of detail.toggles) defaults[t.key] = t.default ?? false;
      setToggles(defaults);
      setConfirmedCadences(new Set());
      setPreview(null);
      setLaunchError(null);
      setStep(2);
    },
    [details, pushToast],
  );

  // Llegó con ?modulo=<slug> desde Activo Sixteam: si existe en el catálogo,
  // se preselecciona y el wizard arranca directo en el paso 2.
  useEffect(() => {
    if (!moduloHint || !modules || selected) return;
    const found = modules.find((m) => m.slug === moduloHint);
    if (found) void selectModule(found);
  }, [moduloHint, modules, selected, selectModule]);

  const missingLabels = useMemo(() => {
    if (!selected || !preview) return [];
    return preview.missing.map((key) => selected.inputs.find((d) => d.key === key)?.label ?? key);
  }, [selected, preview]);

  /** Issues que no son "falta X" (esos ya salen en la lista de faltantes). */
  const otherIssues = useMemo(() => {
    if (!selected || !preview) return [];
    return preview.issues
      .filter((i) => i.code !== "input_required_missing")
      .map((i) => issueText(i, selected.inputs));
  }, [selected, preview]);

  const canContinue = preview?.ok === true && !previewLoading;

  /** Marca/desmarca una cadencia propuesta: dispara un nuevo preview (CA-M3.4). */
  function toggleCadence(key: string, checked: boolean): void {
    setConfirmedCadences((prev) => {
      const next = new Set(prev);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  function goToSummary(): void {
    // Nuevo intento del wizard ⇒ nueva key (doble click en Disparar reutiliza
    // la MISMA — idempotente CA-M2.6; inputs cambiados ⇒ intento nuevo).
    idempotencyKey.current = crypto.randomUUID();
    setLaunchError(null);
    setStep(3);
  }

  async function fire(): Promise<void> {
    if (!selected || !preview?.ok || launching) return;
    setLaunching(true);
    setLaunchError(null);
    try {
      const res = await api.launchModule(selected.slug, {
        inputs: inputsPayload,
        toggles,
        cadences_confirmed: confirmedCadencesList,
        idempotency_key: idempotencyKey.current,
      });
      pushToast(
        "ok",
        `Proyecto «${res.project.name}» creado: ${res.tasks_count} tareas desde ${selected.name} v${selected.version}`,
      );
      await loadProjects();
      await setActiveProject(res.project.id);
      navigate(paths.proyecto(res.project.id, "ruta"));
    } catch (err) {
      setLaunchError(launchErrorMessage(err));
    } finally {
      setLaunching(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-title text-ink">
          {phaseHint ? `Lanzar ${STAGE_LABEL[phaseHint]}` : "Nuevo proyecto"}
        </h1>
        <StepHeader step={step} />
      </div>
      {originProject ? (
        <p className="mb-4 rounded-soft border border-line-soft bg-surface-2 px-3.5 py-2.5 text-small text-muted">
          Vienes de la ruta de <span className="font-semibold text-ink-2">{originProject.name}</span>: elige el
          módulo con el que arranca su fase siguiente.
        </p>
      ) : null}

      {/* ── Paso 1: elegir módulo ─────────────────────────────────────────── */}
      {step === 1 ? (
        modulesError ? (
          <ErrorBox message={modulesError} />
        ) : modules === null ? (
          <Spinner label="Cargando módulos…" />
        ) : modules.length === 0 ? (
          <EmptyState
            title="Sin módulos activos"
            hint="Publica un módulo de fase (modules/*.md) y vuelve a intentarlo."
          />
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {(phaseHint ? modules.filter((m) => m.phase === phaseHint) : modules).map((m) => {
              const excerpt = bodyExcerpt(details[m.slug]?.body_md);
              return (
                <button
                  key={`${m.slug}@${m.version}`}
                  onClick={() => void selectModule(m)}
                  data-testid={`module-card-${m.slug}`}
                  className="rounded-soft border border-line bg-surface p-4 text-left shadow-rest transition-shadow hover:border-faint hover:shadow"
                >
                  <div className="flex items-center gap-2">
                    <p className="text-body font-semibold">{m.name}</p>
                    <span className="rounded bg-ink px-1.5 py-0.5 text-label font-bold uppercase text-surface">
                      {STAGE_LABEL[m.phase]}
                    </span>
                  </div>
                  <p className="mt-1 text-label text-muted">
                    v{m.version} · {m.templates_count} plantillas · {m.project_type} ·{" "}
                    {m.methodology.slug}
                  </p>
                  {excerpt ? <p className="mt-2 text-small text-muted">{excerpt}</p> : null}
                </button>
              );
            })}
          </div>
        )
      ) : null}

      {/* ── Paso 2: formulario generado ───────────────────────────────────── */}
      {step === 2 && selected ? (
        <div className="rounded-soft border border-line bg-surface p-4">
          <div className="mb-3 flex items-center gap-2">
            <p className="text-body font-semibold">
              {selected.name} <span className="text-faint">v{selected.version}</span>
            </p>
            <span className="rounded bg-line-soft px-1.5 py-0.5 text-label text-muted">
              fase {STAGE_LABEL[selected.phase]}
            </span>
          </div>

          <div className="space-y-3">
            {selected.inputs.map((def) => (
              <InputField
                key={def.key}
                def={def}
                value={values[def.key]}
                onChange={(v) => setValues((prev) => ({ ...prev, [def.key]: v }))}
              />
            ))}
          </div>

          {selected.toggles.length > 0 ? (
            <div className="mt-4 space-y-2 border-t border-line-soft pt-3">
              <p className="text-small font-medium text-muted">Opciones del módulo</p>
              {selected.toggles.map((t) => (
                <ToggleSwitch
                  key={t.key}
                  id={`tgl-${t.key}`}
                  label={t.label}
                  hint={t.methodology_add ? `añade metodología ${t.methodology_add}` : undefined}
                  checked={toggles[t.key] ?? false}
                  onChange={(v) => setToggles((prev) => ({ ...prev, [t.key]: v }))}
                />
              ))}
            </div>
          ) : null}

          {/* Estado de validación en vivo (CA-M2.1) */}
          <div className="mt-4 border-t border-line-soft pt-3" aria-live="polite">
            {previewLoading ? (
              <p className="text-small text-faint">Validando…</p>
            ) : preview && !preview.ok ? (
              <div className="rounded-tight border border-work-line bg-work-bg p-3 text-small text-work">
                {missingLabels.length > 0 ? (
                  <>
                    <p className="font-semibold">Campos faltantes:</p>
                    <ul className="mt-1 list-inside list-disc">
                      {missingLabels.map((l) => (
                        <li key={l}>{l}</li>
                      ))}
                    </ul>
                  </>
                ) : null}
                {otherIssues.length > 0 ? (
                  <ul className={`list-inside list-disc ${missingLabels.length > 0 ? "mt-1" : ""}`}>
                    {otherIssues.map((t) => (
                      <li key={t}>{t}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : preview?.ok ? (
              <p className="text-small font-medium text-done">
                ✓ Listo: se crearán {preview.plan?.tasks.length ?? 0} tareas en «
                {preview.plan?.projectName}»
              </p>
            ) : null}
          </div>

          <div className="mt-4 flex items-center justify-between">
            <button
              onClick={() => {
                setSelected(null);
                setPreview(null);
                setStep(1);
              }}
              className="rounded-tight border border-line px-3 py-1.5 text-small font-medium text-muted hover:bg-surface-2"
            >
              ← Volver
            </button>
            <button
              onClick={goToSummary}
              disabled={!canContinue}
              className="rounded-tight bg-ink px-4 py-1.5 text-small font-semibold text-surface enabled:hover:bg-ink-2 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Continuar →
            </button>
          </div>
        </div>
      ) : null}

      {/* ── Paso 3: resumen del preview + Disparar ────────────────────────── */}
      {step === 3 && selected && preview?.ok && preview.plan ? (
        <div className="space-y-4">
          <div className="rounded-soft border border-line bg-surface p-4">
            <p className="text-body font-semibold">{preview.plan.projectName}</p>
            <p className="mt-0.5 text-label text-muted">
              {selected.name} v{selected.version} · fase {STAGE_LABEL[selected.phase]} · workspace{" "}
              <code className="rounded bg-line-soft px-1">{preview.plan.workspacePath}</code>
            </p>
          </div>

          <div className="rounded-soft border border-line bg-surface p-4">
            <p className="mb-2 text-small font-bold uppercase text-faint">
              Tareas que se crearán ({preview.plan.tasks.length})
            </p>
            <table className="w-full text-left text-small">
              <thead>
                <tr className="text-label uppercase text-faint">
                  <th className="py-1 pr-2 font-semibold">Tarea</th>
                  <th className="py-1 pr-2 font-semibold">Asignado</th>
                  <th className="py-1 pr-2 font-semibold">Prioridad</th>
                  <th className="py-1 pr-2 font-semibold">Deps</th>
                  <th className="py-1 pr-2 font-semibold">Due</th>
                  <th className="py-1 font-semibold">Estado</th>
                </tr>
              </thead>
              <tbody>
                {preview.plan.tasks.map((t) => (
                  <tr key={t.key} className="border-t border-line-soft">
                    <td className="py-1.5 pr-2">
                      <span className="font-medium">{t.title}</span>
                      {t.gate ? (
                        <span className="ml-1 rounded bg-decide-bg px-1 py-0.5 text-label font-semibold text-decide">
                          gate {t.gate}
                        </span>
                      ) : null}
                    </td>
                    <td className="py-1.5 pr-2 text-muted">{t.assigneeAgentSlug}</td>
                    <td className="py-1.5 pr-2 text-muted">{t.priority}</td>
                    <td className="py-1.5 pr-2 text-muted">
                      {t.dependsOn.length > 0 ? t.dependsOn.join(", ") : "—"}
                    </td>
                    <td className="py-1.5 pr-2 text-muted">
                      {t.dueAt ? new Date(t.dueAt).toLocaleDateString("es") : "—"}
                    </td>
                    <td className="py-1.5">
                      <span
                        className={`rounded px-1.5 py-0.5 text-label font-semibold ${
                          t.status === "READY"
                            ? "bg-link-bg text-link"
                            : "bg-line text-muted"
                        }`}
                      >
                        {t.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="rounded-soft border border-line bg-surface p-4">
              <p className="mb-2 text-small font-bold uppercase text-faint">Gates</p>
              {preview.plan.gates.length === 0 ? (
                <p className="text-small text-faint">Sin gates</p>
              ) : (
                <ul className="space-y-1 text-small text-muted">
                  {preview.plan.gates.map((g) => (
                    <li key={g.name}>
                      <span className="font-medium">{g.name}</span> ·{" "}
                      {g.when === "phase_close" ? "cierre de fase" : "entregable"}
                      {g.blocksNextStage ? ` · bloquea ${STAGE_LABEL[g.blocksNextStage]}` : ""}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="rounded-soft border border-line bg-surface p-4">
              <p className="mb-2 text-small font-bold uppercase text-faint">
                Entregables de cierre
              </p>
              {preview.plan.deliverables.length === 0 ? (
                <p className="text-small text-faint">Sin entregables de cierre</p>
              ) : (
                <ul className="space-y-1 text-small text-muted">
                  {preview.plan.deliverables.map((d) => (
                    <li key={`${d.kind}:${d.source}`}>
                      <span className="font-medium">{d.kind}</span> · mín. {d.min}
                      {d.producedBy ? ` · lo produce «${d.producedBy}»` : ""}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          <div className="rounded-soft border border-line bg-surface p-4">
            <p className="mb-2 text-small font-bold uppercase text-faint">
              Presupuesto y metodología
            </p>
            <p className="text-small text-muted">
              Fase <span className="font-semibold">${preview.plan.budget.phaseUsd}</span> · por run{" "}
              <span className="font-semibold">${preview.plan.budget.perRunUsd}</span> · avisos al{" "}
              {preview.plan.budget.warningThresholdsPct.map((p) => `${p}%`).join(", ")}
            </p>
            <p className="mt-1 text-small text-muted">
              Metodología{" "}
              <span className="font-semibold">
                {preview.plan.methodology.slug}
                {preview.plan.methodology.version !== null
                  ? `@${preview.plan.methodology.version}`
                  : ""}
              </span>
              {preview.plan.methodology.adds.length > 0
                ? ` + ${preview.plan.methodology.adds.join(", ")}`
                : ""}
            </p>
          </div>

          {preview.plan.cadenceProposals.length > 0 ? (
            <div className="rounded-soft border border-dashed border-line bg-surface-2 p-4">
              <p className="mb-1 text-small font-bold uppercase text-faint">
                Cadencia (se confirmará al disparar)
              </p>
              <ul className="space-y-1 text-small text-muted">
                {preview.plan.cadenceProposals.map((c) => (
                  <li key={c.key}>
                    <label className="flex cursor-pointer items-center gap-1.5">
                      <input
                        type="checkbox"
                        checked={confirmedCadences.has(c.key)}
                        onChange={(e) => toggleCadence(c.key, e.target.checked)}
                        className="h-3.5 w-3.5 rounded border-line"
                      />
                      {c.title} — cada {c.periodDays} días
                    </label>
                  </li>
                ))}
              </ul>
              <p className="mt-1.5 text-label text-faint">
                El módulo propone estas plantillas recurrentes: solo se crea la primera instancia
                de las que confirmes (consent-first).
              </p>
            </div>
          ) : null}

          {launchError ? <ErrorBox message={launchError} /> : null}

          <div className="flex items-center justify-between">
            <button
              onClick={() => setStep(2)}
              disabled={launching}
              className="rounded-tight border border-line px-3 py-1.5 text-small font-medium text-muted hover:bg-surface-2 disabled:opacity-40"
            >
              ← Volver
            </button>
            <button
              onClick={() => void fire()}
              disabled={!preview.ok || launching}
              className="rounded-tight bg-done px-5 py-2 text-small font-bold text-surface enabled:hover:bg-done disabled:cursor-not-allowed disabled:opacity-40"
            >
              {launching ? "Disparando…" : "🚀 Disparar"}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
