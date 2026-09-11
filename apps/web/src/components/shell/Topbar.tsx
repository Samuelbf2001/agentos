/**
 * Barra superior del shell: hamburguesa en móvil, botón para ocultar o mostrar
 * el menú lateral en escritorio (Ctrl+B), miga de pan (agencia o cliente) y
 * las acciones globales de siempre (buscar tareas, pausar/reanudar agentes).
 * El banner del kill switch vive fuera, en `App.tsx`.
 */
import { Menu, PanelLeftClose, PanelLeftOpen, Pause, Play, Search } from "lucide-react";
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
  sidebarColapsado,
  onToggleSidebar,
}: {
  perspective: Perspective;
  caps: ReadonlySet<Capability>;
  killSwitch: boolean;
  onToggleKillSwitch: (next: boolean) => void;
  onSearch: () => void;
  onOpenMenu: () => void;
  /** Escritorio: ¿el menú lateral está oculto? El botón refleja y alterna. */
  sidebarColapsado: boolean;
  onToggleSidebar: () => void;
}) {
  const projects = useStore((s) => s.projects);
  const previewing = useStore((s) => s.previewRole === "sponsor");
  const project =
    perspective.kind === "client"
      ? (projects.find((p) => p.id === perspective.projectId) ?? null)
      : null;
  const clientName = project ? (project.orgName ?? clienteLabel(project.orgId, { projects })) : null;

  return (
    <header className="flex h-14 shrink-0 items-center gap-2 bg-canvas px-4 sm:px-6">
      <button
        type="button"
        onClick={onOpenMenu}
        aria-label="Abrir menú"
        className="press inline-flex h-8 w-8 items-center justify-center rounded-tight text-ink-2 hover:bg-canvas-deep md:hidden"
      >
        <Menu size={16} strokeWidth={1.75} aria-hidden="true" />
      </button>

      {/* Escritorio: ocultar el menú deja todo el ancho al contenido (el
          lienzo de Notas con la tableta lo agradece). El botón queda aquí,
          discreto, como único camino de vuelta además de Ctrl+B. */}
      <button
        type="button"
        onClick={onToggleSidebar}
        aria-label={sidebarColapsado ? "Mostrar menú" : "Ocultar menú"}
        aria-expanded={!sidebarColapsado}
        aria-controls="menu-lateral"
        title={`${sidebarColapsado ? "Mostrar" : "Ocultar"} el menú (Ctrl+B)`}
        className="press hidden min-h-10 min-w-10 items-center justify-center rounded-tight text-ink-2 hover:bg-canvas-deep focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-link md:inline-flex"
      >
        {sidebarColapsado ? (
          <PanelLeftOpen size={16} strokeWidth={1.75} aria-hidden="true" />
        ) : (
          <PanelLeftClose size={16} strokeWidth={1.75} aria-hidden="true" />
        )}
      </button>

      {/* min-w-0 + flex-1: la miga se encoge antes de empujar los botones de
          la derecha; cada tramo trunca por su cuenta. Bajo `lg` el cliente se
          oculta (queda "Sixteam › <proyecto>"): con el proyecto ya en foco,
          el cliente es lo primero que sobra en un ancho estrecho. */}
      <div className="flex min-w-0 flex-1 items-center gap-1.5 text-small text-muted">
        {previewing && project ? (
          <>
            <span className="truncate font-semibold text-ink">{clientName}</span>
            <span aria-hidden="true" className="text-faint">›</span>
            <span className="truncate font-semibold text-ink">{project.name}</span>
            <PhaseChip stage={project.stage} />
          </>
        ) : (
          <>
            <span className={`truncate ${project ? "shrink-0" : "font-semibold text-ink"}`}>Sixteam</span>
            {project ? (
              <>
                <span aria-hidden="true" className="hidden text-faint lg:inline">›</span>
                <span className="hidden truncate lg:inline">{clientName}</span>
                <span aria-hidden="true" className="text-faint">›</span>
                <span className="truncate font-semibold text-ink">{project.name}</span>
                <PhaseChip stage={project.stage} />
              </>
            ) : null}
          </>
        )}
      </div>

      <div className="ml-auto flex items-center gap-2">
        {caps.has("buscar") ? (
          <button
            onClick={onSearch}
            className="press hidden min-h-8 items-center gap-2 rounded-full bg-surface shadow-rest px-3 py-1.5 text-small text-muted sm:inline-flex"
          >
            <Search size={16} strokeWidth={1.75} aria-hidden="true" />
            Buscar tareas
            <kbd className="rounded-md bg-canvas-deep px-1.5 font-sans text-label text-muted">/</kbd>
          </button>
        ) : null}
        {caps.has("agentes:pausar") ? (
          killSwitch ? (
            <button
              onClick={() => onToggleKillSwitch(false)}
              className="press inline-flex min-h-8 items-center gap-1.5 rounded-full bg-surface shadow-rest px-3 py-1.5 text-small font-semibold text-done"
            >
              <Play size={16} strokeWidth={1.75} aria-hidden="true" />
              Reanudar agentes
            </button>
          ) : (
            <button
              onClick={() => onToggleKillSwitch(true)}
              className="press inline-flex min-h-8 items-center gap-1.5 rounded-full bg-surface shadow-rest px-3 py-1.5 text-small font-semibold text-muted"
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
