/**
 * Linaje de la migración de Notion (SQLite).
 *
 * Cinco tablas de solo anexado que responden tres preguntas para cada objeto
 * importado: de dónde vino (`notion_page_archives`), qué se creó con él
 * (`notion_import_links`) y qué NO se pudo traducir (`notion_import_quarantine`
 * + `notion_identity_mappings`), todo atado a una corrida
 * (`notion_migration_runs`) con el hash del snapshot exacto.
 *
 * Idempotencia: `upsertImportLink` resuelve por `(source_kind, notion_page_id)`.
 * Reejecutar el importador sobre la misma DB actualiza el enlace, nunca crea un
 * segundo objeto nativo.
 *
 * El espejo asíncrono vive en `src/pg/repositories/notion-migration.ts`.
 */
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { newId, nowMs } from "@agentos/shared";
import type { AgentosDb } from "../client.js";
import {
  notionIdentityMappings,
  notionImportLinks,
  notionImportQuarantine,
  notionMigrationRuns,
  notionPageArchives,
} from "../schema.js";
import type {
  NewNotionIdentityMapping,
  NewNotionImportLink,
  NewNotionImportQuarantine,
  NewNotionMigrationRun,
  NewNotionPageArchive,
  NotionIdentityMapping,
  NotionImportLink,
  NotionImportQuarantine,
  NotionMigrationRun,
  NotionPageArchive,
  NotionSourceKind,
} from "../types.js";

// ── Corridas ────────────────────────────────────────────────────────────────

export function createNotionMigrationRun(
  db: AgentosDb,
  input: Omit<NewNotionMigrationRun, "id" | "createdAt" | "startedAt"> & {
    id?: string;
    startedAt?: number;
  },
): NotionMigrationRun {
  const now = nowMs();
  const row: NewNotionMigrationRun = {
    ...input,
    id: input.id ?? newId(),
    startedAt: input.startedAt ?? now,
    createdAt: now,
  };
  db.insert(notionMigrationRuns).values(row).run();
  return getNotionMigrationRun(db, row.id!)!;
}

export function getNotionMigrationRun(db: AgentosDb, id: string): NotionMigrationRun | undefined {
  return db.select().from(notionMigrationRuns).where(eq(notionMigrationRuns.id, id)).get();
}

export function listNotionMigrationRuns(db: AgentosDb): NotionMigrationRun[] {
  return db.select().from(notionMigrationRuns).orderBy(desc(notionMigrationRuns.startedAt)).all();
}

/**
 * Cierre de corrida. La fila NO se reescribe para tapar el origen: solo se
 * sellan estado, informe y hora final una vez, al terminar.
 */
export function finishNotionMigrationRun(
  db: AgentosDb,
  id: string,
  patch: { status: NotionMigrationRun["status"]; report?: Record<string, unknown> },
): NotionMigrationRun {
  db.update(notionMigrationRuns)
    .set({ status: patch.status, report: patch.report ?? null, finishedAt: nowMs() })
    .where(eq(notionMigrationRuns.id, id))
    .run();
  return getNotionMigrationRun(db, id)!;
}

// ── Archivo histórico ───────────────────────────────────────────────────────

export function createNotionPageArchive(
  db: AgentosDb,
  input: Omit<NewNotionPageArchive, "id" | "createdAt"> & { id?: string },
): NotionPageArchive {
  const row: NewNotionPageArchive = { ...input, id: input.id ?? newId(), createdAt: nowMs() };
  db.insert(notionPageArchives).values(row).run();
  return db.select().from(notionPageArchives).where(eq(notionPageArchives.id, row.id!)).get()!;
}

export function getNotionPageArchive(db: AgentosDb, id: string): NotionPageArchive | undefined {
  return db.select().from(notionPageArchives).where(eq(notionPageArchives.id, id)).get();
}

/** Último archivo capturado de una página (la corrida más reciente gana). */
export function getLatestNotionPageArchive(
  db: AgentosDb,
  sourceKind: NotionSourceKind,
  notionPageId: string,
): NotionPageArchive | undefined {
  return db
    .select()
    .from(notionPageArchives)
    .where(
      and(
        eq(notionPageArchives.sourceKind, sourceKind),
        eq(notionPageArchives.notionPageId, notionPageId),
      ),
    )
    .orderBy(desc(notionPageArchives.capturedAt), desc(notionPageArchives.createdAt))
    .get();
}

