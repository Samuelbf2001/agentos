/**
 * Cliente de datos (spec B5 §1): wrapper fetch con token de sesión.
 * La UI habla SOLO con apps/api (http://localhost:4300); errores de dominio
 * llegan como { error: { code, message, details? } } y se re-lanzan tipados.
 */
import type {
  Agent,
  AppConfigRow,
  Approval,
  Artifact,
  CanvasNote,
  NoteTaskProposal,
  NoteTranscribeMode,
  NoteTranscribeResponse,
  CanvasScene,
  BrainOverview,
  ConvertRoleToAgentResponse,
  KnowledgeDoc,
  LaunchReceipt,
  LaunchResponse,
  Message,
  Methodology,
  ModuleDetail,
  ModuleSummary,
  Person,
  PhaseClosureStatus,
  PreviewResult,
  ProcessEntity,
  ProcessStep,
  Project,
  ProjectSource,
  ProjectSourceExternalRef,
  ProjectSourceKind,
  LabelUsage,
  SourceBrowseItem,
  MeetingProcessingFilter,
  MeetingProcessingOverview,
  OrgGraph,
  OrgRoleFull,
  OrgRolePerson,
  OrgRoleProcessLink,
  OrgUnit,
  RoleFunction,
  Run,
  Span,
  Stage,
  TaskAssignee,
  TaskAssigneePerson,
  TaskAssistRequest,
  TaskAssistResponse,
  TaskDetailResponse,
  Task,
  TaskEvent,
  TaskPriority,
  TaskSearchHit,
  TaskStatus,
  Thread,
  ToolCatalogEntry,
  UploadedImage,
} from "./types";

const configuredApiBase =
  typeof import.meta !== "undefined" ? import.meta.env?.VITE_AGENTOS_API_URL : undefined;

// Desarrollo conserva la API local directa. La imagen de producción usa el
// mismo origen y el proxy interno de Nginx para que la URL de PostgreSQL/API
// jamás llegue al navegador.
const defaultApiBase =
  typeof window !== "undefined" && import.meta.env.PROD
    ? window.location.origin
    : "http://localhost:4300";

export const API_BASE: string = configuredApiBase || defaultApiBase;

export function wsUrl(token: string): string {
  const base = API_BASE.replace(/^http/, "ws");
  return `${base}/ws?token=${encodeURIComponent(token)}`;
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;
  constructor(code: string, message: string, status: number, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const TOKEN_KEY = "agentos_token";
const PERSON_KEY = "agentos_person";

export function loadSession(): { token: string; person: Person } | null {
  try {
    const token = localStorage.getItem(TOKEN_KEY);
    const raw = localStorage.getItem(PERSON_KEY);
    if (!token || !raw) return null;
    return { token, person: JSON.parse(raw) as Person };
  } catch {
    return null;
  }
}

export function saveSession(token: string, person: Person): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(PERSON_KEY, JSON.stringify(person));
  } catch {
    /* almacenamiento no disponible: sesión solo en memoria */
  }
}

export function clearSession(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(PERSON_KEY);
  } catch {
    /* ignore */
  }
}

let currentToken: string | null = null;
export function setToken(token: string | null): void {
  currentToken = token;
}

type WireTask = Task & {
  assignees?: TaskAssignee[] | null;
  assignee_person_id?: string | null;
  due_at?: number | null;
};

function normalizeAssignee(assignee: TaskAssignee): TaskAssignee {
  const person = assignee.person as (TaskAssigneePerson & { fullName?: string }) | null | undefined;
  if (!person) return assignee;
  const fullName = person.full_name ?? person.fullName;
  return {
    ...assignee,
    person: fullName
      ? { ...person, full_name: fullName, fullName }
      : person,
  };
}

/**
 * Normaliza únicamente aliases de transporte. No rellena personas ni fechas:
 * la UI debe distinguir "sin dato" de un valor inventado.
 */
