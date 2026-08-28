/** Espejo Postgres de src/repositories/methodologies.ts — misma superficie, asíncrona (§NFR-9). */
import { and, asc, desc, eq } from "drizzle-orm";
import { newId, nowMs } from "@agentos/shared";
import type { AgentosPgDb } from "../client-pg.js";
import { methodologies } from "../schema-pg.js";
import type { Methodology, NewMethodology } from "../types-pg.js";

/**
 * La metodología Sixteam como datos versionados (ARCHITECTURE §8b):
 * upsert por (slug, version). Editar el body de una versión existente la
 * actualiza (seed refresh); una versión nueva crea fila nueva — nunca se borra historial.
 */
export async function upsertMethodology(
  db: AgentosPgDb,
  input: Omit<NewMethodology, "id" | "createdAt" | "updatedAt"> & { id?: string },
): Promise<Methodology> {
  const now = nowMs();
  const existing = await getMethodology(db, input.slug, input.version);
  if (existing) {
    await db
      .update(methodologies)
      .set({ ...input, id: existing.id, updatedAt: now })
      .where(eq(methodologies.id, existing.id));
    return (await getMethodology(db, input.slug, input.version))!;
  }
  const row: NewMethodology = {
    ...input,
    id: input.id ?? newId(),
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(methodologies).values(row);
  return (await getMethodology(db, input.slug, input.version))!;
}

/** Sin `version` devuelve la última versión del slug. */
export async function getMethodology(
  db: AgentosPgDb,
  slug: string,
  version?: number,
): Promise<Methodology | undefined> {
  if (version !== undefined) {
    const [row] = await db
      .select()
      .from(methodologies)
      .where(and(eq(methodologies.slug, slug), eq(methodologies.version, version)))
      .limit(1);
    return row;
  }
  const [row] = await db
    .select()
    .from(methodologies)
    .where(eq(methodologies.slug, slug))
    .orderBy(desc(methodologies.version))
    .limit(1);
  return row;
}

export async function listMethodologies(db: AgentosPgDb): Promise<Methodology[]> {
  return await db
    .select()
    .from(methodologies)
    .orderBy(asc(methodologies.slug), desc(methodologies.version));
}
