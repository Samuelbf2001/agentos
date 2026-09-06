/**
 * Endurecimiento para producción (2ª pasada, a nivel de aplicación):
 * fail-closed de secretos al arrancar, cookie `Secure`, superficie mínima del
 * desplegable de login con límite de tasa, CORS por lista explícita y arranque
 * pausado con base nueva. Todo con DB temporal y CERO LLM real.
 */
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { isAgentosError } from "@agentos/shared";
import { buildApi, type Api } from "../src/server.js";
import {
  createApiContext,
  resolveCorsOrigin,
  resolveSessionSecret,
  resolveSharedPassword,
} from "../src/context.js";
import { resolveCookieSecure } from "../src/auth.js";
import { makeFixture, TEST_PASSWORD } from "./helpers.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-api-hardening-"));

/** Variables tocadas por estas pruebas; se restauran SIEMPRE tras cada test. */
const TOUCHED = [
  "NODE_ENV",
  "AGENTOS_SHARED_PASSWORD",
  "AGENTOS_SESSION_SECRET",
  "AGENTOS_WEB_ORIGIN",
  "AGENTOS_COOKIE_SECURE",
] as const;

const ORIGINAL = Object.fromEntries(TOUCHED.map((k) => [k, process.env[k]])) as Record<
  string,
  string | undefined
>;

