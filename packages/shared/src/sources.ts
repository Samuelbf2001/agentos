/**
 * Fuentes del proyecto (Fase 2): tipos compartidos para asociar reuniones y
 * conversaciones de WhatsApp del ecosistema 2brain (WhatsAppHub) a un proyecto
 * e ingerirlas como documentos tipados del Context Hub (ARCHITECTURE §8b).
 *
 * Solo TIPOS y contratos: la implementación real del conector vive en
 * apps/api/src/connectors/whatsapphub.ts (la key jamás sale de env).
 */
import { z } from "zod";

// ── Dominio project_sources ─────────────────────────────────────────────────

export const ProjectSourceKind = z.enum(["meeting", "whatsapp_thread"]);
export type ProjectSourceKind = z.infer<typeof ProjectSourceKind>;

export const ProjectSourceStatus = z.enum(["linked", "ingested", "error"]);
export type ProjectSourceStatus = z.infer<typeof ProjectSourceStatus>;

/** Referencia externa de la fuente: qué cosa de 2brain es. */
export const ProjectSourceExternalRef = z.object({
  system: z.literal("whatsapphub"),
  /** id de reunión (kind='meeting'). */
  meetingId: z.string().optional(),
  /** id de contacto/hilo (kind='whatsapp_thread'). */
  contactId: z.string().optional(),
  title: z.string().min(1),
  url: z.string().optional(),
});
export type ProjectSourceExternalRef = z.infer<typeof ProjectSourceExternalRef>;

// ── Contrato del conector WhatsAppHub ───────────────────────────────────────

/** Item del listado GET /api/meetings/audit. */
export interface WhatsAppHubMeetingSummary {
  id: string;
  title?: string | null;
  client?: string | null;
  date?: string | null;
  is_internal?: boolean | null;
  url?: string | null;
  [key: string]: unknown;
}

export interface WhatsAppHubMeetingsPage {
  meetings: WhatsAppHubMeetingSummary[];
  total?: number;
  page?: number;
  pageSize?: number;
  hasMore?: boolean;
}

/** Detalle GET /api/meetings/:id (extraction y confirmedLinks incluidos). */
export interface WhatsAppHubMeetingDetail extends WhatsAppHubMeetingSummary {
  extraction?: Record<string, unknown> | null;
  confirmedLinks?: unknown[] | null;
}

/** Contacto/hilo del listado GET /api/wiki/contacts. */
export interface WhatsAppHubContact {
  id: string;
  name?: string | null;
  phone?: string | null;
  [key: string]: unknown;
}

/**
 * Cliente tipado de los 5 endpoints REST de WhatsAppHub. La implementación
 * real (apps/api) mete timeout corto y errores legibles; los tests inyectan
 * un mock — ninguna llamada real sale de los tests.
 */
export interface WhatsAppHubConnector {
  /** ¿Hay URL + key configuradas? (sin esto, toda llamada falla legible). */
  isConfigured(): boolean;
  listMeetings(params?: {
    q?: string;
    page?: number;
    pageSize?: number;
  }): Promise<WhatsAppHubMeetingsPage>;
  getMeeting(meetingId: string): Promise<WhatsAppHubMeetingDetail>;
  getMeetingMarkdown(meetingId: string): Promise<string>;
  listContacts(): Promise<WhatsAppHubContact[]>;
  getDossierMarkdown(contactId: string): Promise<string>;
}

/** Códigos de fallo del conector — siempre con mensaje legible para la UI. */
export type SourceConnectorErrorCode =
  | "not_configured"
  | "timeout"
  | "unreachable"
  | "http_error";

/**
 * Error del conector: el VPS de WhatsAppHub sufre CPU steal y puede caerse o
 * tardar — el fallo debe ser corto, legible y reintentable, nunca colgar el
 * server ni filtrar la key.
 */
export class SourceConnectorError extends Error {
  readonly code: SourceConnectorErrorCode;
  readonly status: number | undefined;

  constructor(code: SourceConnectorErrorCode, message: string, status?: number) {
    super(message);
    this.name = "SourceConnectorError";
    this.code = code;
    this.status = status;
  }
}
