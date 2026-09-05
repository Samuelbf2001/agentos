/**
 * Lista de proyectos: la puerta al espacio de trabajo de cada cliente.
 * Es la misma tabla que abre Hoy, porque es el mismo dato y la misma decisión.
 */
import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useStore } from "../state/store";
import { useProjectSummaries } from "../state/useProjectSummaries";
import { ActionButton, SectionHead } from "../components/system";
import { Spinner } from "../components/ui";
import { paths } from "../lib/paths";
import ProjectsTable from "./ProjectsTable";

export default function ProjectsView() {
  const projects = useStore((s) => s.projects);
  const loadProjects = useStore((s) => s.loadProjects);
  const { summaries, loading } = useProjectSummaries(projects);
  const navigate = useNavigate();

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  return (
    <div className="density-explorar mx-auto max-w-[1180px] px-4 pb-20 pt-6 sm:px-5">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-display text-ink">Proyectos</h1>
          <p className="mt-1.5 max-w-[62ch] text-body text-muted">
            Cada proyecto avanza por Entender, Construir y Operar. Entra a uno para ver su ruta, su
            tablero y lo que espera de ti.
          </p>
        </div>
        <ActionButton variant="primary" onClick={() => navigate(paths.nuevoProyecto())}>
          Nuevo proyecto
        </ActionButton>
      </div>

      <SectionHead label="Todos los proyectos" count={projects.length} />
      {loading && projects.length === 0 ? <Spinner label="Cargando proyectos…" /> : null}
      <ProjectsTable summaries={summaries} />
    </div>
  );
}
