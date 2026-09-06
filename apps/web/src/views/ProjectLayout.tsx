/**
 * Espacio de trabajo de un proyecto (PLAN-v1.5 §Navegación nueva).
 *
 * El proyecto es el contexto, así que el selector del header desaparece: la
 * URL manda y el store se sincroniza con ella. Las pestañas se mudaron al
 * menú lateral (`lib/nav.ts` → `clientNav`); aquí sólo queda la cabecera de
 * página con el nombre, la fase y el gate.
 */
import { useEffect } from "react";
import { Link, Navigate, useLocation, useParams } from "react-router-dom";
import { useStore } from "../state/store";
import { EmptyState, Spinner } from "../components/ui";
import { Chip, PhaseChip } from "../components/system";
import {
  CONTEXT_SUBTABS,
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
  const location = useLocation();
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

  if (!projectId) return <Navigate to={{ pathname: paths.proyectos(), search: location.search }} replace />;
  if (!tab) return <Navigate to={{ pathname: paths.proyecto(projectId, "ruta"), search: location.search }} replace />;
  if (!PROJECT_TABS.includes(tab as ProjectTab)) {
    return <Navigate to={{ pathname: paths.proyecto(projectId, "ruta"), search: location.search }} replace />;
  }

  const current = tab as ProjectTab;

  if (!tabs.includes(current)) {
    return tabs.length > 0 ? (
      <Navigate to={{ pathname: paths.proyecto(projectId, tabs[0]), search: location.search }} replace />
    ) : (
      <Navigate to={{ pathname: paths.proyectos(), search: location.search }} replace />
    );
  }

  if (current !== "contexto" && sub) {
    return <Navigate to={{ pathname: paths.proyecto(projectId, current), search: location.search }} replace />;
  }
  if (current === "contexto" && sub && !CONTEXT_SUBTABS.includes(sub as ContextSubtab)) {
    return <Navigate to={{ pathname: paths.contexto(projectId), search: location.search }} replace />;
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
      <div className="mx-auto flex w-full max-w-[1180px] flex-wrap items-center gap-x-3 gap-y-2 px-4 pt-4 pb-2 sm:px-5">
        <h1 className="text-title text-ink">{project.name}</h1>
        <PhaseChip stage={project.stage} />
        <GateChip state={project.gateState} />
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
