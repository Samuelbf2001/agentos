/**
 * Utilidades de test: mock de fetch por rutas (sin msw: un router en memoria
 * es determinista y no añade dependencias) + fixtures de dominio.
 */
import { vi } from "vitest";
import type {
  Agent,
  Approval,
  Message,
  Person,
  Project,
  Run,
  Task,
  Thread,
  TopicEvent,
} from "../src/lib/types";

export interface MockRoute {
  method?: string;
  /** Path exacto ("/api/tasks/t1/move") o RegExp. */
  path: string | RegExp;
  status?: number;
  body: unknown | ((init: { method: string; body: unknown; url: string }) => unknown);
  /** Si se define, fuerza el status por llamada. */
  statusFn?: (init: { method: string; body: unknown; url: string }) => number;
}

export interface FetchCall {
  url: string;
  method: string;
  body: unknown;
}

export function mockFetch(routes: MockRoute[]): { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const path = url.replace(/^https?:\/\/[^/]+/, "").split("?")[0] ?? "";
      const method = (init?.method ?? "GET").toUpperCase();
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method, body });
      for (const route of routes) {
        const matches =
          typeof route.path === "string" ? route.path === path : route.path.test(path);
        if (!matches) continue;
        if (route.method && route.method.toUpperCase() !== method) continue;
        const payload =
          typeof route.body === "function"
            ? (route.body as (i: { method: string; body: unknown; url: string }) => unknown)({
                method,
                body,
                url,
              })
            : route.body;
        const status = route.statusFn?.({ method, body, url }) ?? route.status ?? 200;
        return new Response(JSON.stringify(payload), {
          status,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({ error: { code: "not_found", message: `sin mock para ${method} ${path}` } }),
        { status: 404, headers: { "content-type": "application/json" } },
      );
    }),
  );
  return { calls };
}

// ── Fixtures ────────────────────────────────────────────────────────────────

export const person: Person = { id: "p-ernesto", full_name: "Ernesto", role: "Operador" };

export const project: Project = {
  id: "proj-1",
  orgId: "org-1",
  name: "ACME assessment",
  type: "assessment",
  stage: "ENTENDER",
  gateState: "pending",
  workspacePath: null,
  version: 1,
  createdAt: 1000,
  updatedAt: 1000,
};

export function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    projectId: "proj-1",
    parentTaskId: null,
    title: "Mapear proceso de ventas",
    description: "Entrevistar al equipo",
    definitionOfDone: "Mapa SIPOC validado",
    stage: "ENTENDER",
    status: "READY",
    activityType: null,
    priority: "normal",
    assigneeAgentId: "a-sam",
    assigneePersonId: null,
    requiresApproval: false,
    externalEffect: false,
    leaseUntil: null,
    attempts: 0,
    blockedReason: null,
    orderKey: "a0",
    version: 3,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

export const agents: Agent[] = [
  {
    id: "a-alex",
    slug: "alex",
    name: "Alex",
    layer: "consultoria",
    runtime: "ai_sdk",
    providerProfileId: null,
    model: "claude-sonnet-4-5",
    activePromptVersionId: null,
    toolsAllowlist: [],
    mcpAllowlist: [],
    limits: null,
    autonomy: "supervised",
    status: "active",
    version: 1,
  },
  {
    id: "a-sam",
    slug: "sam",
    name: "Sam",
    layer: "consultoria",
    runtime: "ai_sdk",
    providerProfileId: null,
    model: null,
    activePromptVersionId: null,
    toolsAllowlist: [],
    mcpAllowlist: [],
    limits: null,
    autonomy: "supervised",
    status: "active",
    version: 1,
  },
];

export function makeApproval(overrides: Partial<Approval> = {}): Approval {
  return {
    id: "ap-1",
    kind: "tool_call",
    runId: "r1",
    taskId: "t1",
    projectId: "proj-1",
    payload: { tool: "email.send", args: { to: "cliente@acme.com" } },
    actionDigest: "digest-1",
    status: "pending",
    requestedBy: "agent:sally",
    decidedByPersonId: null,
    decidedAt: null,
    note: null,
    createdAt: Date.now() - 60_000,
    ...overrides,
  };
}

export function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: "r1",
    parentRunId: null,
    rootRunId: "r1",
    agentId: "a-alex",
    taskId: null,
    projectId: "proj-1",
    trigger: "chat",
    runtime: "ai_sdk",
    providerProfileId: null,
    model: "claude-sonnet-4-5",
    status: "succeeded",
    tokensIn: 1200,
    tokensOut: 480,
    tokensCacheRead: null,
    tokensCacheWrite: null,
    costUsd: 0.0123,
    error: null,
    resumeOfRunId: null,
    replayOfRunId: null,
    startedAt: 1000,
    finishedAt: 2000,
    createdAt: 900,
  };
}

export const thread: Thread = {
  id: "th-1",
  channel: "web",
  sessionKey: "web:p-ernesto:main",
  projectId: "proj-1",
  agentId: null,
  title: null,
  createdAt: 1000,
  updatedAt: 1000,
};

export function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "m1",
    threadId: "th-1",
    role: "user",
    content: "Arranca un assessment para ACME",
    idempotencyKey: null,
    runId: null,
    actor: "person:p-ernesto",
    meta: null,
    createdAt: 1000,
    ...overrides,
  };
}

/** Sobre WS crudo para el reductor. */
export function topicEvent(
  topic: string,
  seq: number,
  type: string,
  payload: Record<string, unknown>,
  runId: string | null = null,
): TopicEvent {
  return { topic, seq, type, payload, runId, createdAt: 1_700_000_000_000 + seq };
}

/** Evento de dominio como lo publica busSink: payload = {type, timestamp, payload}. */
export function domainEvent(
  topic: string,
  seq: number,
  type: string,
  inner: Record<string, unknown>,
  runId: string | null = null,
): TopicEvent {
  return topicEvent(topic, seq, type, { type, timestamp: 1, payload: inner }, runId);
}
