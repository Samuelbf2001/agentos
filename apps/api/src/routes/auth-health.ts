/** Rutas públicas: health, login y selección de persona (auth simple del MVP). */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { errors } from "@agentos/shared";
import { getPerson, listPeople } from "@agentos/db";
import { API_VERSION, healthCounts, type ApiContext } from "../context.js";
import { parse } from "../http-errors.js";

const LoginBody = z.object({
  password: z.string().min(1),
  person_id: z.string().min(1),
});

/** Modo pruebas: mismo cuerpo que el login normal pero sin contraseña. */
const SandboxLoginBody = z.object({
  person_id: z.string().min(1),
});

/** Ventana del límite de tasa en el formato que espera @fastify/rate-limit. */
function limit(rule: { max: number; timeWindowMs: number }) {
  return { rateLimit: { max: rule.max, timeWindow: rule.timeWindowMs } };
}

export function registerAuthAndHealth(app: FastifyInstance, ctx: ApiContext): void {
  /**
   * Salud PÚBLICA (la usa el healthcheck del contenedor): solo señales agregadas.
   * Jamás rutas del sistema de archivos, variables de entorno, versiones de
   * dependencias ni identificadores de runs — el detalle de la recuperación y
   * del pool viaja como contadores, no como listas de ids.
   */
  app.get("/api/health", async () => {
    const pool = ctx.pool.snapshot();
    const countIds = (buckets: Record<string, string[]>): number =>
      Object.values(buckets).reduce((total, ids) => total + ids.length, 0);
    return {
      ok: true,
      version: API_VERSION,
      now: Date.now(),
      uptime_ms: Date.now() - ctx.startedAt,
      sandbox: ctx.sandbox,
      kill_switch: await ctx.engine.isKillSwitchActive(),
      recovery: {
        interrupted_runs: ctx.recovery.interruptedRuns.length,
        requeued_tasks: ctx.recovery.requeuedTasks.length,
      },
      pool: { running: countIds(pool.running), queued: countIds(pool.queued) },
      counts: await healthCounts(ctx.db),
    };
  });

  /**
   * Personas internas para el desplegable del login. Es PÚBLICA: devuelve el
   * mínimo imprescindible para pintar el selector (id + nombre) — nunca email,
   * rol ni organización — y con límite de tasa por IP para que no sirva de
   * directorio del equipo a un escáner.
   */
  app.get("/api/auth/people", { config: limit(ctx.rateLimits.people) }, async () => ({
    people: (await listPeople(ctx.db))
      .filter((p) => p.isInternal)
      .map((p) => ({ id: p.id, full_name: p.fullName })),
  }));

  app.post("/api/auth/login", { config: limit(ctx.rateLimits.login) }, async (req, reply) => {
    const body = parse(LoginBody, req.body);
    if (!ctx.auth.verifyPassword(body.password)) {
      return reply.status(401).send({ error: { code: "invalid_credentials", message: "Contraseña incorrecta" } });
    }
    const person = await getPerson(ctx.db, body.person_id);
    if (!person || !person.isInternal) {
      throw errors.notFound("person", body.person_id);
    }
    const token = ctx.auth.issueToken({ id: person.id, fullName: person.fullName });
    reply.header("set-cookie", ctx.auth.cookieFor(token));
    return { token, person: { id: person.id, full_name: person.fullName, role: person.role } };
  });

  /**
   * Entrada sin contraseña del modo pruebas. Solo existe cuando `ctx.sandbox`
   * está activo: con sandbox apagado la ruta no se registra (404), ni siquiera
   * llega a comprobar nada — no hay superficie que probar desde fuera.
   */
  if (ctx.sandbox) {
    app.post("/api/auth/sandbox-login", { config: limit(ctx.rateLimits.login) }, async (req, reply) => {
      const body = parse(SandboxLoginBody, req.body);
      const person = await getPerson(ctx.db, body.person_id);
      if (!person || !person.isInternal) {
        throw errors.notFound("person", body.person_id);
      }
      const token = ctx.auth.issueToken({ id: person.id, fullName: person.fullName });
      reply.header("set-cookie", ctx.auth.cookieFor(token));
      return { token, person: { id: person.id, full_name: person.fullName, role: person.role } };
    });
  }

  app.get("/api/auth/me", async (req) => ({ session: req.session }));

  app.post("/api/auth/logout", async (_req, reply) => {
    // Mismos atributos que la cookie emitida (incluido `Secure`): un navegador
    // no borra una cookie `Secure` con una respuesta que no lo lleva.
    reply.header("set-cookie", ctx.auth.clearCookie());
    return { ok: true };
  });
}
