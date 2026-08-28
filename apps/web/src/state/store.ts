/**
 * Store Zustand (spec B5 §1): un solo store alimentado por el reductor de
 * eventos del WS + snapshots REST. Reglas:
 * - El WS es optimización: cada hueco irrecuperable refetchea el snapshot REST.
 * - Movimientos de kanban: optimistas, revertidos con toast si la API rechaza.
 */
import { create } from "zustand";
import {
  api,
  ApiError,
  clearSession,
  loadSession,
  saveSession,
  setOnUnauthorized,
  setToken,
  wsUrl,
} from "../lib/api";
import { WsClient, type WsStatus } from "../lib/ws";
import type {
  Agent,
  Approval,
  Artifact,
  Message,
  Person,
  Project,
  Run,
  Task,
  TaskEvent,
  TaskStatus,
  Thread,
  TopicEvent,
} from "../lib/types";
import {
  emptyEventState,
  reduceEvent,
  type Effect,
  type EventState,
} from "./reducer";

export interface Toast {
  id: number;
  kind: "error" | "ok" | "info";
  text: string;
}

export interface TaskDetail {
  task: Task;
  events: TaskEvent[];
  artifacts: Artifact[];
  runs: Run[];
}

/** Entregable en REVIEW esperando decisión humana (bandeja, CA-4.2 / fix H10). */
export interface ReviewEntry {
  task: Task;
  artifacts: Artifact[];
}

export interface AppStore extends EventState {
  // sesión
  person: Person | null;
  token: string | null;
  wsStatus: WsStatus;
  bootstrapped: boolean;

  // datos
  projects: Project[];
  activeProjectId: string | null;
  threads: Thread[];
  approvals: Approval[];
  reviewTasks: ReviewEntry[];
  agents: Agent[];
  failedRunsCount: number;
  boardLoading: boolean;
  boardError: string | null;
  taskDetail: TaskDetail | null;
  taskDetailLoading: boolean;
  chatSending: boolean;

  toasts: Toast[];

  // acciones
  init(): Promise<void>;
  login(password: string, personId: string): Promise<void>;
  logout(): void;
  pushToast(kind: Toast["kind"], text: string): void;
  dismissToast(id: number): void;

  loadProjects(): Promise<void>;
  setActiveProject(projectId: string | null): Promise<void>;
  refetchBoard(): Promise<void>;
  moveTaskOptimistic(taskId: string, to: TaskStatus): Promise<boolean>;

  openTask(taskId: string): Promise<void>;
  closeTask(): void;
  commentOnTask(taskId: string, body: string): Promise<void>;
  approveTaskReview(taskId: string, note?: string): Promise<void>;
  rejectTaskReview(taskId: string, note: string): Promise<void>;

  loadThreads(): Promise<void>;
  openThread(threadId: string | null): Promise<void>;
  sendChatMessage(text: string): Promise<void>;

  loadApprovals(): Promise<void>;
  decideApproval(id: string, decision: "approved" | "rejected", note?: string): Promise<void>;

  loadAgents(): Promise<void>;
  setAgentStatus(agentId: string, status: string, expectedVersion: number): Promise<void>;

  loadKillSwitch(): Promise<void>;
  setKillSwitch(active: boolean): Promise<void>;
  refreshBadges(): Promise<void>;

  watchRun(runId: string): void;
  /** Snapshot REST de runs → runsLive (el WS es optimización, no fuente de verdad). */
  mergeRuns(runs: Run[]): void;
  fetchRunHistory(runId: string): Promise<TopicEvent[]>;

  ingest(ev: TopicEvent): void;
}

let toastSeq = 1;

/** Conexión WS y bajas de suscripción viven fuera del estado reactivo. */
const wires: {
  ws: WsClient | null;
  offBoard: (() => void) | null;
  offThread: (() => void) | null;
  runWatchers: Map<string, () => void>;
} = { ws: null, offBoard: null, offThread: null, runWatchers: new Map() };

export function getWs(): WsClient | null {
  return wires.ws;
}

