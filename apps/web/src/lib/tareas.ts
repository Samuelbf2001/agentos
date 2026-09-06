/**
 * La base transversal de tareas (PLAN-v1.5 §Navegación nueva, entrada Tareas;
 * MODELO-TENANCY-v1.4 §El tenant de agencia es el Notion de Sixteam).
 *
 * Una sola base con TODAS las tareas de TODOS los clientes y proyectos. El
 * proyecto y el cliente son atributos por los que se filtra y se agrupa, nunca
 * puertas que haya que cruzar para descubrir el trabajo. Aquí viven sólo las
 * funciones puras —filtrar, ordenar, agrupar, leer y escribir la query— para
 * poder probarlas sin montar la vista.
 *
 * Todo se calcula en el navegador sobre `GET /api/tasks` sin `project_id`, que
 * ya devuelve la lista completa con sus responsables: así los filtros se
 * combinan entre sí sin una ida y vuelta por cada cruce.
 */
import {
  DUE_BUCKETS,
  DUE_BUCKET_LABELS,
  TASK_STATUSES,
  dueBucket,
  getTaskLabels,
  taskAssigneeIsPrimary,
  taskAssigneePersonId,
  taskDueTimestamp,
  getTaskAssignees,
  type DueBucket,
  type Person,
  type Project,
  type Task,
  type TaskPriority,
  type TaskStatus,
} from "./types";

// ── Vocabulario de la vista ─────────────────────────────────────────────────

export type Vista = "tabla" | "tablero";

export const AGRUPACIONES = [
  "ninguna",
  "cliente",
  "proyecto",
  "responsable",
  "estado",
  "etiqueta",
  "vencimiento",
] as const;
export type Agrupacion = (typeof AGRUPACIONES)[number];

export const AGRUPACION_LABELS: Record<Agrupacion, string> = {
  ninguna: "Sin agrupar",
  cliente: "Cliente",
  proyecto: "Proyecto",
  responsable: "Responsable",
  estado: "Estado",
  etiqueta: "Etiqueta",
  vencimiento: "Vencimiento",
};

/** Los cuatro cortes que pidió el producto; `later` no es un filtro ofrecido. */
export const VENCIMIENTOS = ["vencidas", "hoy", "semana", "sin-fecha"] as const;
export type VencimientoFiltro = (typeof VENCIMIENTOS)[number];

export const VENCIMIENTO_LABELS: Record<VencimientoFiltro, string> = {
  vencidas: "Vencidas",
  hoy: "Hoy",
  semana: "Esta semana",
  "sin-fecha": "Sin fecha",
};

const VENCIMIENTO_BUCKET: Record<VencimientoFiltro, DueBucket> = {
  vencidas: "overdue",
  hoy: "today",
  semana: "week",
  "sin-fecha": "none",
};

export const COLUMNAS = [
  "titulo",
  "cliente",
  "proyecto",
  "estado",
  "responsable",
  "etiquetas",
  "vencimiento",
  "prioridad",
] as const;
export type Columna = (typeof COLUMNAS)[number];

export const COLUMNA_LABELS: Record<Columna, string> = {
  titulo: "Título",
  cliente: "Cliente",
  proyecto: "Proyecto",
  estado: "Estado",
  responsable: "Responsable",
  etiquetas: "Etiquetas",
  vencimiento: "Vence",
  prioridad: "Prioridad",
};

export type Direccion = "asc" | "desc";

/** El valor reservado de `responsable` que significa "la persona de la sesión". */
export const YO = "yo";

/** Estados que no son trabajo pendiente y se ocultan mientras no se pidan. */
export const ESTADOS_CERRADOS: TaskStatus[] = ["DONE", "CANCELLED"];

export interface Filtros {
  cliente: string | null;
  proyecto: string | null;
  /** Id de persona, o `YO`. */
  responsable: string | null;
  estado: TaskStatus | null;
  etiqueta: string | null;
  vencimiento: VencimientoFiltro | null;
  texto: string;
  /** Incluir DONE y CANCELLED. */
  cerradas: boolean;
}

