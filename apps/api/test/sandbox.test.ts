/**
 * Modo pruebas (sandbox): entrada sin contraseña, fail-closed en producción.
 * DB SIEMPRE temporal (`:memory:`); jamás `data/agentos.db`.
 */
import { describe, expect, it } from "vitest";
import { isAgentosError } from "@agentos/shared";
import { createPerson, getOrganizationByName, createOrganization } from "@agentos/db";
import { resolveSandbox } from "../src/context.js";
import { makeFixture } from "./helpers.js";

const MINIMAL = { dbPath: ":memory:", seedOnBoot: false, autoStartLoops: false, runners: {} } as const;

describe("resolveSandbox", () => {
  it("lanza si AGENTOS_SANDBOX está activo con NODE_ENV=production", () => {
    expect(() => resolveSandbox({ AGENTOS_SANDBOX: "1", NODE_ENV: "production" })).toThrow(
      /AGENTOS_SANDBOX/,
    );
    const err = (() => {
      try {
        resolveSandbox({ AGENTOS_SANDBOX: "1", NODE_ENV: "production" });
        return undefined;
      } catch (e) {
        return e;
      }
    })();
    expect(isAgentosError(err, "configuration_error")).toBe(true);
  });

  it("sin la variable es false; con 1/true (case-insensitive, con espacios) es true", () => {
    expect(resolveSandbox({})).toBe(false);
    expect(resolveSandbox({ AGENTOS_SANDBOX: "true" })).toBe(true);
    expect(resolveSandbox({ AGENTOS_SANDBOX: "1" })).toBe(true);
    expect(resolveSandbox({ AGENTOS_SANDBOX: " TRUE " })).toBe(true);
    expect(resolveSandbox({ AGENTOS_SANDBOX: "0" })).toBe(false);
    expect(resolveSandbox({ AGENTOS_SANDBOX: "" })).toBe(false);
  });
});

describe("con sandbox apagado", () => {
  it("POST /api/auth/sandbox-login es 404 y GET /api/health trae sandbox:false", async () => {
    const fx = await makeFixture({ ...MINIMAL, sandbox: false });
    try {
      const login = await fx.api.app.inject({
        method: "POST",
        url: "/api/auth/sandbox-login",
        payload: { person_id: fx.person.id },
      });
      expect(login.statusCode).toBe(404);

      const health = await fx.api.app.inject({ method: "GET", url: "/api/health" });
      expect(health.statusCode).toBe(200);
      expect((health.json() as { sandbox: boolean }).sandbox).toBe(false);
    } finally {
      await fx.close();
    }
  });
});

describe("con sandbox encendido", () => {
  it("GET /api/health trae sandbox:true", async () => {
    const fx = await makeFixture({ ...MINIMAL, sandbox: true });
    try {
      const health = await fx.api.app.inject({ method: "GET", url: "/api/health" });
      expect(health.statusCode).toBe(200);
      expect((health.json() as { sandbox: boolean }).sandbox).toBe(true);
    } finally {
      await fx.close();
    }
  });

  it("sandbox-login con persona interna devuelve token que sirve para /api/auth/me", async () => {
    const fx = await makeFixture({ ...MINIMAL, sandbox: true });
    try {
      const login = await fx.api.app.inject({
        method: "POST",
        url: "/api/auth/sandbox-login",
        payload: { person_id: fx.person.id },
      });
      expect(login.statusCode).toBe(200);
      const { token, person } = login.json() as { token: string; person: { id: string } };
      expect(person.id).toBe(fx.person.id);

      const me = await fx.api.app.inject({
        method: "GET",
        url: "/api/auth/me",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(me.statusCode).toBe(200);
    } finally {
      await fx.close();
    }
  });

  it("con una persona isInternal=false responde 404", async () => {
    const fx = await makeFixture({ ...MINIMAL, sandbox: true });
    try {
      const org = (await getOrganizationByName(fx.db, "ACME S.A.")) ?? (await createOrganization(fx.db, { name: "ACME S.A.", kind: "client" }));
      const outsider = await createPerson(fx.db, {
        orgId: org.id,
        fullName: "Persona externa",
        isInternal: false,
        role: "Cliente",
      });
      const login = await fx.api.app.inject({
        method: "POST",
        url: "/api/auth/sandbox-login",
        payload: { person_id: outsider.id },
      });
      expect(login.statusCode).toBe(404);
    } finally {
      await fx.close();
    }
  });

  it("sin person_id responde 400", async () => {
    const fx = await makeFixture({ ...MINIMAL, sandbox: true });
    try {
      const login = await fx.api.app.inject({
        method: "POST",
        url: "/api/auth/sandbox-login",
        payload: {},
      });
      expect(login.statusCode).toBe(400);
    } finally {
      await fx.close();
    }
  });
});
