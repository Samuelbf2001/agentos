/**
 * Contexto de la aplicación (B4): apps/api es el DUEÑO ÚNICO de SQLite, del bus
 * de eventos, del despachador, del RunnerPool y del WebSocket (ARCHITECTURE §1).
 * Todo se construye aquí, una vez, y las rutas lo reciben inyectado.
 */
import { errors, nowMs, type AgentRuntime, type WhatsAppHubConnector } from "@agentos/shared";
import {
  applyMigrations,
  closeAnyDb,
  countDomainTables,
  domainCounts,
  openConfiguredDb,
  type DbDriver,
  seedCatalog,
  seedDemo,
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
import { createAuthService, resolveCookieSecure, type AuthService } from "./auth.js";
import { createDispatcher, type Dispatcher } from "./dispatcher.js";
import { recoverOnBoot, type RecoveryReport } from "./recovery.js";
import {
  createNotificationProcessor,
  createNotificationScheduler,
  type NotificationDelivery,
  type NotificationProcessor,
  type NotificationScheduler,
} from "./notifications.js";

export const API_VERSION = "0.1.0";
export const DEFAULT_PORT = 4300;
export const DEFAULT_WEB_ORIGIN = "http://localhost:4301";
/** Contraseña de conveniencia SOLO para desarrollo; en producción se exige env. */
export const DEV_SHARED_PASSWORD = "agentos-dev";

/** Límites de tasa de las rutas públicas (peticiones por ventana, por IP). */
export interface RateLimitRule {
  max: number;
  timeWindowMs: number;
}
export interface RateLimitConfig {
  login: RateLimitRule;
  people: RateLimitRule;
}
export const DEFAULT_RATE_LIMITS: RateLimitConfig = {
  login: { max: 10, timeWindowMs: 60_000 },
  people: { max: 30, timeWindowMs: 60_000 },
};

/** ¿Estamos en producción? Único punto de verdad para las guardas fail-closed. */
export function isProductionEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.NODE_ENV ?? "").trim().toLowerCase() === "production";
}

/**
 * Modo pruebas ("sandbox"): entrada sin contraseña sobre una COPIA local de la
 * base de datos. `AGENTOS_SANDBOX=1/true` lo activa. Fail-closed: jamás
 * convive con `NODE_ENV=production` — se lanza el mismo tipo de error de
 * configuración que las demás guardas en vez de arrancar con un agujero de
 * autenticación en un despliegue real.
 */
const SANDBOX_IN_PRODUCTION_MESSAGE =
  "AGENTOS_SANDBOX no puede activarse con NODE_ENV=production: el modo pruebas permite entrar sin contraseña y solo existe para copias locales de la base de datos.";

export function resolveSandbox(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.AGENTOS_SANDBOX ?? "").trim().toLowerCase();
  const sandbox = raw === "1" || raw === "true";
  if (sandbox && isProductionEnv(env)) {
    throw errors.configuration(SANDBOX_IN_PRODUCTION_MESSAGE, { variable: "AGENTOS_SANDBOX" });
  }
  return sandbox;
}

/**
 * ¿El arranque debe sembrar la demo (org ACME + launch del módulo Consultoría)?
 * El catálogo (org Sixteam, agentes, metodologías, módulos, proveedores,
 * config) se siembra SIEMPRE — es idempotente y no expone datos de cliente.
 *
 * `AGENTOS_SEED_DEMO=0/false/off` desactiva la demo explícitamente, en
 * cualquier entorno. Sin la variable, el default depende de `NODE_ENV`: en
 * producción NO se siembra (una base Postgres vacía en el despliegue real no
 * debe amanecer con el proyecto demo de ACME); en desarrollo se mantiene el
 * comportamiento histórico (demo sí).
 */
export function shouldSeedDemo(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.AGENTOS_SEED_DEMO?.trim().toLowerCase();
  if (raw === "0" || raw === "false" || raw === "off") return false;
  if (raw) return true; // valor explícito no reconocido como "apagado" ⇒ fuerza la demo
  return !isProductionEnv(env);
}

/**
 * Contraseña compartida. En producción es OBLIGATORIA: sin ella se lanza en el
 * arranque (antes había un fail-open a `agentos-dev` con un simple console.warn,
 * que dejaba cualquier despliegue abierto con una contraseña pública).
 */
