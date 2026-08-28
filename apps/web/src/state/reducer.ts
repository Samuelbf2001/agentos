/**
 * Reductor ÚNICO de eventos (spec B5 §1): eventos AG-UI + eventos de dominio
 * del WS → estado de la UI. Función pura y testeable: devuelve el estado nuevo
 * y una lista de efectos (refetches REST) que el store ejecuta — porque el WS
 * es optimización y el snapshot REST es la fuente de verdad.
 */
import type { Message, Task, TopicEvent } from "../lib/types";
import { domainPayload } from "../lib/types";

export interface StreamBuf {
  text: string;
  done: boolean;
  runId: string | null;
}

export interface ToolCallChip {
  id: string;
  name: string;
  args: string;
  result: string | null;
  isError: boolean;
  done: boolean;
  synthetic: boolean;
}

export type AgentPhase = "esperando_turno" | "pensando" | "usando_tool" | null;

export interface RunLive {
  runId: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  agentId: string | null;
  taskId: string | null;
  phase: AgentPhase;
  currentTool: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
  error: string | null;
}

export interface SwarmEdge {
  id: string;
  /** slug del agente que delega. */
  from: string;
  /** slug del agente asignado. */
  to: string;
  taskId: string;
  at: number;
}

export interface CreatedTaskRef {
  taskId: string;
  runId: string | null;
  at: number;
}

export interface EventState {
  chat: {
    threadId: string | null;
    messages: Message[];
    streams: Record<string, StreamBuf>;
  };
  /** Tool calls por runId (chips del chat y del replay). */
  toolCalls: Record<string, ToolCallChip[]>;
  createdTasks: CreatedTaskRef[];
  board: {
    projectId: string | null;
    tasks: Record<string, Task>;
  };
  runsLive: Record<string, RunLive>;
  edges: SwarmEdge[];
  killSwitch: boolean;
  /** slug → status del agente (eventos agent.status del topic swarm). */
  agentStatus: Record<string, string>;
}

export type Effect =
  | { kind: "refetch_task"; taskId: string }
  | { kind: "refetch_approvals" }
  | { kind: "refetch_projects" }
  | { kind: "watch_run"; runId: string };

export function emptyEventState(): EventState {
  return {
    chat: { threadId: null, messages: [], streams: {} },
    toolCalls: {},
    createdTasks: [],
    board: { projectId: null, tasks: {} },
    runsLive: {},
    edges: [],
    killSwitch: false,
    agentStatus: {},
  };
}

const stripActor = (actor: unknown): string =>
  typeof actor === "string" ? actor.replace(/^(agent|person|system):/, "") : "";

function upsertRun(state: EventState, runId: string, patch: Partial<RunLive>): EventState {
  const prev: RunLive = state.runsLive[runId] ?? {
    runId,
    status: "queued",
    agentId: null,
    taskId: null,
    phase: null,
    currentTool: null,
    tokensIn: null,
    tokensOut: null,
    costUsd: null,
    error: null,
  };
  return {
    ...state,
    runsLive: { ...state.runsLive, [runId]: { ...prev, ...patch } },
  };
}

function patchChip(
  state: EventState,
  runId: string,
  toolCallId: string,
  patch: Partial<ToolCallChip>,
  createName?: string,
): EventState {
  const list = state.toolCalls[runId] ?? [];
  const idx = list.findIndex((c) => c.id === toolCallId);
  let next: ToolCallChip[];
  if (idx === -1) {
    next = [
      ...list,
      {
        id: toolCallId,
        name: createName ?? "tool",
        args: "",
        result: null,
        isError: false,
        done: false,
        synthetic: false,
        ...patch,
      },
    ];
  } else {
    const current = list[idx]!;
    next = [...list];
    next[idx] = { ...current, ...patch, ...(patch.args !== undefined ? {} : {}) };
  }
  return { ...state, toolCalls: { ...state.toolCalls, [runId]: next } };
}

function appendChipArgs(state: EventState, runId: string, toolCallId: string, delta: string): EventState {
  const list = state.toolCalls[runId] ?? [];
  const idx = list.findIndex((c) => c.id === toolCallId);
  if (idx === -1) return patchChip(state, runId, toolCallId, { args: delta });
  const next = [...list];
  next[idx] = { ...next[idx]!, args: next[idx]!.args + delta };
  return { ...state, toolCalls: { ...state.toolCalls, [runId]: next } };
}

