/**
 * Clientes: la puerta al espacio de trabajo de cada uno. Cada cliente avanza
 * por Entender, Construir y Operar a través de sus proyectos.
 */
import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useStore } from "../state/store";
import { useProjectSummaries } from "../state/useProjectSummaries";
import { ActionButton } from "../components/system";
import { Spinner } from "../components/ui";
import { paths } from "../lib/paths";
import ClientsGrid from "./ClientsGrid";

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
          <h1 className="text-display text-ink">Clientes</h1>
          <p className="mt-1.5 max-w-[62ch] text-body text-muted">
            Cada cliente avanza por Entender, Construir y Operar. Entra a uno para ver su ruta, su
            tablero y lo que espera de ti.
          </p>
        </div>
        <ActionButton variant="primary" onClick={() => navigate(paths.nuevoProyecto())}>
          Nuevo cliente
        </ActionButton>
      </div>

      {loading && projects.length === 0 ? <Spinner label="Cargando clientes…" /> : null}
      <div className="mt-6">
        <ClientsGrid summaries={summaries} />
      </div>
    </div>
  );
}