export function resolveSharedPassword(
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const value = explicit?.trim() || env.AGENTOS_SHARED_PASSWORD?.trim();
  if (value) return value;
  if (isProductionEnv(env)) {
    throw errors.configuration(
      "AGENTOS_SHARED_PASSWORD es obligatoria con NODE_ENV=production: define una contraseña compartida propia antes de arrancar (jamás se usa la de desarrollo en producción).",
      { variable: "AGENTOS_SHARED_PASSWORD" },
    );
  }
  console.warn(
    `[agentos-api] AGENTOS_SHARED_PASSWORD no está definida: usando la contraseña de desarrollo '${DEV_SHARED_PASSWORD}'.`,
  );
  return DEV_SHARED_PASSWORD;
}

/**
 * Secreto de firma de sesiones. En producción es OBLIGATORIO y explícito; en
 * desarrollo se devuelve `undefined` y `createAuthService` lo deriva de la
 * contraseña (comportamiento histórico). Rotarlo invalida las sesiones vivas.
 */
export function resolveSessionSecret(
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const value = explicit?.trim() || env.AGENTOS_SESSION_SECRET?.trim();
  if (value) return value;
  if (isProductionEnv(env)) {
    throw errors.configuration(
      "AGENTOS_SESSION_SECRET es obligatoria con NODE_ENV=production: define un secreto largo y aleatorio (rotarlo invalida todas las sesiones).",
      { variable: "AGENTOS_SESSION_SECRET" },
    );
  }
  return undefined;
}

export interface ApiOptions {
  /** Ruta de la DB (default: env AGENTOS_DB_PATH o ./data/agentos.db). */
  dbPath?: string;
  /** Backend explícito; por defecto se resuelve desde AGENTOS_DB_DRIVER (sqlite). */
  dbDriver?: DbDriver;
  /** URL PG explícita para el runtime asíncrono (por defecto AGENTOS_PG_URL). */
  pgUrl?: string;
  /**
   * Aplica seeds al arrancar (default true; los seeds son idempotentes).
   * Siempre siembra el catálogo; la demo depende de `AGENTOS_SEED_DEMO`
   * (ver `shouldSeedDemo`).
   */
  seedOnBoot?: boolean;
  /** Contraseña compartida (default: env AGENTOS_SHARED_PASSWORD; obligatoria en producción). */
  sharedPassword?: string;
  /** Secreto de firma de sesiones (default: env AGENTOS_SESSION_SECRET; obligatorio en producción). */
  sessionSecret?: string;
  /** Fuerza el atributo `Secure` de la cookie (default: AGENTOS_COOKIE_SECURE / producción). */
  cookieSecure?: boolean;
  /** Límites de tasa de las rutas públicas (tests los bajan para provocar el 429). */
  rateLimit?: { login?: Partial<RateLimitRule>; people?: Partial<RateLimitRule> };
  /** Secreto opcional del gateway de canales (header x-channel-secret). */
  channelSecret?: string;
  /**
   * Modo pruebas: entrada sin contraseña (tests). Por defecto sale de
   * `AGENTOS_SANDBOX`; la guarda de producción se aplica siempre sobre el
   * valor final, override incluido.
   */
  sandbox?: boolean;
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
  /**
   * Cadencia del reloj de recordatorios (`processDue`). Por defecto sale de
   * `AGENTOS_NOTIFICATIONS_INTERVAL_MS`; 0 lo deja apagado.
   */
  notificationIntervalMs?: number;
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
  /** Reloj que dispara `processDue`; apagado si el intervalo es 0. */
  notificationScheduler: NotificationScheduler;
  pool: RunnerPool;
  dispatcher: Dispatcher;
  auth: AuthService;
  recovery: RecoveryReport;
  startedAt: number;
  channelSecret?: string | undefined;
  corsOrigin: string | string[];
  rateLimits: RateLimitConfig;
  /** Modo pruebas activo: entrada sin contraseña habilitada (ver `resolveSandbox`). */
  sandbox: boolean;
  close(): Promise<void>;
}

