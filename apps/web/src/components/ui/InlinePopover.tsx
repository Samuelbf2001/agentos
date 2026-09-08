/**
 * Popover anclado a un valor editable (patrón Notion: clic en la propiedad →
 * editor en sitio; cerrar guarda). Envuelve `@radix-ui/react-popover` con la
 * gramática visual del sistema y un cierre por Escape que no se propaga al
 * Dialog que lo contiene (si no, Esc cerraría la ficha entera).
 */
import * as Popover from "@radix-ui/react-popover";
import type { ReactNode } from "react";

export interface InlinePopoverProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  /** Disparador: normalmente el valor actual, como botón. */
  trigger: ReactNode;
  children: ReactNode;
  /** Etiqueta accesible del panel. */
  label: string;
  align?: "start" | "center" | "end";
  className?: string;
  testId?: string;
}

export function InlinePopover({
  open,
  onOpenChange,
  trigger,
  children,
  label,
  align = "start",
  className = "",
  testId,
}: InlinePopoverProps) {
  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger asChild>{trigger}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align={align}
          sideOffset={4}
          collisionPadding={8}
          aria-label={label}
          data-testid={testId}
          onEscapeKeyDown={(event) => {
            // Esc cierra el popover (y guarda) una sola vez; con preventDefault
            // Radix no vuelve a llamar a onDismiss. El Dialog de la ficha no
            // reacciona porque no es la capa superior mientras esto está abierto.
            event.preventDefault();
            onOpenChange(false);
          }}
          className={`z-[70] w-[min(92vw,20rem)] rounded-panel bg-surface p-2 text-body shadow-float focus:outline-none ${className}`}
        >
          {children}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** Fila de opción dentro de un popover: alto mínimo tocable y foco visible. */
export function PopoverOption({
  selected,
  onSelect,
  children,
  testId,
  disabled,
}: {
  selected?: boolean;
  onSelect(): void;
  children: ReactNode;
  testId?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={Boolean(selected)}
      data-testid={testId}
      disabled={disabled}
      onClick={onSelect}
      className={`flex min-h-10 w-full items-center gap-2 rounded-tight px-2 py-1.5 text-left text-small hover:bg-surface-2 focus:outline-none focus:ring-2 focus:ring-link focus:ring-inset disabled:cursor-not-allowed disabled:opacity-40 ${
        selected ? "bg-line-soft font-semibold text-ink" : "text-ink-2"
      }`}
    >
      {children}
    </button>
  );
}

/** Caja de búsqueda de un popover con lista. */
export function PopoverSearch({
  value,
  onChange,
  placeholder,
  label,
  testId,
}: {
  value: string;
  onChange(value: string): void;
  placeholder?: string;
  label: string;
  testId?: string;
}) {
  return (
    <input
      type="search"
      autoFocus
      value={value}
      aria-label={label}
      data-testid={testId}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
      className="mb-1 min-h-10 w-full rounded-soft border border-line bg-surface px-2.5 py-2 text-small focus:border-link focus:outline-none focus:ring-2 focus:ring-link"
    />
  );
}
