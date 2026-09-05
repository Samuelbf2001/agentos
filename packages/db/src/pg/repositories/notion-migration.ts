/**
 * Linaje de la migración de Notion (Postgres) — espejo ASÍNCRONO de
 * `src/repositories/notion-migration.ts`: mismos nombres, mismos argumentos,
 * mismos tipos de fila (docs/POSTGRES.md §5). Lo único que cambia es el `await`.
 */
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { newId, nowMs } from "@agentos/shared";
import type { AgentosPgDb } from "../client-pg.js";
import {
  notionIdentityMappings,
  notionImportLinks,
  notionImportQuarantine,
  notionMigrationRuns,
  notionPageArchives,
} from "../schema-pg.js";
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
} from "../types-pg.js";

// ── Corridas ────────────────────────────────────────────────────────────────

export async function createNotionMigrationRun(
  db: AgentosPgDb,
  input: Omit<NewNotionMigrationRun, "id" | "createdAt" | "startedAt"> & {
    id?: string;
    startedAt?: number;
  },
): Promise<NotionMigrationRun> {
  const now = nowMs();
  const row: NewNotionMigrationRun = {
    ...input,
    id: input.id ?? newId(),
    startedAt: input.startedAt ?? now,
    createdAt: now,
  };
  await db.insert(notionMigrationRuns).values(row);
  return (await getNotionMigrationRun(db, row.id!))!;
}

export async function getNotionMigrationRun(
  db: AgentosPgDb,
  id: string,
): Promise<NotionMigrationRun | undefined> {
  const [row] = await db
    .select()
    .from(notionMigrationRuns)
    .where(eq(notionMigrationRuns.id, id))
    .limit(1);
  return row;
}

export async function listNotionMigrationRuns(db: AgentosPgDb): Promise<NotionMigrationRun[]> {
  return await db.select().from(notionMigrationRuns).orderBy(desc(notionMigrationRuns.startedAt));
}

export async function finishNotionMigrationRun(
  db: AgentosPgDb,
  id: string,
  patch: { status: NotionMigrationRun["status"]; report?: Record<string, unknown> },
): Promise<NotionMigrationRun> {
  await db
    .update(notionMigrationRuns)
    .set({ status: patch.status, report: patch.report ?? null, finishedAt: nowMs() })
    .where(eq(notionMigrationRuns.id, id));
  return (await getNotionMigrationRun(db, id))!;
}

// ── Archivo histórico ───────────────────────────────────────────────────────

export async function createNotionPageArchive(
  db: AgentosPgDb,
  input: Omit<NewNotionPageArchive, "id" | "createdAt"> & { id?: string },
): Promise<NotionPageArchive> {
  const row: NewNotionPageArchive = { ...input, id: input.id ?? newId(), createdAt: nowMs() };
  await db.insert(notionPageArchives).values(row);
  return (await getNotionPageArchive(db, row.id!))!;
}

export async function getNotionPageArchive(
  db: AgentosPgDb,
  id: string,
): Promise<NotionPageArchive | undefined> {
  const [row] = await db
    .select()
    .from(notionPageArchives)
    .where(eq(notionPageArchives.id, id))
    .limit(1);
  return row;
}

export async function getLatestNotionPageArchive(
  db: AgentosPgDb,
  sourceKind: NotionSourceKind,
  notionPageId: string,
): Promise<NotionPageArchive | undefined> {
  const [row] = await db
    .select()
    .from(notionPageArchives)
    .where(
      and(
        eq(notionPageArchives.sourceKind, sourceKind),
        eq(notionPageArchives.notionPageId, notionPageId),
      ),
    )
    .orderBy(desc(notionPageArchives.capturedAt), desc(notionPageArchives.createdAt))
    .limit(1);
  return row;
}

// ── Enlaces idempotentes ────────────────────────────────────────────────────

export async function findNotionImportLink(
  db: AgentosPgDb,
  sourceKind: NotionImportLink["sourceKind"],
  notionPageId: string,
): Promise<NotionImportLink | undefined> {
  const [row] = await db
    .select()
    .from(notionImportLinks)
    .where(
      and(
        eq(notionImportLinks.sourceKind, sourceKind),
        eq(notionImportLinks.notionPageId, notionPageId),
      ),
    )
    .limit(1);
  return row;
}

export async function findNotionImportLinkByObject(
  db: AgentosPgDb,
  objectKind: NotionImportLink["agentosObjectKind"],
  objectId: string,
): Promise<NotionImportLink | undefined> {
  const [row] = await db
    .select()
    .from(notionImportLinks)
    .where(
      and(
        eq(notionImportLinks.agentosObjectKind, objectKind),
        eq(notionImportLinks.agentosObjectId, objectId),
      ),
    )
    .limit(1);
  return row;
}

export async function upsertNotionImportLink(
  db: AgentosPgDb,
  input: Omit<NewNotionImportLink, "id" | "createdAt" | "importedAt"> & { importedAt?: number },
): Promise<{ link: NotionImportLink; created: boolean }> {
  const now = nowMs();
  const existing = await findNotionImportLink(db, input.sourceKind, input.notionPageId);
  if (existing) {
    await db
      .update(notionImportLinks)
      .set({
        migrationRunId: input.migrationRunId,
        archiveId: input.archiveId ?? existing.archiveId,
        importStatus: input.importStatus,
        sourceLastEditedAt: input.sourceLastEditedAt ?? existing.sourceLastEditedAt,
        importedAt: input.importedAt ?? now,
      })
      .where(eq(notionImportLinks.id, existing.id));
    return {
      link: (await findNotionImportLink(db, input.sourceKind, input.notionPageId))!,
      created: false,
    };
  }
  await db
    .insert(notionImportLinks)
    .values({ ...input, id: newId(), importedAt: input.importedAt ?? now, createdAt: now });
  return {
    link: (await findNotionImportLink(db, input.sourceKind, input.notionPageId))!,
    created: true,
  };
}