export const FILTROS_VACIOS: Filtros = {
  cliente: null,
  proyecto: null,
  responsable: null,
  estado: null,
  etiqueta: null,
  vencimiento: null,
  texto: "",
  cerradas: false,
};

/** Lo que la vista sabe del mundo para poder resolver nombres. */
export interface Contexto {
  projects: Project[];
  people: Person[];
  /** Persona de la sesión; resuelve `responsable=yo`. */
  meId: string | null;
  /**
   * Nombre real de cada organización, sacado del recibo de launch
   * (`inputs.empresa`). `/api/projects` no lo trae, así que puede faltar.
   */
  clientNames?: Map<string, string>;
}

/** Lo mínimo para poder nombrar a un cliente. */
export type ClienteCtx = Pick<Contexto, "projects" | "clientNames">;

// ── Nombres legibles ────────────────────────────────────────────────────────

export function normalizar(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("es")
    .trim();
}

export function projectOf(task: Pick<Task, "projectId">, projects: Project[]): Project | null {
  return projects.find((project) => project.id === task.projectId) ?? null;
}

export function orgIdOf(task: Pick<Task, "projectId">, projects: Project[]): string | null {
  return projectOf(task, projects)?.orgId ?? null;
}

/** Prefijo común de palabras entre dos nombres ("ACME assessment"/"ACME ops" → "ACME"). */
function prefijoComun(a: string, b: string): string {
  const left = a.split(/\s+/);
  const right = b.split(/\s+/);
  const words: string[] = [];
  for (let i = 0; i < Math.min(left.length, right.length); i += 1) {
    const l = left[i]!;
    const r = right[i]!;
    if (normalizar(l) !== normalizar(r)) break;
    words.push(l);
  }
  return words.join(" ").trim();
}

/**
 * Nombre del cliente. `/api/projects` sólo devuelve `org_id`, así que el
 * nombre real sale del recibo de launch del proyecto (`inputs.empresa`), que
 * es un endpoint que ya existe. Cuando el proyecto no nació de un módulo no hay
 * recibo: entonces se deduce de lo único legible que queda, los nombres de sus
 * proyectos —uno solo es su nombre; varios, el prefijo que comparten— y en
 * último término se identifica por el id, antes que inventar uno.
 */
export function clienteLabel(orgId: string | null, ctx: ClienteCtx): string {
  if (!orgId) return "Sin cliente";
  const real = ctx.clientNames?.get(orgId);
  if (real) return real;
  const projects = ctx.projects;
  const own = projects.filter((project) => project.orgId === orgId);
  if (own.length === 0) return `Cliente ${orgId.slice(0, 6)}`;
  const first = own[0]!;
  if (own.length === 1) return first.name;
  let prefix = first.name;
  for (const project of own.slice(1)) prefix = prefijoComun(prefix, project.name);
  return prefix.length >= 3 ? prefix : `Cliente ${orgId.slice(0, 6)}`;
}

export function personName(personId: string | null, people: Person[]): string {
  if (!personId) return "Sin responsable";
  const found = people.find((person) => person.id === personId);
  return found?.full_name || found?.fullName || `Persona ${personId.slice(0, 6)}`;
}

/**
 * Responsable principal: el marcado como primario y, si ninguno lo está, el
 * primero de la lista. La proyección `assigneePersonId` sirve de respaldo.
 */
export function responsablePrincipal(task: Task): string | null {
  const assignees = getTaskAssignees(task);
  const primary = assignees.find((assignee) => taskAssigneeIsPrimary(assignee));
  if (primary) return taskAssigneePersonId(primary);
  const first = assignees[0];
  return first ? taskAssigneePersonId(first) : null;
}

