/**
 * Fuentes del proyecto (Fase 2): `sources.list` y `sources.ingest` + la lógica
 * compartida de ingesta (la MISMA que usan las rutas REST de apps/api, para que
 * tool y API no diverjan jamás).
 *
 * `sources.ingest` NO es de efecto externo: es lectura de 2brain hacia dentro
 * (trae markdown de WhatsAppHub y lo registra tipado en el Context Hub).
 */
import { z } from "zod";
import {
  AgentosError,
  ErrorCodes,
  errors,
  nowMs,
  ProjectSourceKind,
  ProjectSourceStatus,
  SourceConnectorError,
  type KnowledgeKind,
  type WhatsAppHubConnector,
} from "@agentos/shared";
import {
  getProject,
  getProjectSource,
  listProjectSources,
  updateProjectSource,
  upsertDoc,
  type AgentosDb,
  type KnowledgeDoc,
  type ProjectSource,
} from "@agentos/db";
import type { ToolDefinition } from "../types.js";
import { defineTool as def } from "../catalog.js";

/** Ids "planos" del payload de 2brain: todo campo *id* top-level viaja a source_refs. */
function collectIds(payload: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!payload) return out;
  for (const [key, value] of Object.entries(payload)) {
    if (!/id$/i.test(key)) continue;
    if (typeof value === "string" || typeof value === "number") out[key] = value;
  }
  return out;
}

function readableConnectorMessage(err: unknown): string {
  if (err instanceof SourceConnectorError) return err.message;
  if (err instanceof AgentosError) return err.message;
  if (err instanceof Error) return `Fallo del conector WhatsAppHub: ${err.message}`;
  return `Fallo del conector WhatsAppHub: ${String(err)}`;
}

export interface IngestResult {
  source: ProjectSource;
  doc: KnowledgeDoc;
}

/**
 * Ingesta una fuente asociada: trae el markdown del conector, crea/actualiza el
 * knowledge_doc TIPADO (reunión → 'interview' o 'evidence' según is_internal;
 * hilo de WhatsApp → 'evidence') con source_refs con TODOS los ids de 2brain,
 * y deja la fila project_sources coherente:
 * - éxito → status 'ingested' + knowledge_doc_id (re-ingerir actualiza el MISMO doc)
 * - fallo del conector → status 'error' + last_error legible, SIN doc huérfano
 */