export async function listNotionImportLinks(
  db: AgentosPgDb,
  filter: { migrationRunId?: string; sourceKind?: NotionImportLink["sourceKind"] } = {},
): Promise<NotionImportLink[]> {
  const conds = [];
  if (filter.migrationRunId) conds.push(eq(notionImportLinks.migrationRunId, filter.migrationRunId));
  if (filter.sourceKind) conds.push(eq(notionImportLinks.sourceKind, filter.sourceKind));
  const base = db.select().from(notionImportLinks);
  return await (conds.length > 0 ? base.where(and(...conds)) : base);
}

export async function listNotionImportLinksByPages(
  db: AgentosPgDb,
  sourceKind: NotionImportLink["sourceKind"],
  notionPageIds: readonly string[],
): Promise<NotionImportLink[]> {
  if (notionPageIds.length === 0) return [];
  return await db
    .select()
    .from(notionImportLinks)
    .where(
      and(
        eq(notionImportLinks.sourceKind, sourceKind),
        inArray(notionImportLinks.notionPageId, [...notionPageIds]),
      ),
    );
}

// ── Identidades ─────────────────────────────────────────────────────────────

export async function findNotionIdentityMapping(
  db: AgentosPgDb,
  notionPersonId: string,
): Promise<NotionIdentityMapping | undefined> {
  const [row] = await db
    .select()
    .from(notionIdentityMappings)
    .where(eq(notionIdentityMappings.notionPersonId, notionPersonId))
    .limit(1);
  return row;
}

export async function upsertNotionIdentityMapping(
  db: AgentosPgDb,
  input: Omit<NewNotionIdentityMapping, "id" | "createdAt">,
): Promise<NotionIdentityMapping> {
  const existing = await findNotionIdentityMapping(db, input.notionPersonId);
  if (existing) {
    await db
      .update(notionIdentityMappings)
      .set({
        migrationRunId: input.migrationRunId,
        notionEmail: input.notionEmail ?? existing.notionEmail,
        agentosPersonId: input.agentosPersonId ?? null,
        matchMethod: input.matchMethod,
        validationState: input.validationState ?? existing.validationState,
        reviewedBy: input.reviewedBy ?? existing.reviewedBy,
        reviewedAt: input.reviewedAt ?? existing.reviewedAt,
      })
      .where(eq(notionIdentityMappings.id, existing.id));
    return (await findNotionIdentityMapping(db, input.notionPersonId))!;
  }
  await db.insert(notionIdentityMappings).values({ ...input, id: newId(), createdAt: nowMs() });
  return (await findNotionIdentityMapping(db, input.notionPersonId))!;
}

export async function listNotionIdentityMappings(
  db: AgentosPgDb,
): Promise<NotionIdentityMapping[]> {
  return await db.select().from(notionIdentityMappings);
}

// ── Cuarentena ──────────────────────────────────────────────────────────────

export async function recordNotionQuarantine(
  db: AgentosPgDb,
  input: Omit<NewNotionImportQuarantine, "id" | "createdAt">,
): Promise<NotionImportQuarantine> {
  // Misma identidad de excepción que en SQLite: `raw_reference` cuenta.
  const [existing] = await db
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
    .limit(1);
  if (existing) return existing;
  const row: NewNotionImportQuarantine = { ...input, id: newId(), createdAt: nowMs() };
  await db.insert(notionImportQuarantine).values(row);
  const [created] = await db
    .select()
    .from(notionImportQuarantine)
    .where(eq(notionImportQuarantine.id, row.id!))
    .limit(1);
  return created!;
}

export async function listNotionQuarantine(
  db: AgentosPgDb,
  filter: {
    migrationRunId?: string;
    sourceKind?: NotionImportQuarantine["sourceKind"];
    notionPageId?: string;
  } = {},
): Promise<NotionImportQuarantine[]> {
  const conds = [];
  if (filter.migrationRunId) {
    conds.push(eq(notionImportQuarantine.migrationRunId, filter.migrationRunId));
  }
  if (filter.sourceKind) conds.push(eq(notionImportQuarantine.sourceKind, filter.sourceKind));
  if (filter.notionPageId) conds.push(eq(notionImportQuarantine.notionPageId, filter.notionPageId));
  const base = db.select().from(notionImportQuarantine);
  return await (conds.length > 0 ? base.where(and(...conds)) : base);
}

// ── Vista de origen ─────────────────────────────────────────────────────────

export interface NotionOriginView {
  link: NotionImportLink;
  archive: NotionPageArchive | undefined;
  run: NotionMigrationRun | undefined;
  quarantine: NotionImportQuarantine[];
}

export async function getNotionOrigin(
  db: AgentosPgDb,
  objectKind: NotionImportLink["agentosObjectKind"],
  objectId: string,
): Promise<NotionOriginView | undefined> {
  const link = await findNotionImportLinkByObject(db, objectKind, objectId);
  if (!link) return undefined;
  const archive = link.archiveId
    ? await getNotionPageArchive(db, link.archiveId)
    : await getLatestNotionPageArchive(db, link.sourceKind as NotionSourceKind, link.notionPageId);
  return {
    link,
    archive,
    run: await getNotionMigrationRun(db, link.migrationRunId),
    quarantine: await listNotionQuarantine(db, { notionPageId: link.notionPageId }),
  };
}
