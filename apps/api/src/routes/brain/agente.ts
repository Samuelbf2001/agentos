/**
 * 2brain › Agente 2brain: estado, prompt y herramientas del agente
 * conversacional/extractor de WhatsAppHub.
 *
 * Proxea exactamente tres endpoints del hub (`/api/agent/status`,
 * `/api/agent/config` GET/PUT) tras la sesión de AgentOS. La edición del
 * prompt se audita SIEMPRE con la longitud del texto, nunca con el texto: el
 * prompt puede contener detalle operativo del cliente y no pertenece a la
 * auditoría.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { appendAudit } from "@agentos/db";
import type { ApiContext } from "../../context.js";
import { parse } from "../../http-errors.js";
import { asDomainError, requireHub } from "./shared.js";

/** Mismo límite que el hub (`agent.controller.js`): un solo tope, un solo lugar. */
const PROMPT_MAX_LENGTH = 50_000;

// ── Whitelist de la respuesta del hub ───────────────────────────────────────
// Solo banderas de configuración, nombres/descripción de herramientas, el
// esquema de entrada (metadatos de la tool, no datos de cliente) y el prompt
// actual/override. Ninguna clave desconocida del hub llega a la UI.

const AgentToolSchema = z.object({
  name: z.string().catch(""),
  description: z.string().nullable().catch(null),
  input_schema: z.unknown().optional(),
});
export type AgentTool = z.infer<typeof AgentToolSchema>;

const AgentStatusResponse = z.object({
  notion: z.boolean().catch(false),
  kapso: z.boolean().catch(false),
  whatsapp_reminders: z.boolean().catch(false),
  wiki_notes: z.boolean().catch(false),
});
export type AgentStatus = z.infer<typeof AgentStatusResponse>;

const AgentConfigResponse = z.object({
  prompt_default: z.string().catch(""),
  prompt_override: z.string().nullable().catch(null),
  prompt_effective: z.string().catch(""),
  tools: z.array(AgentToolSchema).catch([]),
  chat_tools: z.array(AgentToolSchema).catch([]),
  chat_enabled: z.boolean().catch(false),
});
export type AgentConfig = z.infer<typeof AgentConfigResponse>;

const UpdatePromptBody = z.object({
  prompt: z.string().max(PROMPT_MAX_LENGTH).nullable(),
});

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeTool(raw: unknown): unknown {
  const obj = asRecord(raw);
  return { name: obj.name, description: obj.description ?? null, input_schema: obj.input_schema };
}

function normalizeToolList(raw: unknown): unknown[] {
  return Array.isArray(raw) ? raw.map(normalizeTool) : [];
}

/** El hub habla en camelCase; AgentOS expone snake_case como el resto de la API. */
function normalizeStatus(raw: unknown): unknown {
  const obj = asRecord(raw);
  return {
    notion: obj.notion,
    kapso: obj.kapso,
    whatsapp_reminders: obj.whatsapp_reminders,
    wiki_notes: obj.wiki_notes,
  };
}

function normalizeConfig(raw: unknown): unknown {
  const obj = asRecord(raw);
  return {
    prompt_default: obj.promptDefault,
    prompt_override: obj.promptOverride ?? null,
    prompt_effective: obj.promptEffective,
    tools: normalizeToolList(obj.tools),
    chat_tools: normalizeToolList(obj.chatTools),
    chat_enabled: obj.chatEnabled,
  };
}

export function registerBrainAgenteRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const personActor = (req: { session?: { personId: string } | undefined }): string =>
    `person:${req.session!.personId}`;

  app.get("/api/brain/agente/status", async () => {
    const hub = requireHub(ctx);
    try {
      const raw = await hub.hubGetJson("/api/agent/status");
      return AgentStatusResponse.parse(normalizeStatus(raw));
    } catch (err) {
      throw asDomainError(err);
    }
  });

  app.get("/api/brain/agente/config", async () => {
    const hub = requireHub(ctx);
    try {
      const raw = await hub.hubGetJson("/api/agent/config");
      return AgentConfigResponse.parse(normalizeConfig(raw));
    } catch (err) {
      throw asDomainError(err);
    }
  });

  /** `{ prompt: null }` restablece el prompt por defecto (mismo contrato que el hub). */
  app.put("/api/brain/agente/config", async (req) => {
    const body = parse(UpdatePromptBody, req.body);
    const hub = requireHub(ctx);
    let raw: unknown;
    try {
      raw = await hub.hubSendJson("PUT", "/api/agent/config", { prompt: body.prompt });
    } catch (err) {
      throw asDomainError(err);
    }
    const config = AgentConfigResponse.parse(normalizeConfig(raw));
    await appendAudit(ctx.db, {
      actor: personActor(req),
      source: "ui",
      action: "brain_agent.prompt_updated",
      entityType: "agent_config",
      entityId: "prompt",
      // Solo la longitud: el prompt override puede contener detalle operativo
      // del cliente y no pertenece a la auditoría.
      after: { promptLength: body.prompt?.length ?? 0, isOverride: body.prompt !== null },
    });
    return config;
  });
}