function setEnv(vars: Partial<Record<(typeof TOUCHED)[number], string | undefined>>): void {
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(() => {
  for (const key of TOUCHED) {
    if (ORIGINAL[key] === undefined) delete process.env[key];
    else process.env[key] = ORIGINAL[key];
  }
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Contexto mínimo: DB en memoria, sin seeds, sin bucles, sin runners reales. */
const MINIMAL = { dbPath: ":memory:", seedOnBoot: false, autoStartLoops: false, runners: {} } as const;

describe("arranque fail-closed en producción", () => {
  it("sin AGENTOS_SHARED_PASSWORD lanza; con ella arranca", async () => {
    setEnv({
      NODE_ENV: "production",
      AGENTOS_SHARED_PASSWORD: undefined,
      AGENTOS_SESSION_SECRET: "secreto-de-sesion-largo-y-aleatorio",
      AGENTOS_WEB_ORIGIN: "https://agentos.example",
    });

    await expect(createApiContext({ ...MINIMAL })).rejects.toThrow(/AGENTOS_SHARED_PASSWORD/);
    // Error de dominio con código estable, no un Error suelto.
    const err = await createApiContext({ ...MINIMAL }).catch((e: unknown) => e);
    expect(isAgentosError(err, "configuration_error")).toBe(true);

    setEnv({ AGENTOS_SHARED_PASSWORD: "contraseña-real-del-despliegue" });
    const ctx = await createApiContext({ ...MINIMAL });
    expect(ctx.auth.verifyPassword("contraseña-real-del-despliegue")).toBe(true);
    // El fail-open de desarrollo NO sobrevive en producción.
    expect(ctx.auth.verifyPassword("agentos-dev")).toBe(false);
    await ctx.close();
  });

  it("sin AGENTOS_SESSION_SECRET lanza en producción y se deriva en desarrollo", async () => {
    setEnv({
      NODE_ENV: "production",
      AGENTOS_SHARED_PASSWORD: "contraseña-real-del-despliegue",
      AGENTOS_SESSION_SECRET: undefined,
      AGENTOS_WEB_ORIGIN: "https://agentos.example",
    });

    const err = await createApiContext({ ...MINIMAL }).catch((e: unknown) => e);
    expect(isAgentosError(err, "configuration_error")).toBe(true);
    expect((err as Error).message).toMatch(/AGENTOS_SESSION_SECRET/);

    // En desarrollo sigue siendo opcional (derivado de la contraseña).
    setEnv({ NODE_ENV: "development" });
    expect(resolveSessionSecret()).toBeUndefined();
    const ctx = await createApiContext({ ...MINIMAL });
    await ctx.close();
  });

  it("la contraseña de desarrollo solo aparece fuera de producción", () => {
    setEnv({ NODE_ENV: "development", AGENTOS_SHARED_PASSWORD: undefined });
    expect(resolveSharedPassword()).toBe("agentos-dev");
    setEnv({ NODE_ENV: "production" });
    expect(() => resolveSharedPassword()).toThrow(/AGENTOS_SHARED_PASSWORD/);
  });

  it("rotar AGENTOS_SESSION_SECRET invalida los tokens ya emitidos", async () => {
    const dbPath = path.join(tmpDir, "rotacion.db");

    const antes = await makeFixture({ dbPath, sessionSecret: "secreto-viejo" });
    const token = antes.token;
    await antes.close();

    // Mismo secreto → el token sobrevive a un reinicio (control).
    const mismo = await makeFixture({ dbPath, sessionSecret: "secreto-viejo" });
    const ok = await mismo.api.app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(ok.statusCode).toBe(200);
    await mismo.close();

    // Secreto rotado → la firma deja de casar: 401 (fail-closed).
    const despues = await makeFixture({ dbPath, sessionSecret: "secreto-nuevo" });
    const denied = await despues.api.app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(denied.statusCode).toBe(401);
    await despues.close();
  });
});

describe("cookie de sesión", () => {
  async function loginCookie(overrides: Parameters<typeof makeFixture>[0]): Promise<string> {
    const fx = await makeFixture(overrides);
    try {
      const login = await fx.api.app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { password: TEST_PASSWORD, person_id: fx.person.id },
      });
      expect(login.statusCode).toBe(200);
      return String(login.headers["set-cookie"]);
    } finally {
      await fx.close();
    }
  }

  it("en producción viaja con Secure; en desarrollo no", async () => {
    setEnv({
      NODE_ENV: "production",
      AGENTOS_SESSION_SECRET: "secreto-de-sesion-largo-y-aleatorio",
      AGENTOS_WEB_ORIGIN: "https://agentos.example",
      AGENTOS_COOKIE_SECURE: undefined,
    });
    const prod = await loginCookie({});
    expect(prod).toContain("agentos_session=");
    expect(prod).toContain("HttpOnly");
    expect(prod).toContain("SameSite=Lax");
    expect(prod).toContain("Secure");

    setEnv({ NODE_ENV: "development" });
    const dev = await loginCookie({});
    expect(dev).toContain("HttpOnly");
    expect(dev).toContain("SameSite=Lax");
    expect(dev).not.toContain("Secure");
  });

  it("AGENTOS_COOKIE_SECURE=1 fuerza Secure fuera de producción", async () => {
    setEnv({ NODE_ENV: "development", AGENTOS_COOKIE_SECURE: "1" });
    expect(resolveCookieSecure()).toBe(true);
    const cookie = await loginCookie({});
    expect(cookie).toContain("Secure");

    setEnv({ AGENTOS_COOKIE_SECURE: "0", NODE_ENV: "production" });
    expect(resolveCookieSecure()).toBe(false); // la variable manda sobre NODE_ENV
  });

  it("el logout borra la cookie con los MISMOS atributos", async () => {
    setEnv({ NODE_ENV: "development", AGENTOS_COOKIE_SECURE: "1" });
    const fx = await makeFixture({});
    try {
      const out = await fx.api.app.inject({
        method: "POST",
        url: "/api/auth/logout",
        headers: fx.authHeaders,
      });
      const cookie = String(out.headers["set-cookie"]);
      expect(cookie).toContain("agentos_session=;");
      expect(cookie).toContain("Secure");
      expect(cookie).toContain("Max-Age=0");
    } finally {
      await fx.close();
    }
  });
});

describe("/api/auth/people (pública)", () => {
  it("devuelve SOLO id y full_name (ni email, ni rol, ni organización)", async () => {
    const fx = await makeFixture({});
    try {
      const res = await fx.api.app.inject({ method: "GET", url: "/api/auth/people" });
      expect(res.statusCode).toBe(200);
      const { people } = res.json() as { people: Array<Record<string, unknown>> };
      expect(people.length).toBeGreaterThan(0);
      for (const person of people) {
        expect(Object.keys(person).sort()).toEqual(["full_name", "id"]);
      }
      expect(JSON.stringify(people)).not.toContain("Operador"); // el rol ya no viaja
    } finally {
      await fx.close();
    }
  });

  it("responde 429 con código estable al pasarse del límite de tasa", async () => {
    const fx = await makeFixture({ rateLimit: { people: { max: 3, timeWindowMs: 60_000 } } });
    try {
      for (let i = 0; i < 3; i++) {
        const ok = await fx.api.app.inject({ method: "GET", url: "/api/auth/people" });
        expect(ok.statusCode).toBe(200);
      }
      const limited = await fx.api.app.inject({ method: "GET", url: "/api/auth/people" });
      expect(limited.statusCode).toBe(429);
      expect((limited.json() as { error: { code: string } }).error.code).toBe("rate_limited");
    } finally {
      await fx.close();
    }
  });

  it("el login también está limitado por IP (fuerza bruta de la contraseña)", async () => {
    const fx = await makeFixture({ rateLimit: { login: { max: 2, timeWindowMs: 60_000 } } });
    try {
      // El fixture ya consumió 1 intento con su login inicial.
      const second = await fx.api.app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { password: "incorrecta", person_id: fx.person.id },
      });
      expect(second.statusCode).toBe(401);

      const limited = await fx.api.app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { password: "incorrecta", person_id: fx.person.id },
      });
      expect(limited.statusCode).toBe(429);
      expect((limited.json() as { error: { code: string } }).error.code).toBe("rate_limited");
    } finally {
      await fx.close();
    }
  });
});

