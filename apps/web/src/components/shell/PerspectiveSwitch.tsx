/**
 * Cambio de perspectiva Sixteam (agencia) ↔ cliente (patrón "workspace
 * switcher" de Notion/HubSpot): un botón de dos líneas que abre un buscador
 * con todos los clientes agrupados por organización. Elegir uno navega a su
 * Ruta; "Nuevo cliente…" arranca el asistente.
 */
import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowLeft, ChevronsUpDown } from "lucide-react";
import { InlinePopover, PopoverOption, PopoverSearch } from "../ui/InlinePopover";
import { STAGE_LABELS } from "../system";
import { paths } from "../../lib/paths";
import { clienteLabel, normalizar } from "../../lib/tareas";
import type { Perspective } from "../../lib/nav";
import type { Project } from "../../lib/types";
import { useStore } from "../../state/store";

interface ClientGroup {
  orgId: string;
  clientName: string;
  projects: Project[];
}

/** Agrupa los proyectos por cliente; el nombre real de `orgName` gana sobre el deducido. */
function groupByClient(projects: Project[]): ClientGroup[] {
  const byOrg = new Map<string, Project[]>();
  for (const project of projects) {
    const own = byOrg.get(project.orgId) ?? [];
    own.push(project);
    byOrg.set(project.orgId, own);
  }
  const ctx = { projects };
  return [...byOrg.entries()]
    .map(([orgId, own]) => ({
      orgId,
      clientName: own[0]?.orgName ?? clienteLabel(orgId, ctx),
      projects: own,
    }))
    .sort((a, b) => a.clientName.localeCompare(b.clientName, "es"));
}

export function PerspectiveSwitch({
  perspective,
  onNavigate,
}: {
  perspective: Perspective;
  onNavigate?: () => void;
}) {
  const projects = useStore((s) => s.projects);
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const current =
    perspective.kind === "client"
      ? (projects.find((project) => project.id === perspective.projectId) ?? null)
      : null;

  const groups = useMemo(() => {
    const needle = normalizar(query);
    return groupByClient(projects)
      .map((group) => ({
        ...group,
        projects: group.projects.filter(
          (project) =>
            !needle ||
            normalizar(project.name).includes(needle) ||
            normalizar(group.clientName).includes(needle),
        ),
      }))
      .filter((group) => group.projects.length > 0);
  }, [projects, query]);

  function choose(project: Project): void {
    setOpen(false);
    onNavigate?.();
    navigate(paths.proyecto(project.id, "ruta"));
  }

  function crearCliente(): void {
    setOpen(false);
    onNavigate?.();
    navigate(paths.nuevoProyecto());
  }

  const trigger = (
    <button
      type="button"
      data-testid="perspective-switch"
      className="press flex w-full items-center gap-2 rounded-soft border border-line bg-surface-2 px-3 py-2 text-left"
    >
      <span className="min-w-0 flex-1">
        {current ? (
          <>
            <span className="block truncate text-small font-semibold text-ink">
              {current.orgName ?? clienteLabel(current.orgId, { projects })}
            </span>
            <span className="block truncate text-label text-muted">
              {current.name} · {STAGE_LABELS[current.stage]}
            </span>
          </>
        ) : (
          <>
            <span className="block truncate text-small font-semibold text-ink">Sixteam</span>
            <span className="block truncate text-label text-muted">Agencia · todos los clientes</span>
          </>
        )}
      </span>
      <ChevronsUpDown size={16} strokeWidth={1.75} className="shrink-0 text-faint" aria-hidden="true" />
    </button>
  );

  return (
    <div className="px-3 py-2.5">
      {perspective.kind === "client" ? (
        <Link
          to={paths.hoy()}
          onClick={() => onNavigate?.()}
          className="press mb-1.5 inline-flex items-center gap-1 text-small text-link hover:underline"
        >
          <ArrowLeft size={16} strokeWidth={1.75} aria-hidden="true" />
          Volver a Sixteam
        </Link>
      ) : null}
      <InlinePopover
        open={open}
        onOpenChange={(value) => {
          if (value) setQuery("");
          setOpen(value);
        }}
        trigger={trigger}
        label="Cambiar de cliente"
        className="w-[min(92vw,22rem)]"
        testId="perspective-popover"
      >
        <PopoverSearch
          value={query}
          onChange={setQuery}
          label="Buscar cliente"
          placeholder="Buscar cliente o proyecto…"
          testId="perspective-search"
        />
        <div className="max-h-72 overflow-y-auto" role="listbox" aria-label="Clientes">
          {groups.map((group) => (
            <div key={group.orgId} role="group" aria-label={group.clientName}>
              {group.projects.map((project) => (
                <PopoverOption
                  key={project.id}
                  selected={current?.id === project.id}
                  onSelect={() => choose(project)}
                  testId={`perspective-project-${project.id}`}
                >
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate font-semibold text-ink">{group.clientName}</span>
                    <span className="truncate text-label text-muted">
                      {project.name} · {STAGE_LABELS[project.stage]}
                    </span>
                  </span>
                </PopoverOption>
              ))}
            </div>
          ))}
          {groups.length === 0 ? (
            <p className="px-2 py-2 text-small text-faint">Ningún cliente coincide.</p>
          ) : null}
        </div>
        <PopoverOption onSelect={crearCliente} testId="perspective-new-client">
          <span className="font-semibold text-link">+ Nuevo cliente…</span>
        </PopoverOption>
      </InlinePopover>
    </div>
  );
}
