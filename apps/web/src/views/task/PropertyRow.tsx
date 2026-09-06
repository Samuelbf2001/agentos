/**
 * Fila de propiedad al estilo Notion: icono + nombre | valor. El valor es un
 * botón que abre un popover anclado; cerrar el popover guarda (optimista, con
 * reversión en el store). Nunca hay botón "Guardar".
 *
 * 409: el store relee la tarea y deja `taskConflict`; `useInlineCommit`
 * reabre el popover con el valor releído y un aviso de una línea.
 */
import { useCallback, useState, type ReactNode } from "react";
import { InlinePopover } from "../../components/ui/InlinePopover";
import { useStore } from "../../state/store";

export interface PropertyRowProps {
  icon: string;
  label: string;
  /** Valor actual, tal como se pinta en la fila. */
  children: ReactNode;
  /** Editor del popover; ausente = propiedad de solo lectura. */
  editor?: ReactNode;
  open?: boolean;
  onOpenChange?(open: boolean): void;
  /** Aviso de una línea bajo el editor (p. ej. tras un 409). */
  notice?: string | null;
  testId?: string;
  /** true cuando el valor está vacío: se pinta como "Vacío" atenuado. */
  empty?: boolean;
  popoverClassName?: string;
}

export function PropertyRow({
  icon,
  label,
  children,
  editor,
  open = false,
  onOpenChange,
  notice,
  testId,
  empty,
  popoverClassName,
}: PropertyRowProps) {
  const valueClass = `flex min-h-10 w-full items-center gap-1.5 rounded-tight px-2 py-1.5 text-left text-small ${
    empty ? "text-faint" : "text-ink"
  }`;
  return (
    <div className="grid grid-cols-[7.5rem_minmax(0,1fr)] items-start gap-x-2 sm:grid-cols-[8.5rem_minmax(0,1fr)]" role="group" aria-label={label}>
      <div className="flex min-h-10 items-center gap-1.5 px-1 text-small text-muted">
        <span aria-hidden="true" className="w-4 text-center text-faint">{icon}</span>
        <span className="truncate">{label}</span>
      </div>
      {editor && onOpenChange ? (
        <InlinePopover
          open={open}
          onOpenChange={onOpenChange}
          label={`Editar ${label.toLocaleLowerCase("es")}`}
          className={popoverClassName}
          testId={testId ? `${testId}-popover` : undefined}
          trigger={
            <button
              type="button"
              data-testid={testId}
              aria-haspopup="dialog"
              aria-expanded={open}
              className={`${valueClass} hover:bg-surface-2 focus:outline-none focus:ring-2 focus:ring-link`}
            >
              {empty ? <span>Vacío</span> : children}
            </button>
          }
        >
          {notice ? (
            <p className="mb-1.5 rounded-tight border border-work-line bg-work-bg px-2 py-1 text-label text-work" role="status" data-testid={testId ? `${testId}-notice` : undefined}>
              {notice}
            </p>
          ) : null}
          {editor}
        </InlinePopover>
      ) : (
        <div data-testid={testId} className={valueClass}>
          {empty ? <span>Vacío</span> : children}
        </div>
      )}
    </div>
  );
}

/**
 * Estado de apertura + reconciliación de un control inline. `commit` ejecuta
 * la mutación del store; si falla por 409 (el store ya releyó la tarea),
 * reabre el popover con un aviso que nombra el valor nuevo.
 */
export function useInlineCommit(taskId: string) {
  const [open, setOpenState] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const setOpen = useCallback((value: boolean) => {
    setOpenState(value);
    if (value) setNotice(null);
  }, []);

  const commit = useCallback(
    async (run: () => Promise<boolean>, describeCurrent: () => string): Promise<boolean> => {
      setNotice(null);
      const ok = await run();
      if (!ok && useStore.getState().taskConflict?.taskId === taskId) {
        setNotice(`Otra persona lo cambió a ${describeCurrent()}`);
        setOpenState(true);
      }
      return ok;
    },
    [taskId],
  );

  return { open, setOpen, notice, commit };
}
