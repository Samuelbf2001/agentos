/**
 * Sistema (PLAN-v1.5 §Navegación nueva): lo transversal, que no pertenece a un
 * cliente. Las pestañas se mudaron al menú lateral (`lib/nav.ts` →
 * `agencyNav`, grupos "2brain"/"Agencia"/"Sistema"); aquí sólo queda el
 * título de la pestaña actual y su subtítulo.
 */
import { Navigate, useParams } from "react-router-dom";
import { SYSTEM_TAB_LABELS, SYSTEM_TABS, paths, type SystemTab } from "../lib/paths";
import { useCapabilities } from "../lib/capabilities";
import AdminView from "./AdminView";
import RunsView from "./RunsView";
import SwarmView from "./SwarmView";
import SystemHealthView from "./SystemHealthView";
import SystemTeamView from "./SystemTeamView";

const TAB_SUBTITLES: Record<SystemTab, string> = {
  ahora: "Quién está trabajando en este segundo y con qué herramienta.",
  actividad: "Todas las ejecuciones, con su tarea y su proyecto.",
  fuentes: "Estado de las fuentes externas y de la cola de reuniones.",
  equipo: "Personas y agentes: quién puede recibir trabajo y cómo está configurado cada agente.",
  configuracion: "Configuración de la aplicación y estado de los agentes.",
};

export default function SystemLayout() {
  const { tab } = useParams<{ tab?: string }>();
  const caps = useCapabilities();
  const tabs = SYSTEM_TABS.filter((t) => caps.has(`sistema:${t}`));
  if (!tab || !SYSTEM_TABS.includes(tab as SystemTab)) {
    return <Navigate to={paths.sistema("ahora")} replace />;
  }
  const current = tab as SystemTab;

  if (!tabs.includes(current)) {
    return tabs.length > 0 ? (
      <Navigate to={paths.sistema(tabs[0])} replace />
    ) : (
      <Navigate to={paths.hoy()} replace />
    );
  }

  return (
    <div className="flex min-h-full flex-col">
      <div className="mx-auto w-full max-w-[1180px] px-4 pt-4 sm:px-5">
        <h1 className="text-title text-ink">{SYSTEM_TAB_LABELS[current]}</h1>
        <p className="mt-0.5 text-small text-muted">{TAB_SUBTITLES[current]}</p>
      </div>

      {current === "ahora" ? (
        // El lienzo del enjambre lleva su propio alto: es un canvas, no un flujo.
        <SwarmView />
      ) : (
        <div className="mx-auto w-full max-w-[1180px] px-4 pb-20 pt-5 sm:px-5">
          {current === "actividad" ? <RunsView /> : null}
          {current === "fuentes" ? <SystemHealthView /> : null}
          {current === "equipo" ? <SystemTeamView /> : null}
          {current === "configuracion" ? <AdminView /> : null}
        </div>
      )}
    </div>
  );
}
