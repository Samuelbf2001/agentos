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

/** Item normalizado para el picker de la UI. */
export interface BrowseItem {
  id: string;
  title: string;
  subtitle: string | null;
  url: string | null;
  is_internal: boolean | null;
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
          subtitle: [m.client, m.date].filter(Boolean).join(" · ") || null,
          url: m.url ?? null,
          is_internal: typeof m.is_internal === "boolean" ? m.is_internal : null,
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
}