// ── Enlaces idempotentes ────────────────────────────────────────────────────

export function findNotionImportLink(
  db: AgentosDb,
  sourceKind: NotionImportLink["sourceKind"],
  notionPageId: string,
): NotionImportLink | undefined {
  return db
    .select()
    .from(notionImportLinks)
    .where(
      and(
        eq(notionImportLinks.sourceKind, sourceKind),
        eq(notionImportLinks.notionPageId, notionPageId),
      ),
    )
    .get();
}

export function findNotionImportLinkByObject(
  db: AgentosDb,
  objectKind: NotionImportLink["agentosObjectKind"],
  objectId: string,
): NotionImportLink | undefined {
  return db
    .select()
    .from(notionImportLinks)
    .where(
      and(
        eq(notionImportLinks.agentosObjectKind, objectKind),
        eq(notionImportLinks.agentosObjectId, objectId),
      ),
    )
    .get();
}

/**
 * LA operación idempotente del importador. Con enlace previo actualiza la fila
 * existente (y respeta el `agentos_object_id` ya emitido); sin él, inserta.
 */
export function upsertNotionImportLink(
  db: AgentosDb,
  input: Omit<NewNotionImportLink, "id" | "createdAt" | "importedAt"> & { importedAt?: number },
): { link: NotionImportLink; created: boolean } {
  const now = nowMs();
  const existing = findNotionImportLink(db, input.sourceKind, input.notionPageId);
  if (existing) {
    db.update(notionImportLinks)
      .set({
        migrationRunId: input.migrationRunId,
        archiveId: input.archiveId ?? existing.archiveId,
        importStatus: input.importStatus,
        sourceLastEditedAt: input.sourceLastEditedAt ?? existing.sourceLastEditedAt,
        importedAt: input.importedAt ?? now,
      })
      .where(eq(notionImportLinks.id, existing.id))
      .run();
    return { link: findNotionImportLink(db, input.sourceKind, input.notionPageId)!, created: false };
  }
  const row: NewNotionImportLink = {
    ...input,
    id: newId(),
    importedAt: input.importedAt ?? now,
    createdAt: now,
  };
  db.insert(notionImportLinks).values(row).run();
  return { link: findNotionImportLink(db, input.sourceKind, input.notionPageId)!, created: true };
}

export function listNotionImportLinks(
  db: AgentosDb,
  filter: { migrationRunId?: string; sourceKind?: NotionImportLink["sourceKind"] } = {},
): NotionImportLink[] {
  const conds = [];
  if (filter.migrationRunId) conds.push(eq(notionImportLinks.migrationRunId, filter.migrationRunId));
  if (filter.sourceKind) conds.push(eq(notionImportLinks.sourceKind, filter.sourceKind));
  const base = db.select().from(notionImportLinks);
  return (conds.length > 0 ? base.where(and(...conds)) : base).all();
}

/** Enlaces de varias páginas de una vez (segunda pasada de relaciones). */
export function listNotionImportLinksByPages(
  db: AgentosDb,
  sourceKind: NotionImportLink["sourceKind"],
  notionPageIds: readonly string[],
): NotionImportLink[] {
  if (notionPageIds.length === 0) return [];
  return db
    .select()
    .from(notionImportLinks)
    .where(
      and(
        eq(notionImportLinks.sourceKind, sourceKind),
        inArray(notionImportLinks.notionPageId, [...notionPageIds]),
      ),
    )
    .all();
}

// ── Identidades ─────────────────────────────────────────────────────────────

export function findNotionIdentityMapping(
  db: AgentosDb,
  notionPersonId: string,
): NotionIdentityMapping | undefined {
  return db
    .select()
    .from(notionIdentityMappings)
    .where(eq(notionIdentityMappings.notionPersonId, notionPersonId))
    .get();
}

/**
 * `match_method` nunca es "name": el importador solo escribe `confirmed_email`
 * o `admin_decision`; cualquier otro caso entra como `unresolved`.
 */
