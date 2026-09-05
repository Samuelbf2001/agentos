/**
 * Avisos deliberadamente acotados del módulo de Proyectos y Tareas.
 *
 * Hay sólo dos causas válidas: `assignment` y `due_24h`.  El destinatario se
 * obtiene de `task_assignees` y se valida contra `people`; nunca se acepta una
 * dirección, asunto o cuerpo desde una petición HTTP.  Sin configuración, el
 * adaptador queda apagado y sólo se conserva una fila auditable `suppressed`.
 */
import {
  appendAudit,
  claimTaskNotificationLog,
  createTaskNotificationLog,
  getPerson,
  listTaskNotificationLogs,
  listTasks,
  markTaskNotificationDelivered,
  markTaskNotificationFailed,
  suppressTaskNotification,
  type AgentosDb,
  type Person,
  type Task,
  type TaskNotificationKind,
  type TaskNotificationStatus,
} from "@agentos/db";
import { type TaskStatus } from "@agentos/shared";
import { listTaskAssignees, type TaskAssigneeView } from "./task-contract.js";

export const NOTIFICATION_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Cada 15 minutos: la ventana de aviso es de 24 h, no hace falta más fino. */
export const DEFAULT_NOTIFICATION_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Intervalo del reloj de recordatorios leído del entorno.
 * `AGENTOS_NOTIFICATIONS_INTERVAL_MS=0` (u `off`/`false`) lo desactiva; sin la
 * variable se usa el default. Un valor no numérico también apaga el reloj en
 * vez de arrancar con una cadencia inventada.
 */
export function resolveNotificationIntervalMs(
  raw: string | undefined = process.env.AGENTOS_NOTIFICATIONS_INTERVAL_MS,
): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_NOTIFICATION_INTERVAL_MS;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "off" || normalized === "false" || normalized === "0") return 0;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.floor(parsed);
}

export interface NotificationScheduler {
  readonly intervalMs: number;
  readonly running: boolean;
  start(): void;
  stop(): void;
  /** Corre un ciclo ya, sin esperar al temporizador (tests y operación). */
  runOnce(): Promise<NotificationDispatchResult>;
}

/**
 * Reloj del procesador de avisos. `processDue` existía pero nadie lo llamaba:
 * sin este temporizador, el recordatorio de vencimiento sólo salía si alguien
 * golpeaba `POST /api/notifications/process-due` a mano.
 *
 * No se solapa consigo mismo (un ciclo lento no encola otro) y un fallo se
 * registra sin tumbar el proceso: el siguiente tick lo reintenta.
 */
