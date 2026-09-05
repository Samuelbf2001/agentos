import { and, eq } from "drizzle-orm";
import { errors, newId, nowMs, type OrgKind } from "@agentos/shared";
import type { AgentosSqliteDb } from "../client.js";
import { organizations, people } from "../schema.js";
import type { NewOrganization, NewPerson, Organization, Person } from "../types.js";

// ── Organizaciones ──────────────────────────────────────────────────────────

export function createOrganization(
  db: AgentosSqliteDb,
  input: Omit<NewOrganization, "id" | "createdAt" | "updatedAt"> & { id?: string },
): Organization {
  const now = nowMs();
  const row: NewOrganization = { ...input, id: input.id ?? newId(), createdAt: now, updatedAt: now };
  db.insert(organizations).values(row).run();
  return getOrganization(db, row.id!)!;
}

export function getOrganization(db: AgentosSqliteDb, id: string): Organization | undefined {
  return db.select().from(organizations).where(eq(organizations.id, id)).get();
}

export function getOrganizationByName(db: AgentosSqliteDb, name: string): Organization | undefined {
  return db.select().from(organizations).where(eq(organizations.name, name)).get();
}

export function listOrganizations(db: AgentosSqliteDb, kind?: OrgKind): Organization[] {
  if (kind) return db.select().from(organizations).where(eq(organizations.kind, kind)).all();
  return db.select().from(organizations).all();
}

export function updateOrganization(
  db: AgentosSqliteDb,
  id: string,
  patch: Partial<Omit<Organization, "id" | "createdAt">>,
): void {
  db.update(organizations)
    .set({ ...patch, updatedAt: nowMs() })
    .where(eq(organizations.id, id))
    .run();
}

// ── Personas ────────────────────────────────────────────────────────────────

export function createPerson(
  db: AgentosSqliteDb,
  input: Omit<NewPerson, "id" | "createdAt" | "updatedAt"> & { id?: string },
): Person {
  const now = nowMs();
  const row: NewPerson = { ...input, id: input.id ?? newId(), createdAt: now, updatedAt: now };
  db.insert(people).values(row).run();
  return getPerson(db, row.id!)!;
}

export function getPerson(db: AgentosSqliteDb, id: string): Person | undefined {
  return db.select().from(people).where(eq(people.id, id)).get();
}

export function getPersonByFullName(db: AgentosSqliteDb, fullName: string): Person | undefined {
  return db.select().from(people).where(eq(people.fullName, fullName)).get();
}

export function listPeople(db: AgentosSqliteDb, orgId?: string): Person[] {
  if (orgId) return db.select().from(people).where(eq(people.orgId, orgId)).all();
  return db.select().from(people).all();
}

/**
 * Personas asignables a un proyecto de `orgId`: las de su propia organización
 * más el personal interno (`is_internal`), que puede asignarse a cualquier
 * proyecto (I3).
 */
export function listAssignablePeople(db: AgentosSqliteDb, orgId: string): Person[] {
  return listPeople(db).filter((person) => person.isInternal || person.orgId === orgId);
}

export function updatePerson(
  db: AgentosSqliteDb,
  id: string,
  patch: Partial<Omit<Person, "id" | "createdAt">>,
): Person {
  db.update(people)
    .set({ ...patch, updatedAt: nowMs() })
    .where(eq(people.id, id))
    .run();
  const updated = getPerson(db, id);
  if (!updated) throw errors.notFound("person", id);
  return updated;
}

export function listInternalPeople(db: AgentosSqliteDb, orgId: string): Person[] {
  return db
    .select()
    .from(people)
    .where(and(eq(people.orgId, orgId), eq(people.isInternal, true)))
    .all();
}
