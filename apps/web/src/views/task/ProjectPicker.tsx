/**
 * Proyecto de la tarea: chip actual + popover con buscador agrupado por
 * cliente (`clienteLabel`/`clientesDe`). Elegir otro proyecto llama a
 * `moveTaskToProject` (optimista, con reversión); el backend rechaza si hay
 * responsables de otro cliente o padre/dependencias en el proyecto viejo, y
 * el aviso llega por toast. "Cambiar cliente" no existe: el cliente es un
 * atributo del proyecto (decisión §3.4).
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { PopoverOption, PopoverSearch } from "../../components/ui/InlinePopover";
import { paths } from "../../lib/paths";
import { clienteLabel, clientesDe, normalizar } from "../../lib/tareas";
import type { Project, Task } from "../../lib/types";
import { useStore } from "../../state/store";
import { PropertyRow, useInlineCommit } from "./PropertyRow";

export function ProjectPicker({ task, project, onNavigate }: { task: Task; project: Project | null; onNavigate?: () => void }) {
  const projects = useStore((state) => state.projects);
  const moveTaskToProject = useStore((state) => state.moveTaskToProject);
  const { open, setOpen, notice, commit } = useInlineCommit(task.id);
  const [query, setQuery] = useState("");
  const ctx = useMemo(() => ({ projects }), [projects]);

  const groups = useMemo(() => {
    const needle = normalizar(query);
    return clientesDe(ctx)
      .map((client) => ({
        ...client,
        projects: projects
          .filter((candidate) => candidate.orgId === client.id)
          .filter((candidate) => !needle || normalizar(candidate.name).includes(needle) || normalizar(client.label).includes(needle))
          .sort((a, b) => a.name.localeCompare(b.name, "es")),
      }))
      .filter((client) => client.projects.length > 0);
  }, [ctx, projects, query]);

  function choose(next: Project): void {
    setOpen(false);
    if (next.id === task.projectId) return;
    void commit(
      () => moveTaskToProject(task.id, next.id),
      () => {
        const latest = useStore.getState().taskDetail?.task ?? task;
        return projects.find((candidate) => candidate.id === latest.projectId)?.name ?? "otro proyecto";
      },
    );
  }

  return (
    <PropertyRow
      icon="⌂"
      label="Proyecto"
      testId="prop-project"
      open={open}
      onOpenChange={(value) => {
        if (value) setQuery("");
        setOpen(value);
      }}
      notice={notice}
      empty={!project}
      popoverClassName="w-[min(92vw,22rem)]"
      editor={
        <div>
          <PopoverSearch value={query} onChange={setQuery} label="Buscar proyecto" placeholder="Buscar proyecto o cliente…" testId="project-search" />
          <div className="max-h-72 overflow-y-auto" role="listbox" aria-label="Proyectos por cliente">
            {groups.map((client) => (
              <div key={client.id} role="group" aria-label={client.label}>
                <p className="px-2 pb-0.5 pt-2 text-label font-bold text-faint">{client.label}</p>
                {client.projects.map((candidate) => (
                  <PopoverOption
                    key={candidate.id}
                    selected={candidate.id === task.projectId}
                    onSelect={() => choose(candidate)}
                    testId={`project-option-${candidate.id}`}
                  >
                    <span className="min-w-0 flex-1 truncate">{candidate.name}</span>
                  </PopoverOption>
                ))}
              </div>
            ))}
            {groups.length === 0 ? <p className="px-2 py-2 text-small text-faint">Ningún proyecto coincide.</p> : null}
          </div>
          <Link
            to={paths.nuevoProyecto()}
            onClick={() => {
              setOpen(false);
              onNavigate?.();
            }}
            className="mt-1 flex min-h-10 items-center gap-1.5 rounded-tight border-t border-line-soft px-2 text-small font-semibold text-link hover:bg-surface-2 focus:outline-none focus:ring-2 focus:ring-link"
          >
            <span aria-hidden="true">+</span> Crear proyecto
          </Link>
        </div>
      }
    >
      {project ? (
        <span className="inline-flex max-w-full items-center gap-1 rounded-full border border-line bg-surface px-2 py-0.5 text-label font-semibold text-ink-2">
          <span aria-hidden="true">⌂</span>
          <span className="max-w-[14rem] truncate">{project.name}</span>
        </span>
      ) : null}
    </PropertyRow>
  );
}

/** Cliente: solo lectura, derivado del proyecto. */
export function ClientRow({ project }: { project: Project | null }) {
  const projects = useStore((state) => state.projects);
  const label = project ? clienteLabel(project.orgId, { projects }) : null;
  return (
    <PropertyRow icon="◫" label="Cliente" testId="prop-client" empty={!label}>
      {label ? <span className="rounded-full border border-line bg-surface px-2 py-0.5 text-label font-medium text-ink-2">{label}</span> : null}
    </PropertyRow>
  );
}