export function createNotificationScheduler(input: {
  processor: Pick<NotificationProcessor, "processDue">;
  intervalMs?: number;
  onError?: (err: unknown) => void;
}): NotificationScheduler {
  const intervalMs = input.intervalMs ?? resolveNotificationIntervalMs();
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight = false;

  async function runOnce(): Promise<NotificationDispatchResult> {
    return input.processor.processDue();
  }

  async function tick(): Promise<void> {
    if (inFlight) return;
    inFlight = true;
    try {
      await runOnce();
    } catch (err) {
      input.onError?.(err);
    } finally {
      inFlight = false;
    }
  }

  return {
    intervalMs,
    get running() {
      return timer !== null;
    },
    start(): void {
      if (timer || intervalMs <= 0) return;
      timer = setInterval(() => void tick(), intervalMs);
      timer.unref?.();
    },
    stop(): void {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
    runOnce,
  };
}

export interface EmailMessage {
  to: string;
  subject: string;
  body: string;
}

export interface NotificationDelivery {
  /** false means no provider and, importantly, no network call. */
  readonly enabled: boolean;
  readonly provider?: string;
  readonly disabledReason?: string;
  send(message: EmailMessage): Promise<void> | void;
}

export interface NotificationProcessorOptions {
  db: AgentosDb;
  delivery?: NotificationDelivery;
  now?: () => number;
  windowMs?: number;
}

export interface NotificationLogView {
  id: string;
  taskId: string;
  personId: string;
  kind: TaskNotificationKind;
  scheduledAt: number;
  deliveredAt: number | null;
  status: TaskNotificationStatus;
  dedupeKey: string;
  lastError: string | null;
  createdAt: number;
}

export interface NotificationDispatchResult {
  attempted: number;
  delivered: number;
  suppressed: number;
  failed: number;
  deduped: number;
  skipped: number;
  logs: NotificationLogView[];
}

export interface NotificationProcessor {
  readonly delivery: NotificationDelivery;
  notifyAssignment(input: {
    task: Task;
    beforePersonIds: readonly string[];
    afterAssignees: readonly TaskAssigneeView[];
    actor?: string;
    beforePrimaryPersonId?: string | null;
  }): Promise<NotificationDispatchResult>;
  processDue(now?: number): Promise<NotificationDispatchResult>;
  listLogs(taskId?: string): NotificationLogView[];
}

type UnknownRecord = Record<string, unknown>;

function value(row: UnknownRecord, ...names: string[]): unknown {
  for (const name of names) if (row[name] !== undefined) return row[name];
  return undefined;
}

function stringValue(row: UnknownRecord, ...names: string[]): string | null {
  const v = value(row, ...names);
  return typeof v === "string" ? v : null;
}

function numberValue(row: UnknownRecord, ...names: string[]): number | null {
  const v = value(row, ...names);
  return typeof v === "number" ? v : null;
}

function statusValue(valueToNormalize: unknown): TaskNotificationStatus {
  if (
    valueToNormalize === "pending" ||
    valueToNormalize === "processing" ||
    valueToNormalize === "delivered" ||
    valueToNormalize === "failed" ||
    valueToNormalize === "suppressed"
  ) {
    return valueToNormalize;
  }
  return "pending";
}

function kindValue(valueToNormalize: unknown): TaskNotificationKind {
  return valueToNormalize === "due_24h" ? "due_24h" : "assignment";
}

function normalizeLog(valueToNormalize: unknown): NotificationLogView | undefined {
  if (!valueToNormalize || typeof valueToNormalize !== "object") return undefined;
  const row = valueToNormalize as UnknownRecord;
  const id = stringValue(row, "id");
  const taskId = stringValue(row, "taskId", "task_id");
  const personId = stringValue(row, "personId", "person_id");
  const dedupeKey = stringValue(row, "dedupeKey", "dedupe_key");
  const scheduledAt = numberValue(row, "scheduledAt", "scheduled_at");
  const createdAt = numberValue(row, "createdAt", "created_at");
  if (!id || !taskId || !personId || !dedupeKey || scheduledAt === null || createdAt === null) return undefined;
  return {
    id,
    taskId,
    personId,
    kind: kindValue(value(row, "kind")),
    scheduledAt,
    deliveredAt: numberValue(row, "deliveredAt", "delivered_at"),
    status: statusValue(value(row, "status")),
    dedupeKey,
    lastError: stringValue(row, "lastError", "last_error"),
    createdAt,
  };
}

function offDelivery(reason = "Proveedor de correo no configurado"): NotificationDelivery {
  return {
    enabled: false,
    provider: "off",
    disabledReason: reason,
    send: async () => {
      // Deliberately empty: no fetch, SMTP client or other network path.
    },
  };
}

/**
 * Adaptador HTTP explícito.  La URL y el remitente deben estar configurados;
 * el desarrollo y los tests usan `offDelivery` o un fake inyectado.
 */
export function createEmailDeliveryFromEnv(env: NodeJS.ProcessEnv = process.env): NotificationDelivery {
  const endpoint = env.AGENTOS_EMAIL_PROVIDER_URL?.trim();
  const from = env.AGENTOS_EMAIL_FROM?.trim();
  if (!endpoint || !from) return offDelivery("AGENTOS_EMAIL_PROVIDER_URL y AGENTOS_EMAIL_FROM no están configurados");
  const apiKey = env.AGENTOS_EMAIL_PROVIDER_KEY?.trim();
  return {
    enabled: true,
    provider: "http",
    async send(message) {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({ from, to: message.to, subject: message.subject, body: message.body }),
      });
      if (!response.ok) throw new Error(`Proveedor de correo respondió ${response.status}`);
    },
  };
}

function asPerson(personId: string, db: AgentosDb): Person | undefined {
  return getPerson(db, personId);
}

function isTerminal(status: TaskStatus): boolean {
  return status === "DONE" || status === "CANCELLED";
}

function normalizeIds(rows: readonly TaskAssigneeView[]): string[] {
  return [...new Set(rows.map((row) => row.personId))];
}

function listLogs(db: AgentosDb, taskId?: string): NotificationLogView[] {
  const rows = listTaskNotificationLogs(db, taskId ? { taskId } : {});
  return rows.map(normalizeLog).filter((row): row is NotificationLogView => row !== undefined);
}

