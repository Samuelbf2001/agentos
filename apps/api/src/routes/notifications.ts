/** Rutas internas para el procesador de avisos seguros del MVP. */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ApiContext } from "../context.js";
import { parse } from "../http-errors.js";

// El reloj es exclusivamente del servidor. Aceptar una fecha desde la solicitud
// permitiría adelantar recordatorios aunque nunca se pudiera elegir destinatario.
const ProcessDueBody = z.object({}).strict();

export function registerNotificationRoutes(app: FastifyInstance, ctx: ApiContext): void {
  app.post("/api/notifications/process-due", async (req) => {
    parse(ProcessDueBody, req.body ?? {});
    const result = await ctx.notifications.processDue();
    return {
      ...result,
      provider: ctx.notifications.delivery.provider ?? "off",
      delivery_enabled: ctx.notifications.delivery.enabled,
    };
  });
}
