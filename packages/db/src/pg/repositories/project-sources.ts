/**
 * Fuentes del proyecto (Fase 2): asociar reuniones/hilos de WhatsApp de 2brain
 * a un proyecto e ingerirlas como knowledge_docs tipados. La fila `project_sources`
 * es el vínculo; el contenido vive SIEMPRE en el Context Hub (§8b).
 *
 * Espejo Postgres de src/repositories/project-sources.ts — misma superficie, asíncrona (§NFR-9).
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
import type { AgentosPgDb } from "../client-pg.js";
import { projectSources } from "../schema-pg.js";
import type { NewProjectSource, ProjectSource } from "../types-pg.js";

export async function createProjectSource(
  db: AgentosPgDb,
  input: Omit<NewProjectSource, "id" | "createdAt"> & { id?: string },
): Promise<ProjectSource> {
  const row: NewProjectSource = { ...input, id: input.id ?? newId(), createdAt: nowMs() };
  await db.insert(projectSources).values(row);
  return (await getProjectSource(db, row.id!))!;
}

export async function getProjectSource(db: AgentosPgDb, id: string): Promise<ProjectSource | undefined> {
  const [row] = await db.select().from(projectSources).where(eq(projectSources.id, id)).limit(1);
  return row;
}

export async function listProjectSources(
  db: AgentosPgDb,
  filter: { projectId?: string; kind?: ProjectSourceKind; status?: ProjectSourceStatus } = {},
): Promise<ProjectSource[]> {
  const conds = [];
  if (filter.projectId) conds.push(eq(projectSources.projectId, filter.projectId));
  if (filter.kind) conds.push(eq(projectSources.kind, filter.kind));
  if (filter.status) conds.push(eq(projectSources.status, filter.status));
  const base = db.select().from(projectSources);
  const q = conds.length > 0 ? base.where(and(...conds)) : base;
  return await q.orderBy(asc(projectSources.createdAt));
}

/**
 * Idempotencia de asociación: la misma reunión/hilo (misma referencia externa)
 * no se asocia dos veces al mismo proyecto — se devuelve la fila existente.
 */
export async function findProjectSourceByExternalRef(
  db: AgentosPgDb,
  projectId: string,
  kind: ProjectSourceKind,
  ref: Pick<ProjectSourceExternalRef, "meetingId" | "contactId">,
): Promise<ProjectSource | undefined> {
  const sources = await listProjectSources(db, { projectId, kind });
  return sources.find((s) => {
    const ext = s.externalRef;
    return kind === "meeting"
      ? ext.meetingId !== undefined && ext.meetingId === ref.meetingId
      : ext.contactId !== undefined && ext.contactId === ref.contactId;
  });
}

export async function updateProjectSource(
  db: AgentosPgDb,
  id: string,
  patch: Partial<
    Pick<ProjectSource, "status" | "knowledgeDocId" | "lastError" | "lastIngestedAt" | "externalRef">
  >,
): Promise<ProjectSource> {
  const existing = await getProjectSource(db, id);
  if (!existing) throw errors.notFound("project_source", id);
  await db.update(projectSources).set(patch).where(eq(projectSources.id, id));
  return (await getProjectSource(db, id))!;
}
