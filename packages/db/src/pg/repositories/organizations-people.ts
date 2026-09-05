/** Espejo Postgres de src/repositories/organizations-people.ts — misma superficie, asíncrona (§NFR-9). */
import { and, eq } from "drizzle-orm";
import { errors, newId, nowMs, type OrgKind } from "@agentos/shared";
import type { AgentosPgDb } from "../client-pg.js";
import { organizations, people } from "../schema-pg.js";
import type { NewOrganization, NewPerson, Organization, Person } from "../types-pg.js";

// ── Organizaciones ──────────────────────────────────────────────────────────

export async function createOrganization(
  db: AgentosPgDb,
  input: Omit<NewOrganization, "id" | "createdAt" | "updatedAt"> & { id?: string },
): Promise<Organization> {
  const now = nowMs();
  const row: NewOrganization = { ...input, id: input.id ?? newId(), createdAt: now, updatedAt: now };
  await db.insert(organizations).values(row);
  return (await getOrganization(db, row.id!))!;
}

export async function getOrganization(db: AgentosPgDb, id: string): Promise<Organization | undefined> {
  const [row] = await db.select().from(organizations).where(eq(organizations.id, id)).limit(1);
  return row;
}

export async function getOrganizationByName(
  db: AgentosPgDb,
  name: string,
): Promise<Organization | undefined> {
  const [row] = await db.select().from(organizations).where(eq(organizations.name, name)).limit(1);
  return row;
}

export async function listOrganizations(db: AgentosPgDb, kind?: OrgKind): Promise<Organization[]> {
  if (kind) return await db.select().from(organizations).where(eq(organizations.kind, kind));
  return await db.select().from(organizations);
}

export async function updateOrganization(
  db: AgentosPgDb,
  id: string,
  patch: Partial<Omit<Organization, "id" | "createdAt">>,
): Promise<void> {
  await db
    .update(organizations)
    .set({ ...patch, updatedAt: nowMs() })
    .where(eq(organizations.id, id));
}

// ── Personas ────────────────────────────────────────────────────────────────

export async function createPerson(
  db: AgentosPgDb,
  input: Omit<NewPerson, "id" | "createdAt" | "updatedAt"> & { id?: string },
): Promise<Person> {
  const now = nowMs();
  const row: NewPerson = { ...input, id: input.id ?? newId(), createdAt: now, updatedAt: now };
  await db.insert(people).values(row);
  return (await getPerson(db, row.id!))!;
}

export async function getPerson(db: AgentosPgDb, id: string): Promise<Person | undefined> {
  const [row] = await db.select().from(people).where(eq(people.id, id)).limit(1);
  return row;
}

export async function getPersonByFullName(db: AgentosPgDb, fullName: string): Promise<Person | undefined> {
  const [row] = await db.select().from(people).where(eq(people.fullName, fullName)).limit(1);
  return row;
}

export async function listPeople(db: AgentosPgDb, orgId?: string): Promise<Person[]> {
  if (orgId) return await db.select().from(people).where(eq(people.orgId, orgId));
  return await db.select().from(people);
}

/**
 * Personas asignables a un proyecto de `orgId`: las de su propia organización
 * más el personal interno (`is_internal`), que puede asignarse a cualquier
 * proyecto (I3). Espejo de src/repositories/organizations-people.ts.
 */
export async function listAssignablePeople(db: AgentosPgDb, orgId: string): Promise<Person[]> {
  const all = await listPeople(db);
  return all.filter((person) => person.isInternal || person.orgId === orgId);
}

export async function updatePerson(
  db: AgentosPgDb,
  id: string,
  patch: Partial<Omit<Person, "id" | "createdAt">>,
): Promise<Person> {
  await db
    .update(people)
    .set({ ...patch, updatedAt: nowMs() })
    .where(eq(people.id, id));
  const updated = await getPerson(db, id);
  if (!updated) throw errors.notFound("person", id);
  return updated;
}

export async function listInternalPeople(db: AgentosPgDb, orgId: string): Promise<Person[]> {
  return await db
    .select()
    .from(people)
    .where(and(eq(people.orgId, orgId), eq(people.isInternal, true)));
}
