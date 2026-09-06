/**
 * Barra superior del shell: hamburguesa en móvil, miga de pan (agencia o
 * cliente) y las acciones globales de siempre (buscar tareas, pausar/reanudar
 * agentes). El banner del kill switch vive fuera, en `App.tsx`.
 */
import { Menu, Pause, Play, Search } from "lucide-react";
import { useStore } from "../../state/store";
import type { Capability } from "../../lib/capabilities";
import type { Perspective } from "../../lib/nav";
import { clienteLabel } from "../../lib/tareas";
import { PhaseChip } from "../system";

export function Topbar({
  perspective,
  caps,
  killSwitch,
  onToggleKillSwitch,
  onSearch,
  onOpenMenu,
}: {
  perspective: Perspective;
  caps: ReadonlySet<Capability>;
  killSwitch: boolean;
  onToggleKillSwitch: (next: boolean) => void;
  onSearch: () => void;
  onOpenMenu: () => void;
}) {
  const projects = useStore((s) => s.projects);
  const project =
    perspective.kind === "client"
      ? (projects.find((p) => p.id === perspective.projectId) ?? null)
      : null;
  const clientName = project ? (project.orgName ?? clienteLabel(project.orgId, { projects })) : null;

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line bg-surface px-3 sm:px-4">
      <button
        type="button"
        onClick={onOpenMenu}
        aria-label="Abrir menú"
        className="press inline-flex h-8 w-8 items-center justify-center rounded-tight text-ink-2 hover:bg-canvas-deep md:hidden"
      >
        <Menu size={16} strokeWidth={1.75} aria-hidden="true" />
      </button>

      <div className="flex min-w-0 items-center gap-1.5 text-small text-muted">
        <span className={project ? "shrink-0" : "truncate font-medium text-ink"}>Sixteam</span>
        {project ? (
          <>
            <span aria-hidden="true">›</span>
            <span className="truncate">{clientName}</span>
            <span aria-hidden="true">›</span>
            <span className="truncate font-medium text-ink">{project.name}</span>
            <PhaseChip stage={project.stage} />
          </>
        ) : null}
      </div>

      <div className="ml-auto flex items-center gap-2">
        {caps.has("buscar") ? (
          <button
            onClick={onSearch}
            className="press hidden min-h-8 items-center gap-2 rounded-tight border border-line bg-surface px-2.5 py-1 text-small text-muted sm:inline-flex"
          >
            <Search size={16} strokeWidth={1.75} aria-hidden="true" />
            Buscar tareas
            <kbd className="rounded border border-line bg-canvas-deep px-1 font-sans text-label text-faint">/</kbd>
          </button>
        ) : null}
        {caps.has("agentes:pausar") ? (
          killSwitch ? (
            <button
              onClick={() => onToggleKillSwitch(false)}
              className="press inline-flex min-h-8 items-center gap-1.5 rounded-tight border border-done-line bg-done-bg px-2.5 py-1 text-small font-semibold text-done"
            >
              <Play size={16} strokeWidth={1.75} aria-hidden="true" />
              Reanudar agentes
            </button>
          ) : (
            <button
              onClick={() => onToggleKillSwitch(true)}
              className="press inline-flex min-h-8 items-center gap-1.5 rounded-tight border border-line bg-surface px-2.5 py-1 text-small font-semibold text-muted"
            >
              <Pause size={16} strokeWidth={1.75} aria-hidden="true" />
              Pausar agentes
            </button>
          )
        ) : null}
      </div>
    </header>
  );
}
