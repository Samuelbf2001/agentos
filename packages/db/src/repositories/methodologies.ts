import { and, asc, desc, eq } from "drizzle-orm";
import { newId, nowMs } from "@agentos/shared";
import type { AgentosDb } from "../client.js";
import { methodologies } from "../schema.js";
import type { Methodology, NewMethodology } from "../types.js";

/**
 * La metodología Sixteam como datos versionados (ARCHITECTURE §8b):
 * upsert por (slug, version). Editar el body de una versión existente la
 * actualiza (seed refresh); una versión nueva crea fila nueva — nunca se borra historial.
 */
export function upsertMethodology(
  db: AgentosDb,
  input: Omit<NewMethodology, "id" | "createdAt" | "updatedAt"> & { id?: string },
): Methodology {
  const now = nowMs();
  const existing = getMethodology(db, input.slug, input.version);
  if (existing) {
    db.update(methodologies)
      .set({ ...input, id: existing.id, updatedAt: now })
      .where(eq(methodologies.id, existing.id))
      .run();
    return getMethodology(db, input.slug, input.version)!;
  }
  const row: NewMethodology = { ...input, id: input.id ?? newId(), createdAt: now, updatedAt: now };
  db.insert(methodologies).values(row).run();
  return getMethodology(db, input.slug, input.version)!;
}

/** Sin `version` devuelve la última versión del slug. */
export function getMethodology(
  db: AgentosDb,
  slug: string,
  version?: number,
): Methodology | undefined {
  if (version !== undefined) {
    return db
      .select()
      .from(methodologies)
      .where(and(eq(methodologies.slug, slug), eq(methodologies.version, version)))
      .get();
  }
  return db
    .select()
    .from(methodologies)
    .where(eq(methodologies.slug, slug))
    .orderBy(desc(methodologies.version))
    .limit(1)
    .get();
}

export function listMethodologies(db: AgentosDb): Methodology[] {
  return db
    .select()
    .from(methodologies)
    .orderBy(asc(methodologies.slug), desc(methodologies.version))
    .all();
}
