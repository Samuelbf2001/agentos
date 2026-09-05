/**
 * Ficha "Historial de Notion" — SOLO LECTURA.
 *
 * Devuelve todo lo que la página de Notion tenía y AgentOS no modela en columnas
 * nativas: propiedades crudas, árbol de bloques, comentarios y manifiesto de
 * adjuntos, más el enlace de linaje, la corrida que lo importó y las excepciones
 * en cuarentena de esa página.
 *
 * No hay verbo de escritura aquí ni lo habrá: el archivo histórico es de solo
 * inserción y Notion no recibe nunca una petición desde AgentOS.
 *
 * Consumo previsto por la siguiente ola de UI (`apps/web`, otra rama):
 *   GET /api/tasks/:id/notion-origin      → pestaña "Origen Notion" de la tarjeta
 *   GET /api/projects/:id/notion-origin   → misma ficha en la cabecera del proyecto
 * Respuesta 200 siempre que el objeto exista; `has_origin:false` significa
 * "esto no vino de Notion", que no es un error.
 */
import type { FastifyInstance } from "fastify";
import { errors } from "@agentos/shared";
import { getNotionOrigin, getProject, getTask, type NotionOriginView } from "@agentos/db";
import type { ApiContext } from "../context.js";

/** Contrato HTTP estable: snake_case, sin filtrar nombres de columna internos. */
interface NotionOriginResponse {
  has_origin: boolean;
  origin: {
    notion_page_id: string;
    source_kind: string;
    original_url: string | null;
    import_status: string;
    imported_at: number;
    source_last_edited_at: number | null;
    captured_at: number | null;
    payload_hash: string | null;
    /** Rutas relativas dentro del snapshot; el binario vive fuera de la DB. */
    raw_uris: {
      page: string | null;
      blocks: string | null;
      comments: string | null;
      files: string | null;
    };
    /** Origen íntegro: `{page, properties, blocks, comments, files}`. */
    payload: Record<string, unknown> | null;
    run: {
      id: string;
      snapshot_run_id: string;
      manifest_hash: string;
      mode: string;
      status: string;
      captured_at: number;
    } | null;
    quarantine: {
      field_name: string;
      reason: string;
      raw_reference: string | null;
      resolution_state: string;
    }[];
  } | null;
}

function present(view: NotionOriginView | undefined): NotionOriginResponse {
  if (!view) return { has_origin: false, origin: null };
  const { link, archive, run, quarantine } = view;
  return {
    has_origin: true,
    origin: {
      notion_page_id: link.notionPageId,
      source_kind: link.sourceKind,
      original_url: archive?.originalUrl ?? null,
      import_status: link.importStatus,
      imported_at: link.importedAt,
      source_last_edited_at: link.sourceLastEditedAt ?? null,
      captured_at: archive?.capturedAt ?? null,
      payload_hash: archive?.payloadHash ?? null,
      raw_uris: {
        page: archive?.rawPageUri ?? null,
        blocks: archive?.rawBlocksUri ?? null,
        comments: archive?.rawCommentsUri ?? null,
        files: archive?.rawFilesUri ?? null,
      },
      payload: archive?.payload ?? null,
      run: run
        ? {
            id: run.id,
            snapshot_run_id: run.snapshotRunId,
            manifest_hash: run.manifestHash,
            mode: run.mode,
            status: run.status,
            captured_at: run.capturedAt,
          }
        : null,
      quarantine: quarantine.map((entry) => ({
        field_name: entry.fieldName,
        reason: entry.reason,
        raw_reference: entry.rawReference ?? null,
        resolution_state: entry.resolutionState,
      })),
    },
  };
}

export function registerNotionOriginRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const { db } = ctx;

  app.get("/api/tasks/:id/notion-origin", async (req): Promise<NotionOriginResponse> => {
    const { id } = req.params as { id: string };
    if (!(await getTask(db, id))) throw errors.notFound("task", id);
    return present(await getNotionOrigin(db, "task", id));
  });

  app.get("/api/projects/:id/notion-origin", async (req): Promise<NotionOriginResponse> => {
    const { id } = req.params as { id: string };
    if (!(await getProject(db, id))) throw errors.notFound("project", id);
    return present(await getNotionOrigin(db, "project", id));
  });
}

