/**
 * Contexto de la aplicación (B4): apps/api es el DUEÑO ÚNICO de SQLite, del bus
 * de eventos, del despachador, del RunnerPool y del WebSocket (ARCHITECTURE §1).
 * Todo se construye aquí, una vez, y las rutas lo reciben inyectado.
 */
import { nowMs, type AgentRuntime, type WhatsAppHubConnector } from "@agentos/shared";
import {
  applyMigrations,
  closeAnyDb,
  countDomainTables,
  domainCounts,
  openConfiguredDb,
  type DbDriver,
  seed,
  type AgentosDb,
} from "@agentos/db";
import type { EventBus } from "@agentos/events";
import { createBoardEngine, type BoardEngine, type EventSink } from "@agentos/core";
import { createToolRuntime, type ToolRuntime } from "@agentos/tools";
import {
  AiSdkRunner,
  ClaudeCodeRunner,
  RunnerPool,
  type AgentRunner,
} from "@agentos/runners";
import { createWhatsAppHubConnector } from "./connectors/whatsapphub.js";
import { busSink, createBus } from "./bus-bridge.js";
import { createAuthService, type AuthService } from "./auth.js";
import { createDispatcher, type Dispatcher } from "./dispatcher.js";
import { recoverOnBoot, type RecoveryReport } from "./recovery.js";
import {
  createNotificationProcessor,
  type NotificationDelivery,
  type NotificationProcessor,
} from "./notifications.js";

export const API_VERSION = "0.1.0";
export const DEFAULT_PORT = 4300;
export const DEFAULT_WEB_ORIGIN = "http://localhost:4301";

export interface ApiOptions {
  /** Ruta de la DB (default: env AGENTOS_DB_PATH o ./data/agentos.db). */
  dbPath?: string;
  /** Backend explícito; por defecto se resuelve desde AGENTOS_DB_DRIVER (sqlite). */
  dbDriver?: DbDriver;
  /** URL PG explícita para el runtime asíncrono (por defecto AGENTOS_PG_URL). */
  pgUrl?: string;
  /** Aplica seeds al arrancar (default true; los seeds son idempotentes). */
  seedOnBoot?: boolean;
  /** Contraseña compartida (default: env AGENTOS_SHARED_PASSWORD). */
  sharedPassword?: string;
  sessionSecret?: string;
  /** Secreto opcional del gateway de canales (header x-channel-secret). */
  channelSecret?: string;
  /** Runners inyectables (tests: SIEMPRE fakes; jamás LLM real en tests). */
  runners?: Partial<Record<AgentRuntime, AgentRunner>>;
  /** Arranca los bucles (despachador + reaper) automáticamente (default true). */
  autoStartLoops?: boolean;
  /** Conector WhatsAppHub inyectable (tests: SIEMPRE mock; jamás red real en tests). */
  whatsappHub?: WhatsAppHubConnector;
  /** Adaptador de avisos; por defecto queda apagado y no toca la red. */
  notificationDelivery?: NotificationDelivery;
  /** Reloj inyectable para tests de ventana 24h y deduplicación. */
  notificationNow?: () => number;
  dispatchIntervalMs?: number;
  reaperIntervalMs?: number;
  leaseMs?: number;
  defaultRunTimeoutMs?: number;
  corsOrigin?: string | string[];
  logger?: boolean;
}

export interface ApiContext {
  db: AgentosDb;
  bus: EventBus;
  sink: EventSink;
  engine: BoardEngine;
  toolRuntime: ToolRuntime;
  /** Conector 2brain/WhatsAppHub (Fuentes del proyecto). */
  whatsappHub: WhatsAppHubConnector;
  /** Procesador de los únicos avisos permitidos por el MVP. */
  notifications: NotificationProcessor;
  pool: RunnerPool;
  dispatcher: Dispatcher;
  auth: AuthService;
  recovery: RecoveryReport;
  startedAt: number;
  channelSecret?: string | undefined;
  corsOrigin: string | string[];
  close(): Promise<void>;
}