/** Aplica un evento del WS. Devuelve estado nuevo + efectos (refetches REST). */
export function reduceEvent(
  state: EventState,
  ev: TopicEvent,
): { state: EventState; effects: Effect[] } {
  const effects: Effect[] = [];
  let next = state;

  // ── Topic del hilo de chat ────────────────────────────────────────────────
  if (state.chat.threadId && ev.topic === `thread:${state.chat.threadId}`) {
    next = reduceThreadEvent(next, ev);
  }

  // ── Topic del tablero ─────────────────────────────────────────────────────
  if (ev.topic.startsWith("board:")) {
    const p = domainPayload(ev);
    const taskId = typeof p.taskId === "string" ? p.taskId : null;
    switch (ev.type) {
      case "task.created": {
        if (taskId) {
          next = {
            ...next,
            createdTasks: [
              ...next.createdTasks.slice(-49),
              { taskId, runId: ev.runId, at: ev.createdAt },
            ],
          };
          effects.push({ kind: "refetch_task", taskId });
        }
        break;
      }
      case "task.moved": {
        if (taskId) {
          const existing = next.board.tasks[taskId];
          if (existing && typeof p.to === "string") {
            next = {
              ...next,
              board: {
                ...next.board,
                tasks: {
                  ...next.board.tasks,
                  [taskId]: { ...existing, status: p.to as Task["status"] },
                },
              },
            };
          }
          effects.push({ kind: "refetch_task", taskId });
        }
        break;
      }
      case "task.reaped": {
        if (taskId) effects.push({ kind: "refetch_task", taskId });
        break;
      }
      case "task.claimed":
      case "task.assigned":
      case "task.commented":
      case "task.artifact_attached": {
        if (taskId) effects.push({ kind: "refetch_task", taskId });
        break;
      }
      case "task.delegated": {
        const parentTaskId = typeof p.parentTaskId === "string" ? p.parentTaskId : "";
        const childTaskId = typeof p.childTaskId === "string" ? p.childTaskId : "";
        const from = stripActor(p.actor);
        const to = typeof p.assignee === "string" ? p.assignee : "";
        if (childTaskId && from && to) {
          next = {
            ...next,
            edges: [
              ...next.edges.slice(-29),
              {
                id: `${parentTaskId}:${childTaskId}`,
                from,
                to,
                taskId: childTaskId,
                at: ev.createdAt || Date.now(),
              },
            ],
          };
          effects.push({ kind: "refetch_task", taskId: childTaskId });
        }
        break;
      }
      case "gate.approved":
      case "gate.rejected":
      case "project.created": {
        effects.push({ kind: "refetch_projects" });
        break;
      }
      default:
        break;
    }
  }

  // ── Topic swarm (cola del pool, kill switch, estado de agentes) ───────────
  if (ev.topic === "swarm") {
    switch (ev.type) {
      case "RUN_QUEUED": {
        const runId = String(ev.payload.runId ?? ev.runId ?? "");
        if (runId) {
          next = upsertRun(next, runId, { status: "queued", phase: "esperando_turno" });
          effects.push({ kind: "watch_run", runId });
        }
        break;
      }
      case "RUN_DEQUEUED": {
        const runId = String(ev.payload.runId ?? ev.runId ?? "");
        if (runId) effects.push({ kind: "watch_run", runId });
        break;
      }
      case "RUN_CANCELLED": {
        const runId = String(ev.payload.runId ?? ev.runId ?? "");
        if (runId) {
          next = upsertRun(next, runId, {
            status: "cancelled",
            phase: null,
            currentTool: null,
          });
        }
        break;
      }
      case "kill_switch.on":
        next = { ...next, killSwitch: true };
        break;
      case "kill_switch.off":
        next = { ...next, killSwitch: false };
        break;
      case "agent.status": {
        const p = domainPayload(ev);
        if (typeof p.slug === "string" && typeof p.status === "string") {
          next = { ...next, agentStatus: { ...next.agentStatus, [p.slug]: p.status } };
        }
        break;
      }
      default:
        break;
    }
  }

  // ── Topic approvals ───────────────────────────────────────────────────────
  if (ev.topic === "approvals") {
    if (ev.type.startsWith("approval.")) effects.push({ kind: "refetch_approvals" });
  }

  // ── Topics run:<id> (AG-UI del runner) ────────────────────────────────────
  if (ev.topic.startsWith("run:")) {
    const runId = ev.topic.slice(4);
    const p = ev.payload;
    switch (ev.type) {
      case "RUN_STARTED": {
        next = upsertRun(next, runId, {
          status: "running",
          phase: "pensando",
          agentId: typeof p.agentId === "string" ? p.agentId : null,
          taskId: typeof p.taskId === "string" ? p.taskId : null,
        });
        break;
      }
      case "TEXT_MESSAGE_CONTENT": {
        next = upsertRun(next, runId, { phase: "pensando" });
        break;
      }
      case "TOOL_CALL_START": {
        const id = String(p.toolCallId ?? "");
        const name = String(p.toolCallName ?? "tool");
        next = patchChip(next, runId, id, { name }, name);
        next = upsertRun(next, runId, { phase: "usando_tool", currentTool: name });
        break;
      }
      case "TOOL_CALL_ARGS": {
        next = appendChipArgs(next, runId, String(p.toolCallId ?? ""), String(p.delta ?? ""));
        break;
      }
      case "TOOL_CALL_END": {
        next = patchChip(next, runId, String(p.toolCallId ?? ""), { done: true });
        break;
      }
      case "TOOL_CALL_RESULT": {
        next = patchChip(next, runId, String(p.toolCallId ?? ""), {
          done: true,
          result: typeof p.content === "string" ? p.content : JSON.stringify(p.content ?? null),
          isError: p.isError === true,
          synthetic: p.synthetic === true,
        });
        next = upsertRun(next, runId, { phase: "pensando", currentTool: null });
        break;
      }
      case "RUN_FINISHED": {
        const usage = (p.usage ?? {}) as Record<string, unknown>;
        next = upsertRun(next, runId, {
          status: "succeeded",
          phase: null,
          currentTool: null,
          tokensIn: typeof usage.tokensIn === "number" ? usage.tokensIn : null,
          tokensOut: typeof usage.tokensOut === "number" ? usage.tokensOut : null,
          costUsd: typeof p.costUsd === "number" ? p.costUsd : null,
        });
        break;
      }
      case "RUN_ERROR": {
        next = upsertRun(next, runId, {
          status: "failed",
          phase: null,
          currentTool: null,
          error: typeof p.message === "string" ? p.message : "error",
        });
        break;
      }
      case "RUN_CANCELLED": {
        next = upsertRun(next, runId, { status: "cancelled", phase: null, currentTool: null });
        break;
      }
      case "RUN_QUEUED": {
        next = upsertRun(next, runId, { status: "queued", phase: "esperando_turno" });
        break;
      }
      default:
        break;
    }
  }

  return { state: next, effects };
}

