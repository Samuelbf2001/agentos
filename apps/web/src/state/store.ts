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
import type { PreviewRole } from "../lib/capabilities";
import type {
  Agent,
  Approval,
  Artifact,
  CanvasNote,
  CanvasScene,
  LabelUsage,
  Message,
  Person,
  Project,
  Run,
  Stage,
  Task,
  TaskDetailResponse,
  TaskPriority,
  TaskProjectContext,
  TaskSearchHit,
  BoardFilter,
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
  /** Franja contextual del proyecto; opcional para servidores anteriores. */
  projectContext?: TaskProjectContext | null;
  project?: Project | null;
}

/**
 * Movimiento rechazado por el motor por falta de evidencia. Se guarda para que
 * la ficha diga QUÉ falta y ofrezca adjuntarlo, en vez de revertir en silencio.
 */
export interface BlockedMove {
  taskId: string;
  to: TaskStatus;
  code: string;
  message: string;
}

export interface CreateTaskInput {
  project_id: string;
  title: string;
  stage: Stage;
  description?: string;
  definition_of_done?: string;
  priority?: TaskPriority;
  assignee_person_ids?: string[];
  primary_assignee_person_id?: string | null;
  due_at?: number | null;
  labels?: string[];
}

/**
 * Opciones de envío al canal web. `threadHint` fija la session_key
 * (`web:<personId>:<hint>`) en vez del uuid aleatorio: el panel del tablero usa
 * `board:<projectId>` para reabrir siempre el mismo hilo. `projectId` pone ese
 * proyecto en el scope del run aunque `activeProjectId` sea otro o null.
 */
export interface SendChatOptions {
  threadHint?: string;
  projectId?: string;
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
  /** Modo pruebas: copia local de datos, entrada sin contraseña (ver docs/SANDBOX.md). */
  sandbox: boolean;
  /** "Ver como cliente": previsualización local, no un rol de sesión real. */
  previewRole: PreviewRole;

  // datos
  projects: Project[];
  activeProjectId: string | null;
  people: Person[];
  peopleLoading: boolean;
  peopleError: string | null;
  /**
   * Roster acotado al proyecto activo. `null` = la API no lo pudo dar (servidor
   * anterior o error): en ese caso la interfaz vuelve al roster global.
   */
  projectPeople: Person[] | null;
  projectPeopleId: string | null;
  threads: Thread[];
  approvals: Approval[];
  reviewTasks: ReviewEntry[];
  agents: Agent[];
  failedRunsCount: number;
  boardLoading: boolean;
  boardError: string | null;
  taskDetail: TaskDetail | null;
  taskDetailLoading: boolean;
  taskDetailId: string | null;
  taskDetailError: string | null;
  taskMutationError: string | null;
  /**
   * Último 409 de la ficha abierta. Tras releer la tarea, el control inline
   * que falló reabre su popover con el valor nuevo y un aviso de una línea.
   */
  taskConflict: { taskId: string; at: number } | null;
  taskSaving: boolean;
  /**
   * Panel copiloto del tablero. Vive en el store porque el side peek de la
   * ficha lo cierra por debajo de 1280px (no caben los dos, decisión §3.1).
   */
  copilotOpen: boolean;
  boardFilter: BoardFilter;
  /** Etiqueta activa del tablero; null = sin filtrar por etiqueta. */
  boardLabelFilter: string | null;
  labelCatalog: LabelUsage[];
  taskCreating: boolean;
  blockedMove: BlockedMove | null;
  taskSearchQuery: string;
  taskSearchResults: TaskSearchHit[];
  taskSearchLoading: boolean;
  taskSearchError: string | null;
  chatSending: boolean;

  /** Notas manuscritas (lienzo Excalidraw). El diario, más reciente primero. */
  notes: CanvasNote[];
  notesLoading: boolean;
  notesError: string | null;
  /** Nota abierta en el lienzo. */
  activeNoteId: string | null;
  /** Autoguardado en vuelo; el indicador discreto de la vista lo lee. */
  noteSaving: boolean;
  /** Momento del último guardado confirmado por la API (para "Guardado …"). */
  noteSavedAt: number | null;
  noteCapturing: boolean;


  toasts: Toast[];

