import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import { AgentosError, ErrorCodes } from "@agentos/shared";
import type { ProviderProfile } from "@agentos/db";

/**
 * Registry de proveedores sobre Vercel AI SDK (ARCHITECTURE §3, spec B2).
 *
 * Reglas de secretos (NFR-11):
 * - La DB guarda SOLO el NOMBRE de la variable (api_key_env); el valor se lee
 *   de process.env en el momento de crear el modelo.
 * - El valor JAMÁS se persiste, se loguea ni viaja en mensajes de error.
 */

export type ProfileLike = Pick<
  ProviderProfile,
  "slug" | "kind" | "baseUrl" | "apiKeyEnv" | "costInputPerMtok" | "costOutputPerMtok" | "capabilities"
>;

/**
 * Resuelve la API key del perfil desde el entorno. Lanza `provider_not_configured`
 * mencionando SOLO el nombre de la variable, nunca su valor.
 */
export function resolveApiKey(
  profile: Pick<ProfileLike, "slug" | "kind" | "apiKeyEnv">,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (!profile.apiKeyEnv) {
    throw new AgentosError(
      ErrorCodes.PROVIDER_NOT_CONFIGURED,
      `El perfil '${profile.slug}' no tiene api_key_env configurado`,
      { slug: profile.slug },
    );
  }
  const value = env[profile.apiKeyEnv];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AgentosError(
      ErrorCodes.PROVIDER_NOT_CONFIGURED,
      `Falta la variable de entorno ${profile.apiKeyEnv} para el perfil '${profile.slug}'`,
      { slug: profile.slug, apiKeyEnv: profile.apiKeyEnv },
    );
  }
  return value;
}

function isOfficialOpenAi(baseUrl: string | null): boolean {
  if (!baseUrl) return true;
  try {
    return new URL(baseUrl).hostname === "api.openai.com";
  } catch {
    return false;
  }
}

/**
 * Crea el LanguageModel del AI SDK para un perfil + modelId.
 *
 * - `anthropic_api`      → @ai-sdk/anthropic
 * - `openai_compatible`  → @ai-sdk/openai si apunta a api.openai.com (o sin base_url);
 *                          createOpenAICompatible (kimi/minimax/glm/…) en el resto.
 * - `claude_subscription`→ NO es un proveedor de API: se usa vía ClaudeCodeRunner.
 */
export function createModel(
  profile: ProfileLike,
  modelId: string,
  env: NodeJS.ProcessEnv = process.env,
): LanguageModel {
  if (!modelId || modelId.trim().length === 0) {
    throw new AgentosError(
      ErrorCodes.VALIDATION_ERROR,
      `modelId vacío para el perfil '${profile.slug}'`,
      { slug: profile.slug },
    );
  }
  switch (profile.kind) {
    case "claude_subscription":
      throw new AgentosError(
        ErrorCodes.RUNNER_UNAVAILABLE,
        `El perfil '${profile.slug}' es claude_subscription: no expone API para el AiSdkRunner; usa runtime claude_code`,
        { slug: profile.slug },
      );
    case "anthropic_api": {
      const anthropic = createAnthropic({
        apiKey: resolveApiKey(profile, env),
        ...(profile.baseUrl ? { baseURL: profile.baseUrl } : {}),
      });
      return anthropic(modelId);
    }
    case "openai_compatible": {
      const apiKey = resolveApiKey(profile, env);
      if (isOfficialOpenAi(profile.baseUrl)) {
        const openai = createOpenAI({
          apiKey,
          ...(profile.baseUrl ? { baseURL: profile.baseUrl } : {}),
        });
        return openai(modelId);
      }
      const compatible = createOpenAICompatible({
        name: profile.slug,
        baseURL: profile.baseUrl!,
        apiKey,
      });
      return compatible(modelId);
    }
    default: {
      // Fail-closed ante kinds futuros no soportados.
      throw new AgentosError(
        ErrorCodes.PROVIDER_NOT_CONFIGURED,
        `Kind de proveedor no soportado: ${String((profile as { kind?: unknown }).kind)}`,
        { slug: profile.slug },
      );
    }
  }
}

/**
 * Registry con caché por perfil+modelo. El caché se invalida recreando el
 * registry (los perfiles cambian poco y el coste de crear un modelo es bajo).
 */
export class ProviderRegistry {
  private readonly cache = new Map<string, LanguageModel>();

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  getModel(profile: ProfileLike, modelId: string): LanguageModel {
    const key = `${profile.slug}::${profile.baseUrl ?? ""}::${modelId}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const model = createModel(profile, modelId, this.env);
    this.cache.set(key, model);
    return model;
  }

  clear(): void {
    this.cache.clear();
  }
}
