/**
 * Rutas de la aplicación en un solo sitio (PLAN-v1.5 §Navegación nueva).
 *
 * El proyecto es el objeto raíz: cuatro entradas globales y cinco pestañas
 * dentro del proyecto. Todo enlace se construye aquí para que los caminos de
 * vuelta (run → tarea → proyecto) no dependan de cadenas sueltas por la app.
 */

export const PROJECT_TABS = ["ruta", "tablero", "contexto", "conversacion", "actividad"] as const;
export type ProjectTab = (typeof PROJECT_TABS)[number];

export const PROJECT_TAB_LABELS: Record<ProjectTab, string> = {
  ruta: "Ruta",
  tablero: "Tablero",
  contexto: "Contexto",
  conversacion: "Conversación",
  actividad: "Actividad",
};

export const SYSTEM_TABS = ["ahora", "actividad", "salud", "equipo", "ajustes"] as const;
export type SystemTab = (typeof SYSTEM_TABS)[number];

export const SYSTEM_TAB_LABELS: Record<SystemTab, string> = {
  ahora: "Ahora mismo",
  actividad: "Actividad",
  salud: "Salud",
  equipo: "Equipo",
  ajustes: "Ajustes",
};

export const paths = {
  hoy: (projectId?: string | null) => (projectId ? `/hoy?proyecto=${encodeURIComponent(projectId)}` : "/hoy"),
  misTareas: () => "/mis-tareas",
  proyectos: () => "/proyectos",
  proyecto: (projectId: string, tab: ProjectTab = "ruta") => `/proyectos/${projectId}/${tab}`,
  nuevoProyecto: (params?: { projectId?: string; phase?: string }) => {
    const search = new URLSearchParams();
    if (params?.projectId) search.set("proyecto", params.projectId);
    if (params?.phase) search.set("fase", params.phase);
    const qs = search.toString();
    return `/nuevo-proyecto${qs ? `?${qs}` : ""}`;
  },
  sistema: (tab: SystemTab = "ahora") => `/sistema/${tab}`,
  run: (runId: string) => `/sistema/actividad/${runId}`,
  activo: () => "/activo",
} as const;