  // acciones
  init(): Promise<void>;
  login(password: string, personId: string): Promise<void>;
  /** Modo pruebas: mismo flujo que login() pero sin contraseña. */
  loginSandbox(personId: string): Promise<void>;
  logout(): void;
  /** "Ver como cliente": reduce el shell a las capacidades de un sponsor. */
  setPreviewRole(role: PreviewRole): void;
  pushToast(kind: Toast["kind"], text: string): void;
  dismissToast(id: number): void;

  loadProjects(): Promise<void>;
  loadPeople(): Promise<void>;
  loadProjectPeople(projectId: string): Promise<void>;
  setActiveProject(projectId: string | null): Promise<void>;
  setBoardFilter(filter: BoardFilter): void;
  setBoardLabelFilter(label: string | null): void;
  setCopilotOpen(open: boolean): void;
  loadLabels(projectId?: string): Promise<void>;
  refetchBoard(): Promise<void>;
  moveTaskOptimistic(taskId: string, to: TaskStatus): Promise<boolean>;
  clearBlockedMove(): void;
  /** Reintenta el movimiento que el motor rechazó por falta de artefacto. */
  retryBlockedMove(): Promise<boolean>;
  createTask(input: CreateTaskInput): Promise<Task | null>;
  setTaskLabels(taskId: string, labels: string[]): Promise<boolean>;
  attachArtifactLink(taskId: string, input: { title: string; url: string }): Promise<boolean>;
  uploadTaskArtifact(taskId: string, file: File, title?: string): Promise<boolean>;
  searchTasks(query: string, opts?: { projectId?: string; mine?: boolean }): Promise<void>;
  clearTaskSearch(): void;

  openTask(taskId: string): Promise<void>;
  retryTaskDetail(): Promise<void>;
  closeTask(): void;
  updateTask(
    taskId: string,
    patch: {
      due_at?: number | null;
      title?: string;
      description?: string | null;
      definition_of_done?: string | null;
      activity_type?: string | null;
      priority?: Task["priority"];
    },
  ): Promise<boolean>;
  assignTaskPeople(taskId: string, personIds: string[], primaryPersonId: string | null): Promise<boolean>;
  /** Cambia la tarea de proyecto (optimista, con reversión). */
  moveTaskToProject(taskId: string, projectId: string): Promise<boolean>;
  commentOnTask(taskId: string, body: string): Promise<void>;
  approveTaskReview(taskId: string, note?: string): Promise<void>;
  rejectTaskReview(taskId: string, note: string): Promise<void>;

  loadNotes(projectId?: string): Promise<void>;
  createNote(input?: { title?: string; projectId?: string }): Promise<CanvasNote | null>;
  openNote(noteId: string | null): void;
  /** Autoguardado del lienzo; devuelve false si la API lo rechazó. */
  saveNote(noteId: string, patch: { title?: string; scene?: CanvasScene }): Promise<boolean>;
  /** "Terminar notas": manda el PNG ya exportado (base64) y deja la nota en `captured`. */
  captureNote(noteId: string, imageBase64: string): Promise<boolean>;

  loadThreads(): Promise<void>;
  openThread(threadId: string | null): Promise<void>;
  sendChatMessage(text: string, opts?: SendChatOptions): Promise<void>;

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
  let taskDetailRequestSeq = 0;

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

  function currentTask(taskId: string): Task | null {
    const detail = get().taskDetail;
    if (detail?.task.id === taskId) return detail.task;
    return get().board.tasks[taskId] ?? null;
  }

  function mergeTask(updated: Task): void {
    const state = get();
    const inBoard = state.board.tasks[updated.id];
    if (inBoard || updated.projectId === state.board.projectId) {
      set({ board: { ...state.board, tasks: { ...state.board.tasks, [updated.id]: updated } } });
    }
    if (state.taskDetail?.task.id === updated.id) {
      set({ taskDetail: { ...state.taskDetail, task: updated } });
    }
  }

  /**
   * Cambio de proyecto: la tarjeta sale del tablero viejo y entra en el nuevo
   * (si es el que está montado). Sirve tanto para el paso optimista como para
   * la reversión: se llama con la tarea "de destino" en cada caso.
   */
  function applyProjectMove(task: Task): void {
    const state = get();
    const tasks = { ...state.board.tasks };
    if (state.board.projectId === task.projectId) tasks[task.id] = task;
    else delete tasks[task.id];
    set({ board: { ...state.board, tasks } });
    if (state.taskDetail?.task.id === task.id) {
      const project = state.projects.find((candidate) => candidate.id === task.projectId) ?? null;
      set({ taskDetail: { ...state.taskDetail, task, project } });
    }
  }

