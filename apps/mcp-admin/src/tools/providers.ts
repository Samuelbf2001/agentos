/**
 * Tools de proveedores LLM. Regla dura (US-9 / ARCHITECTURE §5, §7):
 * la DB guarda SOLO el NOMBRE de la variable de entorno — jamás un valor.
 * Cualquier argumento que parezca una clave real se RECHAZA (fail-closed) y
 * `providers.test` responde configured true/false sin revelar el valor.
 */
import { z } from "zod";
import { errors, ProviderCapabilities, ProviderKind } from "@agentos/shared";
import {
  isProviderConfigured,
  listProviderProfiles,
  getProviderProfileBySlug,
  upsertProviderProfile,
  type ProviderProfile,
} from "@agentos/db";
import { auditMutation } from "../context.js";
import { defineAdminTool as def, type AdminToolDefinition } from "../registry.js";
import { resolveProviderRef } from "../resolve.js";

const Reason = z.string().max(2000).optional();

/** Nombre válido de variable de entorno (MAYÚSCULAS_CON_GUIONES_BAJOS). */
const ENV_VAR_NAME = /^[A-Z][A-Z0-9_]{1,63}$/;

/** Patrones de credencial real (sk-/key-like, tokens conocidos, blobs largos). */
const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{4,}/i, // OpenAI / Anthropic style
  /key-[A-Za-z0-9_-]{4,}/i,
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key
  /\bghp_[A-Za-z0-9]{20,}\b/, // GitHub PAT
  /\bxox[abp]-[A-Za-z0-9-]{10,}\b/, // Slack
  /\bAIza[0-9A-Za-z_-]{30,}\b/, // Google API key
];

export function looksLikeSecret(value: string): boolean {
  if (SECRET_PATTERNS.some((re) => re.test(value))) return true;
  // Blob largo sin pinta de nombre/URL: casi seguro una credencial pegada.
  if (value.length > 64 && !/\s/.test(value) && !/^https?:\/\//i.test(value)) return true;
  return false;
}

function providerAuditFields(p: ProviderProfile): Record<string, unknown> {
  return {
    slug: p.slug,
    name: p.name,
    kind: p.kind,
    baseUrl: p.baseUrl,
    apiKeyEnv: p.apiKeyEnv, // solo el NOMBRE de la env var
    costInputPerMtok: p.costInputPerMtok,
    costOutputPerMtok: p.costOutputPerMtok,
    isDefault: p.isDefault,
  };
}

export const providerTools: AdminToolDefinition[] = [
  def({
    name: "agentos.providers.list",
    description:
      "Lista perfiles de proveedor LLM (kind, base_url, nombre de env var y costes). Nunca expone valores de claves.",
    schema: z.object({}),
    readOnly: true,
    async handler(ctx) {
      return await listProviderProfiles(ctx.db);
    },
  }),

  def({
    name: "agentos.providers.upsert",
    description:
      "Crea/actualiza un perfil de proveedor por slug. `api_key_env` es el NOMBRE de la variable " +
      "de entorno (p. ej. OPENAI_API_KEY) — si el valor parece una clave real, se rechaza.",
    schema: z.object({
      slug: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/, "slug en minúsculas"),
      name: z.string().min(1),
      kind: ProviderKind,
      base_url: z.string().url().nullable().optional(),
      api_key_env: z.string().nullable().optional(),
      cost_input_per_mtok: z.number().nonnegative().nullable().optional(),
      cost_output_per_mtok: z.number().nonnegative().nullable().optional(),
      capabilities: ProviderCapabilities.optional(),
      is_default: z.boolean().optional(),
      reason: Reason,
    }),
    readOnly: false,
    async handler(ctx, args) {
      if (typeof args.api_key_env === "string") {
        if (looksLikeSecret(args.api_key_env)) {
          throw errors.validation(
            "api_key_env parece una CLAVE REAL, no el nombre de una variable de entorno. " +
              "Aquí solo se guarda el NOMBRE (p. ej. OPENAI_API_KEY); exporta el valor en tu entorno.",
            { arg: "api_key_env" },
          );
        }
        if (!ENV_VAR_NAME.test(args.api_key_env)) {
          throw errors.validation(
            `api_key_env inválido: "${args.api_key_env}" no es un nombre de variable de entorno ` +
              "(esperado MAYUSCULAS_CON_GUIONES_BAJOS, p. ej. KIMI_API_KEY)",
            { arg: "api_key_env" },
          );
        }
      }
      for (const [key, value] of Object.entries(args)) {
        if (typeof value === "string" && key !== "api_key_env" && looksLikeSecret(value)) {
          throw errors.validation(
            `El argumento "${key}" parece contener una credencial: rechazado (jamás se guardan valores de claves)`,
            { arg: key },
          );
        }
      }
      const existing = await getProviderProfileBySlug(ctx.db, args.slug);
      const profile = await upsertProviderProfile(ctx.db, {
        slug: args.slug,
        name: args.name,
        kind: args.kind,
        baseUrl: args.base_url ?? existing?.baseUrl ?? null,
        apiKeyEnv: args.api_key_env ?? existing?.apiKeyEnv ?? null,
        costInputPerMtok: args.cost_input_per_mtok ?? existing?.costInputPerMtok ?? null,
        costOutputPerMtok: args.cost_output_per_mtok ?? existing?.costOutputPerMtok ?? null,
        capabilities: args.capabilities ?? existing?.capabilities ?? null,
        isDefault: args.is_default ?? existing?.isDefault ?? false,
      });
      await auditMutation(ctx, {
        action: "providers.upsert",
        entityType: "provider_profile",
        entityId: profile.id,
        before: existing ? providerAuditFields(existing) : null,
        after: providerAuditFields(profile),
        reason: args.reason,
      });
      return profile;
    },
  }),

  def({
    name: "agentos.providers.test",
    description:
      "Verifica si el proveedor tiene credencial configurada (existe la env var): " +
      "devuelve configured true/false SIN el valor.",
    schema: z.object({ provider: z.string().min(1) }),
    readOnly: true,
    async handler(ctx, args) {
      const profile = await resolveProviderRef(ctx.db, args.provider);
      return {
        slug: profile.slug,
        kind: profile.kind,
        api_key_env: profile.apiKeyEnv,
        configured: isProviderConfigured(profile),
        note:
          profile.kind === "claude_subscription"
            ? "claude_subscription usa el login del CLI: cuenta como configurado"
            : undefined,
      };
    },
  }),
];
