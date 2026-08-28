/**
 * Conector WhatsAppHub (Fuentes del proyecto, Fase 2): cliente fetch tipado de
 * los 5 endpoints REST del backend 2brain (protegidos por header `x-wiki-key`).
 *
 * Reglas duras:
 * - La key viene SOLO de env (AGENTOS_WHATSAPPHUB_KEY) y JAMÁS se loguea ni
 *   viaja en errores/respuestas.
 * - Timeout corto SIEMPRE (el VPS sufre CPU steal): un fallo debe ser rápido,
 *   legible y reintentable — nunca colgar el server.
 */
import {
  SourceConnectorError,
  type WhatsAppHubConnector,
  type WhatsAppHubContact,
  type WhatsAppHubMeetingDetail,
  type WhatsAppHubMeetingsPage,
  type WhatsAppHubMeetingSummary,
} from "@agentos/shared";

export const DEFAULT_TIMEOUT_MS = 8_000;

export interface WhatsAppHubConnectorOptions {
  /** Default: env AGENTOS_WHATSAPPHUB_URL. */
  baseUrl?: string | undefined;
  /** Default: env AGENTOS_WHATSAPPHUB_KEY. Nunca se loguea. */
  apiKey?: string | undefined;
  timeoutMs?: number | undefined;
  /** Inyectable en tests (jamás red real en tests). */
  fetchFn?: typeof fetch | undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Normaliza la página de reuniones: acepta array pelado o {meetings|items|data}. */
function normalizeMeetingsPage(payload: unknown): WhatsAppHubMeetingsPage {
  if (Array.isArray(payload)) return { meetings: payload as WhatsAppHubMeetingSummary[] };
  const obj = asRecord(payload);
  const list = obj.meetings ?? obj.items ?? obj.data ?? [];
  return {
    meetings: (Array.isArray(list) ? list : []) as WhatsAppHubMeetingSummary[],
    ...(typeof obj.total === "number" ? { total: obj.total } : {}),
    ...(typeof obj.page === "number" ? { page: obj.page } : {}),
    ...(typeof obj.pageSize === "number" ? { pageSize: obj.pageSize } : {}),
    ...(typeof obj.hasMore === "boolean" ? { hasMore: obj.hasMore } : {}),
  };
}

function normalizeContacts(payload: unknown): WhatsAppHubContact[] {
  if (Array.isArray(payload)) return payload as WhatsAppHubContact[];
  const obj = asRecord(payload);
  const list = obj.contacts ?? obj.items ?? obj.data ?? [];
  return (Array.isArray(list) ? list : []) as WhatsAppHubContact[];
}

/** El endpoint puede servir markdown plano o JSON {markdown|content}. */
function extractMarkdown(raw: string, contentType: string | null): string {
  if (contentType?.includes("application/json")) {
    try {
      const obj = asRecord(JSON.parse(raw));
      const md = obj.markdown ?? obj.content ?? obj.body ?? obj.text;
      if (typeof md === "string") return md;
    } catch {
      /* no era JSON válido: se devuelve tal cual */
    }
  }
  return raw;
}

export function createWhatsAppHubConnector(
  opts: WhatsAppHubConnectorOptions = {},
): WhatsAppHubConnector {
  const baseUrl = (opts.baseUrl ?? process.env.AGENTOS_WHATSAPPHUB_URL ?? "").replace(/\/+$/, "");
  const apiKey = opts.apiKey ?? process.env.AGENTOS_WHATSAPPHUB_KEY ?? "";
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchFn = opts.fetchFn ?? fetch;

  async function request(path: string): Promise<Response> {
    if (!baseUrl || !apiKey) {
      throw new SourceConnectorError(
        "not_configured",
        "Conector WhatsAppHub no configurado: define AGENTOS_WHATSAPPHUB_URL y AGENTOS_WHATSAPPHUB_KEY",
      );
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchFn(`${baseUrl}${path}`, {
        headers: { "x-wiki-key": apiKey },
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new SourceConnectorError(
          "http_error",
          `WhatsAppHub respondió ${res.status} en ${path}`,
          res.status,
        );
      }
      return res;
    } catch (err) {
      if (err instanceof SourceConnectorError) throw err;
      if (err instanceof Error && err.name === "AbortError") {
        throw new SourceConnectorError(
          "timeout",
          `WhatsAppHub no respondió en ${timeoutMs} ms (${path}). El VPS puede estar saturado; reintenta más tarde.`,
        );
      }
      // Mensaje legible SIN detalles internos (y jamás la key).
      throw new SourceConnectorError(
        "unreachable",
        `No se pudo conectar con WhatsAppHub (${path}). ¿VPS caído? Reintenta más tarde.`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async function requestJson(path: string): Promise<unknown> {
    const res = await request(path);
    try {
      return await res.json();
    } catch {
      throw new SourceConnectorError("http_error", `WhatsAppHub devolvió una respuesta no-JSON en ${path}`);
    }
  }

  async function requestMarkdown(path: string): Promise<string> {
    const res = await request(path);
    const raw = await res.text();
    return extractMarkdown(raw, res.headers.get("content-type"));
  }

  return {
    isConfigured: () => Boolean(baseUrl && apiKey),

    async listMeetings(params = {}) {
      const qs = new URLSearchParams();
      if (params.q?.trim()) qs.set("q", params.q.trim());
      if (params.page !== undefined) qs.set("page", String(params.page));
      if (params.pageSize !== undefined) qs.set("pageSize", String(params.pageSize));
      const suffix = qs.toString() ? `?${qs.toString()}` : "";
      return normalizeMeetingsPage(await requestJson(`/api/meetings/audit${suffix}`));
    },

    async getMeeting(meetingId) {
      return asRecord(
        await requestJson(`/api/meetings/${encodeURIComponent(meetingId)}`),
      ) as WhatsAppHubMeetingDetail;
    },

    async getMeetingMarkdown(meetingId) {
      return requestMarkdown(`/api/meetings/${encodeURIComponent(meetingId)}/markdown`);
    },

    async listContacts() {
      return normalizeContacts(await requestJson("/api/wiki/contacts"));
    },

    async getDossierMarkdown(contactId) {
      return requestMarkdown(`/api/wiki/dossier/${encodeURIComponent(contactId)}`);
    },
  };
}