function insertLog(
  db: AgentosDb,
  input: Omit<NotificationLogView, "id" | "deliveredAt" | "createdAt"> & { createdAt?: number },
): { row: NotificationLogView; inserted: boolean } {
  const now = input.createdAt ?? Date.now();
  const payload = {
    taskId: input.taskId,
    personId: input.personId,
    kind: input.kind,
    scheduledAt: input.scheduledAt,
    status: input.status,
    dedupeKey: input.dedupeKey,
    lastError: input.lastError,
    createdAt: now,
  };
  const result = createTaskNotificationLog(db, payload);
  const normalized = normalizeLog(result.notification);
  if (!normalized) throw new Error("No se pudo leer el log de notificación recién creado");
  return { row: normalized, inserted: result.inserted };
}

function updateLog(
  db: AgentosDb,
  row: NotificationLogView,
  patch: Pick<NotificationLogView, "status" | "deliveredAt" | "lastError">,
): NotificationLogView {
  const updated =
    patch.status === "delivered"
      ? markTaskNotificationDelivered(db, row.id, patch.deliveredAt ?? Date.now())
      : patch.status === "failed"
        ? markTaskNotificationFailed(db, row.id, patch.lastError ?? "Error de entrega")
        : suppressTaskNotification(db, row.id, patch.lastError ?? "Proveedor no configurado");
  const normalized = normalizeLog(updated);
  if (!normalized) throw new Error("No se pudo actualizar el log de notificación");
  return normalized;
}

function auditNotification(db: AgentosDb, row: NotificationLogView, actor: string, detail: Record<string, unknown>): void {
  appendAudit(db, {
    actor,
    source: actor.startsWith("person:") ? "ui" : "system",
    action: `notification.${row.kind}.${row.status}`,
    entityType: "task_notification",
    entityId: row.id,
    after: { taskId: row.taskId, personId: row.personId, dedupeKey: row.dedupeKey, ...detail },
  });
}

function noEmailReason(delivery: NotificationDelivery): string {
  return delivery.disabledReason ?? "Proveedor de correo no configurado";
}

function deterministicAssignmentMessage(task: Task, person: Person): EmailMessage {
  return {
    to: person.email!,
    subject: `[AgentOS] Tarea asignada: ${task.title}`,
    body: `Se te asignó la tarea "${task.title}". Proyecto: ${task.projectId}. Estado actual: ${task.status}.`,
  };
}

function deterministicDueMessage(task: Task, person: Person): EmailMessage {
  return {
    to: person.email!,
    subject: `[AgentOS] Tarea próxima a vencer: ${task.title}`,
    body: `La tarea "${task.title}" vence el ${new Date(task.dueAt!).toISOString()}. Proyecto: ${task.projectId}.`,
  };
}

function emptyResult(): NotificationDispatchResult {
  return { attempted: 0, delivered: 0, suppressed: 0, failed: 0, deduped: 0, skipped: 0, logs: [] };
}

