/**
 * Fuentes del proyecto (Fase 2): asociar reuniones/hilos de WhatsApp de 2brain
 * a un proyecto, ingerirlas como knowledge_docs tipados y navegar el catálogo
 * remoto (browse) para el picker de la UI.
 *
 * La ingesta usa la MISMA función que la tool `sources.ingest`
 * (@agentos/tools.ingestProjectSource): un solo camino, cero divergencia.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  AgentosError,
  ErrorCodes,
  errors,
  ProjectSourceExternalRef,
  ProjectSourceKind,
  SourceConnectorError,
} from "@agentos/shared";
import {
  appendAudit,
  createProjectSource,
  findProjectSourceByExternalRef,
  getProject,
  getProjectSource,
  listProjectSources,
} from "@agentos/db";
import { ingestProjectSource } from "@agentos/tools";
import type { ApiContext } from "../context.js";
import { parse } from "../http-errors.js";

const LinkSourceBody = z.object({
  kind: ProjectSourceKind,
  external_ref: ProjectSourceExternalRef,
});

const BrowseQuery = z.object({
  kind: ProjectSourceKind,
  q: z.string().optional(),
  page: z.coerce.number().int().positive().optional(),
  page_size: z.coerce.number().int().positive().max(100).optional(),
});

const MeetingProcessingQuery = z.object({
  status: z.enum(["all", "pending", "error", "ok"]).optional(),
  page: z.coerce.number().int().positive().optional(),
  page_size: z.coerce.number().int().positive().max(50).optional(),
});

/** Item normalizado para el picker de la UI. */
export interface BrowseItem {
  id: string;
  title: string;
  subtitle: string | null;
  url: string | null;
  is_internal: boolean | null;
}

/** Metadatos permitidos fuera de WhatsAppHub; nunca transcript, participantes ni extracción. */
export interface MeetingProcessingItem {
  id: string;
  title: string;
  source: string | null;
  meeting_date: string | null;
  created_at: string | null;
  extracted_at: string | null;
  extract_attempts: number | null;
  association_status: string;
  task_status: string;
  notion_synced_at: string | null;
  wiki_exported: boolean;
  wiki_synced_at: string | null;
  processing_error: string | null;
}

function displayText(value: unknown, fallback: string, max = 240): string {
  if (typeof value !== "string") return fallback;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().replace(/\s+/g, " ");
  return normalized ? normalized.slice(0, max) : fallback;
}

