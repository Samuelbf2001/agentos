/**
 * Errores propios del MCP admin (los de dominio vienen de @agentos/shared).
 * `read_only_profile` es la regla dura del perfil `ro` (ARCHITECTURE §7):
 * toda mutación se rechaza con este código, jamás se ejecuta en silencio.
 */
import { isAgentosError } from "@agentos/shared";

export const AdminErrorCodes = {
  READ_ONLY_PROFILE: "read_only_profile",
  UNKNOWN_TOOL: "unknown_tool",
} as const;

export type AdminErrorCode = (typeof AdminErrorCodes)[keyof typeof AdminErrorCodes];

export class McpAdminError extends Error {
  readonly code: AdminErrorCode;
  readonly details: unknown;

  constructor(code: AdminErrorCode, message?: string, details?: unknown) {
    super(message ?? code);
    this.name = "McpAdminError";
    this.code = code;
    this.details = details;
  }
}

export interface ErrorPayload {
  status: "error";
  code: string;
  message: string;
  details?: unknown;
}

/** Serializa cualquier error a un payload estable para el cliente MCP. */
export function toErrorPayload(err: unknown): ErrorPayload {
  if (err instanceof McpAdminError) {
    return { status: "error", code: err.code, message: err.message, details: err.details };
  }
  if (isAgentosError(err)) {
    return { status: "error", code: err.code, message: err.message, details: err.details };
  }
  return {
    status: "error",
    code: "internal_error",
    message: err instanceof Error ? err.message : String(err),
  };
}
