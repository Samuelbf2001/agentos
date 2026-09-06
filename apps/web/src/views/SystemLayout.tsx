/**
 * Sistema (PLAN-v1.5 §Navegación nueva): lo transversal, que no pertenece a un
 * cliente. Aquí aterrizaron el Enjambre —que deja de ser entrada de menú—, los
 * runs globales, la salud de las fuentes, el equipo y los ajustes.
 */
import { NavLink, Navigate, useParams } from "react-router-dom";
import { SYSTEM_TAB_LABELS, SYSTEM_TABS, paths, type SystemTab } from "../lib/paths";
import AdminView from "./AdminView";
import RunsView from "./RunsView";
import SwarmView from "./SwarmView";
import SystemHealthView from "./SystemHealthView";
import SystemTeamView from "./SystemTeamView";

const TAB_SUBTITLES: Record<SystemTab, string> = {
  ahora: "Quién está trabajando en este segundo y con qué herramienta.",
  actividad: "Todas las ejecuciones, con su tarea y su proyecto.",
  salud: "Contadores y fuentes de datos.",
  equipo: "Personas y agentes que pueden recibir trabajo.",
  ajustes: "Agentes, presupuesto y kill switch.",
};

export default function SystemLayout() {
  const { tab } = useParams<{ tab?: string }>();
  if (!tab || !SYSTEM_TABS.includes(tab as SystemTab)) {
    return <Navigate to={paths.sistema("ahora")} replace />;
  }
  const current = tab as SystemTab;

  return (
    <div className="flex min-h-full flex-col">
      <div className="border-b border-line-soft bg-surface/70">
        <div className="mx-auto max-w-[1180px] px-4 pt-4 sm:px-5">
          <h1 className="text-title text-ink">Sistema</h1>
          <p className="mt-0.5 text-small text-muted">{TAB_SUBTITLES[current]}</p>
        </div>
        <nav
          aria-label="Secciones del sistema"
          className="mx-auto flex max-w-[1180px] gap-0.5 overflow-x-auto px-4 pb-2 pt-2 sm:px-5"
        >
          {SYSTEM_TABS.map((entry) => (
            <NavLink
              key={entry}
              to={paths.sistema(entry)}
              className={({ isActive }) =>
                `press inline-flex min-h-9 shrink-0 items-center rounded-tight px-3 py-1.5 text-small font-semibold ${
                  isActive ? "bg-canvas-deep text-ink" : "text-muted hover:text-ink-2"
                }`
              }
            >
              {SYSTEM_TAB_LABELS[entry]}
            </NavLink>
          ))}
        </nav>
      </div>

      {current === "ahora" ? (
        // El lienzo del enjambre lleva su propio alto: es un canvas, no un flujo.
        <SwarmView />
      ) : (
        <div className="mx-auto w-full max-w-[1180px] px-4 pb-20 pt-5 sm:px-5">
          {current === "actividad" ? <RunsView /> : null}
          {current === "salud" ? <SystemHealthView /> : null}
          {current === "equipo" ? <SystemTeamView /> : null}
          {current === "ajustes" ? <AdminView /> : null}
        </div>
      )}
    </div>
  );
}
