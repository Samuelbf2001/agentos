/**
 * Servidor Fastify de apps/api (B4). buildApi() arma el contexto (DB, bus,
 * pool, despachador, recuperación) y monta REST (/api), canal web (/v1) y
 * WebSocket (/ws). Todo endpoint —salvo login/health/people— exige sesión.
 */
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { getPerson } from "@agentos/db";
import { createApiContext, type ApiContext, type ApiOptions } from "./context.js";
import { extractToken, type Session } from "./auth.js";
import { handleApiError } from "./http-errors.js";
import { registerAuthAndHealth } from "./routes/auth-health.js";
import { registerBoardRoutes } from "./routes/board.js";
import { registerOpsRoutes } from "./routes/ops.js";
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
  const ctx = createApiContext(options);
  const app = Fastify({ logger: options.logger ?? false });

  await app.register(cors, {
    origin: ctx.corsOrigin,
    credentials: true,
  });
  await app.register(websocket);

  app.setErrorHandler(handleApiError);

  // Auth global: sesión firmada para todo /api y /v1 (menos rutas públicas).
  app.addHook("onRequest", async (req, reply) => {
    const path = req.url.split("?")[0] ?? req.url;
    if (!path.startsWith("/api") && !path.startsWith("/v1")) return; // /ws hace su propia auth
    if (PUBLIC_PATHS.has(path)) return;

    const headers = req.headers as { authorization?: string; cookie?: string };
    const token = extractToken(headers);
    const session = ctx.auth.verifyToken(token);
    if (session) {
      // Q4: la firma+exp del token no bastan — un interno deprovisionado (borrado
      // o desactivado) tras emitirse el token conservaría acceso hasta `exp`.
      // Revalidamos que la persona siga existiendo y siendo interna en cada request.
      const person = getPerson(ctx.db, session.personId);
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
  registerOpsRoutes(app, ctx);
  registerWebChannel(app, ctx);
  registerWs(app, ctx);

  app.addHook("onClose", async () => {
    ctx.close();
  });

  return {
    app,
    ctx,
    close: async () => {
      await app.close();
    },
  };
}
