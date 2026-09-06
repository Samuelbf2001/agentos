/**
 * Espacio de trabajo de un proyecto (PLAN-v1.5 §Navegación nueva).
 *
 * El proyecto es el contexto, así que el selector del header desaparece: la
 * URL manda y el store se sincroniza con ella. En la barra viven siempre el
 * nombre del cliente y el chip de fase; debajo, las cinco pestañas.
 */
import { useEffect } from "react";
import { Link, NavLink, Navigate, useParams } from "react-router-dom";
import { useStore } from "../state/store";
import { EmptyState, Spinner } from "../components/ui";
import { Chip, PhaseChip } from "../components/system";
import {
  CONTEXT_SUBTABS,
  PROJECT_TAB_LABELS,
  PROJECT_TABS,
  paths,
  type ContextSubtab,
  type ProjectTab,
} from "../lib/paths";
import { useCapabilities } from "../lib/capabilities";
import BoardView from "./BoardView";
import ChatView from "./ChatView";
import ContextView from "./ContextView";
import RunsView from "./RunsView";
import RutaView from "./RutaView";

function GateChip({ state }: { state: "pending" | "approved" | "rejected" }) {
  if (state === "approved") return <Chip tone="done">Gate aprobado</Chip>;
  if (state === "rejected") return <Chip tone="broken">Gate rechazado</Chip>;
  return <Chip tone="decide">Gate pendiente</Chip>;
}

export default function ProjectLayout() {
  const { projectId, tab, sub } = useParams<{ projectId: string; tab?: string; sub?: string }>();
  const projects = useStore((s) => s.projects);
  const setActiveProject = useStore((s) => s.setActiveProject);
  const bootstrapped = useStore((s) => s.bootstrapped);
  const caps = useCapabilities();
  const tabs = PROJECT_TABS.filter((t) => caps.has(`proyecto:${t}`));

  // La URL es la fuente de verdad del proyecto activo. Al salir del layout
  // (desmontar) se limpia el proyecto activo: fuera de /proyectos/:id/* no
  // hay proyecto activo.
  useEffect(() => {
    if (projectId && projectId !== useStore.getState().activeProjectId) {
      void setActiveProject(projectId);
    }
    return () => {
      void useStore.getState().setActiveProject(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  if (!projectId) return <Navigate to={paths.proyectos()} replace />;
  if (!tab) return <Navigate to={paths.proyecto(projectId, "ruta")} replace />;
  if (!PROJECT_TABS.includes(tab as ProjectTab)) {
    return <Navigate to={paths.proyecto(projectId, "ruta")} replace />;
  }

  const current = tab as ProjectTab;

  if (!tabs.includes(current)) {
    return tabs.length > 0 ? (
      <Navigate to={paths.proyecto(projectId, tabs[0])} replace />
    ) : (
      <Navigate to={paths.proyectos()} replace />
    );
  }

  if (current !== "contexto" && sub) {
    return <Navigate to={paths.proyecto(projectId, current)} replace />;
  }
  if (current === "contexto" && sub && !CONTEXT_SUBTABS.includes(sub as ContextSubtab)) {
    return <Navigate to={paths.contexto(projectId)} replace />;
  }
  const contextSub: ContextSubtab =
    current === "contexto" && sub && CONTEXT_SUBTABS.includes(sub as ContextSubtab)
      ? (sub as ContextSubtab)
      : "documentos";

  const project = projects.find((p) => p.id === projectId);

  if (!project) {
    return projects.length === 0 && bootstrapped ? (
      <div className="mx-auto max-w-[1180px] p-5">
        <Spinner label="Cargando el proyecto…" />
      </div>
    ) : (
      <div className="mx-auto max-w-[1180px] p-5">
        <EmptyState
          title="Ese proyecto ya no está en tu lista"
          hint="Puede que se haya cerrado o que pertenezca a otra organización."
          action={
            <Link to={paths.proyectos()} className="press mt-1 text-small font-semibold text-link underline">
              Ver todos los proyectos
            </Link>
          }
        />
      </div>
    );
  }

  return (
    <div className="density-operar flex min-h-full flex-col">
      <div className="border-b border-line-soft bg-surface/70">
        <div className="mx-auto flex max-w-[1180px] flex-wrap items-center gap-x-3 gap-y-2 px-4 pt-3 sm:px-5">
          <Link to={paths.proyectos()} className="press text-small text-muted hover:text-ink-2">
            Proyectos
          </Link>
          <span className="text-faint" aria-hidden="true">
            ›
          </span>
          <h1 className="text-title text-ink">{project.name}</h1>
          <PhaseChip stage={project.stage} />
          <GateChip state={project.gateState} />
          <Link
            to={paths.hoy(project.id)}
            className="press ml-auto text-small font-semibold text-link hover:underline"
          >
            Decisiones de este proyecto
          </Link>
        </div>
        <nav
          aria-label="Secciones del proyecto"
          className="mx-auto flex max-w-[1180px] gap-0.5 overflow-x-auto px-4 pb-2 pt-2 sm:px-5"
        >
          {tabs.map((entry) => (
            <NavLink
              key={entry}
              to={entry === "contexto" ? paths.contexto(project.id) : paths.proyecto(project.id, entry)}
              className={() =>
                // El isActive de NavLink compara contra el "to" resuelto: para
                // Contexto eso incluiría el subtab por defecto y dejaría de
                // marcarse activo en /contexto/procesos. `current` ya sabe qué
                // pestaña vive en la URL, subtabs incluidos.
                `press inline-flex min-h-9 shrink-0 items-center rounded-tight px-3 py-1.5 text-small font-semibold ${
                  entry === current ? "bg-canvas-deep text-ink" : "text-muted hover:text-ink-2"
                }`
              }
            >
              {PROJECT_TAB_LABELS[entry]}
            </NavLink>
          ))}
        </nav>
      </div>

      <div className="min-h-0 flex-1">
        {current === "ruta" ? <RutaView project={project} /> : null}
        {current === "tablero" ? <BoardView projectId={project.id} /> : null}
        {current === "contexto" ? <ContextView projectId={project.id} sub={contextSub} /> : null}
        {current === "conversacion" ? <ChatView /> : null}
        {current === "actividad" ? <RunsView projectId={project.id} /> : null}
      </div>
    </div>
  );
}
