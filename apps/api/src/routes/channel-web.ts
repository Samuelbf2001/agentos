/**
 * Canal `web` — contrato de gateway de canales (ARCHITECTURE §9).
 * El chat web ES el canal web desde el día 1:
 *
 * - Entrada: POST /v1/channels/web/events con InboundMessage.
 * - Idempotencia por unique(channel, message_id): duplicado → 200 {deduped:true}
 *   sin segundo run (silencioso).
 * - Resuelve/crea thread por session_key, persiste el mensaje y encola el run
 *   de Alex (el orquestador).
 * - Salida: deltas TEXT_MESSAGE_* por el topic del run/thread; el OutboundMessage
 *   final se publica a thread:<id> y channel:web (lo hace el despachador).
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AgentosError, isAgentosError, ErrorCodes } from "@agentos/shared";
import {
  appendMessage,
  buildSessionKey,
  findChannelMessage,
  getOrCreateThread,
  setThreadProject,
} from "@agentos/db";
import { channelTopic, threadTopic } from "@agentos/events";
import type { ApiContext } from "../context.js";
import { publishRaw } from "../bus-bridge.js";
import { parse } from "../http-errors.js";

export const WEB_CHANNEL = "web";

export const InboundMessage = z.object({
  external_user_id: z.string().min(1),
  external_chat_id: z.string().min(1),
  message_id: z.string().min(1),
  text: z.string().min(1),
  thread_hint: z.string().optional(),
  project_id: z.string().optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});
export type InboundMessage = z.infer<typeof InboundMessage>;

export function registerWebChannel(app: FastifyInstance, ctx: ApiContext): void {
  const { db, bus, dispatcher } = ctx;

  app.post("/v1/channels/web/events", async (req, reply) => {
    const body = parse(InboundMessage, req.body);

    // Dedup por (channel, message_id): descarta el duplicado en silencio.
    const existing = await findChannelMessage(db, WEB_CHANNEL, body.message_id);
    if (existing) {
      return reply.status(200).send({
        deduped: true,
        thread_id: existing.threadId,
        message_id: existing.id,
        run_id: null,
      });
    }

    let thread = await getOrCreateThread(db, {
      channel: WEB_CHANNEL,
      sessionKey: buildSessionKey(WEB_CHANNEL, body.external_chat_id, body.thread_hint),
      projectId: body.project_id ?? null,
    });
    // Reconciliación (DISENO-SCOPE-GATEWAY §1): getOrCreateThread solo fija el
    // proyecto al crear. Un hilo sin proyecto adopta el que llega; un hilo vivo
    // de OTRO proyecto no se reasigna en silencio (409 conflict).
    if (body.project_id) {
      if (thread.projectId == null) {
        thread = await setThreadProject(db, thread.id, body.project_id);
      } else if (thread.projectId !== body.project_id) {
        throw new AgentosError(
          ErrorCodes.CONFLICT,
          `El hilo ${thread.id} ya pertenece al proyecto ${thread.projectId}; no se reasigna a ${body.project_id}`,
          { thread_id: thread.id, thread_project_id: thread.projectId, project_id: body.project_id },
        );
      }
    }

    const { message, inserted } = await appendMessage(db, {
      threadId: thread.id,
      role: "user",
      content: body.text,
      idempotencyKey: body.message_id,
      actor: req.session ? `person:${req.session.personId}` : `system:channel-web`,
      meta: {
        external_user_id: body.external_user_id,
        external_chat_id: body.external_chat_id,
        ...(body.meta ?? {}),
      },
    });
    if (!inserted) {
      // Carrera con otro POST idéntico: el índice único manda.
      return reply.status(200).send({
        deduped: true,
        thread_id: thread.id,
        message_id: message.id,
        run_id: null,
      });
    }

    await publishRaw(bus, threadTopic(thread.id), {
      type: "message.inbound",
      payload: {
        channel: WEB_CHANNEL,
        thread_id: thread.id,
        message_id: message.id,
        external_user_id: body.external_user_id,
        text: body.text,
      },
    });
    await publishRaw(bus, channelTopic(WEB_CHANNEL), {
      type: "message.inbound",
      payload: { thread_id: thread.id, message_id: message.id },
    });

    // Encolar el run de Alex. Si el kill switch está activo el mensaje queda
    // persistido y se responde con el aviso (no hay run).
    try {
      const { runId } = await dispatcher.enqueueChatRun({ threadId: thread.id, text: body.text });
      return reply.status(200).send({
        deduped: false,
        thread_id: thread.id,
        message_id: message.id,
        run_id: runId,
      });
    } catch (err) {
      if (
        isAgentosError(err, ErrorCodes.KILL_SWITCH_ACTIVE) ||
        isAgentosError(err, ErrorCodes.BUDGET_EXCEEDED) ||
        isAgentosError(err, ErrorCodes.POLICY_DENIED)
      ) {
        return reply.status(200).send({
          deduped: false,
          thread_id: thread.id,
          message_id: message.id,
          run_id: null,
          warning: err.code,
        });
      }
      throw err;
    }
  });
}