/** Todas las personas asignadas: el filtro por responsable mira a todas, no sólo a la principal. */
export function responsables(task: Task): string[] {
  return getTaskAssignees(task)
    .map((assignee) => taskAssigneePersonId(assignee))
    .filter((id): id is string => Boolean(id));
}

// ── Filtrado ────────────────────────────────────────────────────────────────

function coincideTexto(task: Task, texto: string, ctx: Contexto): boolean {
  const needle = normalizar(texto);
  if (!needle) return true;
  const project = projectOf(task, ctx.projects);
  const haystack = [
    task.title,
    task.description ?? "",
    task.definitionOfDone ?? "",
    project?.name ?? "",
    ...getTaskLabels(task),
  ]
    .map(normalizar)
    .join(" ");
  return haystack.includes(needle);
}

/**
 * Aplica TODOS los filtros a la vez: son combinables por definición, porque la
 * base es una sola y el humano no debe elegir entre "por cliente" o "por
 * responsable".
 */
export function filtrar(tasks: Task[], filtros: Filtros, ctx: Contexto, now = Date.now()): Task[] {
  const responsableId = filtros.responsable === YO ? ctx.meId : filtros.responsable;
  return tasks.filter((task) => {
    if (
      !filtros.cerradas &&
      !(filtros.estado && ESTADOS_CERRADOS.includes(filtros.estado)) &&
      ESTADOS_CERRADOS.includes(task.status)
    ) {
      return false;
    }
    if (filtros.proyecto && task.projectId !== filtros.proyecto) return false;
    if (filtros.cliente && orgIdOf(task, ctx.projects) !== filtros.cliente) return false;
    if (filtros.estado && task.status !== filtros.estado) return false;
    if (filtros.responsable) {
      // `responsable=yo` sin sesión resuelta no debe colar la base entera.
      if (!responsableId) return false;
      if (!responsables(task).includes(responsableId)) return false;
    }
    if (filtros.etiqueta) {
      const wanted = normalizar(filtros.etiqueta);
      if (!getTaskLabels(task).some((label) => normalizar(label) === wanted)) return false;
    }
    if (filtros.vencimiento && dueBucket(task, now) !== VENCIMIENTO_BUCKET[filtros.vencimiento]) {
      return false;
    }
    if (!coincideTexto(task, filtros.texto, ctx)) return false;
    return true;
  });
}

// ── Orden ───────────────────────────────────────────────────────────────────

const PRIORIDAD_PESO: Record<TaskPriority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

function valorDeColumna(task: Task, columna: Columna, ctx: Contexto): string | number {
  switch (columna) {
    case "titulo":
      return normalizar(task.title);
    case "cliente":
      return normalizar(clienteLabel(orgIdOf(task, ctx.projects), ctx));
    case "proyecto":
      return normalizar(projectOf(task, ctx.projects)?.name ?? "");
    case "estado":
      return TASK_STATUSES.indexOf(task.status);
    case "responsable":
      return normalizar(personName(responsablePrincipal(task), ctx.people));
    case "etiquetas":
      return normalizar(getTaskLabels(task).join(" "));
    case "vencimiento":
      // Sin fecha nunca se cuela entre las que vencen: va al final en ascendente.
      return taskDueTimestamp(task) ?? Number.POSITIVE_INFINITY;
    case "prioridad":
      return PRIORIDAD_PESO[task.priority];
  }
}

export function ordenar(tasks: Task[], columna: Columna, direccion: Direccion, ctx: Contexto): Task[] {
  const factor = direccion === "asc" ? 1 : -1;
  return [...tasks].sort((a, b) => {
    const left = valorDeColumna(a, columna, ctx);
    const right = valorDeColumna(b, columna, ctx);
    let cmp: number;
    if (typeof left === "number" && typeof right === "number") cmp = left - right;
    else cmp = String(left).localeCompare(String(right), "es");
    if (cmp !== 0) return cmp * factor;
    // Desempate estable y legible: el título, siempre ascendente.
    return a.title.localeCompare(b.title, "es");
  });
}

