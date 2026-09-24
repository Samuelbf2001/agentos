/**
 * Etiqueta y color del estado de una nota. Aparte de `NotasView` para que
 * `NotasRecientesLista` (aside de escritorio + Inicio/pestañas de celular) y
 * la cabecera compacta del celular usen exactamente las mismas palabras.
 */
import type { CanvasNote } from "../../lib/types";

export const STATUS_LABELS: Record<CanvasNote["status"], string> = {
  draft: "Borrador",
  captured: "Terminada",
  transcribed: "Transcrita",
  converted: "Con tareas",
};

export const STATUS_CLASSES: Record<CanvasNote["status"], string> = {
  draft: "border-line bg-surface-2 text-muted",
  captured: "border-done-line bg-done-bg text-done",
  transcribed: "border-link bg-link-bg text-link",
  converted: "border-done-line bg-done-bg text-done",
};
