import type { ProviderCapabilities, ProviderKind } from "@agentos/shared";
import type { ProviderProfile } from "@agentos/db";

/**
 * Flags de capacidad por proveedor (ARCHITECTURE §3):
 * "nunca mostrar un knob que el driver no puede girar".
 * Defaults conservadores por kind; el perfil puede sobreescribirlos en DB.
 */
export function defaultCapabilities(kind: ProviderKind): ProviderCapabilities {
  switch (kind) {
    case "claude_subscription":
      return {
        tool_calling: true,
        streaming: true,
        vision: true,
        computer_use: true,
        prompt_cache: true,
      };
    case "anthropic_api":
      return {
        tool_calling: true,
        streaming: true,
        vision: true,
        computer_use: true,
        prompt_cache: true,
      };
    case "openai_compatible":
      // Mínimo común de kimi/minimax/glm/openai: tools + streaming.
      return {
        tool_calling: true,
        streaming: true,
        vision: false,
        computer_use: false,
        prompt_cache: false,
      };
  }
}

/** Capacidades efectivas: defaults del kind + overrides del perfil (DB manda). */
export function effectiveCapabilities(
  profile: Pick<ProviderProfile, "kind" | "capabilities">,
): ProviderCapabilities {
  return { ...defaultCapabilities(profile.kind), ...(profile.capabilities ?? {}) };
}
