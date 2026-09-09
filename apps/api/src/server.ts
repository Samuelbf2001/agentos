/**
 * Servidor Fastify de apps/api (B4). buildApi() arma el contexto (DB, bus,
 * pool, despachador, recuperación) y monta REST (/api), canal web (/v1) y
 * WebSocket (/ws). Todo endpoint —salvo login/health/people— exige sesión.
 */
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import multipart from "@fastify/multipart";
import { errors } from "@agentos/shared";
import { getPerson } from "@agentos/db";
import { createApiContext, type ApiContext, type ApiOptions } from "./context.js";
import { extractToken, type Session } from "./auth.js";
import { handleApiError } from "./http-errors.js";
import { maxArtifactBytes } from "./artifact-files.js";
import { registerAuthAndHealth } from "./routes/auth-health.js";
import { registerBoardRoutes } from "./routes/board.js";
import { registerModuleRoutes } from "./routes/modules.js";
import { registerOpsRoutes } from "./routes/ops.js";
import { registerSourcesRoutes } from "./routes/sources.js";
import { registerNotificationRoutes } from "./routes/notifications.js";
import { registerNoteRoutes } from "./routes/notes.js";
import { registerNotionOriginRoutes } from "./routes/notion-origin.js";
import { registerBrainRoutes } from "./routes/brain.js";
import { registerOrgGraphRoutes } from "./routes/org-graph.js";
import { registerProcessRoutes } from "./routes/processes.js";
import { registerToolCatalogRoutes } from "./routes/tool-catalog.js";
import { registerRoleAgentRoutes } from "./routes/role-agent.js";
import { registerWebChannel } from "./routes/channel-web.js";
import { registerWs } from "./ws.js";

declare module "fastify" {
  interface FastifyRequest {
    session?: Session;
  }
}

const PUBLIC_PATHS = new Set(["/api/health", "/api/auth/login", "/api/auth/people"]);

export interface Api {
  app: FastifyInstance;
  ctx: ApiContext;
  close(): Promise<void>;
}

export async function buildApi(options: ApiOptions = {}): Promise<Api> {
  const ctx = await createApiContext(options);
  const app = Fastify({ logger: options.logger ?? false });

  // `origin` como función (en vez del array/string directo): así, ante un
  // origen fuera de la lista, @fastify/cors desactiva TODO el manejo de CORS
  // para esa petición (ni allow-origin ni allow-methods ni preflight), en vez
  // de solo omitir allow-origin. Fail-closed también en el preflight.
  const allowedOrigins = new Set(
    Array.isArray(ctx.corsOrigin) ? ctx.corsOrigin : [ctx.corsOrigin],
  );
  await app.register(cors, {
    origin: (origin, cb) => {
      cb(null, !!origin && allowedOrigins.has(origin));
    },
    credentials: true,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  });
  // Límite de tasa SOLO donde hace falta (`global: false`): las dos rutas
  // públicas sin sesión (/api/auth/login y /api/auth/people) declaran el suyo
  // en `config.rateLimit`. El 429 sale con el mismo sobre de error que el resto
  // de la API ({ error: { code, message } }) vía AgentosError.
  await app.register(rateLimit, {
    global: false,
    errorResponseBuilder: (_req, ctx) =>
      errors.rateLimited(
        `Demasiadas peticiones: máximo ${ctx.max} por ${ctx.after}. Reintenta más tarde.`,
        { max: ctx.max, retry_after: ctx.after },
      ),
  });
  await app.register(websocket);
  // Subida de artefactos (US: cerrar una tarea desde la interfaz). El limite
  // vive en artifact-files.ts para que ruta y parser no puedan divergir.
  await app.register(multipart, {
    limits: { fileSize: maxArtifactBytes(), files: 1, fields: 8 },
  });

  app.setErrorHandler(handleApiError);

  // Auth global: sesión firmada para todo /api y /v1 (menos rutas públicas).
  app.addHook("onRequest", async (req, reply) => {
    const path = req.url.split("?")[0] ?? req.url;
    if (!path.startsWith("/api") && !path.startsWith("/v1")) return; // /ws hace su propia auth
    if (PUBLIC_PATHS.has(path)) return;
    // Esta ruta solo EXISTE cuando el modo pruebas está activo (registrada
    // condicionalmente en registerAuthAndHealth); dejarla pasar aquí no la
    // hace pública con sandbox apagado, porque entonces no hay handler y
    // Fastify responde 404 en vez del 401 fail-closed de esta guarda.
    // Doble cerrojo: además de no existir el handler, la guarda solo la deja
    // pasar cuando el contexto arrancó en modo pruebas.
    if (ctx.sandbox && path === "/api/auth/sandbox-login") return;

    const headers = req.headers as { authorization?: string; cookie?: string };
    const token = extractToken(headers);
    const session = ctx.auth.verifyToken(token);
    if (session) {
      // Q4: la firma+exp del token no bastan — un interno deprovisionado (borrado
      // o desactivado) tras emitirse el token conservaría acceso hasta `exp`.
      // Revalidamos que la persona siga existiendo y siendo interna en cada request.
      const person = await getPerson(ctx.db, session.personId);
      if (person?.isInternal) {
        req.session = session;
        return;
      }
      // Persona inexistente o ya no interna: se cae al 401 (fail-closed).
    }
    // Canal web: un adaptador externo puede autenticarse con el secreto de canal.
    if (path.startsWith("/v1/channels/") && ctx.channelSecret) {
      const secret = req.headers["x-channel-secret"];
      if (typeof secret === "string" && secret === ctx.channelSecret) return;
    }
    await reply
      .status(401)
      .send({ error: { code: "unauthorized", message: "Sesión requerida (POST /api/auth/login)" } });
  });

  registerAuthAndHealth(app, ctx);
  registerBoardRoutes(app, ctx);
  registerModuleRoutes(app, ctx);
  registerOpsRoutes(app, ctx);
  registerSourcesRoutes(app, ctx);
  registerNotificationRoutes(app, ctx);
  registerNoteRoutes(app, ctx);
  registerNotionOriginRoutes(app, ctx);
  registerBrainRoutes(app, ctx);
  registerOrgGraphRoutes(app, ctx);
  registerProcessRoutes(app, ctx);
  registerToolCatalogRoutes(app, ctx);
  registerRoleAgentRoutes(app, ctx);
  registerWebChannel(app, ctx);
  registerWs(app, ctx);

  app.addHook("onClose", async () => {
    await ctx.close();
  });

  return {
    app,
    ctx,
    close: async () => {
      await app.close();
    },
  };
}