function reduceThreadEvent(state: EventState, ev: TopicEvent): EventState {
  const p = ev.payload;
  switch (ev.type) {
    case "TEXT_MESSAGE_START": {
      const id = String(p.messageId ?? "");
      return {
        ...state,
        chat: {
          ...state.chat,
          streams: { ...state.chat.streams, [id]: { text: "", done: false, runId: ev.runId } },
        },
      };
    }
    case "TEXT_MESSAGE_CONTENT": {
      const id = String(p.messageId ?? "");
      const prev = state.chat.streams[id] ?? { text: "", done: false, runId: ev.runId };
      return {
        ...state,
        chat: {
          ...state.chat,
          streams: {
            ...state.chat.streams,
            [id]: { ...prev, text: prev.text + String(p.delta ?? "") },
          },
        },
      };
    }
    case "TEXT_MESSAGE_END": {
      const id = String(p.messageId ?? "");
      const prev = state.chat.streams[id];
      if (!prev) return state;
      return {
        ...state,
        chat: { ...state.chat, streams: { ...state.chat.streams, [id]: { ...prev, done: true } } },
      };
    }
    case "message.final": {
      const d = domainPayload(ev);
      const messageId = String(d.message_id ?? "");
      if (state.chat.messages.some((m) => m.id === messageId)) return state;
      const msg: Message = {
        id: messageId,
        threadId: String(d.thread_id ?? state.chat.threadId ?? ""),
        role: "assistant",
        content: String(d.text ?? ""),
        idempotencyKey: null,
        runId: typeof d.run_id === "string" ? d.run_id : null,
        actor: null,
        meta: d.error ? { error: true } : null,
        createdAt: ev.createdAt || Date.now(),
      };
      // El final reemplaza cualquier parcial en curso.
      return {
        ...state,
        chat: { ...state.chat, messages: [...state.chat.messages, msg], streams: {} },
      };
    }
    case "message.inbound": {
      const d = domainPayload(ev);
      const messageId = String(d.message_id ?? "");
      if (!messageId || state.chat.messages.some((m) => m.id === messageId)) return state;
      const msg: Message = {
        id: messageId,
        threadId: String(d.thread_id ?? state.chat.threadId ?? ""),
        role: "user",
        content: String(d.text ?? ""),
        idempotencyKey: null,
        runId: null,
        actor: null,
        meta: null,
        createdAt: ev.createdAt || Date.now(),
      };
      return { ...state, chat: { ...state.chat, messages: [...state.chat.messages, msg] } };
    }
    default:
      return state;
  }
}
