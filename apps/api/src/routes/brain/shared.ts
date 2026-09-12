/**
 * Utilidades compartidas por las rutas que hablan con el conector WhatsAppHub
 * (Fuentes del proyecto y los seis módulos de 2brain): exigir el conector
 * configurado y traducir sus errores a errores de dominio. Un solo camino
 * para que ninguna ruta invente su propio mensaje o código HTTP.
 */
import { AgentosError, ErrorCodes, SourceConnectorError, type WhatsAppHubConnector } from "@agentos/shared";
import type { ApiContext } from "../../context.js";

/** Exige el conector configurado (URL + key); si no, provider_not_configured legible. */
export function requireConnector(ctx: ApiContext): WhatsAppHubConnector {
  if (!ctx.whatsappHub.isConfigured()) {
    throw new AgentosError(
      ErrorCodes.PROVIDER_NOT_CONFIGURED,
      "Conector WhatsAppHub no configurado: define AGENTOS_WHATSAPPHUB_URL y AGENTOS_WHATSAPPHUB_KEY en el entorno de apps/api",
    );
  }
  return ctx.whatsappHub;
}

/** Los errores del conector viajan como provider_error (502) con mensaje legible. */
export function asDomainError(err: unknown): unknown {
  if (err instanceof SourceConnectorError) {
    return new AgentosError(ErrorCodes.PROVIDER_ERROR, err.message, { connector_code: err.code });
  }
  return err;
}

/**
 * Exige los métodos genéricos del hub (`hubGetJson`/`hubSendJson`/`hubGetText`/
 * `hubGetRaw`) para los seis módulos de 2brain; si el conector inyectado no los
 * expone (p. ej. un mock viejo de test), el mismo error de proveedor no
 * configurado que `requireConnector`, no un `TypeError` al invocar `undefined`.
 */
export function requireHub(
  ctx: ApiContext,
): Required<Pick<WhatsAppHubConnector, "hubGetJson" | "hubSendJson" | "hubGetText" | "hubGetRaw">> {
  const connector = requireConnector(ctx);
  const { hubGetJson, hubSendJson, hubGetText, hubGetRaw } = connector;
  if (!hubGetJson || !hubSendJson || !hubGetText || !hubGetRaw) {
    throw new AgentosError(
      ErrorCodes.PROVIDER_NOT_CONFIGURED,
      "Conector WhatsAppHub sin los métodos genéricos de 2brain (hubGetJson/hubSendJson/hubGetText/hubGetRaw)",
    );
  }
  return { hubGetJson, hubSendJson, hubGetText, hubGetRaw };
}
