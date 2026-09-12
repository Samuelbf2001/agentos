/**
 * Asistente de IA de la ficha de tarea.
 *
 * `POST /api/ai/task-assist` hace dos cosas según `mode`:
 * - `enrich`: mejora UN campo del borrador (título, descripción o definición de
 *   terminado) con el contexto del cliente y las capturas pegadas.
 * - `execution_prompt`: redacta el prompt listo para pegar en Claude Code.
 *
 * Dos decisiones que la interfaz da por hechas:
 * - En `enrich`, si el proveedor falla se responde 503 con el sobre estándar
 *   `{ error: { code: "provider_unavailable", message } }`:
 *   un campo inventado por defecto sería peor que un error visible.
 * - En `execution_prompt` NUNCA se falla: si el proveedor cae, sale la misma
 *   estructura armada en código (`context.model === "plantilla"`), porque el
 *   botón "Copiar prompt" tiene que funcionar siempre.
 */
import type { FastifyInstance } from "fastify";
import { appendAudit } from "@agentos/db";
import { ErrorCodes, isAgentosError } from "@agentos/shared";
import type { TokenUsage } from "@agentos/providers";
import type { ApiContext } from "../context.js";
import { parse } from "../http-errors.js";
import { estimarCosteUsd } from "../tasks/assist-pricing.js";
import { TaskAssistBody, buildTaskAssistContext } from "../tasks/assist-context.js";
import {
  SYSTEM_ENRIQUECER,
  SYSTEM_PROMPT_EJECUCION,
  construirPromptEjecucion,
  construirPromptEnriquecer,
  plantillaPromptEjecucion,
  publicBaseUrl,
} from "../tasks/assist-prompts.js";

/** Modelo declarado cuando la respuesta la armó el código, no el proveedor. */
export const MODELO_PLANTILLA = "plantilla";

export function registerAiRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const { db } = ctx;
  const personActor = (req: { session?: { personId: string } | undefined }): string =>
    `person:${req.session!.personId}`;

  app.post("/api/ai/task-assist", async (req, reply) => {
    const body = parse(TaskAssistBody, req.body);
    const assistContext = await buildTaskAssistContext(db, body);
    const base = publicBaseUrl();

    const system = body.mode === "enrich" ? SYSTEM_ENRIQUECER : SYSTEM_PROMPT_EJECUCION;
    const prompt =
      body.mode === "enrich"
        ? construirPromptEnriquecer(assistContext, body, base)
        : construirPromptEjecucion(assistContext, body, base);

    let text: string;
    let model: string;
    let usage: TokenUsage | null = null;
    try {
      const completion = await ctx.taskAssistant.complete({
        system,
        prompt,
        images: assistContext.images.map((image) => ({
          data: image.data,
          mediaType: image.mediaType,
        })),
      });
      text = completion.text;
      model = completion.model;
      usage = completion.usage;
    } catch (err) {
      if (body.mode === "execution_prompt") {
        // Plan B determinista: misma estructura, sin modelo.
        text = plantillaPromptEjecucion(assistContext, body, base);
        model = MODELO_PLANTILLA;
        req.log?.warn?.(
          { mode: body.mode },
          "asistente de tareas no disponible: se devuelve la plantilla determinista",
        );
      } else if (isAgentosError(err, ErrorCodes.PROVIDER_UNAVAILABLE)) {
        // El mensaje ya viene saneado por `asProviderUnavailable`: nombra como
        // mucho la VARIABLE de entorno, nunca la clave.
        return reply
          .status(503)
          .send({ error: { code: ErrorCodes.PROVIDER_UNAVAILABLE, message: err.message } });
      } else {
        throw err;
      }
    }

    // En modo plantilla no hubo llamada al modelo: coste cero, no "sin datos".
    // Fuera de plantilla, sin usage (el proveedor no lo informó) es `null`, nunca cero inferido.
    const usageInfo =
      model === MODELO_PLANTILLA
        ? { input_tokens: 0, output_tokens: 0, cost_usd: 0 }
        : usage
          ? {
              input_tokens: usage.tokensIn ?? 0,
              output_tokens: usage.tokensOut ?? 0,
              cost_usd: estimarCosteUsd(model, usage),
            }
          : null;

    await appendAudit(db, {
      actor: personActor(req),
      source: "ui",
      action: "task.assist",
      entityType: "task",
      entityId: body.task_id ?? null,
      after: {
        mode: body.mode,
        field: body.field ?? null,
        project_id: assistContext.project?.id ?? null,
        model,
        docs: assistContext.docs.length,
        images: assistContext.images.length,
        sibling_tasks: assistContext.siblingTasks.length,
        chars: text.length,
        input_tokens: usageInfo?.input_tokens ?? null,
        output_tokens: usageInfo?.output_tokens ?? null,
        cost_usd: usageInfo?.cost_usd ?? null,
      },
    });

    return {
      text,
      context: {
        org_name: assistContext.org?.name ?? null,
        project_name: assistContext.project?.name ?? null,
        docs: assistContext.docs.length,
        images: assistContext.images.length,
        sibling_tasks: assistContext.siblingTasks.length,
        model,
        usage: usageInfo,
      },
    };
  });
}
