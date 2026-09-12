/**
 * 2brain › Conversaciones: chats de WhatsApp del agente 2brain y su registro
 * de acciones. Solo lectura (proxy del hub WhatsAppHub); ninguna mutación —
 * por eso no hay `appendAudit` en este módulo.
 *
 * Cada ruta valida SU PROPIA entrada con Zod antes de hablar con el hub
 * (`requireHub`), y la respuesta del hub se re-valida con Zod: solo las
 * claves que la vista usa sobreviven (whitelist por `z.object` sin
 * passthrough; cualquier otra clave del hub se descarta en silencio).
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ApiContext } from "../../context.js";
import { parse } from "../../http-errors.js";
import { asDomainError, requireHub } from "./shared.js";

// ── Formas que llegan del hub — solo lo que la vista necesita ──────────────

const HubThread = z.object({
  phone: z.string(),
  /** El hub hoy no lo enriquece (no hay JOIN con contactos); se deja por si algún día lo hace. */
  name: z.string().nullable().optional(),
  lastBody: z.string().nullable().optional(),
  lastAt: z.string().nullable().optional(),
  count: z.number().nullable().optional(),
});

const HubChatsResponse = z.object({
  threads: z.array(HubThread).optional(),
});

const HubMessage = z.object({
  id: z.number(),
  direction: z.string(),
  body: z.string().nullable().optional(),
  created_at: z.string().nullable().optional(),
});

const HubMessagesResponse = z.object({
  messages: z.array(HubMessage).optional(),
});

/** `payload`/`result` son JSON opaco del hub: se whitelistea la clave, no la forma interna. */
const HubAction = z.object({
  id: z.number(),
  status: z.string(),
  action_type: z.string(),
  created_at: z.string().nullable().optional(),
  payload: z.unknown().nullable().optional(),
  result: z.unknown().nullable().optional(),
});

const HubActionsResponse = z.object({
  actions: z.array(HubAction).optional(),
});

// ── Entrada de nuestra propia API ───────────────────────────────────────────

const MessagesParams = z.object({
  phone: z.string().trim().min(1, "phone requerido"),
});

const MessagesQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

const ActionsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
  status: z.string().trim().min(1).max(20).optional(),
});

export function registerBrainConversacionesRoutes(app: FastifyInstance, ctx: ApiContext): void {
  // ── Hilos de chat (lista, sin mensajes) ───────────────────────────────────
  app.get("/api/brain/conversaciones/chats", async () => {
    const hub = requireHub(ctx);
    try {
      const raw = await hub.hubGetJson("/api/agent/chats");
      const parsed = HubChatsResponse.parse(raw ?? {});
      return { threads: parsed.threads ?? [] };
    } catch (err) {
      throw asDomainError(err);
    }
  });

  // ── Mensajes de un hilo, en orden cronológico ─────────────────────────────
  app.get("/api/brain/conversaciones/chats/:phone/messages", async (req) => {
    const { phone } = parse(MessagesParams, req.params);
    const { limit } = parse(MessagesQuery, req.query);
    const hub = requireHub(ctx);
    try {
      const raw = await hub.hubGetJson(`/api/agent/chats/${encodeURIComponent(phone)}/messages`, {
        limit: limit ?? 200,
      });
      const parsed = HubMessagesResponse.parse(raw ?? {});
      return { phone, messages: parsed.messages ?? [] };
    } catch (err) {
      throw asDomainError(err);
    }
  });

  // ── Registro de acciones del agente (auditoría) ───────────────────────────
  app.get("/api/brain/conversaciones/acciones", async (req) => {
    const { limit, status } = parse(ActionsQuery, req.query);
    const hub = requireHub(ctx);
    try {
      const raw = await hub.hubGetJson("/api/agent/actions", {
        limit: limit ?? 100,
        ...(status ? { status } : {}),
      });
      const parsed = HubActionsResponse.parse(raw ?? {});
      return { actions: parsed.actions ?? [] };
    } catch (err) {
      throw asDomainError(err);
    }
  });
}