function dateOrNull(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function nonNegativeIntOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function normalizeProcessingItem(raw: Record<string, unknown>): MeetingProcessingItem {
  const id = displayText(raw.id, "sin-id", 96);
  return {
    id,
    title: displayText(raw.title, `Reunión ${id}`),
    source: typeof raw.source === "string" ? displayText(raw.source, "", 64) || null : null,
    meeting_date: dateOrNull(raw.meetingDate ?? raw.date),
    created_at: dateOrNull(raw.createdAt),
    extracted_at: dateOrNull(raw.extractedAt),
    extract_attempts: nonNegativeIntOrNull(raw.extractAttempts),
    association_status: displayText(raw.associationStatus, "awaiting_confirmation", 64),
    task_status: displayText(raw.taskStatus, "candidates_pending_confirmation", 64),
    notion_synced_at: dateOrNull(raw.notionSyncedAt),
    wiki_exported: raw.wikiExported === true,
    wiki_synced_at: dateOrNull(raw.wikiSyncedAt),
    processing_error: typeof raw.processingError === "string" ? displayText(raw.processingError, "", 500) || null : null,
  };
}

function requireConnector(ctx: ApiContext) {
  if (!ctx.whatsappHub.isConfigured()) {
    throw new AgentosError(
      ErrorCodes.PROVIDER_NOT_CONFIGURED,
      "Conector WhatsAppHub no configurado: define AGENTOS_WHATSAPPHUB_URL y AGENTOS_WHATSAPPHUB_KEY en el entorno de apps/api",
    );
  }
  return ctx.whatsappHub;
}

/** Los errores del conector viajan como provider_error (502) con mensaje legible. */
function asDomainError(err: unknown): unknown {
  if (err instanceof SourceConnectorError) {
    return new AgentosError(ErrorCodes.PROVIDER_ERROR, err.message, { connector_code: err.code });
  }
  return err;
}

export function registerSourcesRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const { db } = ctx;

  const personActor = (req: { session?: { personId: string } | undefined }): string =>
    `person:${req.session!.personId}`;

  // ── Fuentes de un proyecto ────────────────────────────────────────────────

  app.get("/api/projects/:id/sources", async (req) => {
    const { id } = req.params as { id: string };
    if (!getProject(db, id)) throw errors.notFound("project", id);
    return { sources: listProjectSources(db, { projectId: id }) };
  });

  /** Asociar (kind + external_ref). Idempotente: la misma referencia no duplica. */
  app.post("/api/projects/:id/sources", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!getProject(db, id)) throw errors.notFound("project", id);
    const body = parse(LinkSourceBody, req.body);
    const ref = body.external_ref;
    if (body.kind === "meeting" && !ref.meetingId) {
      throw errors.validation("external_ref.meetingId es obligatorio para kind='meeting'");
    }
    if (body.kind === "whatsapp_thread" && !ref.contactId) {
      throw errors.validation("external_ref.contactId es obligatorio para kind='whatsapp_thread'");
    }

    const existing = findProjectSourceByExternalRef(db, id, body.kind, ref);
    if (existing) {
      return { source: existing, deduped: true };
    }
    const source = createProjectSource(db, {
      projectId: id,
      kind: body.kind,
      externalRef: ref,
      status: "linked",
      createdBy: personActor(req),
    });
    appendAudit(db, {
      actor: personActor(req),
      source: "ui",
      action: "source.link",
      entityType: "project_source",
      entityId: source.id,
      after: { projectId: id, kind: body.kind, externalRef: ref },
    });
    reply.status(201);
    return { source, deduped: false };
  });

  // ── Ingesta (y re-ingesta: actualiza el MISMO doc) ────────────────────────

  app.post("/api/sources/:id/ingest", async (req) => {
    const { id } = req.params as { id: string };
    if (!getProjectSource(db, id)) throw errors.notFound("project_source", id);
    const connector = requireConnector(ctx);
    const actor = personActor(req);
    const { source, doc } = await ingestProjectSource(db, connector, id, actor);
    appendAudit(db, {
      actor,
      source: "ui",
      action: "source.ingest",
      entityType: "project_source",
      entityId: source.id,
      after: { status: source.status, knowledgeDocId: source.knowledgeDocId, docKind: doc.kind },
    });
    return { source, doc };
  });

  // ── Browse (proxy del catálogo remoto para el picker) ─────────────────────

  app.get("/api/sources/browse", async (req) => {
    const q = parse(BrowseQuery, req.query);
    const connector = requireConnector(ctx);
    const page = q.page ?? 1;
    const pageSize = q.page_size ?? 20;
    const needle = q.q?.trim().toLowerCase() ?? "";

    try {
      if (q.kind === "meeting") {
        const res = await connector.listMeetings({
          ...(needle ? { q: needle } : {}),
          page,
          pageSize,
        });
        // Filtro local de respaldo (si el backend ignora `q`).
        const filtered = needle
          ? res.meetings.filter((m) =>
              `${m.title ?? ""} ${m.client ?? ""}`.toLowerCase().includes(needle),
            )
          : res.meetings;
        const items: BrowseItem[] = filtered.map((m) => ({
          id: String(m.id),
          title: m.title?.trim() || `Reunión ${m.id}`,
          subtitle: [m.client, m.meetingDate ?? m.date].filter(Boolean).join(" · ") || null,
          url: m.url ?? null,
          is_internal:
            typeof m.is_internal === "boolean"
              ? m.is_internal
              : typeof (m as Record<string, unknown>).isInternal === "boolean"
                ? ((m as Record<string, unknown>).isInternal as boolean)
                : null,
        }));
        return {
          items,
          page,
          page_size: pageSize,
          total: res.total ?? null,
          has_more: res.hasMore ?? (res.total !== undefined ? page * pageSize < res.total : items.length >= pageSize),
        };
      }

      // whatsapp_thread: el backend lista todos los contactos; filtro+paginación locales.
      const contacts = await connector.listContacts();
      const filtered = needle
        ? contacts.filter((c) => `${c.name ?? ""} ${c.phone ?? ""} ${c.id}`.toLowerCase().includes(needle))
        : contacts;
      const start = (page - 1) * pageSize;
      const items: BrowseItem[] = filtered.slice(start, start + pageSize).map((c) => ({
        id: String(c.id),
        title: c.name?.trim() || String(c.phone ?? c.id),
        subtitle: c.phone ?? null,
        url: null,
        is_internal: null,
      }));
      return {
        items,
        page,
        page_size: pageSize,
        total: filtered.length,
        has_more: start + pageSize < filtered.length,
      };
    } catch (err) {
      throw asDomainError(err);
    }
  });

  /**
   * Ledger visible del pipeline histórico de reuniones. Es intencionalmente
   * read-only: AgentOS observa captura → extracción → revisión humana →
   * sincronías, pero no invoca process/review/Notion en WhatsAppHub.
   */
  app.get("/api/meetings/processing", async (req) => {
    const q = parse(MeetingProcessingQuery, req.query);
    const connector = requireConnector(ctx);
    const page = q.page ?? 1;
    const pageSize = q.page_size ?? 20;
    const status = q.status ?? "all";
    try {
      const [selected, pending, errors, complete] = await Promise.all([
        connector.listMeetings({ page, pageSize, status }),
        connector.listMeetings({ page: 1, pageSize: 1, status: "pending" }),
        connector.listMeetings({ page: 1, pageSize: 1, status: "error" }),
        connector.listMeetings({ page: 1, pageSize: 1, status: "ok" }),
      ]);
      const localMeetings = listProjectSources(db, { kind: "meeting" });
      return {
        source: "2brain / WhatsAppHub",
        mode: "remote_read_only" as const,
        page,
        page_size: pageSize,
        status,
        total: selected.total ?? null,
        has_more: selected.hasMore ?? false,
        queue: {
          pending: pending.total ?? null,
          errors: errors.total ?? null,
          complete: complete.total ?? null,
        },
        agentos_context: {
          linked: localMeetings.length,
          ingested: localMeetings.filter((item) => item.status === "ingested").length,
          errors: localMeetings.filter((item) => item.status === "error").length,
        },
        meetings: selected.meetings.map((meeting) => normalizeProcessingItem(meeting as Record<string, unknown>)),
      };
    } catch (err) {
      throw asDomainError(err);
    }
  });
}