export async function createApiContext(options: ApiOptions = {}): Promise<ApiContext> {
  const sharedPassword =
    options.sharedPassword ?? process.env.AGENTOS_SHARED_PASSWORD ?? "agentos-dev";
  if (!options.sharedPassword && !process.env.AGENTOS_SHARED_PASSWORD) {
    console.warn(
      "[agentos-api] AGENTOS_SHARED_PASSWORD no está definida: usando la contraseña de desarrollo 'agentos-dev'.",
    );
  }

  // 1) DB: abrir y migrar según el driver configurado (idempotente).
  const db = await openConfiguredDb({
    ...(options.dbDriver ? { driver: options.dbDriver } : {}),
    ...(options.dbPath ? { dbPath: options.dbPath } : {}),
    ...(options.pgUrl ? { pgUrl: options.pgUrl } : {}),
  });
  await applyMigrations(db);
  if (options.seedOnBoot !== false) {
    await seed(db);
  }

  // 2) Bus de eventos (DB = fuente de verdad, ring buffer por topic).
  const bus = createBus(db);
  const sink = busSink(bus);

  // 3) Motor del tablero + gateway de tools (comparten sink y engine).
  // El conector WhatsAppHub (Fuentes del proyecto) se inyecta al gateway para
  // que la tool sources.ingest use el MISMO cliente que las rutas REST.
  const whatsappHub = options.whatsappHub ?? createWhatsAppHubConnector();
  const notifications = createNotificationProcessor({
    db,
    ...(options.notificationDelivery ? { delivery: options.notificationDelivery } : {}),
    ...(options.notificationNow ? { now: options.notificationNow } : {}),
  });
  const engine = createBoardEngine({ db, sink, ...(options.leaseMs ? { leaseMs: options.leaseMs } : {}) });
  const toolRuntime = createToolRuntime({
    db,
    sink,
    engine,
    whatsappHub,
    notifyAssignment: (input) =>
      notifications.notifyAssignment({
        task: input.task,
        beforePersonIds: input.beforePersonIds,
        beforePrimaryPersonId: input.beforePrimaryPersonId,
        afterAssignees: input.afterAssignees,
        actor: input.actor,
      }),
  });

  // 4) Recuperación al arrancar (NFR-4) ANTES de despachar nada.
  const recovery = await recoverOnBoot(db, engine);

  // 5) RunnerPool con los runners reales (o los inyectados por tests).
  const runners: Partial<Record<AgentRuntime, AgentRunner>> =
    options.runners ?? {
      ai_sdk: new AiSdkRunner({ db }),
      claude_code: new ClaudeCodeRunner({ db }),
    };
  const pool = new RunnerPool({
    db,
    bus,
    runners,
    ...(options.defaultRunTimeoutMs !== undefined
      ? { defaultTimeoutMs: options.defaultRunTimeoutMs }
      : {}),
  });

  // 6) Despachador determinista.
  const dispatcher = await createDispatcher({
    db,
    bus,
    engine,
    toolRuntime,
    pool,
    ...(options.dispatchIntervalMs !== undefined
      ? { dispatchIntervalMs: options.dispatchIntervalMs }
      : {}),
    ...(options.reaperIntervalMs !== undefined ? { reaperIntervalMs: options.reaperIntervalMs } : {}),
    ...(options.leaseMs !== undefined ? { leaseMs: options.leaseMs } : {}),
  });
  if (options.autoStartLoops !== false) {
    dispatcher.start();
  }

  const auth = createAuthService({
    sharedPassword,
    ...(options.sessionSecret ? { sessionSecret: options.sessionSecret } : {}),
  });

  let closed = false;
  return {
    db,
    bus,
    sink,
    engine,
    toolRuntime,
    whatsappHub,
    notifications,
    pool,
    dispatcher,
    auth,
    recovery,
    startedAt: nowMs(),
    channelSecret: options.channelSecret ?? process.env.AGENTOS_CHANNEL_WEB_SECRET,
    corsOrigin: options.corsOrigin ?? DEFAULT_WEB_ORIGIN,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      dispatcher.stop();
      await closeAnyDb(db);
    },
  };
}

export async function healthCounts(db: AgentosDb): Promise<Record<string, number>> {
  const counts = await domainCounts(db);
  return {
    tables: await countDomainTables(db),
    organizations: counts.organizations,
    projects: counts.projects,
    tasks: counts.tasks,
    agents: counts.agents,
    threads: counts.threads,
    messages: counts.messages,
    runs_total: counts.runsTotal,
    runs_running: counts.runsRunning,
    runs_queued: counts.runsQueued,
    approvals_pending: counts.approvalsPending,
    events: counts.events,
  };
}
