/**
 * Papelera: «Eliminar» no borra. La tarea pasa a Desactivadas, se puede
 * restaurar durante 90 días y después la API la borra para siempre.
 *
 * El botón vive en la cabecera de la ficha con estilo destructivo discreto
 * (gris hasta que se apunta) y siempre pide confirmación en la ventana centrada
 * del sistema (`Modal`, Radix Dialog: foco atrapado, Esc cierra). Si la tarea
 * tiene subtareas, la confirmación dice cuántas se van con ella: el número se
 * lee del proyecto al abrir, porque la ficha no carga las hijas.
 */
import { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import { api } from "../../lib/api";
import { isTaskDeleted, PAPELERA_DIAS, type Task } from "../../lib/types";
import { useStore } from "../../state/store";
import { Modal } from "../../components/ui/Modal";

/** Frase de la confirmación; exportada para no duplicar el texto en tests. */
export const TEXTO_PAPELERA = `La tarea pasa a Desactivadas. Puedes restaurarla durante ${PAPELERA_DIAS} días; después se borra para siempre.`;

export function textoSubtareas(count: number): string {
  if (count <= 0) return "";
  return count === 1
    ? "Tiene 1 subtarea: también pasa a Desactivadas."
    : `Tiene ${count} subtareas: también pasan a Desactivadas.`;
}

export function DeleteTaskButton({ task, className = "" }: { task: Task; className?: string }) {
  const deactivateTask = useStore((state) => state.deactivateTask);
  const [open, setOpen] = useState(false);
  const [subtareas, setSubtareas] = useState<number | null>(null);

  useEffect(() => {
    if (!open) return;
    let vivo = true;
    setSubtareas(null);
    api
      .tasks({ project_id: task.projectId })
      .then(({ tasks }) => {
        if (!vivo) return;
        setSubtareas(tasks.filter((t) => t.parentTaskId === task.id && !isTaskDeleted(t)).length);
      })
      .catch(() => {
        // Sin el número se confirma igual: la API desactiva las hijas de todos modos.
        if (vivo) setSubtareas(0);
      });
    return () => {
      vivo = false;
    };
  }, [open, task.id, task.projectId]);

  if (isTaskDeleted(task)) return null;

  function confirmar(): void {
    setOpen(false);
    void deactivateTask(task.id);
  }

  return (
    <>
      <button
        type="button"
        data-testid="task-eliminar"
        aria-label="Eliminar tarea"
        title="Eliminar tarea (pasa a Desactivadas)"
        onClick={() => setOpen(true)}
        className={`press inline-flex min-h-10 shrink-0 items-center gap-1.5 rounded-soft px-2.5 text-small font-semibold text-muted hover:bg-broken-bg hover:text-broken focus:outline-none focus:ring-2 focus:ring-broken ${className}`}
      >
        <Trash2 size={15} strokeWidth={1.75} aria-hidden="true" />
        <span className="hidden sm:inline">Eliminar</span>
      </button>

      <Modal
        open={open}
        onOpenChange={setOpen}
        testId="task-eliminar-dialogo"
        title="¿Eliminar esta tarea?"
        description={TEXTO_PAPELERA}
        closeLabel="Cancelar y cerrar"
        widthClass="sm:w-[min(94vw,480px)]"
        footer={
          <div className="flex flex-wrap justify-end gap-2">
            <button
              type="button"
              data-testid="task-eliminar-cancelar"
              onClick={() => setOpen(false)}
              className="press min-h-10 rounded-tight border border-line bg-surface px-3 py-2 text-small font-semibold text-ink-2 hover:bg-line-soft focus:outline-none focus:ring-2 focus:ring-link"
            >
              Cancelar
            </button>
            <button
              type="button"
              data-testid="task-eliminar-confirmar"
              onClick={confirmar}
              className="press inline-flex min-h-10 items-center gap-1.5 rounded-tight bg-broken px-3 py-2 text-small font-semibold text-surface hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-broken"
            >
              <Trash2 size={15} strokeWidth={1.75} aria-hidden="true" />
              Eliminar
            </button>
          </div>
        }
      >
        <p className="text-body font-medium text-ink">{task.title}</p>
        {subtareas === null ? (
          <p className="mt-2 text-small text-faint" data-testid="task-eliminar-subtareas-cargando">
            Comprobando subtareas…
          </p>
        ) : subtareas > 0 ? (
          <p className="mt-2 text-small text-broken" data-testid="task-eliminar-subtareas">
            {textoSubtareas(subtareas)}
          </p>
        ) : null}
      </Modal>
    </>
  );
}
