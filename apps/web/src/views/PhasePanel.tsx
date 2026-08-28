/**
 * Recibo del launch y cierre de fase en la vista del proyecto:
 * - Badge "Disparado desde <Módulo> v<N> por <persona>" (CA-M2.4) con panel del
 *   recibo (inputs YA redactados por el servidor, task_count, fecha).
 * - Panel "Cierre de fase" (CA-M3.1): entregables required/found/missing y
 *   estado del gate; el backend ya impide aprobar el gate con faltantes.
 * - Con todo completo: check verde + hueco del botón "Disparar <siguiente>"
 *   (CA-M3.2) DESHABILITADO con tooltip "próximamente" — el endpoint de
 *   next-phase aún no existe y no se inventa aquí.
 *
 * Un proyecto sin launch (reason: "no_launch") no pinta nada: no nació de un
 * módulo y no tiene recibo ni entregables de cierre que mostrar.
 */
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { LaunchReceipt, PhaseClosureStatus, Stage } from "../lib/types";
import { fmtDate } from "../components/ui";

/** Etiqueta del siguiente módulo por fase (solo para el hueco CA-M3.2). */
const NEXT_MODULE_LABEL: Record<Stage, string | null> = {
  ENTENDER: "Implementación",
  CONSTRUIR: "Operación",
  OPERAR: null,
};

const SOURCE_LABEL: Record<string, string> = {
  knowledge_doc: "Context Hub",
  process: "procesos as-is",
  artifact: "artefactos de tareas",
};

function fmtInputValue(v: unknown): string {
  if (Array.isArray(v)) return v.map((x) => String(x)).join(", ");
  if (typeof v === "boolean") return v ? "sí" : "no";
  if (v === null || v === undefined) return "—";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function ReceiptPanel({ launch }: { launch: LaunchReceipt }) {
  const toggles = Object.entries(launch.toggles ?? {});
  return (
    <div className="mt-2 rounded-md border border-slate-200 bg-slate-50 p-3 text-xs" data-testid="launch-receipt">
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-slate-600">
        <span>
          Módulo{" "}
          <span className="font-semibold">
            {launch.module_name} v{launch.module_version}
          </span>
        </span>
        <span>
          Por <span className="font-semibold">{launch.actor_name ?? launch.actor}</span>
        </span>
        <span>{fmtDate(launch.created_at)}</span>
        <span>
          <span className="font-semibold">{launch.task_count}</span> tareas
        </span>
        <span>
          Presupuesto ${launch.budget_phase_usd} fase · ${launch.budget_per_run_usd}/run
        </span>
      </div>
      <div className="mt-2 border-t border-slate-200 pt-2">
        <p className="mb-1 font-semibold text-slate-500">Inputs del disparo</p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
          {Object.entries(launch.inputs).map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-slate-400">{k}</dt>
              <dd className="break-words text-slate-700">{fmtInputValue(v)}</dd>
            </div>
          ))}
        </dl>
        {toggles.length > 0 ? (
          <p className="mt-1.5 text-slate-500">
            Opciones:{" "}
            {toggles.map(([k, v]) => `${k}: ${v ? "sí" : "no"}`).join(" · ")}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function ClosurePanel({ status, phase }: { status: PhaseClosureStatus; phase: Stage }) {
  const nextLabel = NEXT_MODULE_LABEL[phase];
  return (
    <div className="mt-2 rounded-md border border-slate-200 bg-white p-3" data-testid="phase-closure">
      <div className="flex items-center gap-2">
        <p className="text-xs font-bold uppercase tracking-wide text-slate-400">Cierre de fase</p>
        {status.complete ? (
          <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700">
            ✓ entregables completos
          </span>
        ) : (
          <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700">
            faltan entregables
          </span>
        )}
      </div>

      {status.items.length === 0 ? (
        <p className="mt-2 text-xs text-slate-400">El módulo no declaró entregables de cierre.</p>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {status.items.map((item) => (
            <li key={`${item.kind}:${item.source}`} className="text-xs">
              <span className="flex items-center gap-2">
                <span aria-hidden>{item.missing === null ? "✅" : "▢"}</span>
                <span className="font-medium text-slate-700">{item.kind}</span>
                <span className="text-slate-400">
                  {SOURCE_LABEL[item.source] ?? item.source} · {item.found}/{item.required}
                </span>
              </span>
              {item.missing !== null ? (
                <p className="ml-6 mt-0.5 text-[11px] text-rose-700">{item.missing}</p>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {status.complete ? (
        <div className="mt-3 flex items-center gap-2 border-t border-slate-100 pt-2">
          <span className="text-xs font-medium text-emerald-700">✓ Fase completa</span>
          {nextLabel ? (
            <button
              disabled
              title="próximamente"
              className="cursor-not-allowed rounded-md border border-slate-300 px-2.5 py-1 text-xs font-semibold text-slate-400"
            >
              🚀 Disparar {nextLabel}
            </button>
          ) : null}
        </div>
      ) : (
        <p className="mt-2 border-t border-slate-100 pt-2 text-[11px] text-slate-500">
          El gate de fase no puede aprobarse mientras falten entregables.
        </p>
      )}
    </div>
  );
}

/**
 * Cabecera de fase del proyecto: se pinta bajo el header del tablero. Falla en
 * silencio (proyecto sin launch, API vieja): la vista del tablero no se rompe.
 */
export function ProjectPhaseHeader({ projectId }: { projectId: string }) {
  const [launch, setLaunch] = useState<LaunchReceipt | null>(null);
  const [status, setStatus] = useState<PhaseClosureStatus | null>(null);
  const [receiptOpen, setReceiptOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLaunch(null);
    setStatus(null);
    setReceiptOpen(false);
    (async () => {
      const [launchesRes, statusRes] = await Promise.allSettled([
        api.projectLaunches(projectId),
        api.phaseStatus(projectId),
      ]);
      if (cancelled) return;
      if (launchesRes.status === "fulfilled") {
        const sorted = [...launchesRes.value.launches].sort((a, b) => b.created_at - a.created_at);
        setLaunch(sorted[0] ?? null);
      }
      if (statusRes.status === "fulfilled" && statusRes.value.status.reason !== "no_launch") {
        setStatus(statusRes.value.status);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  if (!launch && !status) return null;

  return (
    <div className="mb-3">
      {launch ? (
        <>
          <button
            onClick={() => setReceiptOpen((v) => !v)}
            className="inline-flex items-center gap-1.5 rounded-full border border-indigo-200 bg-indigo-50 px-2.5 py-1 text-[11px] font-medium text-indigo-800 hover:bg-indigo-100"
            title="Ver recibo del disparo"
          >
            <span aria-hidden>🚀</span>
            {launch.label}
            <span className="text-indigo-400">{receiptOpen ? "▾" : "▸"}</span>
          </button>
          {receiptOpen ? <ReceiptPanel launch={launch} /> : null}
        </>
      ) : null}
      {status && launch ? <ClosurePanel status={status} phase={launch.phase} /> : null}
    </div>
  );
}
