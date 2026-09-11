/**
 * Estado del shell que una vista necesita imponer desde dentro: el modo
 * inmersivo. Cuando una pantalla lo pide (el lienzo de Notas a pantalla
 * completa), `App.tsx` deja de pintar menú lateral y cabecera y el contenido
 * ocupa la ventana entera. Es layout, no la Fullscreen API del navegador (que
 * falla en iframes y tabletas).
 *
 * Va aparte del store principal a propósito: es efímero, no viene de la API
 * y ninguna vista salvo la que lo pide debe depender de él. La vista que lo
 * activa es responsable de apagarlo al desmontarse.
 */
import { create } from "zustand";

interface ShellState {
  inmersivo: boolean;
  setInmersivo(inmersivo: boolean): void;
}

export const useShell = create<ShellState>((set) => ({
  inmersivo: false,
  setInmersivo: (inmersivo) => set({ inmersivo }),
}));
