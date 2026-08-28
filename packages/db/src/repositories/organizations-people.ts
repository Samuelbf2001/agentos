import { and, eq } from "drizzle-orm";
import { newId, nowMs, type OrgKind } from "@agentos/shared";
import type { AgentosDb } from "../client.js";
import { organizations, people } from "../schema.js";
import type { NewOrganization, NewPerson, Organization, Person } from "../types.js";

// ── Organizaciones ──────────────────────────────────────────────────────────

export function createOrganization(
  db: AgentosDb,
  input: Omit<NewOrganization, "id" | "createdAt" | "updatedAt"> & { id?: string },
): Organization {
  const now = nowMs();
  const row: NewOrganization = { ...input, id: input.id ?? newId(), createdAt: now, updatedAt: now };
  db.insert(organizations).values(row).run();
  return getOrganization(db, row.id!)!;
}

export function getOrganization(db: AgentosDb, id: string): Organization | undefined {
  return db.select().from(organizations).where(eq(organizations.id, id)).get();
}

export function getOrganizationByName(db: AgentosDb, name: string): Organization | undefined {
  return db.select().from(organizations).where(eq(organizations.name, name)).get();
}

export function listOrganizations(db: AgentosDb, kind?: OrgKind): Organization[] {
  if (kind) return db.select().from(organizations).where(eq(organizations.kind, kind)).all();
  return db.select().from(organizations).all();
}

export function updateOrganization(
  db: AgentosDb,
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
  db: AgentosDb,
  input: Omit<NewPerson, "id" | "createdAt" | "updatedAt"> & { id?: string },
): Person {
  const now = nowMs();
  const row: NewPerson = { ...input, id: input.id ?? newId(), createdAt: now, updatedAt: now };
  db.insert(people).values(row).run();
  return getPerson(db, row.id!)!;
}

export function getPerson(db: AgentosDb, id: string): Person | undefined {
  return db.select().from(people).where(eq(people.id, id)).get();
}

export function getPersonByFullName(db: AgentosDb, fullName: string): Person | undefined {
  return db.select().from(people).where(eq(people.fullName, fullName)).get();
}

export function listPeople(db: AgentosDb, orgId?: string): Person[] {
  if (orgId) return db.select().from(people).where(eq(people.orgId, orgId)).all();
  return db.select().from(people).all();
}

export function listInternalPeople(db: AgentosDb, orgId: string): Person[] {
  return db
    .select()
    .from(people)
    .where(and(eq(people.orgId, orgId), eq(people.isInternal, true)))
    .all();
}
