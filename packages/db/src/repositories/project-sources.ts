/**
 * Fuentes del proyecto (Fase 2): asociar reuniones/hilos de WhatsApp de 2brain
 * a un proyecto e ingerirlas como knowledge_docs tipados. La fila `project_sources`
 * es el vínculo; el contenido vive SIEMPRE en el Context Hub (§8b).
 */
import { and, asc, eq } from "drizzle-orm";
import {
  errors,
  newId,
  nowMs,
  type ProjectSourceExternalRef,
  type ProjectSourceKind,
  type ProjectSourceStatus,
} from "@agentos/shared";
import type { AgentosSqliteDb } from "../client.js";
import { projectSources } from "../schema.js";
import type { NewProjectSource, ProjectSource } from "../types.js";

export function createProjectSource(
  db: AgentosSqliteDb,
  input: Omit<NewProjectSource, "id" | "createdAt"> & { id?: string },
): ProjectSource {
  const row: NewProjectSource = { ...input, id: input.id ?? newId(), createdAt: nowMs() };
  db.insert(projectSources).values(row).run();
  return getProjectSource(db, row.id!)!;
}

export function getProjectSource(db: AgentosSqliteDb, id: string): ProjectSource | undefined {
  return db.select().from(projectSources).where(eq(projectSources.id, id)).get();
}

export function listProjectSources(
  db: AgentosSqliteDb,
  filter: { projectId?: string; kind?: ProjectSourceKind; status?: ProjectSourceStatus } = {},
): ProjectSource[] {
  const conds = [];
  if (filter.projectId) conds.push(eq(projectSources.projectId, filter.projectId));
  if (filter.kind) conds.push(eq(projectSources.kind, filter.kind));
  if (filter.status) conds.push(eq(projectSources.status, filter.status));
  const base = db.select().from(projectSources);
  const q = conds.length > 0 ? base.where(and(...conds)) : base;
  return q.orderBy(asc(projectSources.createdAt)).all();
}

/**
 * Idempotencia de asociación: la misma reunión/hilo (misma referencia externa)
 * no se asocia dos veces al mismo proyecto — se devuelve la fila existente.
 */
export function findProjectSourceByExternalRef(
  db: AgentosSqliteDb,
  projectId: string,
  kind: ProjectSourceKind,
  ref: Pick<ProjectSourceExternalRef, "meetingId" | "contactId">,
): ProjectSource | undefined {
  return listProjectSources(db, { projectId, kind }).find((s) => {
    const ext = s.externalRef;
    return kind === "meeting"
      ? ext.meetingId !== undefined && ext.meetingId === ref.meetingId
      : ext.contactId !== undefined && ext.contactId === ref.contactId;
  });
}

export function updateProjectSource(
  db: AgentosSqliteDb,
  id: string,
  patch: Partial<
    Pick<ProjectSource, "status" | "knowledgeDocId" | "lastError" | "lastIngestedAt" | "externalRef">
  >,
): ProjectSource {
  const existing = getProjectSource(db, id);
  if (!existing) throw errors.notFound("project_source", id);
  db.update(projectSources).set(patch).where(eq(projectSources.id, id)).run();
  return getProjectSource(db, id)!;
}