export const useStore = create<AppStore>()((set, get) => {
  function runEffects(effects: Effect[]): void {
    for (const eff of effects) {
      switch (eff.kind) {
        case "refetch_task":
          void refetchTask(eff.taskId);
          break;
        case "refetch_approvals":
          void get().loadApprovals();
          break;
        case "refetch_projects":
          void get().loadProjects();
          break;
        case "watch_run":
          get().watchRun(eff.runId);
          break;
      }
    }
  }

  async function refetchTask(taskId: string): Promise<void> {
    try {
      const detail = await api.task(taskId);
      const state = get();
      if (detail.task.projectId === state.board.projectId) {
        set({
          board: {
            ...get().board,
            tasks: { ...get().board.tasks, [detail.task.id]: detail.task },
          },
        });
      }
      if (state.taskDetail?.task.id === taskId) {
        set({ taskDetail: detail });
      }
    } catch {
      /* la tarjeta puede haber sido borrada o no ser visible; el snapshot manda */
    }
  }

  function connectWs(token: string): void {
    wires.ws?.close();
    wires.runWatchers.clear();
    wires.offBoard = null;
    wires.offThread = null;
    const ws = new WsClient({
      url: wsUrl(token),
      onStatus: (status) => set({ wsStatus: status }),
    });
    wires.ws = ws;
    ws.connect();
    // Topics globales: swarm (estado de agentes, cola, kill switch) y approvals.
    ws.subscribe("swarm", {
      onEvent: (ev) => get().ingest(ev),
    });
    ws.subscribe("approvals", {
      onEvent: (ev) => get().ingest(ev),
    });
  }

  function subscribeBoard(projectId: string, sinceSeq: number): void {
    wires.offBoard?.();
    wires.offBoard =
      wires.ws?.subscribe(`board:${projectId}`, {
        sinceSeq,
        onEvent: (ev) => get().ingest(ev),
        onGap: () => void get().refetchBoard(),
      }) ?? null;
  }

  function subscribeThread(threadId: string, sinceSeq: number): void {
    wires.offThread?.();
    wires.offThread =
      wires.ws?.subscribe(`thread:${threadId}`, {
        sinceSeq,
        onEvent: (ev) => get().ingest(ev),
        onGap: () => void reloadThreadMessages(threadId),
      }) ?? null;
  }

  async function reloadThreadMessages(threadId: string): Promise<void> {
    try {
      const { messages } = await api.messages(threadId);
      set({ chat: { ...get().chat, threadId, messages, streams: {} } });
    } catch (err) {
      toastError(err, "No se pudieron cargar los mensajes");
    }
  }

  function toastError(err: unknown, fallback: string): void {
    const msg =
      err instanceof ApiError ? `${err.code}: ${err.message}` : err instanceof Error ? err.message : fallback;
    get().pushToast("error", msg);
  }

  return {
    ...emptyEventState(),
    person: null,
    token: null,
    wsStatus: "closed",
    bootstrapped: false,

    projects: [],
    activeProjectId: null,
    threads: [],
    approvals: [],
    reviewTasks: [],
    agents: [],
    failedRunsCount: 0,
    boardLoading: false,
    boardError: null,
    taskDetail: null,
    taskDetailLoading: false,
    chatSending: false,
    toasts: [],

    async init() {
      setOnUnauthorized(() => {
        if (get().token) get().logout();
      });
      const session = loadSession();
      if (!session) {
        set({ bootstrapped: true });
        return;
      }
      setToken(session.token);
      set({ token: session.token, person: session.person });
      connectWs(session.token);
      set({ bootstrapped: true });
      await Promise.allSettled([
        get().loadProjects(),
        get().loadApprovals(),
        get().loadAgents(),
        get().loadKillSwitch(),
        get().refreshBadges(),
      ]);
      const savedProject = localStorage.getItem("agentos_project");
      const projects = get().projects;
      const target =
        (savedProject && projects.find((p) => p.id === savedProject)?.id) ?? projects[0]?.id ?? null;
      if (target) await get().setActiveProject(target);
    },

    async login(password, personId) {
      const res = await api.login(password, personId);
      setToken(res.token);
      saveSession(res.token, res.person);
      set({ token: res.token, person: res.person });
      connectWs(res.token);
      await Promise.allSettled([
        get().loadProjects(),
        get().loadApprovals(),
        get().loadAgents(),
        get().loadKillSwitch(),
        get().refreshBadges(),
      ]);
      const first = get().projects[0]?.id ?? null;
      if (first) await get().setActiveProject(first);
    },

    logout() {
      wires.ws?.close();
      wires.ws = null;
      clearSession();
      setToken(null);
      set({
        ...emptyEventState(),
        person: null,
        token: null,
        wsStatus: "closed",
        projects: [],
        threads: [],
        approvals: [],
        reviewTasks: [],
        agents: [],
        taskDetail: null,
        activeProjectId: null,
      });
    },

    pushToast(kind, text) {
      const id = toastSeq++;
      set({ toasts: [...get().toasts, { id, kind, text }] });
      setTimeout(() => get().dismissToast(id), 6000);
    },

    dismissToast(id) {
      set({ toasts: get().toasts.filter((t) => t.id !== id) });
    },

    async loadProjects() {
      try {
        const { projects } = await api.projects();
        set({ projects });
      } catch (err) {
        toastError(err, "No se pudieron cargar los proyectos");
      }
    },

    async setActiveProject(projectId) {
      set({ activeProjectId: projectId });
      try {
        if (projectId) localStorage.setItem("agentos_project", projectId);
      } catch {
        /* ignore */
      }
      if (!projectId) {
        wires.offBoard?.();
        wires.offBoard = null;
        set({ board: { projectId: null, tasks: {} } });
        return;
      }
      set({ boardLoading: true, boardError: null });
      try {
        const snap = await api.board(projectId);
        const tasks: Record<string, Task> = {};
        for (const list of Object.values(snap.columns)) {
          for (const t of list ?? []) tasks[t.id] = t;
        }
        set({
          board: { projectId, tasks },
          boardLoading: false,
          projects: get().projects.map((p) => (p.id === snap.project.id ? snap.project : p)),
        });
        subscribeBoard(projectId, snap.board_seq);
      } catch (err) {
        set({
          boardLoading: false,
          boardError: err instanceof ApiError ? `${err.code}: ${err.message}` : "Error cargando el tablero",
        });
      }
    },

    async refetchBoard() {
      const projectId = get().board.projectId;
      if (!projectId) return;
      try {
        const snap = await api.board(projectId);
        const tasks: Record<string, Task> = {};
        for (const list of Object.values(snap.columns)) {
          for (const t of list ?? []) tasks[t.id] = t;
        }
        set({ board: { projectId, tasks } });
      } catch {
        /* siguiente evento/gap lo reintenta */
      }
    },

    async moveTaskOptimistic(taskId, to) {
      const task = get().board.tasks[taskId];
      if (!task) return false;
      if (task.status === to) return true;
      const prev = task;
      // Optimista: pinta el destino ya.
      set({
        board: { ...get().board, tasks: { ...get().board.tasks, [taskId]: { ...task, status: to } } },
      });
      try {
        const { task: updated } = await api.moveTask(taskId, {
          to,
          expected_version: prev.version,
        });
        set({
          board: { ...get().board, tasks: { ...get().board.tasks, [taskId]: updated } },
        });
        return true;
      } catch (err) {
        // Reconciliación: revertir y contar el error de dominio.
        set({
          board: { ...get().board, tasks: { ...get().board.tasks, [taskId]: prev } },
        });
        toastError(err, "La API rechazó la transición");
        if (err instanceof ApiError && (err.code === "version_conflict" || err.code === "conflict")) {
          void get().refetchBoard();
        }
        return false;
      }
    },

    async openTask(taskId) {
      set({ taskDetailLoading: true });
      try {
        const detail = await api.task(taskId);
        set({ taskDetail: detail, taskDetailLoading: false });
      } catch (err) {
        set({ taskDetailLoading: false });
        toastError(err, "No se pudo abrir la tarjeta");
      }
    },

    closeTask() {
      set({ taskDetail: null });
    },

    async commentOnTask(taskId, body) {
      try {
        await api.commentTask(taskId, body);
        await get().openTask(taskId);
      } catch (err) {
        toastError(err, "No se pudo comentar");
      }
    },

    async approveTaskReview(taskId, note) {
      // La tarjeta puede venir del drawer, del tablero o de la bandeja (H10).
      const openDetail = get().taskDetail?.task.id === taskId ? get().taskDetail!.task : null;
      const task =
        openDetail ??
        get().board.tasks[taskId] ??
        get().reviewTasks.find((r) => r.task.id === taskId)?.task;
      if (!task) return;
      try {
        await api.approveTask(taskId, task.version, note);
        get().pushToast("ok", "Tarea aprobada → DONE");
        if (openDetail) await get().openTask(taskId);
        void get().loadApprovals();
      } catch (err) {
        toastError(err, "No se pudo aprobar");
      }
    },

    async rejectTaskReview(taskId, note) {
      const openDetail = get().taskDetail?.task.id === taskId ? get().taskDetail!.task : null;
      const task =
        openDetail ??
        get().board.tasks[taskId] ??
        get().reviewTasks.find((r) => r.task.id === taskId)?.task;
      if (!task) return;
      try {
        await api.rejectTask(taskId, task.version, note);
        get().pushToast("ok", "Tarea rechazada: vuelve al agente con tu nota");
        if (openDetail) await get().openTask(taskId);
        void get().loadApprovals();
      } catch (err) {
        toastError(err, "No se pudo rechazar");
      }
    },

    async loadThreads() {
      try {
        const { threads } = await api.threads("web");
        set({ threads });
      } catch (err) {
        toastError(err, "No se pudieron cargar los hilos");
      }
    },

    async openThread(threadId) {
      wires.offThread?.();
      wires.offThread = null;
      if (!threadId) {
        set({ chat: { threadId: null, messages: [], streams: {} } });
        return;
      }
      try {
        const [{ messages }, { last_seq }] = await Promise.all([
          api.messages(threadId),
          api.thread(threadId),
        ]);
        set({ chat: { threadId, messages, streams: {} } });
        subscribeThread(threadId, last_seq);
      } catch (err) {
        toastError(err, "No se pudo abrir el hilo");
      }
    },

    async sendChatMessage(text) {
      const person = get().person;
      if (!person || !text.trim()) return;
      const state = get();
      const messageId = crypto.randomUUID();
      // session_key = web:<chat_id>:<thread_hint>. Para continuar el MISMO hilo
      // se reutilizan chat_id + hint parseados de su sessionKey.
      let externalChatId = person.id;
      let threadHint: string | undefined;
      if (state.chat.threadId) {
        const thread = state.threads.find((t) => t.id === state.chat.threadId);
        if (thread) {
          const parts = thread.sessionKey.split(":");
          externalChatId = parts[1] ?? person.id;
          threadHint = parts.slice(2).join(":") || undefined;
        }
      } else {
        threadHint = crypto.randomUUID();
      }
      set({ chatSending: true });
      // Eco optimista del mensaje propio (idempotente: el WS lo dedupe por id).
      const optimistic: Message = {
        id: messageId,
        threadId: state.chat.threadId ?? "",
        role: "user",
        content: text,
        idempotencyKey: messageId,
        runId: null,
        actor: `person:${person.id}`,
        meta: null,
        createdAt: Date.now(),
      };
      try {
        const res = await api.sendChat({
          external_user_id: person.id,
          external_chat_id: externalChatId,
          message_id: messageId,
          text,
          ...(threadHint ? { thread_hint: threadHint } : {}),
          ...(get().activeProjectId ? { project_id: get().activeProjectId! } : {}),
        });
        if (!get().chat.threadId) {
          await get().openThread(res.thread_id);
          await get().loadThreads();
        }
        const chat = get().chat;
        if (!chat.messages.some((m) => m.id === res.message_id || m.idempotencyKey === messageId)) {
          set({
            chat: {
              ...chat,
              messages: [...chat.messages, { ...optimistic, id: res.message_id, threadId: res.thread_id }],
            },
          });
        }
        if (res.warning) {
          get().pushToast(
            "info",
            res.warning === "kill_switch_active"
              ? "Agentes en pausa: el mensaje quedó guardado pero no arrancó ningún run"
              : `Aviso: ${res.warning}`,
          );
        }
        if (res.run_id) get().watchRun(res.run_id);
      } catch (err) {
        toastError(err, "No se pudo enviar el mensaje");
      } finally {
        set({ chatSending: false });
      }
    },

    async loadApprovals() {
      try {
        // Bandeja completa (H10): aprobaciones pendientes + entregables en REVIEW.
        const { approvals, review_tasks } = await api.waiting();
        set({ approvals, reviewTasks: review_tasks });
      } catch {
        /* badge se refresca en el siguiente ciclo */
      }
    },

    async decideApproval(id, decision, note) {
      try {
        await api.decideApproval(id, decision, note);
        set({ approvals: get().approvals.filter((a) => a.id !== id) });
        get().pushToast("ok", decision === "approved" ? "Aprobación concedida" : "Aprobación rechazada");
      } catch (err) {
        toastError(err, "No se pudo decidir la aprobación");
        void get().loadApprovals();
      }
    },

    async loadAgents() {
      try {
        const { agents } = await api.agents();
        set({ agents });
      } catch {
        /* vista admin lo reintenta */
      }
    },

    async setAgentStatus(agentId, status, expectedVersion) {
      try {
        const { agent } = await api.setAgentStatus(agentId, status, expectedVersion);
        set({ agents: get().agents.map((a) => (a.id === agent.id ? agent : a)) });
        get().pushToast("ok", `${agent.name}: ${agent.status}`);
      } catch (err) {
        toastError(err, "No se pudo cambiar el estado del agente");
        void get().loadAgents();
      }
    },

    async loadKillSwitch() {
      try {
        const { active } = await api.killSwitch();
        set({ killSwitch: active });
      } catch {
        /* health lo trae también */
      }
    },

    async setKillSwitch(active) {
      try {
        const res = active ? await api.pauseAll("desde la UI") : await api.resumeAll("desde la UI");
        set({ killSwitch: res.active });
        get().pushToast("ok", res.active ? "Agentes pausados" : "Agentes reanudados");
      } catch (err) {
        toastError(err, "No se pudo cambiar el kill switch");
      }
    },

    async refreshBadges() {
      // La bandeja (aprobaciones + REVIEW) también se refresca por ciclo: el WS
      // es optimización, nunca fuente de verdad.
      void get().loadApprovals();
      try {
        const { runs } = await api.runs({ status: "failed", limit: 100 });
        set({ failedRunsCount: runs.length });
      } catch {
        /* siguiente ciclo */
      }
    },

    watchRun(runId) {
      if (!wires.ws || wires.runWatchers.has(runId)) return;
      // Cap defensivo de suscripciones run:<id> vivas.
      if (wires.runWatchers.size > 24) {
        const first = wires.runWatchers.keys().next().value;
        if (first) {
          wires.runWatchers.get(first)?.();
          wires.runWatchers.delete(first);
        }
      }
      const off = wires.ws.subscribe(`run:${runId}`, {
        sinceSeq: 0,
        onEvent: (ev) => get().ingest(ev),
      });
      wires.runWatchers.set(runId, off);
    },

    mergeRuns(runs) {
      const live = { ...get().runsLive };
      for (const run of runs) {
        const status =
          run.status === "queued"
            ? ("queued" as const)
            : run.status === "running"
              ? ("running" as const)
              : run.status === "succeeded"
                ? ("succeeded" as const)
                : run.status === "failed"
                  ? ("failed" as const)
                  : ("cancelled" as const);
        const prev = live[run.id];
        live[run.id] = {
          runId: run.id,
          status,
          agentId: run.agentId ?? prev?.agentId ?? null,
          taskId: run.taskId ?? prev?.taskId ?? null,
          // Conserva la fase fina del stream si el run sigue vivo.
          phase:
            prev && prev.status === status && (status === "running" || status === "queued")
              ? prev.phase
              : status === "running"
                ? "pensando"
                : status === "queued"
                  ? "esperando_turno"
                  : null,
          currentTool: prev && status === "running" ? prev.currentTool : null,
          tokensIn: run.tokensIn ?? prev?.tokensIn ?? null,
          tokensOut: run.tokensOut ?? prev?.tokensOut ?? null,
          costUsd: run.costUsd ?? prev?.costUsd ?? null,
          error: run.error ?? prev?.error ?? null,
        };
        if (status === "running" || status === "queued") get().watchRun(run.id);
      }
      set({ runsLive: live });
    },

    async fetchRunHistory(runId) {
      if (!wires.ws) throw new Error("WS no conectado");
      return wires.ws.fetchHistory(`run:${runId}`);
    },

    ingest(ev) {
      const state = get();
      const eventState: EventState = {
        chat: state.chat,
        toolCalls: state.toolCalls,
        createdTasks: state.createdTasks,
        board: state.board,
        runsLive: state.runsLive,
        edges: state.edges,
        killSwitch: state.killSwitch,
        agentStatus: state.agentStatus,
      };
      const { state: next, effects } = reduceEvent(eventState, ev);
      set(next);
      runEffects(effects);
    },
  };
});