// ── Agrupación ──────────────────────────────────────────────────────────────

export interface Grupo {
  key: string;
  label: string;
  tasks: Task[];
}

export function agrupar(
  tasks: Task[],
  agrupacion: Agrupacion,
  ctx: Contexto,
  now = Date.now(),
): Grupo[] {
  if (agrupacion === "ninguna") return [{ key: "todas", label: "Todas", tasks }];

  if (agrupacion === "estado") {
    return TASK_STATUSES.map((status) => ({
      key: status,
      label: status,
      tasks: tasks.filter((task) => task.status === status),
    })).filter((group) => group.tasks.length > 0);
  }

  if (agrupacion === "vencimiento") {
    return DUE_BUCKETS.map((bucket) => ({
      key: bucket,
      label: DUE_BUCKET_LABELS[bucket],
      tasks: tasks.filter((task) => dueBucket(task, now) === bucket),
    })).filter((group) => group.tasks.length > 0);
  }

  const buckets = new Map<string, { label: string; tasks: Task[] }>();
  const push = (key: string, label: string, task: Task): void => {
    const found = buckets.get(key);
    if (found) found.tasks.push(task);
    else buckets.set(key, { label, tasks: [task] });
  };

  for (const task of tasks) {
    if (agrupacion === "cliente") {
      const orgId = orgIdOf(task, ctx.projects);
      push(orgId ?? "sin-cliente", clienteLabel(orgId, ctx), task);
    } else if (agrupacion === "proyecto") {
      const project = projectOf(task, ctx.projects);
      push(task.projectId, project?.name ?? `Proyecto ${task.projectId.slice(0, 6)}`, task);
    } else if (agrupacion === "responsable") {
      const personId = responsablePrincipal(task);
      push(personId ?? "sin-responsable", personName(personId, ctx.people), task);
    } else if (agrupacion === "etiqueta") {
      const labels = getTaskLabels(task);
      // Una tarea con tres etiquetas aparece en las tres: agrupar no es repartir.
      if (labels.length === 0) push("sin-etiqueta", "Sin etiqueta", task);
      else for (const label of labels) push(label, label, task);
    }
  }

  const sinDueno = ["sin-cliente", "sin-responsable", "sin-etiqueta"];
  return [...buckets.entries()]
    .map(([key, value]) => ({ key, label: value.label, tasks: value.tasks }))
    .sort((a, b) => {
      // "Sin …" cierra la lista: es residuo, no un grupo más.
      const aEmpty = sinDueno.includes(a.key);
      const bEmpty = sinDueno.includes(b.key);
      if (aEmpty !== bEmpty) return aEmpty ? 1 : -1;
      return a.label.localeCompare(b.label, "es");
    });
}

// ── La query es el estado: un enlace reproduce exactamente la vista ─────────