  /** La nota que vuelve de la API manda sobre la copia local (incluida `version`). */
  function mergeNote(note: CanvasNote): void {
    set({ notes: get().notes.map((n) => (n.id === note.id ? note : n)) });
  }

  function isVersionConflict(err: unknown): boolean {
    return err instanceof ApiError && (err.code === "version_conflict" || err.code === "conflict" || err.status === 409);
  }

  /**
   * 409: la tarea cambió por debajo. Se relee (sin pasar por el spinner de
   * apertura) y se deja la marca para que el control que falló reabra su
   * popover con el valor nuevo.
   */
  async function handleConflict(taskId: string): Promise<void> {
    await refetchTask(taskId);
    set({ taskConflict: { taskId, at: Date.now() } });
  }

  /** Proyección camelCase del body PATCH, para pintar antes de que responda la API. */
  function optimisticPatch(task: Task, patch: Parameters<AppStore["updateTask"]>[1]): Task {
    const next: Task = { ...task };
    if (patch.title !== undefined) next.title = patch.title;
    if (patch.description !== undefined) next.description = patch.description;
    if (patch.definition_of_done !== undefined) next.definitionOfDone = patch.definition_of_done;
    if (patch.activity_type !== undefined) next.activityType = patch.activity_type;
    if (patch.priority !== undefined) next.priority = patch.priority;
    if (patch.due_at !== undefined) {
      next.dueAt = patch.due_at;
      if ("due_at" in next) next.due_at = patch.due_at;
    }
    return next;
  }

