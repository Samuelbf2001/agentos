/** Rutas públicas: health, login y selección de persona (auth simple del MVP). */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { errors } from "@agentos/shared";
import { getPerson, listPeople } from "@agentos/db";
import { API_VERSION, healthCounts, type ApiContext } from "../context.js";
import { parse } from "../http-errors.js";
import { SESSION_COOKIE } from "../auth.js";

const LoginBody = z.object({
  password: z.string().min(1),
  person_id: z.string().min(1),
});

export function registerAuthAndHealth(app: FastifyInstance, ctx: ApiContext): void {
  app.get("/api/health", async () => ({
    ok: true,
    version: API_VERSION,
    now: Date.now(),
    uptime_ms: Date.now() - ctx.startedAt,
    kill_switch: await ctx.engine.isKillSwitchActive(),
    recovery: ctx.recovery,
    pool: ctx.pool.snapshot(),
    counts: await healthCounts(ctx.db),
  }));

  /** Personas internas para el selector del login (solo id + nombre + rol). */
  app.get("/api/auth/people", async () => ({
    people: (await listPeople(ctx.db))
      .filter((p) => p.isInternal)
      .map((p) => ({ id: p.id, full_name: p.fullName, role: p.role })),
  }));

  app.post("/api/auth/login", async (req, reply) => {
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

  app.get("/api/auth/me", async (req) => ({ session: req.session }));

  app.post("/api/auth/logout", async (_req, reply) => {
    reply.header("set-cookie", `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0`);
    return { ok: true };
  });
}
