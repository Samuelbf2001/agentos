/**
 * Ventana centrada reutilizable.
 *
 * Hasta ahora cada formulario inventaba su propio contenedor: el alta de tarea
 * era un cajón pegado a la derecha ("hazlo en ventana central en medio de la
 * pantalla"). Esto es el contenedor único: Radix Dialog con la gramática del
 * sistema —velo que desenfoca, panel que sube al entrar, radio y sombra de
 * flotante—, Esc y × para cerrar, y pantalla completa por debajo de 640 px,
 * donde una ventana centrada no es una ventana sino una isla.
 *
 * El movimiento reducido lo resuelve `.enter-rise` en styles.css: con la
 * preferencia activada el desplazamiento se cambia por un fundido corto.
 */
import * as Dialog from "@radix-ui/react-dialog";
import type { ReactNode } from "react";

export interface ModalProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  /** Título visible en la cabecera; también es el nombre accesible. */
  title: ReactNode;
  /** Una línea bajo el título. Se enlaza con `aria-describedby`. */
  description?: ReactNode;
  children: ReactNode;
  /** Pie fijo (los botones de acción). */
  footer?: ReactNode;
  /** Ancho máximo del panel; por defecto 800 px. */
  widthClass?: string;
  testId?: string;
  /** Etiqueta del botón de cierre, para decir QUÉ se cierra. */
  closeLabel?: string;
  /** Se ejecuta cuando el panel ya tiene el foco: para enfocar el primer campo. */
  onOpenAutoFocus?(event: Event): void;
}

export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  widthClass = "sm:w-[min(94vw,800px)]",
  testId,
  closeLabel = "Cerrar",
  onOpenAutoFocus,
}: ModalProps) {
  const describedBy = description && testId ? `${testId}-description` : undefined;
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/35 backdrop-blur-sm" />
        <Dialog.Content
          data-testid={testId}
          aria-describedby={describedBy}
          onOpenAutoFocus={onOpenAutoFocus}
          className={`enter-rise fixed inset-0 z-50 flex h-[100dvh] w-full flex-col overflow-hidden bg-surface shadow-float focus:outline-none sm:inset-auto sm:left-1/2 sm:top-1/2 sm:h-auto sm:max-h-[88vh] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-panel ${widthClass}`}
        >
          <div className="flex shrink-0 items-start gap-3 border-b border-line px-4 py-3 sm:px-6 sm:py-4">
            <div className="min-w-0 flex-1">
              <Dialog.Title className="text-title text-ink">{title}</Dialog.Title>
              {description ? (
                <Dialog.Description id={describedBy} className="mt-0.5 text-small text-muted">
                  {description}
                </Dialog.Description>
              ) : null}
            </div>
            <Dialog.Close
              aria-label={closeLabel}
              className="press inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-soft text-title text-faint hover:bg-line-soft hover:text-ink-2 focus:outline-none focus:ring-2 focus:ring-link"
            >
              <span aria-hidden="true">×</span>
            </Dialog.Close>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6">{children}</div>

          {footer ? (
            <div className="shrink-0 border-t border-line-soft px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6">
              {footer}
            </div>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export default Modal;