export function upsertNotionIdentityMapping(
  db: AgentosDb,
  input: Omit<NewNotionIdentityMapping, "id" | "createdAt">,
): NotionIdentityMapping {
  const existing = findNotionIdentityMapping(db, input.notionPersonId);
  if (existing) {
    db.update(notionIdentityMappings)
      .set({
        migrationRunId: input.migrationRunId,
        notionEmail: input.notionEmail ?? existing.notionEmail,
        agentosPersonId: input.agentosPersonId ?? null,
        matchMethod: input.matchMethod,
        validationState: input.validationState ?? existing.validationState,
        reviewedBy: input.reviewedBy ?? existing.reviewedBy,
        reviewedAt: input.reviewedAt ?? existing.reviewedAt,
      })
      .where(eq(notionIdentityMappings.id, existing.id))
      .run();
    return findNotionIdentityMapping(db, input.notionPersonId)!;
  }
  db.insert(notionIdentityMappings)
    .values({ ...input, id: newId(), createdAt: nowMs() })
    .run();
  return findNotionIdentityMapping(db, input.notionPersonId)!;
}

export function listNotionIdentityMappings(db: AgentosDb): NotionIdentityMapping[] {
  return db.select().from(notionIdentityMappings).all();
}

// ── Cuarentena ──────────────────────────────────────────────────────────────

/** Anexado idempotente dentro de una corrida: la misma excepción no se duplica. */
export function recordNotionQuarantine(
  db: AgentosDb,
  input: Omit<NewNotionImportQuarantine, "id" | "createdAt">,
): NotionImportQuarantine {
  // La identidad de una excepción incluye `raw_reference`: dos responsables sin
  // resolver en la misma tarea son dos filas, no una.
  const existing = db
    .select()
    .from(notionImportQuarantine)
    .where(
      and(
        eq(notionImportQuarantine.migrationRunId, input.migrationRunId),
        eq(notionImportQuarantine.sourceKind, input.sourceKind),
        eq(notionImportQuarantine.notionPageId, input.notionPageId),
        eq(notionImportQuarantine.fieldName, input.fieldName),
        input.rawReference === undefined || input.rawReference === null
          ? isNull(notionImportQuarantine.rawReference)
          : eq(notionImportQuarantine.rawReference, input.rawReference),
      ),
    )
    .get();
  if (existing) return existing;
  const row: NewNotionImportQuarantine = { ...input, id: newId(), createdAt: nowMs() };
  db.insert(notionImportQuarantine).values(row).run();
  return db.select().from(notionImportQuarantine).where(eq(notionImportQuarantine.id, row.id!)).get()!;
}

export function listNotionQuarantine(
  db: AgentosDb,
  filter: {
    migrationRunId?: string;
    sourceKind?: NotionImportQuarantine["sourceKind"];
    notionPageId?: string;
  } = {},
): NotionImportQuarantine[] {
  const conds = [];
  if (filter.migrationRunId) {
    conds.push(eq(notionImportQuarantine.migrationRunId, filter.migrationRunId));
  }
  if (filter.sourceKind) conds.push(eq(notionImportQuarantine.sourceKind, filter.sourceKind));
  if (filter.notionPageId) conds.push(eq(notionImportQuarantine.notionPageId, filter.notionPageId));
  const base = db.select().from(notionImportQuarantine);
  return (conds.length > 0 ? base.where(and(...conds)) : base).all();
}

// ── Vista de origen (ficha "Historial de Notion", solo lectura) ─────────────

export interface NotionOriginView {
  link: NotionImportLink;
  archive: NotionPageArchive | undefined;
  run: NotionMigrationRun | undefined;
  quarantine: NotionImportQuarantine[];
}

/**
 * Todo lo que Notion tenía de un objeto nativo: enlace, archivo íntegro,
 * corrida y excepciones. Es la fuente de `GET /api/{tasks,projects}/:id/notion-origin`.
 */
export function getNotionOrigin(
  db: AgentosDb,
  objectKind: NotionImportLink["agentosObjectKind"],
  objectId: string,
): NotionOriginView | undefined {
  const link = findNotionImportLinkByObject(db, objectKind, objectId);
  if (!link) return undefined;
  const archive = link.archiveId
    ? getNotionPageArchive(db, link.archiveId)
    : getLatestNotionPageArchive(db, link.sourceKind as NotionSourceKind, link.notionPageId);
  return {
    link,
    archive,
    run: getNotionMigrationRun(db, link.migrationRunId),
    quarantine: listNotionQuarantine(db, { notionPageId: link.notionPageId }),
  };
}
