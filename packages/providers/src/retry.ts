import { classifyProviderError, type ProviderErrorKind } from "./errors.js";

export interface RetryOptions {
  /** Intentos totales (incluido el primero). Default 3. */
  maxAttempts?: number;
  /** Base del backoff exponencial en ms. Default 250. */
  baseDelayMs?: number;
  /** Techo del backoff en ms. Default 10_000. */
  maxDelayMs?: number;
  /** Jitter aleatorio (default true). Apagable para tests deterministas. */
  jitter?: boolean;
  /** Inyectable para tests: por defecto setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Decide si se reintenta. Default: rate_limit | transient. */
  shouldRetry?: (kind: ProviderErrorKind, error: unknown, attempt: number) => boolean;
  /** Callback de observabilidad por reintento (jamás loguear secretos aquí). */
  onRetry?: (info: { attempt: number; delayMs: number; kind: ProviderErrorKind }) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Backoff exponencial puro (exportado para tests): base * 2^(attempt-1), con techo. */
export function backoffDelayMs(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  jitter: boolean,
): number {
  const exp = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
  if (!jitter) return exp;
  // full-jitter acotado: [exp/2, exp]
  return Math.floor(exp / 2 + Math.random() * (exp / 2));
}

/**
 * Ejecuta `fn` con reintentos + backoff exponencial según la clasificación del
 * error (rate limit / transient reintentan; auth / permanent NO). El error
 * original se propaga sin envolver para que el llamador lo clasifique.
 */
export async function withRetries<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 250;
  const maxDelayMs = options.maxDelayMs ?? 10_000;
  const jitter = options.jitter ?? true;
  const sleep = options.sleep ?? defaultSleep;
  const shouldRetry =
    options.shouldRetry ?? ((kind: ProviderErrorKind) => kind === "rate_limit" || kind === "transient");

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      const kind = classifyProviderError(error);
      if (attempt >= maxAttempts || !shouldRetry(kind, error, attempt)) {
        throw error;
      }
      const delayMs = backoffDelayMs(attempt, baseDelayMs, maxDelayMs, jitter);
      options.onRetry?.({ attempt, delayMs, kind });
      await sleep(delayMs);
    }
  }
  // Inalcanzable (el loop siempre retorna o lanza), pero TypeScript no lo sabe.
  throw lastError;
}
