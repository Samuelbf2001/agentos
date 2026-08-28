import { APICallError } from "ai";

/**
 * Clasificación de errores de proveedor (spec B2):
 * - rate_limit  → reintentable con backoff (429)
 * - transient   → reintentable (5xx, timeouts, red)
 * - auth        → NO reintentable; revisar api_key_env (401/403)
 * - permanent   → NO reintentable (400, schema, modelo inexistente, ...)
 */
export type ProviderErrorKind = "rate_limit" | "auth" | "transient" | "permanent";

const TRANSIENT_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

export function classifyProviderError(error: unknown): ProviderErrorKind {
  if (APICallError.isInstance(error)) {
    const status = error.statusCode;
    if (status === 429) return "rate_limit";
    if (status === 401 || status === 403) return "auth";
    if (status === 408 || (status !== undefined && status >= 500)) return "transient";
    if (error.isRetryable) return "transient";
    return "permanent";
  }
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code && TRANSIENT_CODES.has(code)) return "transient";
    if (error.name === "TimeoutError" || error.name === "AbortError") return "transient";
    // fetch de undici envuelve fallos de red como TypeError("fetch failed")
    if (error.message.toLowerCase().includes("fetch failed")) return "transient";
    const cause = (error as { cause?: unknown }).cause;
    if (cause && cause !== error) return classifyProviderError(cause);
  }
  return "permanent";
}

/** ¿Vale la pena reintentar este error? */
export function isRetryableProviderError(error: unknown): boolean {
  const kind = classifyProviderError(error);
  return kind === "rate_limit" || kind === "transient";
}
