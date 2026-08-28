import { describe, expect, it } from "vitest";
import { isAgentosError, ErrorCodes } from "@agentos/shared";
import { createModel, ProviderRegistry, resolveApiKey, type ProfileLike } from "../src/registry.js";
import { defaultCapabilities, effectiveCapabilities } from "../src/capabilities.js";

function profile(overrides: Partial<ProfileLike> = {}): ProfileLike {
  return {
    slug: "test-provider",
    kind: "openai_compatible",
    baseUrl: "https://api.moonshot.ai/v1",
    apiKeyEnv: "TEST_PROVIDER_KEY",
    costInputPerMtok: 3,
    costOutputPerMtok: 15,
    capabilities: null,
    ...overrides,
  };
}

const envWithKey = { TEST_PROVIDER_KEY: "sk-test-123" } as NodeJS.ProcessEnv;

describe("resolveApiKey", () => {
  it("lee la key del entorno por nombre (api_key_env)", () => {
    expect(resolveApiKey(profile(), envWithKey)).toBe("sk-test-123");
  });

  it("falla provider_not_configured sin filtrar el valor (solo el NOMBRE de la var)", () => {
    try {
      resolveApiKey(profile(), {} as NodeJS.ProcessEnv);
      expect.unreachable();
    } catch (err) {
      expect(isAgentosError(err, ErrorCodes.PROVIDER_NOT_CONFIGURED)).toBe(true);
      expect((err as Error).message).toContain("TEST_PROVIDER_KEY");
      expect((err as Error).message).not.toContain("sk-test");
    }
  });

  it("falla si el perfil no declara api_key_env", () => {
    expect(() => resolveApiKey(profile({ apiKeyEnv: null }), envWithKey)).toThrow();
  });
});

describe("createModel", () => {
  it("openai_compatible con base_url ajena → createOpenAICompatible (kimi/minimax/glm)", () => {
    const model = createModel(profile({ slug: "kimi" }), "kimi-k2", envWithKey);
    const m = model as { modelId: string; provider: string };
    expect(m.modelId).toBe("kimi-k2");
    expect(m.provider).toContain("kimi");
  });

  it("openai_compatible apuntando a api.openai.com (o sin base_url) → @ai-sdk/openai", () => {
    const withUrl = createModel(
      profile({ slug: "openai", baseUrl: "https://api.openai.com/v1" }),
      "gpt-5",
      envWithKey,
    ) as { provider: string };
    const withoutUrl = createModel(profile({ slug: "openai", baseUrl: null }), "gpt-5", envWithKey) as {
      provider: string;
    };
    expect(withUrl.provider).toContain("openai");
    expect(withoutUrl.provider).toContain("openai");
    expect(withoutUrl.provider).not.toContain("compatible");
  });

  it("anthropic_api → @ai-sdk/anthropic", () => {
    const model = createModel(
      profile({ slug: "anthropic", kind: "anthropic_api", baseUrl: null, apiKeyEnv: "TEST_ANTH" }),
      "claude-sonnet-4-5",
      { TEST_ANTH: "sk-ant-x" } as NodeJS.ProcessEnv,
    ) as { modelId: string; provider: string };
    expect(model.modelId).toBe("claude-sonnet-4-5");
    expect(model.provider).toContain("anthropic");
  });

  it("claude_subscription NO expone API → runner_unavailable (se usa claude_code)", () => {
    try {
      createModel(profile({ kind: "claude_subscription" }), "claude-sonnet-4-5", envWithKey);
      expect.unreachable();
    } catch (err) {
      expect(isAgentosError(err, ErrorCodes.RUNNER_UNAVAILABLE)).toBe(true);
    }
  });

  it("modelId vacío → validation_error", () => {
    expect(() => createModel(profile(), "", envWithKey)).toThrow();
  });
});

describe("ProviderRegistry", () => {
  it("cachea por perfil+modelo", () => {
    const registry = new ProviderRegistry(envWithKey);
    const a = registry.getModel(profile(), "kimi-k2");
    const b = registry.getModel(profile(), "kimi-k2");
    const c = registry.getModel(profile(), "kimi-k2-turbo");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("capabilities", () => {
  it("defaults por kind y override del perfil (DB manda)", () => {
    expect(defaultCapabilities("openai_compatible").computer_use).toBe(false);
    expect(defaultCapabilities("claude_subscription").computer_use).toBe(true);
    const caps = effectiveCapabilities({
      kind: "openai_compatible",
      capabilities: { tool_calling: true, streaming: true, vision: true, computer_use: false, prompt_cache: false },
    });
    expect(caps.vision).toBe(true); // override del perfil
    expect(caps.computer_use).toBe(false);
  });
});
