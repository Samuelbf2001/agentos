import { describe, expect, it } from "vitest";
import { APICallError } from "ai";
import { classifyProviderError, isRetryableProviderError } from "../src/errors.js";
import { backoffDelayMs, withRetries } from "../src/retry.js";

function apiError(statusCode: number, isRetryable?: boolean): APICallError {
  return new APICallError({
    message: `HTTP ${statusCode}`,
    url: "https://api.test.local/v1/chat",
    requestBodyValues: {},
    statusCode,
    ...(isRetryable !== undefined ? { isRetryable } : {}),
  });
}

describe("classifyProviderError", () => {
  it("429 → rate_limit", () => {
    expect(classifyProviderError(apiError(429))).toBe("rate_limit");
  });

  it("401/403 → auth (no reintentable)", () => {
    expect(classifyProviderError(apiError(401))).toBe("auth");
    expect(classifyProviderError(apiError(403))).toBe("auth");
    expect(isRetryableProviderError(apiError(401))).toBe(false);
  });

  it("5xx y timeouts → transient", () => {
    expect(classifyProviderError(apiError(500))).toBe("transient");
    expect(classifyProviderError(apiError(503))).toBe("transient");
    expect(classifyProviderError(apiError(408))).toBe("transient");
    const timeout = new Error("se acabó el tiempo");
    timeout.name = "TimeoutError";
    expect(classifyProviderError(timeout)).toBe("transient");
  });

  it("errores de red de Node → transient", () => {
    const err = new Error("socket colgado") as NodeJS.ErrnoException;
    err.code = "ECONNRESET";
    expect(classifyProviderError(err)).toBe("transient");
    expect(classifyProviderError(new TypeError("fetch failed"))).toBe("transient");
  });

  it("400 y errores desconocidos → permanent", () => {
    expect(classifyProviderError(apiError(400))).toBe("permanent");
    expect(classifyProviderError(new Error("schema inválido"))).toBe("permanent");
    expect(classifyProviderError("string raro")).toBe("permanent");
  });
});

describe("backoffDelayMs", () => {
  it("exponencial con techo (sin jitter, determinista)", () => {
    expect(backoffDelayMs(1, 250, 10_000, false)).toBe(250);
    expect(backoffDelayMs(2, 250, 10_000, false)).toBe(500);
    expect(backoffDelayMs(3, 250, 10_000, false)).toBe(1000);
    expect(backoffDelayMs(10, 250, 4_000, false)).toBe(4_000);
  });
});

describe("withRetries", () => {
  it("reintenta en 429 con backoff exponencial y termina en éxito", async () => {
    const delays: number[] = [];
    let calls = 0;
    const result = await withRetries(
      async () => {
        calls += 1;
        if (calls < 3) throw apiError(429);
        return "ok";
      },
      {
        maxAttempts: 4,
        baseDelayMs: 100,
        jitter: false,
        sleep: async (ms) => {
          delays.push(ms);
        },
      },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
    expect(delays).toEqual([100, 200]);
  });

  it("NO reintenta errores auth/permanent", async () => {
    let calls = 0;
    await expect(
      withRetries(
        async () => {
          calls += 1;
          throw apiError(401);
        },
        { maxAttempts: 5, sleep: async () => {} },
      ),
    ).rejects.toMatchObject({ statusCode: 401 });
    expect(calls).toBe(1);
  });

  it("agota los intentos y propaga el error original", async () => {
    let calls = 0;
    await expect(
      withRetries(
        async () => {
          calls += 1;
          throw apiError(503);
        },
        { maxAttempts: 3, jitter: false, sleep: async () => {} },
      ),
    ).rejects.toMatchObject({ statusCode: 503 });
    expect(calls).toBe(3);
  });
});
