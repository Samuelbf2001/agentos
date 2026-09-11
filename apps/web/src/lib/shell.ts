/**
 * Preferencias del shell (menú lateral) que viven en `localStorage`. Helpers
 * puros, sin React ni store: el mismo patrón que las preferencias de la ficha
 * en `lib/tareas.ts` (leer tolera basura y ausencia; guardar nunca lanza).
 */

export const SIDEBAR_COLAPSADO_KEY = "agentos_sidebar_colapsado";

/** ¿El usuario dejó el menú lateral oculto? Sin valor (o con basura) → visible. */
export function leerSidebarColapsado(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_COLAPSADO_KEY) === "1";
  } catch {
    return false;
  }
}

export function guardarSidebarColapsado(colapsado: boolean): void {
  try {
    localStorage.setItem(SIDEBAR_COLAPSADO_KEY, colapsado ? "1" : "0");
  } catch {
    // Sin almacenamiento el botón sigue funcionando: sólo no se recuerda.
  }
}

/**
 * Ctrl+B (⌘B en Mac) alterna el menú lateral, como en VS Code. Con Alt o
 * Shift no cuenta: esos son otros atajos (del navegador o de Excalidraw).
 */
export function esAtajoMenuLateral(
  event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">,
): boolean {
  if (!(event.ctrlKey || event.metaKey)) return false;
  if (event.altKey || event.shiftKey) return false;
  return typeof event.key === "string" && event.key.toLowerCase() === "b";
}
