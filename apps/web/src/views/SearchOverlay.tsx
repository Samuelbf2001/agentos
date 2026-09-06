/**
 * Buscador global de tareas. Se abre con `/` desde cualquier pantalla y se
 * cierra con `Esc` (Radix ya lo hace). Entra y sale por el mismo lado, con el
 * origen en la parte alta de la pantalla, que es donde vive la barra.
 */
import * as Dialog from "@radix-ui/react-dialog";
import { useStore } from "../state/store";
import TaskSearchBox from "./TaskSearchBox";

export function SearchOverlay({
  open,
  onOpenChange,
  projectId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId?: string | undefined;
}) {
  const projects = useStore((s) => s.projects);
  const projectName = projectId ? projects.find((p) => p.id === projectId)?.name : undefined;
  const scopeLabel = projectId
    ? `Buscando en ${projectName ?? "este proyecto"}`
    : "Buscando en todos los proyectos";
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/25 backdrop-blur-[1px]" />
        <Dialog.Content
          className="enter-rise fixed left-1/2 top-20 z-50 w-[min(38rem,calc(100vw-2rem))] -translate-x-1/2 rounded-panel border border-line bg-surface p-3 shadow-float focus:outline-none"
          aria-describedby={undefined}
        >
          <Dialog.Title className="sr-only">Buscar tareas</Dialog.Title>
          <p className="mb-1.5 px-1 text-small text-muted">{scopeLabel}</p>
          <TaskSearchBox
            {...(projectId ? { projectId } : {})}
            placeholder="Busca una tarea por título, descripción o comentario…"
          />
          <p className="mt-2 px-1 text-small text-faint">
            Escribe para buscar. <kbd className="font-sans font-semibold">Esc</kbd> cierra.
          </p>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export default SearchOverlay;
