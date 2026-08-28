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
  KnowledgeDoc,
  Message,
  Methodology,
  Person,
  ProcessEntity,
  Project,
  Run,
  Span,
  Stage,
  Task,
  TaskEvent,
  TaskStatus,
  Thread,
} from "./types";

export const API_BASE: string =
  (typeof import.meta !== "undefined" && import.meta.env?.VITE_AGENTOS_API_URL) ||
  "http://localhost:4300";

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
  request,

  people: () => request<{ people: Person[] }>("/api/auth/people"),
  login: (password: string, personId: string) =>
    request<{ token: string; person: Person }>("/api/auth/login", {
      method: "POST",
      body: { password, person_id: personId },
    }),
  logout: () => request<{ ok: boolean }>("/api/auth/logout", { method: "POST" }),
  health: () =>
    request<{
      ok: boolean;
      kill_switch: boolean;
      counts: Record<string, number>;
    }>("/api/health"),

  // ── Projects / board ──────────────────────────────────────────────────────
  projects: () => request<{ projects: Project[] }>("/api/projects"),
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
  task: (id: string) =>
    request<{ task: Task; events: TaskEvent[]; artifacts: Artifact[]; runs: Run[] }>(
      `/api/tasks/${id}`,
    ),
  moveTask: (
    id: string,
    body: { to: TaskStatus; expected_version: number; note?: string; blocked_reason?: string },
  ) => request<{ task: Task }>(`/api/tasks/${id}/move`, { method: "POST", body }),
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
  createTask: (body: {
    project_id: string;
    title: string;
    stage: Stage;
    description?: string;
    definition_of_done?: string;
    assignee_agent_slug?: string;
  }) => request<{ task: Task }>("/api/tasks", { method: "POST", body }),

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

  // ── Approvals ─────────────────────────────────────────────────────────────
  approvalsPending: () => request<{ approvals: Approval[] }>("/api/approvals/pending"),
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
  knowledgeDoc: (id: string) => request<{ doc: KnowledgeDoc }>(`/api/knowledge/${id}`),
  processes: (orgId?: string) =>
    request<{ processes: ProcessEntity[] }>(`/api/processes${orgId ? `?org_id=${orgId}` : ""}`),
  process: (id: string) => request<{ process: ProcessEntity }>(`/api/processes/${id}`),
  methodologies: () => request<{ methodologies: Methodology[] }>("/api/methodologies"),
  methodology: (slug: string) =>
    request<{ methodology: Methodology }>(`/api/methodologies/${slug}`),
};

export type Api = typeof api;