export function normalizeTask(task: WireTask): Task {
  const next = { ...task } as Task;
  if (next.assignees) next.assignees = next.assignees.map(normalizeAssignee);
  if (next.assignees === undefined && task.assignees !== undefined && task.assignees !== null) {
    next.assignees = task.assignees;
  }
  if (next.dueAt === undefined && task.due_at !== undefined) next.dueAt = task.due_at;
  if (next.assigneePersonId === undefined && task.assignee_person_id !== undefined) {
    next.assigneePersonId = task.assignee_person_id;
  }
  if (next.assigneePersonId === undefined || next.assigneePersonId === null) {
    const primary = (next.assignees ?? []).find((a) => a.isPrimary ?? a.is_primary);
    if (primary) next.assigneePersonId = primary.personId ?? primary.person_id ?? primary.person?.id ?? null;
  }
  return next;
}

function normalizeTaskDetail(raw: TaskDetailResponse): TaskDetailResponse {
  const response = {
    ...raw,
    task: normalizeTask({
      ...(raw.task as WireTask),
      ...(raw.assignees && !raw.task.assignees ? { assignees: raw.assignees } : {}),
    }),
  };
  const context = raw.projectContext ?? raw.project_context ?? raw.context;
  const topLevelSources = raw.sources;
  const topLevelDocuments = raw.documents ?? raw.knowledge_docs;
  if (context || topLevelSources || topLevelDocuments || raw.project) {
    const sourceContext = context ?? {};
    response.projectContext = {
      ...sourceContext,
      project: sourceContext.project ?? raw.project ?? null,
      sources: sourceContext.sources ?? sourceContext.project_sources ?? topLevelSources ?? [],
      documents: sourceContext.documents ?? sourceContext.knowledge_docs ?? topLevelDocuments ?? [],
    };
  }
  return response;
}

interface WireToolCatalogEntry {
  name: string;
  description: string;
  read_only: boolean;
  external_effect: boolean;
  requires_approval: boolean;
}

function normalizeToolCatalogEntry(entry: WireToolCatalogEntry): ToolCatalogEntry {
  return {
    name: entry.name,
    description: entry.description,
    readOnly: entry.read_only,
    externalEffect: entry.external_effect,
    requiresApproval: entry.requires_approval,
  };
}

/** Hook para 401: la shell lo usa para volver al login. */
export let onUnauthorized: (() => void) | null = null;
export function setOnUnauthorized(fn: (() => void) | null): void {
  onUnauthorized = fn;
}

async function request<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (currentToken) headers["authorization"] = `Bearer ${currentToken}`;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method: init.method ?? "GET",
      headers,
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
  } catch {
    throw new ApiError("network_error", "No se pudo conectar con la API (¿apps/api corriendo en 4300?)", 0);
  }
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    /* respuesta sin cuerpo */
  }
  if (!res.ok) {
    const err = (json as { error?: { code?: string; message?: string; details?: unknown } })?.error;
    if (res.status === 401 && onUnauthorized) onUnauthorized();
    throw new ApiError(
      err?.code ?? "http_error",
      err?.message ?? `Error HTTP ${res.status}`,
      res.status,
      err?.details,
    );
  }
  return json as T;
}

// ── Auth ────────────────────────────────────────────────────────────────────