/**
 * Origen(es) permitidos por CORS. `AGENTOS_WEB_ORIGIN` admite una lista separada
 * por comas (varias copias de la app o varios dominios). Reglas fail-closed:
 * `*` NUNCA se acepta (la API va con `credentials: true`) y en producción la
 * variable es obligatoria — sin lista explícita no se sirve nada. En desarrollo
 * se conserva el default de cero fricción (`http://localhost:4301`). Los
 * orígenes fuera de la lista no reciben `access-control-allow-origin`.
 */
export function resolveCorsOrigin(
  raw: string | undefined = process.env.AGENTOS_WEB_ORIGIN,
  env: NodeJS.ProcessEnv = process.env,
): string | string[] {
  const origins = (raw ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (origins.includes("*")) {
    throw errors.configuration(
      "AGENTOS_WEB_ORIGIN no admite '*': la API viaja con credenciales (cookie de sesión). Enumera los orígenes exactos separados por comas.",
      { variable: "AGENTOS_WEB_ORIGIN" },
    );
  }
  if (origins.length === 0) {
    if (isProductionEnv(env)) {
      throw errors.configuration(
        "AGENTOS_WEB_ORIGIN es obligatoria con NODE_ENV=production: enumera los orígenes exactos de la web (lista separada por comas, sin '*').",
        { variable: "AGENTOS_WEB_ORIGIN" },
      );
    }
    return DEFAULT_WEB_ORIGIN;
  }
  return origins.length === 1 ? origins[0]! : origins;
}

/** Límites de tasa efectivos (los defaults se pueden bajar en tests). */
export function resolveRateLimits(
  overrides: ApiOptions["rateLimit"] = undefined,
): RateLimitConfig {
  return {
    login: { ...DEFAULT_RATE_LIMITS.login, ...(overrides?.login ?? {}) },
    people: { ...DEFAULT_RATE_LIMITS.people, ...(overrides?.people ?? {}) },
  };
}

export async function createApiContext(options: ApiOptions = {}): Promise<ApiContext> {
  // 0) Guardas de configuración ANTES de tocar disco/red: en producción, una
  // instalación sin contraseña, sin secreto de sesión o sin orígenes CORS no
  // arranca (fail-closed) en vez de servir con valores de desarrollo.
  const sharedPassword = resolveSharedPassword(options.sharedPassword);
  const sessionSecret = resolveSessionSecret(options.sessionSecret);
  const corsOrigin = options.corsOrigin ?? resolveCorsOrigin();
  const rateLimits = resolveRateLimits(options.rateLimit);
  const cookieSecure = options.cookieSecure ?? resolveCookieSecure();
  // El override de tests también pasa por la guarda de producción: nadie
  // fuerza `sandbox: true` con NODE_ENV=production, ni siquiera un test.
  const sandbox = options.sandbox ?? resolveSandbox();
  if (options.sandbox !== undefined && sandbox && isProductionEnv()) {
    throw errors.configuration(SANDBOX_IN_PRODUCTION_MESSAGE, { variable: "AGENTOS_SANDBOX" });
  }
  if (sandbox) {
    console.log(
      "[agentos-api] MODO PRUEBAS activo: entrada sin contraseña habilitada. Nunca uses este proceso contra la base de datos real.",
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
    // El catálogo se siembra siempre (idempotente); la demo solo si el flag
    // no la desactiva (default: sí en desarrollo, no en producción).
    await seedCatalog(db);
    if (shouldSeedDemo()) {
      await seedDemo(db);
    }
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
  // 6b. Reloj de recordatorios: `processDue` ya existía pero nadie lo llamaba.
  const notificationScheduler = createNotificationScheduler({
    processor: notifications,
    ...(options.notificationIntervalMs !== undefined
      ? { intervalMs: options.notificationIntervalMs }
      : {}),
    onError: (err) => {
      console.warn("[agentos-api] ciclo de recordatorios falló:", err);
    },
  });
  if (options.autoStartLoops !== false) {
    dispatcher.start();
    notificationScheduler.start();
  }

  const auth = createAuthService({
    sharedPassword,
    ...(sessionSecret ? { sessionSecret } : {}),
    cookieSecure,
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
    notificationScheduler,
    pool,
    dispatcher,
    auth,
    recovery,
    startedAt: nowMs(),
    channelSecret: options.channelSecret ?? process.env.AGENTOS_CHANNEL_WEB_SECRET,
    corsOrigin,
    rateLimits,
    sandbox,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      dispatcher.stop();
      notificationScheduler.stop();
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
