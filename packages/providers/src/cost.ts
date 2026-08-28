import type { ProviderProfile } from "@agentos/db";

/**
 * Uso de tokens normalizado para persistir en `runs`.
 * Regla PRD CA-7.2: null = "el proveedor no lo reportó" — NUNCA cero inferido.
 */
export interface TokenUsage {
  tokensIn: number | null;
  tokensOut: number | null;
  tokensCacheRead: number | null;
  tokensCacheWrite: number | null;
}

export const EMPTY_USAGE: TokenUsage = {
  tokensIn: null,
  tokensOut: null,
  tokensCacheRead: null,
  tokensCacheWrite: null,
};

/** Forma laxa del usage del AI SDK (LanguageModelUsage) — todos los campos opcionales. */
export interface AiSdkUsageLike {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  inputTokenDetails?: {
    cacheReadTokens?: number | undefined;
    cacheWriteTokens?: number | undefined;
  };
}

/** Normaliza el usage del AI SDK a nuestro contrato null-explicito. */
export function normalizeUsage(usage: AiSdkUsageLike | null | undefined): TokenUsage {
  if (!usage) return { ...EMPTY_USAGE };
  return {
    tokensIn: usage.inputTokens ?? null,
    tokensOut: usage.outputTokens ?? null,
    tokensCacheRead: usage.inputTokenDetails?.cacheReadTokens ?? null,
    tokensCacheWrite: usage.inputTokenDetails?.cacheWriteTokens ?? null,
  };
}

/** Suma dos usages preservando null (null + n = n; null + null = null). */
export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  const add = (x: number | null, y: number | null): number | null =>
    x === null && y === null ? null : (x ?? 0) + (y ?? 0);
  return {
    tokensIn: add(a.tokensIn, b.tokensIn),
    tokensOut: add(a.tokensOut, b.tokensOut),
    tokensCacheRead: add(a.tokensCacheRead, b.tokensCacheRead),
    tokensCacheWrite: add(a.tokensCacheWrite, b.tokensCacheWrite),
  };
}

/**
 * Coste en USD según cost_in/out_per_mtok del perfil.
 * Devuelve null si faltan tokens (in u out) o tarifas — nunca cero inferido.
 */
export function computeCostUsd(
  usage: Pick<TokenUsage, "tokensIn" | "tokensOut">,
  profile: Pick<ProviderProfile, "costInputPerMtok" | "costOutputPerMtok">,
): number | null {
  const { tokensIn, tokensOut } = usage;
  const { costInputPerMtok, costOutputPerMtok } = profile;
  if (tokensIn === null || tokensOut === null) return null;
  if (costInputPerMtok === null || costOutputPerMtok === null) return null;
  if (costInputPerMtok === undefined || costOutputPerMtok === undefined) return null;
  return (tokensIn / 1_000_000) * costInputPerMtok + (tokensOut / 1_000_000) * costOutputPerMtok;
}