export async function ingestProjectSource(
  db: AgentosDb,
  connector: WhatsAppHubConnector,
  sourceId: string,
  actor: string,
): Promise<IngestResult> {
  const source = await getProjectSource(db, sourceId);
  if (!source) throw errors.notFound("project_source", sourceId);
  const project = await getProject(db, source.projectId);
  if (!project) throw errors.notFound("project", source.projectId);

  try {
    const now = nowMs();
    let bodyMd: string;
    let docKind: KnowledgeKind;
    let title: string;
    let sourceRef: Record<string, unknown>;

    if (source.kind === "meeting") {
      const meetingId = source.externalRef.meetingId;
      if (!meetingId) {
        throw errors.validation(`La fuente ${sourceId} (meeting) no tiene meetingId en external_ref`);
      }
      const detail = await connector.getMeeting(meetingId);
      bodyMd = await connector.getMeetingMarkdown(meetingId);
      const isInternal = detail.is_internal === true;
      // Reunión con cliente = entrevista; reunión interna = evidencia.
      docKind = isInternal ? "evidence" : "interview";
      title = source.externalRef.title || detail.title || `Reunión ${meetingId}`;
      sourceRef = {
        system: "whatsapphub",
        kind: "meeting",
        meeting_id: meetingId,
        project_source_id: source.id,
        title,
        is_internal: detail.is_internal ?? null,
        ...(source.externalRef.url ? { url: source.externalRef.url } : {}),
        ids: collectIds(detail),
        ingested_at: now,
      };
    } else {
      const contactId = source.externalRef.contactId;
      if (!contactId) {
        throw errors.validation(
          `La fuente ${sourceId} (whatsapp_thread) no tiene contactId en external_ref`,
        );
      }
      bodyMd = await connector.getDossierMarkdown(contactId);
      docKind = "evidence";
      title = source.externalRef.title || `Conversación WhatsApp ${contactId}`;
      sourceRef = {
        system: "whatsapphub",
        kind: "whatsapp_thread",
        contact_id: contactId,
        project_source_id: source.id,
        title,
        ...(source.externalRef.url ? { url: source.externalRef.url } : {}),
        ingested_at: now,
      };
    }

    if (!bodyMd || !bodyMd.trim()) {
      throw new SourceConnectorError(
        "http_error",
        "WhatsAppHub devolvió un markdown vacío: nada que ingerir",
      );
    }

    // Re-ingerir actualiza el MISMO doc (id existente), nunca duplica.
    const doc = await upsertDoc(db, {
      ...(source.knowledgeDocId ? { id: source.knowledgeDocId } : {}),
      orgId: project.orgId,
      projectId: source.projectId,
      kind: docKind,
      title,
      bodyMd,
      sourceRefs: [sourceRef],
      tags: ["fuente-2brain", source.kind],
      createdBy: actor,
    });

    const updated = await updateProjectSource(db, source.id, {
      status: "ingested",
      knowledgeDocId: doc.id,
      lastIngestedAt: now,
      lastError: null,
    });
    return { source: updated, doc };
  } catch (err) {
    const message = readableConnectorMessage(err);
    // Fallo → estado 'error' legible y reintentable. knowledge_doc_id no se toca:
    // si había doc de una ingesta previa se conserva; si no, NO se crea huérfano.
    await updateProjectSource(db, source.id, { status: "error", lastError: message });
    if (err instanceof AgentosError) throw err;
    throw new AgentosError(ErrorCodes.PROVIDER_ERROR, message, {
      source_id: sourceId,
      ...(err instanceof SourceConnectorError ? { connector_code: err.code } : {}),
    });
  }
}

export const sourcesTools: ToolDefinition[] = [
  def({
    name: "sources.list",
    description:
      "Lista las fuentes de 2brain (reuniones / hilos de WhatsApp) asociadas al proyecto, con su estado de ingesta y el doc del Context Hub enlazado.",
    schema: z.object({
      project_id: z.string().optional(),
      kind: ProjectSourceKind.optional(),
      status: ProjectSourceStatus.optional(),
    }),
    flags: { read_only: true, external_effect: false, requires_approval: false },
    handler(ctx, args) {
      const projectId = args.project_id ?? ctx.project_id ?? undefined;
      if (!projectId) {
        throw errors.validation("sources.list necesita project_id (o un run con proyecto activo)");
      }
      return listProjectSources(ctx.db, {
        projectId,
        ...(args.kind ? { kind: args.kind } : {}),
        ...(args.status ? { status: args.status } : {}),
      });
    },
  }),

  def({
    name: "sources.ingest",
    description:
      "Ingesta (o re-ingesta) una fuente asociada: trae el markdown de WhatsAppHub y crea/actualiza su knowledge_doc tipado en el Context Hub. Sin efecto externo: es lectura de 2brain hacia dentro.",
    schema: z.object({ source_id: z.string().min(1) }),
    flags: { read_only: false, external_effect: false, requires_approval: false },
    // La fuente pertenece a un proyecto: el objetivo es source.projectId.
    projectScope: { by: "source", arg: "source_id" },
    async handler(ctx, args) {
      if (!ctx.whatsappHub) {
        throw new AgentosError(
          ErrorCodes.PROVIDER_NOT_CONFIGURED,
          "Conector WhatsAppHub no configurado (AGENTOS_WHATSAPPHUB_URL / AGENTOS_WHATSAPPHUB_KEY)",
        );
      }
      return ingestProjectSource(ctx.db, ctx.whatsappHub, args.source_id, ctx.actor);
    },
  }),
];