/** Crea el adaptador y el procesador. No se ejecuta ningún envío al construirlo. */
export function createNotificationProcessor(options: NotificationProcessorOptions): NotificationProcessor {
  const delivery = options.delivery ?? createEmailDeliveryFromEnv();
  const now = options.now ?? Date.now;
  const windowMs = options.windowMs ?? NOTIFICATION_WINDOW_MS;

  async function dispatch(
    task: Task,
    person: Person,
    kind: TaskNotificationKind,
    dedupeKey: string,
    scheduledAt: number,
    actor: string,
    message: EmailMessage,
  ): Promise<{ result: NotificationDispatchResult; log: NotificationLogView }> {
    const result = emptyResult();
    const initialStatus: TaskNotificationStatus = delivery.enabled ? "pending" : "suppressed";
    const initialError = delivery.enabled ? null : noEmailReason(delivery);
    const inserted = insertLog(options.db, {
      taskId: task.id,
      personId: person.id,
      kind,
      scheduledAt,
      status: initialStatus,
      dedupeKey,
      lastError: initialError,
    });
    let row = inserted.row;
    if (!delivery.enabled) {
      if (!inserted.inserted) {
        result.deduped = 1;
        result.skipped = 1;
        result.logs.push(row);
        return { result, log: row };
      }
      result.suppressed = 1;
      auditNotification(options.db, row, actor, { reason: initialError, provider: delivery.provider ?? "off" });
      result.logs.push(row);
      return { result, log: row };
    }

    // Un aviso nuevo y un reintento fallido pasan por el mismo claim. Así un
    // segundo worker no puede enviar mientras el primero está en `processing`,
    // y un fallo transitorio conserva la misma dedupe_key en vez de crear otro
    // correo. Los logs delivered/suppressed no vuelven a ejecutarse.
    if (!claimTaskNotificationLog(options.db, row.id, now())) {
      result.deduped = 1;
      result.skipped = 1;
      result.logs.push(row);
      return { result, log: row };
    }
    row = normalizeLog(listTaskNotificationLogs(options.db, { taskId: row.taskId }).find((entry) => entry.id === row.id)) ?? row;
    result.attempted = 1;
    try {
      await delivery.send(message);
      row = updateLog(options.db, row, { status: "delivered", deliveredAt: now(), lastError: null });
      result.delivered = 1;
      auditNotification(options.db, row, actor, { provider: delivery.provider ?? "configured" });
    } catch (err) {
      const lastError = err instanceof Error ? err.message : String(err);
      row = updateLog(options.db, row, { status: "failed", deliveredAt: null, lastError });
      result.failed = 1;
      auditNotification(options.db, row, actor, { error: lastError, provider: delivery.provider ?? "configured" });
    }
    result.logs.push(row);
    return { result, log: row };
  }

  async function notifyAssignment(input: {
    task: Task;
    beforePersonIds: readonly string[];
    afterAssignees: readonly TaskAssigneeView[];
    actor?: string;
    beforePrimaryPersonId?: string | null;
  }): Promise<NotificationDispatchResult> {
    const result = emptyResult();
    const task = input.task;
    if (isTerminal(task.status)) {
      result.skipped = input.afterAssignees.length;
      return result;
    }
    const before = new Set(input.beforePersonIds);
    const primary = input.afterAssignees.find((row) => row.isPrimary)?.personId ?? null;
    const beforePrimary = input.beforePrimaryPersonId ?? input.beforePersonIds[0] ?? null;
    const candidates = input.afterAssignees.filter(
      (row) => !before.has(row.personId) || (row.isPrimary && primary !== beforePrimary),
    );
    const snapshot = `${normalizeIds(input.afterAssignees).sort().join(",")}|primary=${primary ?? ""}`;
    for (const assignment of candidates) {
      const person = asPerson(assignment.personId, options.db);
      if (!person?.email) {
        result.skipped += 1;
        continue;
      }
      const dedupeKey = `${task.id}:assignment:v${task.version}:${snapshot}:${person.id}`;
      const dispatched = await dispatch(
        task,
        person,
        "assignment",
        dedupeKey,
        now(),
        input.actor ?? "system:notifications",
        deterministicAssignmentMessage(task, person),
      );
      result.attempted += dispatched.result.attempted;
      result.delivered += dispatched.result.delivered;
      result.suppressed += dispatched.result.suppressed;
      result.failed += dispatched.result.failed;
      result.deduped += dispatched.result.deduped;
      result.skipped += dispatched.result.skipped;
      result.logs.push(...dispatched.result.logs);
    }
    return result;
  }

  async function processDue(nowAt = now()): Promise<NotificationDispatchResult> {
    const result = emptyResult();
    const tasks = listTasks(options.db);
    for (const task of tasks) {
      if (isTerminal(task.status) || typeof task.dueAt !== "number") {
        continue;
      }
      if (task.dueAt < nowAt || task.dueAt > nowAt + windowMs) continue;
      let assignees = listTaskAssignees(options.db, task.id);
      if (assignees.length === 0 && task.assigneePersonId) {
        assignees = [
          {
            taskId: task.id,
            personId: task.assigneePersonId,
            isPrimary: true,
            assignedBy: "legacy:tasks.assignee_person_id",
            createdAt: task.createdAt,
          },
        ];
      }
      for (const assignment of assignees) {
        const person = asPerson(assignment.personId, options.db);
        if (!person?.email) {
          result.skipped += 1;
          continue;
        }
        const dedupeKey = `${task.id}:due_24h:${person.id}:due=${task.dueAt}`;
        const dispatched = await dispatch(
          task,
          person,
          "due_24h",
          dedupeKey,
          nowAt,
          "system:notifications",
          deterministicDueMessage(task, person),
        );
        result.attempted += dispatched.result.attempted;
        result.delivered += dispatched.result.delivered;
        result.suppressed += dispatched.result.suppressed;
        result.failed += dispatched.result.failed;
        result.deduped += dispatched.result.deduped;
        result.skipped += dispatched.result.skipped;
        result.logs.push(...dispatched.result.logs);
      }
    }
    return result;
  }

  return {
    delivery,
    notifyAssignment,
    processDue,
    listLogs: (taskId?: string) => listLogs(options.db, taskId),
  };
}