function pick<T extends string>(value: string | null, allowed: readonly T[]): T | null {
  return value && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

export function parseFiltros(params: URLSearchParams): Filtros {
  return {
    cliente: params.get("cliente") || null,
    proyecto: params.get("proyecto") || null,
    responsable: params.get("responsable") || null,
    estado: pick(params.get("estado"), TASK_STATUSES),
    etiqueta: params.get("etiqueta") || null,
    vencimiento: pick(params.get("vencimiento"), VENCIMIENTOS),
    texto: params.get("q") ?? "",
    cerradas: params.get("cerradas") === "1",
  };
}

export function parseAgrupacion(params: URLSearchParams): Agrupacion {
  return pick(params.get("agrupar"), AGRUPACIONES) ?? "ninguna";
}

export function parseOrden(params: URLSearchParams): { columna: Columna; direccion: Direccion } {
  return {
    columna: pick(params.get("orden"), COLUMNAS) ?? "vencimiento",
    direccion: params.get("dir") === "desc" ? "desc" : "asc",
  };
}

export function filtrosAParams(
  filtros: Filtros,
  extra: { agrupacion?: Agrupacion; orden?: { columna: Columna; direccion: Direccion } } = {},
): URLSearchParams {
  const params = new URLSearchParams();
  if (filtros.cliente) params.set("cliente", filtros.cliente);
  if (filtros.proyecto) params.set("proyecto", filtros.proyecto);
  if (filtros.responsable) params.set("responsable", filtros.responsable);
  if (filtros.estado) params.set("estado", filtros.estado);
  if (filtros.etiqueta) params.set("etiqueta", filtros.etiqueta);
  if (filtros.vencimiento) params.set("vencimiento", filtros.vencimiento);
  if (filtros.texto.trim()) params.set("q", filtros.texto.trim());
  if (filtros.cerradas) params.set("cerradas", "1");
  if (extra.agrupacion && extra.agrupacion !== "ninguna") params.set("agrupar", extra.agrupacion);
  if (extra.orden && extra.orden.columna !== "vencimiento") params.set("orden", extra.orden.columna);
  if (extra.orden && extra.orden.direccion === "desc") params.set("dir", "desc");
  return params;
}

// ── Chips: lo que está filtrado se ve y se puede quitar ─────────────────────

export interface Chip {
  key: keyof Filtros;
  label: string;
  value: string;
}

export function chipsActivos(filtros: Filtros, ctx: Contexto): Chip[] {
  const chips: Chip[] = [];
  if (filtros.cliente) {
    chips.push({ key: "cliente", label: "Cliente", value: clienteLabel(filtros.cliente, ctx) });
  }
  if (filtros.proyecto) {
    const project = ctx.projects.find((p) => p.id === filtros.proyecto);
    chips.push({ key: "proyecto", label: "Proyecto", value: project?.name ?? filtros.proyecto });
  }
  if (filtros.responsable) {
    chips.push({
      key: "responsable",
      label: "Responsable",
      value: filtros.responsable === YO ? "Yo" : personName(filtros.responsable, ctx.people),
    });
  }
  if (filtros.estado) chips.push({ key: "estado", label: "Estado", value: filtros.estado });
  if (filtros.etiqueta) chips.push({ key: "etiqueta", label: "Etiqueta", value: filtros.etiqueta });
  if (filtros.vencimiento) {
    chips.push({
      key: "vencimiento",
      label: "Vencimiento",
      value: VENCIMIENTO_LABELS[filtros.vencimiento],
    });
  }
  if (filtros.texto.trim()) chips.push({ key: "texto", label: "Texto", value: filtros.texto.trim() });
  if (filtros.cerradas) chips.push({ key: "cerradas", label: "Incluye", value: "cerradas" });
  return chips;
}

export function hayFiltros(filtros: Filtros): boolean {
  return chipsActivos(filtros, { projects: [], people: [], meId: null }).length > 0;
}

/** Clientes presentes en la base, para el desplegable. */
export function clientesDe(ctx: ClienteCtx): { id: string; label: string }[] {
  const ids = [...new Set(ctx.projects.map((project) => project.orgId))];
  return ids
    .map((id) => ({ id, label: clienteLabel(id, ctx) }))
    .sort((a, b) => a.label.localeCompare(b.label, "es"));
}

// ── Persistencia del conmutador de vista ────────────────────────────────────

export const VISTA_STORAGE_KEY = "agentos_tareas_vista";

export function leerVista(): Vista {
  try {
    return localStorage.getItem(VISTA_STORAGE_KEY) === "tablero" ? "tablero" : "tabla";
  } catch {
    return "tabla";
  }
}

export function guardarVista(vista: Vista): void {
  try {
    localStorage.setItem(VISTA_STORAGE_KEY, vista);
  } catch {
    // Sin almacenamiento la vista sigue funcionando: sólo no se recuerda.
  }
}

export const PROYECTO_RECIENTE_KEY = "agentos_tareas_ultimo_proyecto";

export function leerProyectoReciente(): string | null {
  try {
    return localStorage.getItem(PROYECTO_RECIENTE_KEY);
  } catch {
    return null;
  }
}

export function guardarProyectoReciente(projectId: string): void {
  try {
    localStorage.setItem(PROYECTO_RECIENTE_KEY, projectId);
  } catch {
    // Idem: el selector simplemente empezará vacío la próxima vez.
  }
}

// ── Persistencia de la ficha (side peek) ────────────────────────────────────

export const PEEK_WIDTH_KEY = "agentos_task_peek_width";
export const PEEK_MODE_KEY = "agentos_task_peek_mode";
export const PEEK_MORE_KEY = "agentos_task_peek_more";

export const PEEK_MIN_WIDTH = 384;
export const PEEK_MAX_WIDTH = 920;
export const PEEK_DEFAULT_WIDTH = 560;
/** Paso del tirador con teclado (ArrowLeft/ArrowRight). */
export const PEEK_KEY_STEP = 32;

export type PeekMode = "side" | "center" | "full";
export const PEEK_MODES: PeekMode[] = ["side", "center", "full"];

/** Ancho máximo real del peek para una ventana dada: nunca más del 90 %. */
export function anchoMaximoPeek(innerWidth: number): number {
  return Math.max(PEEK_MIN_WIDTH, Math.min(PEEK_MAX_WIDTH, Math.floor(innerWidth * 0.9)));
}

/** `clamp(384, ancho, min(920, innerWidth*0.9))`: el puntero puede salirse de la ventana. */
export function acotarAnchoPeek(width: number, innerWidth: number): number {
  if (!Number.isFinite(width)) return PEEK_DEFAULT_WIDTH;
  return Math.min(anchoMaximoPeek(innerWidth), Math.max(PEEK_MIN_WIDTH, Math.round(width)));
}

/** Ancho que corresponde a un puntero en `clientX` con el panel pegado a la derecha. */
export function anchoDesdePuntero(clientX: number, innerWidth: number): number {
  return acotarAnchoPeek(innerWidth - clientX, innerWidth);
}

export function leerAnchoPeek(innerWidth: number = typeof window !== "undefined" ? window.innerWidth : 1280): number {
  try {
    const raw = localStorage.getItem(PEEK_WIDTH_KEY);
    const parsed = raw === null ? Number.NaN : Number(raw);
    return acotarAnchoPeek(Number.isFinite(parsed) ? parsed : PEEK_DEFAULT_WIDTH, innerWidth);
  } catch {
    return acotarAnchoPeek(PEEK_DEFAULT_WIDTH, innerWidth);
  }
}

export function guardarAnchoPeek(width: number): void {
  try {
    localStorage.setItem(PEEK_WIDTH_KEY, String(Math.round(width)));
  } catch {
    // Sin almacenamiento el tirador sigue funcionando: sólo no se recuerda.
  }
}

export function leerModoPeek(): PeekMode {
  try {
    const raw = localStorage.getItem(PEEK_MODE_KEY);
    return raw === "center" || raw === "full" ? raw : "side";
  } catch {
    return "side";
  }
}

export function guardarModoPeek(mode: PeekMode): void {
  try {
    localStorage.setItem(PEEK_MODE_KEY, mode);
  } catch {
    // Idem.
  }
}

/** "N más propiedades": si el usuario las desplegó, se quedan desplegadas. */
export function leerMasPropiedades(): boolean {
  try {
    return localStorage.getItem(PEEK_MORE_KEY) === "1";
  } catch {
    return false;
  }
}

export function guardarMasPropiedades(open: boolean): void {
  try {
    localStorage.setItem(PEEK_MORE_KEY, open ? "1" : "0");
  } catch {
    // Idem.
  }
}