  function normalizeMutationError(err: unknown, fallback: string): string {
    return err instanceof ApiError
      ? `${err.code}: ${err.message}`
      : err instanceof Error
        ? err.message
        : fallback;
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
    sandbox: false,
    previewRole: null,

    projects: [],
    activeProjectId: null,
    people: [],
    peopleLoading: false,
    peopleError: null,
    projectPeople: null,
    projectPeopleId: null,
    threads: [],
    approvals: [],
    reviewTasks: [],
    agents: [],
    failedRunsCount: 0,
    boardLoading: false,
    boardError: null,
    taskDetail: null,
    taskDetailLoading: false,
    taskDetailId: null,
    taskDetailError: null,
    taskMutationError: null,
    taskConflict: null,
    taskSaving: false,
    copilotOpen: false,
    boardFilter: "all",
    boardLabelFilter: null,
    labelCatalog: [],
    taskCreating: false,
    blockedMove: null,
    taskSearchQuery: "",
    taskSearchResults: [],
    taskSearchLoading: false,
    taskSearchError: null,
    chatSending: false,
    notes: [],
    notesLoading: false,
    notesError: null,
    activeNoteId: null,
    noteSaving: false,
    noteSavedAt: null,
    noteCapturing: false,
    toasts: [],

    async init() {
      setOnUnauthorized(() => {
        if (get().token) get().logout();
      });
      // El chip "Pruebas" y el botón sin contraseña dependen de esto incluso
      // antes de iniciar sesión (LoginView). Si la API no responde, queda en
      // false: nunca rompe el arranque normal.
      try {
        const health = await api.health();
        set({ sandbox: health.sandbox === true });
      } catch {
        set({ sandbox: false });
      }
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
        get().loadPeople(),
        get().loadApprovals(),
        get().loadAgents(),
        get().loadKillSwitch(),
        get().refreshBadges(),
      ]);
    },

    async login(password, personId) {
      const res = await api.login(password, personId);
      setToken(res.token);
      saveSession(res.token, res.person);
      set({ token: res.token, person: res.person });
      connectWs(res.token);
      await Promise.allSettled([
        get().loadProjects(),
        get().loadPeople(),
        get().loadApprovals(),
        get().loadAgents(),
        get().loadKillSwitch(),
        get().refreshBadges(),
      ]);
    },

    async loginSandbox(personId) {
      const res = await api.sandboxLogin(personId);
      setToken(res.token);
      saveSession(res.token, res.person);
      set({ token: res.token, person: res.person });
      connectWs(res.token);
      await Promise.allSettled([
        get().loadProjects(),
        get().loadPeople(),
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
        previewRole: null,
        projects: [],
        people: [],
        peopleLoading: false,
        peopleError: null,
        projectPeople: null,
        projectPeopleId: null,
        threads: [],
        approvals: [],
        reviewTasks: [],
        agents: [],
        taskDetail: null,
        taskDetailId: null,
        taskDetailError: null,
        taskMutationError: null,
        taskConflict: null,
        taskSaving: false,
        copilotOpen: false,
        boardFilter: "all",
        boardLabelFilter: null,
        labelCatalog: [],
        blockedMove: null,
        taskSearchQuery: "",
        taskSearchResults: [],
        activeProjectId: null,
      });
    },

    setPreviewRole(role) {
      set({ previewRole: role });
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

    async loadPeople() {
      set({ peopleLoading: true, peopleError: null });
      try {
        const { people } = await api.people();
        set({ people, peopleLoading: false });
      } catch (err) {
        const message = normalizeMutationError(err, "No se pudo cargar el equipo");
        set({ peopleLoading: false, peopleError: message });
        // El roster es recuperable desde el drawer; no ocultamos el resto del tablero.
      }
    },

    async loadProjectPeople(projectId) {
      try {
        const { people } = await api.projectPeople(projectId);
        set({ projectPeople: people, projectPeopleId: projectId });
      } catch {
        // Sin roster de proyecto la ficha usa el global: peor filtro, pero
        // nunca un selector vacío por un fallo de red.
        set({ projectPeople: null, projectPeopleId: projectId });
      }
    },

    setBoardFilter(filter) {
      set({ boardFilter: filter });
    },

    setBoardLabelFilter(label) {
      set({ boardLabelFilter: label });
    },

    setCopilotOpen(open) {
      set({ copilotOpen: open });
    },

    async loadLabels(projectId) {
      try {
        const { labels } = await api.labels(projectId ?? get().activeProjectId ?? undefined);
        set({ labelCatalog: labels });
      } catch {
        /* el catálogo es una ayuda: sin él la ficha sigue aceptando texto libre */
      }
    },

    async setActiveProject(projectId) {
      set({
        activeProjectId: projectId,
        taskDetail: null,
        taskDetailId: null,
        taskDetailError: null,
        taskMutationError: null,
      });
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
        void get().loadLabels(projectId);
        void get().loadProjectPeople(projectId);
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
      // La ficha puede estar abierta sobre una tarea que no está en el tablero
      // montado (Hoy, Tareas, búsqueda): la fuente es la ficha o el tablero.
      const task = currentTask(taskId);
      if (!task) return false;
      if (task.status === to) return true;
      const prev = task;
      // Optimista: pinta el destino ya.
      mergeTask({ ...task, status: to });
      try {
        const { task: updated } = await api.moveTask(taskId, {
          to,
          expected_version: prev.version,
        });
        mergeTask(updated);
        return true;
      } catch (err) {
        // Reconciliación: revertir y contar el error de dominio.
        mergeTask(prev);
        // La regla anti-teatro (ningún REVIEW/DONE sin artefacto) es la causa
        // más frecuente de rechazo y la única que el humano puede resolver ahí
        // mismo: en vez de revertir en silencio, se abre la ficha explicando
        // qué falta para que adjunte la evidencia y reintente.
        if (err instanceof ApiError && err.code === "missing_artifact") {
          set({
            blockedMove: {
              taskId,
              to,
              code: err.code,
              message: err.message,
            },
          });
          get().pushToast(
            "error",
            `Falta evidencia para llevar la tarea a ${to}: adjunta un archivo o un enlace en la ficha.`,
          );
          await get().openTask(taskId);
          return false;
        }
        toastError(err, "La API rechazó la transición");
        if (isVersionConflict(err)) {
          void get().refetchBoard();
          if (get().taskDetail?.task.id === taskId) await handleConflict(taskId);
        }
        return false;
      }
    },

    clearBlockedMove() {
      set({ blockedMove: null });
    },

    async retryBlockedMove() {
      const blocked = get().blockedMove;
      if (!blocked) return false;
      const task = currentTask(blocked.taskId);
      if (!task) {
        set({ blockedMove: null });
        return false;
      }
      try {
        const { task: updated } = await api.moveTask(blocked.taskId, {
          to: blocked.to,
          expected_version: task.version,
        });
        mergeTask(updated);
        set({ blockedMove: null });
        get().pushToast("ok", `Tarea movida a ${blocked.to}`);
        void get().refetchBoard();
        return true;
      } catch (err) {
        // Sigue faltando algo: se conserva el aviso con el mensaje nuevo.
        if (err instanceof ApiError) {
          set({ blockedMove: { ...blocked, code: err.code, message: err.message } });
        }
        toastError(err, "La API rechazó la transición");
        return false;
      }
    },

    async createTask(input) {
      set({ taskCreating: true });
      try {
        const { task } = await api.createTask({
          project_id: input.project_id,
          title: input.title,
          stage: input.stage,
          ...(input.description ? { description: input.description } : {}),
          ...(input.definition_of_done ? { definition_of_done: input.definition_of_done } : {}),
          ...(input.priority ? { priority: input.priority } : {}),
          ...(input.assignee_person_ids && input.assignee_person_ids.length > 0
            ? { assignee_person_ids: input.assignee_person_ids }
            : {}),
          ...(input.primary_assignee_person_id
            ? { primary_assignee_person_id: input.primary_assignee_person_id }
            : {}),
          ...(input.due_at !== undefined ? { due_at: input.due_at } : {}),
          ...(input.labels && input.labels.length > 0 ? { labels: input.labels } : {}),
        });
        mergeTask(task);
        get().pushToast("ok", `Tarea creada: ${task.title}`);
        // El snapshot manda: el WS es optimización, no fuente de verdad.
        void get().refetchBoard();
        void get().loadLabels();
        return task;
      } catch (err) {
        toastError(err, "No se pudo crear la tarea");
        return null;
      } finally {
        set({ taskCreating: false });
      }
    },

    async setTaskLabels(taskId, labels) {
      const prev = currentTask(taskId);
      set({ taskSaving: true, taskMutationError: null });
      // Optimista: las etiquetas no participan en la reconciliación por
      // versión (PUT sin expected_version, a propósito), así que sólo se
      // revierte si la API falla.
      if (prev) mergeTask({ ...prev, labels });
      try {
        const result = await api.setTaskLabels(taskId, labels);
        mergeTask(result.task);
        void get().loadLabels();
        get().pushToast("ok", "Etiquetas actualizadas");
        return true;
      } catch (err) {
        if (prev) mergeTask(prev);
        const message = normalizeMutationError(err, "No se pudieron guardar las etiquetas");
        set({ taskMutationError: message });
        toastError(err, "No se pudieron guardar las etiquetas");
        return false;
      } finally {
        set({ taskSaving: false });
      }
    },

    async attachArtifactLink(taskId, input) {
      set({ taskSaving: true });
      try {
        await api.attachArtifact(taskId, { kind: "link", title: input.title, content: input.url });
        await get().openTask(taskId);
        get().pushToast("ok", "Enlace adjuntado como artefacto");
        return true;
      } catch (err) {
        toastError(err, "No se pudo adjuntar el enlace");
        return false;
      } finally {
        set({ taskSaving: false });
      }
    },

    async uploadTaskArtifact(taskId, file, title) {
      set({ taskSaving: true });
      try {
        await api.uploadArtifact(taskId, file, title);
        await get().openTask(taskId);
        get().pushToast("ok", `Archivo adjuntado: ${file.name}`);
        return true;
      } catch (err) {
        toastError(err, "No se pudo subir el archivo");
        return false;
      } finally {
        set({ taskSaving: false });
      }
    },

    async searchTasks(query, opts = {}) {
      const trimmed = query.trim();
      set({ taskSearchQuery: query, taskSearchError: null });
      if (!trimmed) {
        set({ taskSearchResults: [], taskSearchLoading: false });
        return;
      }
      set({ taskSearchLoading: true });
      try {
        const { hits } = await api.searchTasks(trimmed, opts);
        // Una respuesta vieja no puede pisar a la búsqueda que el humano ve.
        if (get().taskSearchQuery !== query) return;
        set({ taskSearchResults: hits, taskSearchLoading: false });
      } catch (err) {
        if (get().taskSearchQuery !== query) return;
        set({
          taskSearchLoading: false,
          taskSearchResults: [],
          taskSearchError: normalizeMutationError(err, "No se pudo buscar"),
        });
      }
    },

    clearTaskSearch() {
      set({ taskSearchQuery: "", taskSearchResults: [], taskSearchError: null, taskSearchLoading: false });
    },

    async openTask(taskId) {
      const requestSeq = ++taskDetailRequestSeq;
      set({
        taskDetailId: taskId,
        taskDetailLoading: true,
        taskDetailError: null,
        taskMutationError: null,
        taskConflict: null,
        taskDetail: null,
      });
      try {
        const detail = (await api.task(taskId)) as TaskDetailResponse;
        if (requestSeq !== taskDetailRequestSeq) return;
        const normalized: TaskDetail = {
          task: detail.task,
          events: detail.events,
          artifacts: detail.artifacts,
          runs: detail.runs,
          projectContext: detail.projectContext ?? detail.project_context ?? detail.context ?? undefined,
          project: detail.project ?? undefined,
        };
        set({ taskDetail: normalized, taskDetailLoading: false, taskDetailError: null });
        mergeTask(normalized.task);
      } catch (err) {
        if (requestSeq !== taskDetailRequestSeq) return;
        const message = normalizeMutationError(err, "No se pudo abrir la tarjeta");
        set({ taskDetailLoading: false, taskDetailError: message });
        toastError(err, "No se pudo abrir la tarjeta");
      }
    },

    async retryTaskDetail() {
      const taskId = get().taskDetailId;
      if (taskId) await get().openTask(taskId);
    },

    closeTask() {
      taskDetailRequestSeq += 1;
      set({ taskDetail: null, taskDetailId: null, taskDetailLoading: false, taskDetailError: null, taskMutationError: null, taskConflict: null, taskSaving: false });
    },

    async updateTask(taskId, patch) {
      const current = currentTask(taskId);
      if (!current) return false;
      set({ taskSaving: true, taskMutationError: null, taskConflict: null });
      // Optimista: se pinta al cerrar el popover; si la API rechaza, se revierte.
      mergeTask(optimisticPatch(current, patch));
      try {
        const { task } = await api.updateTask(taskId, {
          ...patch,
          expected_version: current.version,
        });
        mergeTask(task);
        return true;
      } catch (err) {
        mergeTask(current);
        const message = normalizeMutationError(err, "No se pudieron guardar los cambios");
        set({ taskMutationError: message });
        if (isVersionConflict(err)) await handleConflict(taskId);
        else toastError(err, "No se pudieron guardar los cambios");
        return false;
      } finally {
        set({ taskSaving: false });
      }
    },

    async assignTaskPeople(taskId, personIds, primaryPersonId) {
      const current = currentTask(taskId);
      if (!current) return false;
      const uniqueIds = [...new Set(personIds.filter(Boolean))];
      const primary = primaryPersonId && uniqueIds.includes(primaryPersonId) ? primaryPersonId : uniqueIds[0] ?? null;
      set({ taskSaving: true, taskMutationError: null, taskConflict: null });
      // Optimista: conserva los datos embebidos de quien ya estaba.
      const known = new Map((current.assignees ?? []).map((assignee) => [assignee.personId ?? assignee.person_id ?? assignee.person?.id ?? "", assignee]));
      mergeTask({
        ...current,
        assigneePersonId: primary,
        assignees: uniqueIds.map((personId) => ({ ...(known.get(personId) ?? {}), personId, isPrimary: personId === primary })),
      });
      try {
        const result = await api.assignTask(taskId, {
          expected_version: current.version,
          assignee_person_ids: uniqueIds,
          primary_assignee_person_id: primary,
        });
        const task = result.assignees && !result.task.assignees
          ? { ...result.task, assignees: result.assignees }
          : result.task;
        mergeTask(task);
        return true;
      } catch (err) {
        mergeTask(current);
        const message = normalizeMutationError(err, "No se pudieron actualizar los responsables");
        set({ taskMutationError: message });
        if (isVersionConflict(err)) await handleConflict(taskId);
        else toastError(err, "No se pudieron actualizar los responsables");
        return false;
      } finally {
        set({ taskSaving: false });
      }
    },

    async moveTaskToProject(taskId, projectId) {
      const current = currentTask(taskId);
      if (!current) return false;
      if (current.projectId === projectId) return true;
      set({ taskSaving: true, taskMutationError: null, taskConflict: null });
      applyProjectMove({ ...current, projectId });
      try {
        const { task } = await api.moveTaskProject(taskId, {
          project_id: projectId,
          expected_version: current.version,
        });
        applyProjectMove(task);
        // Contexto (fuentes, documentos, roster) del proyecto nuevo, sin spinner.
        void refetchTask(taskId);
        void get().loadProjectPeople(projectId);
        return true;
      } catch (err) {
        applyProjectMove(current);
        const message = normalizeMutationError(err, "No se pudo cambiar la tarea de proyecto");
        set({ taskMutationError: message });
        if (isVersionConflict(err)) await handleConflict(taskId);
        else toastError(err, "No se pudo cambiar la tarea de proyecto");
        return false;
      } finally {
        set({ taskSaving: false });
      }
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

    // ── Notas manuscritas ─────────────────────────────────────────────────

    async loadNotes(projectId) {
      set({ notesLoading: true, notesError: null });
      try {
        const { notes } = await api.notes(projectId);
        set({ notes, notesLoading: false });
      } catch (err) {
        set({
          notesLoading: false,
          notesError: normalizeMutationError(err, "No se pudieron cargar las notas"),
        });
      }
    },

    async createNote(input = {}) {
      try {
        const { note } = await api.createNote({
          ...(input.title ? { title: input.title } : {}),
          ...(input.projectId ? { project_id: input.projectId } : {}),
        });
        set({ notes: [note, ...get().notes], activeNoteId: note.id, noteSavedAt: null });
        return note;
      } catch (err) {
        toastError(err, "No se pudo crear la nota");
        return null;
      }
    },

    openNote(noteId) {
      set({ activeNoteId: noteId, noteSavedAt: null });
    },

    async saveNote(noteId, patch) {
      const current = get().notes.find((n) => n.id === noteId);
      if (!current) return false;
      set({ noteSaving: true });
      try {
        const { note } = await api.saveNote(noteId, {
          ...(patch.title !== undefined ? { title: patch.title } : {}),
          ...(patch.scene !== undefined ? { scene: patch.scene } : {}),
          expected_version: current.version,
        });
        mergeNote(note);
        set({ noteSavedAt: Date.now() });
        return true;
      } catch (err) {
        // 409: otra pestaña guardó antes. Se relee la nota (no se pisa su
        // trabajo) y el lienzo sigue con lo que el usuario tiene delante.
        if (isVersionConflict(err)) {
          try {
            const { note } = await api.note(noteId);
            mergeNote(note);
          } catch {
            /* si tampoco se puede releer, manda el error de abajo */
          }
          get().pushToast("info", "La nota cambió en otra pestaña: se recargó su versión");
          return false;
        }
        toastError(err, "No se pudo guardar la nota");
        return false;
      } finally {
        set({ noteSaving: false });
      }
    },

    async captureNote(noteId, imageBase64) {
      set({ noteCapturing: true });
      try {
        const { note } = await api.captureNote(noteId, { image_base64: imageBase64 });
        mergeNote(note);
        get().pushToast("ok", "Notas terminadas: la imagen quedó guardada");
        return true;
      } catch (err) {
        toastError(err, "No se pudo terminar la nota");
        return false;
      } finally {
        set({ noteCapturing: false });
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

    async sendChatMessage(text, opts) {
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
      // Hint determinista (panel del tablero): manda sobre lo parseado para que
      // el mensaje nunca caiga en otro hilo aunque la slice apunte a otro.
      if (opts?.threadHint) threadHint = opts.threadHint;
      const projectId = opts?.projectId ?? state.activeProjectId ?? undefined;
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
          ...(projectId ? { project_id: projectId } : {}),
        });
        // Hilo nuevo, o el servidor lo enrutó a otro (hint determinista):
        // se abre el que respondió para no mezclar mensajes de dos hilos.
        if (get().chat.threadId !== res.thread_id) {
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