describe("CORS", () => {
  it("acepta una lista de orígenes y no responde a los que no están", async () => {
    setEnv({
      NODE_ENV: "production",
      AGENTOS_SHARED_PASSWORD: "contraseña-real-del-despliegue",
      AGENTOS_SESSION_SECRET: "secreto-de-sesion-largo-y-aleatorio",
      AGENTOS_WEB_ORIGIN: "https://app.example, https://admin.example",
    });
    expect(resolveCorsOrigin()).toEqual(["https://app.example", "https://admin.example"]);

    let api: Api | undefined;
    try {
      api = await buildApi({ ...MINIMAL });
      for (const origin of ["https://app.example", "https://admin.example"]) {
        const res = await api.app.inject({ method: "GET", url: "/api/health", headers: { origin } });
        expect(res.headers["access-control-allow-origin"]).toBe(origin);
      }
      const intruso = await api.app.inject({
        method: "GET",
        url: "/api/health",
        headers: { origin: "https://malicioso.example" },
      });
      expect(intruso.headers["access-control-allow-origin"]).toBeUndefined();

      const preflight = await api.app.inject({
        method: "OPTIONS",
        url: "/api/tasks",
        headers: {
          origin: "https://malicioso.example",
          "access-control-request-method": "GET",
        },
      });
      expect(preflight.headers["access-control-allow-origin"]).toBeUndefined();
    } finally {
      await api?.close();
    }
  });

  it("rechaza '*' y exige la variable en producción", () => {
    setEnv({ NODE_ENV: "production", AGENTOS_WEB_ORIGIN: undefined });
    expect(() => resolveCorsOrigin()).toThrow(/AGENTOS_WEB_ORIGIN/);
    expect(() => resolveCorsOrigin("*")).toThrow(/'\*'/);
    expect(() => resolveCorsOrigin("https://app.example,*")).toThrow(/'\*'/);

    // En desarrollo se conserva el default de cero fricción.
    setEnv({ NODE_ENV: "development" });
    expect(resolveCorsOrigin(undefined)).toBe("http://localhost:4301");
  });
});

describe("/api/health (pública)", () => {
  it("no filtra rutas del sistema de archivos, variables ni identificadores", async () => {
    setEnv({ NODE_ENV: "development", AGENTOS_SHARED_PASSWORD: "contraseña-secreta-de-prueba" });
    const dbPath = path.join(tmpDir, "salud.db");
    const fx = await makeFixture({ dbPath });
    try {
      const res = await fx.api.app.inject({ method: "GET", url: "/api/health" });
      expect(res.statusCode).toBe(200);
      const body = res.json() as Record<string, unknown>;
      expect(body["ok"]).toBe(true);
      expect(body["kill_switch"]).toBe(false);
      expect(body["recovery"]).toEqual({ interrupted_runs: 0, requeued_tasks: 0 });
      expect(body["pool"]).toEqual({ running: 0, queued: 0 });

      const raw = res.body;
      expect(raw).not.toContain(dbPath);
      expect(raw).not.toContain(tmpDir);
      expect(raw).not.toContain(".db");
      expect(raw).not.toContain("contraseña-secreta-de-prueba");
      expect(raw).not.toContain("AGENTOS_");
    } finally {
      await fx.close();
    }
  });
});

describe("arranque pausado con base nueva", () => {
  it("una base NUEVA queda con el kill switch activo también en producción", async () => {
    setEnv({
      NODE_ENV: "production",
      AGENTOS_SHARED_PASSWORD: "contraseña-real-del-despliegue",
      AGENTOS_SESSION_SECRET: "secreto-de-sesion-largo-y-aleatorio",
      AGENTOS_WEB_ORIGIN: "https://agentos.example",
    });
    const dbPath = path.join(tmpDir, "arranque-nuevo.db");
    const ctx = await createApiContext({
      dbPath,
      autoStartLoops: false,
      runners: {},
    });
    try {
      expect(await ctx.engine.isKillSwitchActive()).toBe(true);
    } finally {
      await ctx.close();
    }

    // Reabrir NO pisa la decisión de un humano: si reanudó, sigue reanudado.
    const segunda = await createApiContext({ dbPath, autoStartLoops: false, runners: {} });
    try {
      await segunda.engine.setKillSwitch(false, "person:test", "resume_all");
      expect(await segunda.engine.isKillSwitchActive()).toBe(false);
    } finally {
      await segunda.close();
    }

    const tercera = await createApiContext({ dbPath, autoStartLoops: false, runners: {} });
    try {
      expect(await tercera.engine.isKillSwitchActive()).toBe(false);
    } finally {
      await tercera.close();
    }
  }, 60_000);
});
