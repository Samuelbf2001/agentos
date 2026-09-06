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

export const CONTEXT_SUBTABS = ["documentos", "procesos"] as const;
export type ContextSubtab = (typeof CONTEXT_SUBTABS)[number];

export const SYSTEM_TABS = ["ahora", "actividad", "fuentes", "equipo", "ajustes"] as const;
export type SystemTab = (typeof SYSTEM_TABS)[number];

export const SYSTEM_TAB_LABELS: Record<SystemTab, string> = {
  ahora: "Ahora mismo",
  actividad: "Actividad",
  fuentes: "Fuentes",
  equipo: "Equipo",
  ajustes: "Ajustes",
};

/** Filtros que se pueden fijar desde un enlace a la vista Tareas. */
export interface TareasFiltrosLink {
  cliente?: string;
  proyecto?: string;
  responsable?: string;
  estado?: string;
  etiqueta?: string;
  vencimiento?: string;
  agrupar?: string;
  q?: string;
}

export const paths = {
  hoy: (projectId?: string | null) => (projectId ? `/hoy?proyecto=${encodeURIComponent(projectId)}` : "/hoy"),
  /**
   * La base transversal de tareas. Los filtros viajan en la query para que un
   * enlace reproduzca exactamente la vista: el cliente y el proyecto son
   * atributos, no rutas propias.
   */
  tareas: (filtros: TareasFiltrosLink = {}) => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(filtros)) {
      if (value) search.set(key, value);
    }
    const qs = search.toString();
    return `/tareas${qs ? `?${qs}` : ""}`;
  },
  /** "Mis tareas" dejó de ser una vista: es el filtro por responsable. */
  misTareas: () => "/tareas?responsable=yo",
  proyectos: () => "/proyectos",
  proyecto: (projectId: string, tab: ProjectTab = "ruta") => `/proyectos/${projectId}/${tab}`,
  contexto: (projectId: string, sub: ContextSubtab = "documentos") =>
    `/proyectos/${projectId}/contexto/${sub}`,
  nuevoProyecto: (params?: { projectId?: string; phase?: string; modulo?: string }) => {
    const search = new URLSearchParams();
    if (params?.projectId) search.set("proyecto", params.projectId);
    if (params?.phase) search.set("fase", params.phase);
    if (params?.modulo) search.set("modulo", params.modulo);
    const qs = search.toString();
    return `/nuevo-proyecto${qs ? `?${qs}` : ""}`;
  },
  sistema: (tab: SystemTab = "ahora") => `/sistema/${tab}`,
  run: (runId: string) => `/sistema/actividad/${runId}`,
  activo: () => "/activo",
} as const;