export const api = {
  people: () => request<{ people: Person[] }>("/api/auth/people"),
  login: (password: string, personId: string) =>
    request<{ token: string; person: Person }>("/api/auth/login", {
      method: "POST",
      body: { password, person_id: personId },
    }),
  /** Modo pruebas (sandbox): entrada sin contraseña, misma forma que login(). */
  sandboxLogin: (personId: string) =>
    request<{ token: string; person: Person }>("/api/auth/sandbox-login", {
      method: "POST",
      body: { person_id: personId },
    }),
  health: () =>
    request<{
      ok: boolean;
      sandbox: boolean;
      kill_switch: boolean;
      counts: Record<string, number>;
    }>("/api/health"),
  brainOverview: () => request<BrainOverview>("/api/brain/overview"),

  // ── Projects / board ──────────────────────────────────────────────────────
  projects: () => request<{ projects: Project[] }>("/api/projects"),
  /** Personas asignables a un proyecto (las de su organización). */
  projectPeople: (projectId: string) =>
    request<{ org_id: string; people: Person[] }>(`/api/projects/${projectId}/people`),
  board: (projectId: string) =>
    request<{
      project: Project;
      board_seq: number;
      total: number;
      columns: Partial<Record<TaskStatus, Task[]>>;
      cells: Record<string, Partial<Record<TaskStatus, Task[]>>>;
    }>(`/api/board/${projectId}`),
  gate: (projectId: string, decision: "approve" | "reject", note?: string) =>
    request<{ project: Project }>(`/api/projects/${projectId}/gate`, {
      method: "POST",
      body: { decision, ...(note ? { note } : {}) },
    }),

  // ── Tasks ─────────────────────────────────────────────────────────────────
  tasks: async (q: {
    project_id?: string;
    status?: TaskStatus;
    assignee_person_id?: string;
    assignee_agent_id?: string;
    label?: string;
    /** "1" pide las tareas de la persona de la sesión sin conocer su id. */
    mine?: "1";
  } = {}) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(q)) {
      if (value !== undefined && value !== "") params.set(key, String(value));
    }
    const query = params.toString();
    const result = await request<{ tasks: Task[] }>(`/api/tasks${query ? `?${query}` : ""}`);
    return { ...result, tasks: result.tasks.map((task) => normalizeTask(task as WireTask)) };
  },
  task: (id: string) =>
    request<TaskDetailResponse>(`/api/tasks/${id}`).then(normalizeTaskDetail),
  moveTask: (
    id: string,
    body: { to: TaskStatus; expected_version: number; note?: string; blocked_reason?: string },
  ) => request<{ task: Task }>(`/api/tasks/${id}/move`, { method: "POST", body }),
  /**
   * Cambio de proyecto. El backend valida destino, responsables de otro
   * cliente y padre/dependencias, recalcula `orderKey` y publica
   * `task.moved_project` en `board:<viejo>` y `board:<nuevo>`.
   */
  moveTaskProject: (id: string, body: { project_id: string; expected_version: number }) =>
    request<{ task: Task; assignees?: TaskAssignee[] }>(`/api/tasks/${id}/project`, {
      method: "POST",
      body,
    }).then((result) => ({
      ...result,
      task: normalizeTask({
        ...(result.task as WireTask),
        ...(result.assignees && !result.task.assignees ? { assignees: result.assignees } : {}),
      }),
    })),
  commentTask: (id: string, body: string) =>
    request<{ event: TaskEvent }>(`/api/tasks/${id}/comment`, { method: "POST", body: { body } }),
  approveTask: (id: string, expectedVersion: number, note?: string) =>
    request<{ task: Task }>(`/api/tasks/${id}/approve`, {
      method: "POST",
      body: { expected_version: expectedVersion, ...(note ? { note } : {}) },
    }),
  rejectTask: (id: string, expectedVersion: number, note: string) =>
    request<{ task: Task }>(`/api/tasks/${id}/reject`, {
      method: "POST",
      body: { expected_version: expectedVersion, note },
    }),
  updateTask: (
    id: string,
    body: {
      expected_version: number;
      title?: string;
      description?: string | null;
      definition_of_done?: string | null;
      activity_type?: string | null;
      priority?: Task["priority"];
      due_at?: number | null;
    },
  ) =>
    request<{ task: Task; assignees?: TaskAssignee[] }>(`/api/tasks/${id}`, {
      method: "PATCH",
      body,
    }).then((result) => ({
      ...result,
      task: normalizeTask({
        ...(result.task as WireTask),
        ...(result.assignees && !result.task.assignees ? { assignees: result.assignees } : {}),
      }),
    })),
  assignTask: (
    id: string,
    body: {
      expected_version: number;
      assignee_person_ids: string[];
      primary_assignee_person_id?: string | null;
      /** Optional: kept separate from people; the UI does not edit it. */
      agent_slug?: string | null;
    },
  ) =>
    request<{ task: Task; assignees?: TaskAssignee[] }>(`/api/tasks/${id}/assign`, {
      method: "POST",
      body,
    }).then((result) => ({
      ...result,
      task: normalizeTask({
        ...(result.task as WireTask),
        ...(result.assignees && !result.task.assignees ? { assignees: result.assignees } : {}),
      }),
    })),
  createTask: async (body: {
    project_id: string;
    title: string;
    stage: Stage;
    description?: string;
    definition_of_done?: string;
    priority?: TaskPriority;
    assignee_agent_slug?: string;
    assignee_person_ids?: string[];
    primary_assignee_person_id?: string | null;
    due_at?: number | null;
    labels?: string[];
  }) => {
    const result = await request<{ task: Task }>("/api/tasks", { method: "POST", body });
    return { ...result, task: normalizeTask(result.task as WireTask) };
  },

  // ── Etiquetas ─────────────────────────────────────────────────────────────
  /** Reemplazo completo; no consume expected_version (clasificar no es transición). */
  setTaskLabels: async (id: string, labels: string[]) => {
    const result = await request<{ task: Task; labels: string[] }>(`/api/tasks/${id}/labels`, {
      method: "PUT",
      body: { labels },
    });
    return { ...result, task: normalizeTask(result.task as WireTask) };
  },
  labels: (projectId?: string) =>
    request<{ labels: LabelUsage[] }>(
      `/api/labels${projectId ? `?project_id=${encodeURIComponent(projectId)}` : ""}`,
    ),

  // ── Búsqueda de tareas ────────────────────────────────────────────────────
  searchTasks: (q: string, opts: { projectId?: string; mine?: boolean; limit?: number } = {}) => {
    const params = new URLSearchParams({ q });
    if (opts.projectId) params.set("project_id", opts.projectId);
    if (opts.mine) params.set("mine", "1");
    if (opts.limit) params.set("limit", String(opts.limit));
    return request<{ query: string; hits: TaskSearchHit[] }>(`/api/tasks/search?${params.toString()}`);
  },

  // ── Artefactos ────────────────────────────────────────────────────────────
  /** Artefacto por enlace o texto: no sube binario, sólo referencia. */
  attachArtifact: (
    id: string,
    body: { kind: string; title: string; content?: string },
  ) => request<{ artifact: Artifact }>(`/api/tasks/${id}/artifacts`, { method: "POST", body }),
  /**
   * Subida real de archivo. Va por fetch directo y no por `request`: el cuerpo
   * es FormData y el navegador debe poner él mismo el boundary del multipart.
   */
  uploadArtifact: async (id: string, file: File, title?: string) => {
    const form = new FormData();
    if (title && title.trim()) form.append("title", title.trim());
    form.append("file", file, file.name);
    const headers: Record<string, string> = {};
    if (currentToken) headers["authorization"] = `Bearer ${currentToken}`;
    let res: Response;
    try {
      res = await fetch(`${API_BASE}/api/tasks/${id}/artifacts/upload`, {
        method: "POST",
        headers,
        body: form,
      });
    } catch {
      throw new ApiError("network_error", "No se pudo subir el archivo (¿la API está viva?)", 0);
    }
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      /* respuesta sin cuerpo */
    }
    if (!res.ok) {
      const err = (json as { error?: { code?: string; message?: string } })?.error;
      if (res.status === 401 && onUnauthorized) onUnauthorized();
      throw new ApiError(
        err?.code ?? "http_error",
        err?.message ?? `Error HTTP ${res.status}`,
        res.status,
      );
    }
    return json as { artifact: Artifact };
  },

  // ── Imágenes en texto largo ───────────────────────────────────────────────
  /**
   * Sube una imagen para incrustarla en una descripción. Como `uploadArtifact`,
   * va por `fetch` directo: el cuerpo es FormData y el boundary lo pone el
   * navegador.
   *
   * `url` vuelve del servidor como ruta (`/api/uploads/<id>`); aquí se
   * absolutiza contra `API_BASE` porque en desarrollo la web (4301) y la API
   * (4300) son orígenes distintos y un `<img src="/api/uploads/…">` apuntaría
   * al puerto de Vite. La cookie de sesión es SameSite=Lax y ambos puertos son
   * el mismo sitio, así que la imagen se sirve igual.
   */
  uploadImage: async (file: File) => {
    const form = new FormData();
    form.append("file", file, file.name);
    const headers: Record<string, string> = {};
    if (currentToken) headers["authorization"] = `Bearer ${currentToken}`;
    let res: Response;
    try {
      res = await fetch(`${API_BASE}/api/uploads/images`, {
        method: "POST",
        headers,
        body: form,
        credentials: "include",
      });
    } catch {
      throw new ApiError("network_error", "No se pudo subir la imagen (¿la API está viva?)", 0);
    }
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      /* respuesta sin cuerpo */
    }
    if (!res.ok) {
      const err = (json as { error?: { code?: string; message?: string } })?.error;
      if (res.status === 401 && onUnauthorized) onUnauthorized();
      throw new ApiError(
        err?.code ?? "http_error",
        err?.message ?? `Error HTTP ${res.status}`,
        res.status,
      );
    }
    const raw = json as UploadedImage;
    return { ...raw, url: raw.url?.startsWith("/") ? `${API_BASE}${raw.url}` : raw.url };
  },

  // ── Asistencia de IA sobre un campo de la tarea ───────────────────────────
  /**
   * Redacta (o mejora) un campo consultando el contexto del cliente, o devuelve
   * el prompt de ejecución para pegar en Claude Code. 503 llega como
   * `ApiError("provider_unavailable")`: el asistente no está disponible, la
   * tarea sí.
   */
  taskAssist: (body: TaskAssistRequest) =>
    request<TaskAssistResponse>("/api/ai/task-assist", { method: "POST", body }),

  // ── Runs ──────────────────────────────────────────────────────────────────
  runs: (q: { status?: string; agent_id?: string; task_id?: string; project_id?: string; limit?: number } = {}) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined) params.set(k, String(v));
    const qs = params.toString();
    return request<{ runs: Run[] }>(`/api/runs${qs ? `?${qs}` : ""}`);
  },
  run: (id: string) =>
    request<{ run: Run; spans: Span[]; tree: Run[]; last_seq: number }>(`/api/runs/${id}`),
  cancelRun: (id: string) => request<{ run: Run }>(`/api/runs/${id}/cancel`, { method: "POST" }),

  // ── Approvals / bandeja ───────────────────────────────────────────────────
  /** Bandeja completa (CA-4.2, H10): aprobaciones + entregables en REVIEW con artefactos. */
  waiting: () =>
    request<{ approvals: Approval[]; review_tasks: { task: Task; artifacts: Artifact[] }[] }>(
      "/api/waiting",
    ),
  decideApproval: (id: string, decision: "approved" | "rejected", note?: string) =>
    request<{ approval: Approval; executed: unknown; resume_run_id: string | null }>(
      `/api/approvals/${id}/decide`,
      { method: "POST", body: { decision, ...(note ? { note } : {}) } },
    ),

  // ── Chat (canal web) ──────────────────────────────────────────────────────
  threads: (channel = "web") => request<{ threads: Thread[] }>(`/api/threads?channel=${channel}`),
  thread: (id: string) => request<{ thread: Thread; last_seq: number }>(`/api/threads/${id}`),
  messages: (threadId: string) =>
    request<{ messages: Message[] }>(`/api/threads/${threadId}/messages`),
  sendChat: (body: {
    external_user_id: string;
    external_chat_id: string;
    message_id: string;
    text: string;
    thread_hint?: string;
    project_id?: string;
  }) =>
    request<{
      deduped: boolean;
      thread_id: string;
      message_id: string;
      run_id: string | null;
      warning?: string;
    }>("/v1/channels/web/events", { method: "POST", body }),

  // ── Agents / admin ────────────────────────────────────────────────────────
  agents: () => request<{ agents: Agent[] }>("/api/agents"),
  setAgentStatus: (id: string, status: string, expectedVersion: number, reason?: string) =>
    request<{ agent: Agent }>(`/api/agents/${id}/status`, {
      method: "POST",
      body: { status, expected_version: expectedVersion, ...(reason ? { reason } : {}) },
    }),
  updateAgent: (id: string, body: { expected_version: number; model?: string | null }) =>
    request<{ agent: Agent }>(`/api/agents/${id}`, { method: "PATCH", body }),
  config: () => request<{ config: AppConfigRow[] }>("/api/config"),
  killSwitch: () => request<{ active: boolean }>("/api/config/kill-switch"),
  pauseAll: (reason?: string) =>
    request<{ active: boolean }>("/api/config/pause-all", { method: "POST", body: { ...(reason ? { reason } : {}) } }),
  resumeAll: (reason?: string) =>
    request<{ active: boolean }>("/api/config/resume-all", { method: "POST", body: { ...(reason ? { reason } : {}) } }),

  // ── Contexto (§8b) ────────────────────────────────────────────────────────
  knowledge: (q: { org_id?: string; project_id?: string; kind?: string } = {}) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v) params.set(k, v);
    const qs = params.toString();
    return request<{ docs: KnowledgeDoc[] }>(`/api/knowledge${qs ? `?${qs}` : ""}`);
  },
  knowledgeSearch: (query: string, limit = 20) =>
    request<{ hits: KnowledgeDoc[] }>(
      `/api/knowledge/search?q=${encodeURIComponent(query)}&limit=${limit}`,
    ),
  processes: (orgId?: string) =>
    request<{ processes: ProcessEntity[] }>(`/api/processes${orgId ? `?org_id=${orgId}` : ""}`),
  createProcess: (
    orgId: string,
    body: {
      name: string;
      variant?: "as_is" | "to_be";
      owner_person?: string | null;
      steps?: ProcessStep[];
      systems?: string[];
      pain_points?: string[];
      iso_refs?: string[];
    },
  ) => request<{ process: ProcessEntity }>(`/api/orgs/${orgId}/processes`, { method: "POST", body }),
  updateProcess: (
    id: string,
    body: {
      name?: string;
      variant?: "as_is" | "to_be";
      owner_person?: string | null;
      steps?: ProcessStep[];
      systems?: string[];
      pain_points?: string[];
      iso_refs?: string[];
      status?: "draft" | "validated";
    },
  ) => request<{ process: ProcessEntity }>(`/api/processes/${id}`, { method: "PATCH", body }),
  deleteProcess: (id: string) => request<{ ok: boolean }>(`/api/processes/${id}`, { method: "DELETE" }),
  methodologies: () => request<{ methodologies: Methodology[] }>("/api/methodologies"),

  // ── Módulos de Fase (M4 — wizard "Nuevo proyecto") ────────────────────────
  modules: () => request<{ modules: ModuleSummary[] }>("/api/modules"),
  module: (slug: string) => request<{ module: ModuleDetail }>(`/api/modules/${slug}`),
  /** Dry-run CA-M2.1: con inputs incompletos responde 200 {ok:false, missing, issues}. */
  previewModule: (
    slug: string,
    body: {
      inputs: Record<string, unknown>;
      toggles?: Record<string, boolean>;
      /** Cadencias que el humano confirmó en el wizard (CA-M3.4 — M6a). */
      cadences_confirmed?: string[];
    },
  ) => request<PreviewResult>(`/api/modules/${slug}/preview`, { method: "POST", body }),
  launchModule: (
    slug: string,
    body: {
      inputs: Record<string, unknown>;
      toggles?: Record<string, boolean>;
      /** Cadencias que el humano confirmó en el wizard (CA-M3.4 — M6a). */
      cadences_confirmed?: string[];
      idempotency_key: string;
      previous_launch_id?: string;
    },
  ) => request<LaunchResponse>(`/api/modules/${slug}/launch`, { method: "POST", body }),
  projectLaunches: (projectId: string) =>
    request<{ launches: LaunchReceipt[] }>(`/api/projects/${projectId}/launches`),
  phaseStatus: (projectId: string) =>
    request<{ status: PhaseClosureStatus }>(`/api/projects/${projectId}/phase-status`),

  // ── Fuentes del proyecto (Fase 2) ─────────────────────────────────────────
  projectSources: (projectId: string) =>
    request<{ sources: ProjectSource[] }>(`/api/projects/${projectId}/sources`),
  linkProjectSource: (projectId: string, kind: ProjectSourceKind, externalRef: ProjectSourceExternalRef) =>
    request<{ source: ProjectSource; deduped: boolean }>(`/api/projects/${projectId}/sources`, {
      method: "POST",
      body: { kind, external_ref: externalRef },
    }),
  ingestSource: (sourceId: string) =>
    request<{ source: ProjectSource; doc: KnowledgeDoc }>(`/api/sources/${sourceId}/ingest`, {
      method: "POST",
    }),
  browseSources: (kind: ProjectSourceKind, q = "", page = 1) => {
    const params = new URLSearchParams({ kind, page: String(page) });
    if (q.trim()) params.set("q", q.trim());
    return request<{
      items: SourceBrowseItem[];
      page: number;
      page_size: number;
      total: number | null;
      has_more: boolean;
    }>(`/api/sources/browse?${params.toString()}`);
  },
  meetingProcessing: (status: MeetingProcessingFilter = "all", page = 1) => {
    const params = new URLSearchParams({ status, page: String(page) });
    return request<MeetingProcessingOverview>(`/api/meetings/processing?${params.toString()}`);
  },

  // ── Notas manuscritas (lienzo Excalidraw) ─────────────────────────────────
  notes: (projectId?: string) =>
    request<{ notes: CanvasNote[] }>(
      `/api/notes${projectId ? `?project_id=${encodeURIComponent(projectId)}` : ""}`,
    ),
  note: (id: string) => request<{ note: CanvasNote }>(`/api/notes/${id}`),
  createNote: (body: { title?: string; project_id?: string } = {}) =>
    request<{ note: CanvasNote }>("/api/notes", { method: "POST", body }),
  /** Autoguardado: `expected_version` convierte la carrera en 409, no en pérdida. */
  saveNote: (
    id: string,
    body: {
      title?: string;
      scene?: CanvasScene;
      transcription?: string;
      expected_version?: number;
    },
  ) => request<{ note: CanvasNote }>(`/api/notes/${id}`, { method: "PATCH", body }),
  /** El PNG ya exportado por el lienzo, en base64. `keep_status` = captura intermedia (no cambia el estado). */
  captureNote: (
    id: string,
    body: { image_base64: string; task_id?: string; keep_status?: boolean },
  ) => request<{ note: CanvasNote }>(`/api/notes/${id}/capture`, { method: "POST", body }),
  /** Pasa el PNG por el modelo de visión; 502 provider_unavailable si el proveedor falla. */
  transcribeNote: (id: string, body: { mode: NoteTranscribeMode }) =>
    request<NoteTranscribeResponse>(`/api/notes/${id}/transcribe`, { method: "POST", body }),
  noteImageUrl: (id: string) => `${API_BASE}/api/notes/${id}/image`,
  /** Fase 3: PROPONE tareas desde la transcripción y las guarda en la nota. No crea ninguna. */
  proposeNoteTasks: (id: string) =>
    request<{ note: CanvasNote }>(`/api/notes/${id}/propose`, { method: "POST" }),
  /** Guarda la lista revisada por el humano; `expected_version` → 409 si otra pestaña la cambió. */
  saveNoteProposals: (id: string, body: { proposals: NoteTaskProposal[]; expected_version: number }) =>
    request<{ note: CanvasNote }>(`/api/notes/${id}/proposals`, { method: "PATCH", body }),
  /** La ÚNICA orden que crea tareas: las incluidas y aún sin `created_task_id`. */
  commitNoteTasks: (id: string, body: { expected_version: number }) =>
    request<{ note: CanvasNote; tasks: { proposalId: string; taskId: string }[] }>(
      `/api/notes/${id}/commit-tasks`,
      { method: "POST", body },
    ),
  // ── Organigrama ────────────────────────────────────────────────────────────
  orgGraph: (orgId: string) => request<OrgGraph>(`/api/orgs/${orgId}/graph`),
  createOrgUnit: (
    orgId: string,
    body: { name: string; parent_unit_id?: string | null; description?: string | null },
  ) => request<{ unit: OrgUnit }>(`/api/orgs/${orgId}/units`, { method: "POST", body }),
  updateOrgUnit: (
    id: string,
    body: { name?: string; parent_unit_id?: string | null; description?: string | null },
  ) => request<{ unit: OrgUnit }>(`/api/units/${id}`, { method: "PATCH", body }),
  deleteOrgUnit: (id: string) => request<{ ok: boolean }>(`/api/units/${id}`, { method: "DELETE" }),
  createOrgRole: (
    orgId: string,
    body: {
      name: string;
      unit_id?: string | null;
      purpose?: string | null;
      reports_to_role_id?: string | null;
      canvas_x?: number;
      canvas_y?: number;
    },
  ) => request<{ role: OrgRoleFull }>(`/api/orgs/${orgId}/roles`, { method: "POST", body }),
  updateOrgRole: (
    id: string,
    body: {
      name?: string;
      unit_id?: string | null;
      purpose?: string | null;
      reports_to_role_id?: string | null;
      canvas_x?: number;
      canvas_y?: number;
      status?: "draft" | "validated";
      expected_version?: number;
    },
  ) => request<{ role: OrgRoleFull }>(`/api/roles/${id}`, { method: "PATCH", body }),
  deleteOrgRole: (id: string) => request<{ ok: boolean }>(`/api/roles/${id}`, { method: "DELETE" }),
  replaceRoleFunctions: (
    id: string,
    functions: { id?: string; name: string; description?: string | null }[],
  ) => request<{ functions: RoleFunction[] }>(`/api/roles/${id}/functions`, { method: "PUT", body: { functions } }),
  replaceRolePeople: (id: string, people: { person_id: string; dedication_pct?: number | null }[]) =>
    request<{ people: OrgRolePerson[] }>(`/api/roles/${id}/people`, { method: "PUT", body: { people } }),
  replaceRoleProcesses: (
    id: string,
    processes: { process_id: string; relation: "owner" | "participant" }[],
  ) =>
    request<{ processes: OrgRoleProcessLink[] }>(`/api/roles/${id}/processes`, {
      method: "PUT",
      body: { processes },
    }),

  // ── Convertir un rol en agente ────────────────────────────────────────────
  toolCatalog: async () => {
    const { tools } = await request<{ tools: WireToolCatalogEntry[] }>("/api/tools/catalog");
    return { tools: tools.map(normalizeToolCatalogEntry) };
  },
  convertRoleToAgent: (
    roleId: string,
    body: {
      function_ids: string[];
      autonomy: "manual" | "supervised";
      activate: boolean;
      tools_allowlist: string[];
      name?: string;
    },
  ) => request<ConvertRoleToAgentResponse>(`/api/roles/${roleId}/agent`, { method: "POST", body }),
};

export type Api = typeof api;
