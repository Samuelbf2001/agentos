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
  type WhatsAppHubWikiPagesStatus,
  type WhatsAppHubWikiStats,
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

function asNonNegativeInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    return undefined;
  }
  return value;
}

function asIsoDate(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  if (typeof value !== "string" && typeof value !== "number") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Normaliza solo los agregados documentados por WhatsAppHub. Las claves
 * desconocidas se descartan para evitar que el VPS pueda inyectar contenido o
 * PII en la respuesta de AgentOS.
 */
function normalizeWikiStats(payload: unknown): WhatsAppHubWikiStats {
  const obj = asRecord(payload);
  const counts: Record<string, number> = {};
  const keys: Record<string, string> = {
    total_contacts: "contacts",
    total_inbound: "messages_inbound",
    total_outbound: "messages_outbound",
    active_7d: "active_7d",
  };
  for (const [remoteKey, localKey] of Object.entries(keys)) {
    const count = asNonNegativeInt(obj[remoteKey]);
    if (count !== undefined) counts[localKey] = count;
  }
  const lastActivity = asIsoDate(obj.last_activity);
  if (Object.keys(counts).length === 0 && !lastActivity) {
    throw new SourceConnectorError(
      "http_error",
      "WhatsAppHub devolvió un agregado inválido en /api/wiki/stats",
    );
  }
  return { counts, lastActivity };
}

function normalizeWikiPagesStatus(payload: unknown): WhatsAppHubWikiPagesStatus {
  const obj = asRecord(payload);
  const total = asNonNegativeInt(obj.total);
  if (total === undefined) {
    throw new SourceConnectorError(
      "http_error",
      "WhatsAppHub devolvió un agregado inválido en /api/wiki/pages/status",
    );
  }
  const countsByType: Record<string, number> = {};
  const rawByType = asRecord(obj.byType ?? obj.by_type);
  for (const [type, value] of Object.entries(rawByType)) {
    // El nombre del tipo se muestra solo como una faceta; no permitimos rutas,
    // HTML ni cadenas excesivas procedentes del endpoint remoto.
    if (!/^[a-z0-9_-]{1,64}$/u.test(type)) continue;
    const count = asNonNegativeInt(value);
    if (count !== undefined) countsByType[type] = count;
  }
  return {
    total,
    byType: countsByType,
    lastIngestedAt: asIsoDate(obj.lastIngestedAt ?? obj.last_ingested_at),
  };
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
    ...(typeof obj.pageSize === "number"
      ? { pageSize: obj.pageSize }
      : typeof obj.limit === "number"
        ? { pageSize: obj.limit }
        : {}),
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

/** Serializa la query de los métodos genéricos; omite claves `undefined`. */
function serializeQuery(query?: Record<string, string | number | boolean | undefined>): string {
  if (!query) return "";
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    qs.set(key, String(value));
  }
  const suffix = qs.toString();
  return suffix ? `?${suffix}` : "";
}

export function createWhatsAppHubConnector(
  opts: WhatsAppHubConnectorOptions = {},
): WhatsAppHubConnector {
  const baseUrl = (opts.baseUrl ?? process.env.AGENTOS_WHATSAPPHUB_URL ?? "").replace(/\/+$/, "");
  const apiKey = opts.apiKey ?? process.env.AGENTOS_WHATSAPPHUB_KEY ?? "";
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchFn = opts.fetchFn ?? fetch;

  /**
   * Núcleo de toda llamada autenticada al hub. Los métodos genéricos
   * (`hubGetJson`/`hubSendJson`/`hubGetText`/`hubGetRaw`, para los seis
   * módulos de 2brain) reutilizan esta misma función con `opts`; las llamadas
   * sin `opts` (los 5 endpoints históricos) se comportan exactamente igual que
   * antes: GET, solo el header `x-wiki-key`, timeout por defecto.
   */
  async function request(
    path: string,
    callOpts: {
      method?: string;
      body?: unknown;
      timeoutMs?: number;
      headers?: Record<string, string>;
    } = {},
  ): Promise<Response> {
    if (!baseUrl || !apiKey) {
      throw new SourceConnectorError(
        "not_configured",
        "Conector WhatsAppHub no configurado: define AGENTOS_WHATSAPPHUB_URL y AGENTOS_WHATSAPPHUB_KEY",
      );
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), callOpts.timeoutMs ?? timeoutMs);
    try {
      const res = await fetchFn(`${baseUrl}${path}`, {
        method: callOpts.method ?? "GET",
        headers: {
          "x-wiki-key": apiKey,
          // `hubSendJson` manda cuerpo JSON: el content-type por defecto se
          // puede sobrescribir vía `headers`, pero nadie más lo necesita hoy.
          ...(callOpts.body !== undefined ? { "content-type": "application/json" } : {}),
          ...(callOpts.headers ?? {}),
        },
        ...(callOpts.body !== undefined ? { body: JSON.stringify(callOpts.body) } : {}),
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
          `WhatsAppHub no respondió en ${callOpts.timeoutMs ?? timeoutMs} ms (${path}). El VPS puede estar saturado; reintenta más tarde.`,
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

  /** Igual que request(), pero para los endpoints de agregados que el VPS
   * permite consultar sin key. Si hay key, se manda igualmente por consistencia
   * y para que instalaciones que protegen también estas lecturas funcionen. */
  async function requestOverview(path: string): Promise<Response> {
    if (!baseUrl) {
      throw new SourceConnectorError(
        "not_configured",
        "Conector WhatsAppHub no configurado: define AGENTOS_WHATSAPPHUB_URL",
      );
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers: Record<string, string> = {};
      if (apiKey) headers["x-wiki-key"] = apiKey;
      const res = await fetchFn(`${baseUrl}${path}`, {
        headers,
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
      throw new SourceConnectorError(
        "unreachable",
        `No se pudo conectar con WhatsAppHub (${path}). ¿VPS caído? Reintenta más tarde.`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async function requestJson(
    path: string,
    opts: { method?: string; body?: unknown; timeoutMs?: number } = {},
  ): Promise<unknown> {
    const res = await request(path, opts);
    try {
      return await res.json();
    } catch {
      throw new SourceConnectorError("http_error", `WhatsAppHub devolvió una respuesta no-JSON en ${path}`);
    }
  }

  async function requestText(path: string, opts: { timeoutMs?: number } = {}): Promise<string> {
    const res = await request(path, opts);
    return res.text();
  }

  async function requestRaw(
    path: string,
    opts: { timeoutMs?: number } = {},
  ): Promise<{ status: number; contentType: string | null; body: Uint8Array }> {
    const res = await request(path, opts);
    const buffer = await res.arrayBuffer();
    return { status: res.status, contentType: res.headers.get("content-type"), body: new Uint8Array(buffer) };
  }

  async function requestOverviewJson(path: string): Promise<unknown> {
    const res = await requestOverview(path);
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
    isOverviewConfigured: () => Boolean(baseUrl),

    async getWikiStats() {
      return normalizeWikiStats(await requestOverviewJson("/api/wiki/stats"));
    },

    async getWikiPagesStatus() {
      return normalizeWikiPagesStatus(await requestOverviewJson("/api/wiki/pages/status"));
    },

    async listMeetings(params = {}) {
      const qs = new URLSearchParams();
      if (params.q?.trim()) qs.set("q", params.q.trim());
      if (params.page !== undefined) qs.set("page", String(params.page));
      // WhatsAppHub documenta `limit`; antes enviábamos `pageSize`, que el
      // backend histórico ignora y podía devolver hasta 100 filas por lectura.
      if (params.pageSize !== undefined) qs.set("limit", String(params.pageSize));
      if (params.status && params.status !== "all") qs.set("status", params.status);
      const suffix = qs.toString() ? `?${qs.toString()}` : "";
      return normalizeMeetingsPage(await requestJson(`/api/meetings/audit${suffix}`));
    },

    async getMeeting(meetingId) {
      const payload = asRecord(await requestJson(`/api/meetings/${encodeURIComponent(meetingId)}`));
      // El backend legado responde { meeting: {...} }; aceptar también el
      // objeto plano conserva compatibilidad con instalaciones anteriores.
      return asRecord(payload.meeting ?? payload) as WhatsAppHubMeetingDetail;
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

    // ── Genéricos para los módulos de 2brain (conversaciones, notas de voz,
    // grabadora, videos, grafo, agente): la ruta que llama valida la forma con
    // Zod, este conector solo transporta la petición autenticada. ───────────

    async hubGetJson(path, query, opts) {
      return requestJson(`${path}${serializeQuery(query)}`, { timeoutMs: opts?.timeoutMs });
    },

    async hubSendJson(method, path, body, opts) {
      return requestJson(path, {
        method,
        body,
        timeoutMs: opts?.timeoutMs,
      });
    },

    async hubGetText(path, opts) {
      return requestText(path, { timeoutMs: opts?.timeoutMs });
    },

    async hubGetRaw(path, opts) {
      return requestRaw(path, { timeoutMs: opts?.timeoutMs });
    },
  };
}
