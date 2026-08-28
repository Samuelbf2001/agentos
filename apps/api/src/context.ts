/**
 * Contexto de la aplicación (B4): apps/api es el DUEÑO ÚNICO de SQLite, del bus
 * de eventos, del despachador, del RunnerPool y del WebSocket (ARCHITECTURE §1).
 * Todo se construye aquí, una vez, y las rutas lo reciben inyectado.
 */
import { nowMs, type AgentRuntime, type WhatsAppHubConnector } from "@agentos/shared";
import {
  closeDb,
  countDomainTables,
  openDb,
  runMigrations,
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

export const API_VERSION = "0.1.0";
export const DEFAULT_PORT = 4300;
export const DEFAULT_WEB_ORIGIN = "http://localhost:4301";

export interface ApiOptions {
  /** Ruta de la DB (default: env AGENTOS_DB_PATH o ./data/agentos.db). */
  dbPath?: string;
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
  pool: RunnerPool;
  dispatcher: Dispatcher;
  auth: AuthService;
  recovery: RecoveryReport;
  startedAt: number;
  channelSecret?: string | undefined;
  corsOrigin: string | string[];
  close(): void;
}

export function createApiContext(options: ApiOptions = {}): ApiContext {
  const sharedPassword =
    options.sharedPassword ?? process.env.AGENTOS_SHARED_PASSWORD ?? "agentos-dev";
  if (!options.sharedPassword && !process.env.AGENTOS_SHARED_PASSWORD) {
    console.warn(
      "[agentos-api] AGENTOS_SHARED_PASSWORD no está definida: usando la contraseña de desarrollo 'agentos-dev'.",
    );
  }

  // 1) DB: abrir y migrar si falta (idempotente).
  const db = openDb(options.dbPath);
  runMigrations(db);
  if (options.seedOnBoot !== false) {
    seed(db);
  }

  // 2) Bus de eventos (DB = fuente de verdad, ring buffer por topic).
  const bus = createBus(db);
  const sink = busSink(bus);

  // 3) Motor del tablero + gateway de tools (comparten sink y engine).
  // El conector WhatsAppHub (Fuentes del proyecto) se inyecta al gateway para
  // que la tool sources.ingest use el MISMO cliente que las rutas REST.
  const whatsappHub = options.whatsappHub ?? createWhatsAppHubConnector();
  const engine = createBoardEngine({ db, sink, ...(options.leaseMs ? { leaseMs: options.leaseMs } : {}) });
  const toolRuntime = createToolRuntime({ db, sink, engine, whatsappHub });

  // 4) Recuperación al arrancar (NFR-4) ANTES de despachar nada.
  const recovery = recoverOnBoot(db, engine);

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
  const dispatcher = createDispatcher({
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
    pool,
    dispatcher,
    auth,
    recovery,
    startedAt: nowMs(),
    channelSecret: options.channelSecret ?? process.env.AGENTOS_CHANNEL_WEB_SECRET,
    corsOrigin: options.corsOrigin ?? DEFAULT_WEB_ORIGIN,
    close(): void {
      if (closed) return;
      closed = true;
      dispatcher.stop();
      closeDb(db);
    },
  };
}

export function healthCounts(db: AgentosDb): Record<string, number> {
  const one = (sql: string): number => (db.$client.prepare(sql).get() as { n: number }).n;
  return {
    tables: countDomainTables(db),
    organizations: one("SELECT count(*) n FROM organizations"),
    projects: one("SELECT count(*) n FROM projects"),
    tasks: one("SELECT count(*) n FROM tasks"),
    agents: one("SELECT count(*) n FROM agents"),
    threads: one("SELECT count(*) n FROM threads"),
    messages: one("SELECT count(*) n FROM messages"),
    runs_total: one("SELECT count(*) n FROM runs"),
    runs_running: one("SELECT count(*) n FROM runs WHERE status = 'running'"),
    runs_queued: one("SELECT count(*) n FROM runs WHERE status = 'queued'"),
    approvals_pending: one("SELECT count(*) n FROM approvals WHERE status = 'pending'"),
    events: one("SELECT count(*) n FROM events"),
  };
}
