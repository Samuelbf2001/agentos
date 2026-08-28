/**
 * Mapeo de errores de dominio (AgentosError, códigos estables de @agentos/shared)
 * a HTTP. La forma de respuesta es SIEMPRE { error: { code, message, details? } }
 * — la UI y los tests dependen del `code`, no del texto.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { AgentosError, ErrorCodes, errors, isAgentosError } from "@agentos/shared";

const STATUS_BY_CODE: Record<string, number> = {
  [ErrorCodes.NOT_FOUND]: 404,
  [ErrorCodes.VALIDATION_ERROR]: 400,
  [ErrorCodes.CONFLICT]: 409,
  [ErrorCodes.VERSION_CONFLICT]: 409,
  [ErrorCodes.CLAIM_LOST]: 409,
  [ErrorCodes.IDEMPOTENCY_CONFLICT]: 409,
  [ErrorCodes.INVALID_TRANSITION]: 422,
  [ErrorCodes.GATE_NOT_PASSED]: 422,
  [ErrorCodes.MISSING_ARTIFACT]: 422,
  [ErrorCodes.HUMAN_APPROVAL_REQUIRED]: 422,
  [ErrorCodes.PENDING_APPROVAL]: 422,
  [ErrorCodes.APPROVAL_INVALIDATED]: 422,
  [ErrorCodes.POLICY_DENIED]: 403,
  [ErrorCodes.KILL_SWITCH_ACTIVE]: 409,
  [ErrorCodes.BUDGET_EXCEEDED]: 429,
  [ErrorCodes.DELEGATION_LIMIT]: 422,
  [ErrorCodes.AGENT_NOT_ASSIGNABLE]: 422,
  // Módulos de fase (§13): errores de dominio → 4xx con código estable, jamás 500.
  [ErrorCodes.MODULE_VERSION_IMMUTABLE]: 409,
  [ErrorCodes.MODULE_NOT_ACTIVE]: 409,
  [ErrorCodes.DEPENDENCY_NOT_SATISFIED]: 422,
  [ErrorCodes.PROVIDER_ERROR]: 502,
  [ErrorCodes.PROVIDER_NOT_CONFIGURED]: 502,
  [ErrorCodes.RUNNER_UNAVAILABLE]: 502,
};

export function statusForError(err: AgentosError): number {
  return STATUS_BY_CODE[err.code] ?? 500;
}

/** Error handler global de Fastify: dominio → HTTP con código estable. */
export function handleApiError(err: unknown, _req: FastifyRequest, reply: FastifyReply): void {
  if (isAgentosError(err)) {
    reply.status(statusForError(err)).send({
      error: { code: err.code, message: err.message, details: err.details ?? undefined },
    });
    return;
  }
  const fastifyErr = err as { statusCode?: number; message?: string };
  const status = fastifyErr.statusCode ?? 500;
  reply.status(status).send({
    error: {
      code: status === 500 ? "internal_error" : "http_error",
      message: fastifyErr.message ?? "Error interno",
    },
  });
}

/** Valida body/query con Zod y lanza validation_error de dominio si no cumple. */
export function parse<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const res = schema.safeParse(value ?? {});
  if (!res.success) {
    throw errors.validation("Entrada inválida", res.error.issues);
  }
  return res.data;
}
