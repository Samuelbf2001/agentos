/** Espejo Postgres de src/repositories/org-graph.ts — misma superficie, asíncrona (§NFR-9). */
import { and, asc, eq, sql } from "drizzle-orm";
import { errors, newId, nowMs, type RoleProcessRelation } from "@agentos/shared";
import type { AgentosPgDb } from "../client-pg.js";
import { orgRoles, orgUnits, roleFunctions, rolePeople, roleProcesses } from "../schema-pg.js";
import type {
  NewOrgRole,
  NewOrgUnit,
  OrgRole,
  OrgUnit,
  RoleFunction,
  RolePerson,
  RoleProcess,
} from "../types-pg.js";

// ── Áreas ────────────────────────────────────────────────────────────────────

export async function createOrgUnit(
  db: AgentosPgDb,
  input: Omit<NewOrgUnit, "id" | "createdAt" | "updatedAt"> & { id?: string },
): Promise<OrgUnit> {
  const now = nowMs();
  const row: NewOrgUnit = { ...input, id: input.id ?? newId(), createdAt: now, updatedAt: now };
  await db.insert(orgUnits).values(row);
  return (await getOrgUnit(db, row.id!))!;
}

export async function getOrgUnit(db: AgentosPgDb, id: string): Promise<OrgUnit | undefined> {
  const [row] = await db.select().from(orgUnits).where(eq(orgUnits.id, id)).limit(1);
  return row;
}

export async function getOrgUnitByName(
  db: AgentosPgDb,
  orgId: string,
  name: string,
): Promise<OrgUnit | undefined> {
  const [row] = await db
    .select()
    .from(orgUnits)
    .where(and(eq(orgUnits.orgId, orgId), eq(orgUnits.name, name)))
    .limit(1);
  return row;
}

export async function listOrgUnits(db: AgentosPgDb, orgId: string): Promise<OrgUnit[]> {
  return await db.select().from(orgUnits).where(eq(orgUnits.orgId, orgId)).orderBy(asc(orgUnits.name));
}

export async function updateOrgUnit(
  db: AgentosPgDb,
  id: string,
  patch: Partial<Omit<OrgUnit, "id" | "orgId" | "createdAt">>,
): Promise<OrgUnit> {
  const current = await getOrgUnit(db, id);
  if (!current) throw errors.notFound("org_unit", id);
  await db
    .update(orgUnits)
    .set({ ...patch, updatedAt: nowMs() })
    .where(eq(orgUnits.id, id));
  return (await getOrgUnit(db, id))!;
}

/** Los roles del área quedan sin área; las sub-áreas quedan sin padre. */
export async function deleteOrgUnit(db: AgentosPgDb, id: string): Promise<void> {
  await db.transaction(async (tx) => {
    const now = nowMs();
    await tx.update(orgRoles).set({ unitId: null, updatedAt: now }).where(eq(orgRoles.unitId, id));
    await tx
      .update(orgUnits)
      .set({ parentUnitId: null, updatedAt: now })
      .where(eq(orgUnits.parentUnitId, id));
    await tx.delete(orgUnits).where(eq(orgUnits.id, id));
  });
}

// ── Roles ────────────────────────────────────────────────────────────────────

export async function createOrgRole(
  db: AgentosPgDb,
  input: Omit<NewOrgRole, "id" | "createdAt" | "updatedAt" | "version" | "status"> & { id?: string },
): Promise<OrgRole> {
  const now = nowMs();
  const row: NewOrgRole = {
    ...input,
    id: input.id ?? newId(),
    status: "draft",
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(orgRoles).values(row);
  return (await getOrgRole(db, row.id!))!;
}

export async function getOrgRole(db: AgentosPgDb, id: string): Promise<OrgRole | undefined> {
  const [row] = await db.select().from(orgRoles).where(eq(orgRoles.id, id)).limit(1);
  return row;
}

export async function getOrgRoleByName(
  db: AgentosPgDb,
  orgId: string,
  name: string,
): Promise<OrgRole | undefined> {
  const [row] = await db
    .select()
    .from(orgRoles)
    .where(and(eq(orgRoles.orgId, orgId), eq(orgRoles.name, name)))
    .limit(1);
  return row;
}

export async function listOrgRoles(db: AgentosPgDb, orgId: string): Promise<OrgRole[]> {
  return await db.select().from(orgRoles).where(eq(orgRoles.orgId, orgId)).orderBy(asc(orgRoles.name));
}

/** ¿Asignar `newManagerId` como manager de `roleId` cerraría un ciclo? (incluye auto-reporte). */
async function wouldCreateReportingCycle(
  db: AgentosPgDb,
  roleId: string,
  newManagerId: string,
): Promise<boolean> {
  const seen = new Set<string>();
  let current: string | null = newManagerId;
  while (current) {
    if (current === roleId) return true;
    if (seen.has(current)) return false;
    seen.add(current);
    current = (await getOrgRole(db, current))?.reportsToRoleId ?? null;
  }
  return false;
}

/**
 * Optimistic locking salvo cuando el patch SOLO trae `canvasX`/`canvasY`
 * (arrastrar en el lienzo) o `agentId` (convertir el rol en agente): eso ni
 * sube `version` ni exige `expectedVersion`, porque no es una transición de
 * dominio del rol — es la posición de un dibujo o el enlace con su agente.
 */
export async function updateOrgRole(
  db: AgentosPgDb,
  id: string,
  patch: Partial<Omit<OrgRole, "id" | "orgId" | "createdAt" | "version">>,
  expectedVersion?: number,
): Promise<OrgRole> {
  const current = await getOrgRole(db, id);
  if (!current) throw errors.notFound("org_role", id);

  const keys = Object.keys(patch);
  const canvasOnly =
    keys.length > 0 && keys.every((k) => k === "canvasX" || k === "canvasY" || k === "agentId");

  if (patch.reportsToRoleId !== undefined && patch.reportsToRoleId !== null) {
    if (patch.reportsToRoleId === id || (await wouldCreateReportingCycle(db, id, patch.reportsToRoleId))) {
      throw errors.validation("Un rol no puede reportar a sí mismo ni a uno de sus subordinados");
    }
  }

  if (canvasOnly) {
    await db
      .update(orgRoles)
      .set({ ...patch, updatedAt: nowMs() })
      .where(eq(orgRoles.id, id));
    return (await getOrgRole(db, id))!;
  }

  if (expectedVersion !== undefined) {
    const rows = await db
      .update(orgRoles)
      .set({ ...patch, updatedAt: nowMs(), version: sql`${orgRoles.version} + 1` })
      .where(and(eq(orgRoles.id, id), eq(orgRoles.version, expectedVersion)))
      .returning({ id: orgRoles.id });
    if (rows.length === 0) throw errors.versionConflict("org_role", id, expectedVersion);
  } else {
    await db
      .update(orgRoles)
      .set({ ...patch, updatedAt: nowMs(), version: sql`${orgRoles.version} + 1` })
      .where(eq(orgRoles.id, id));
  }
  return (await getOrgRole(db, id))!;
}

/** Sus subordinados quedan sin manager; se borran sus funciones y uniones. */
export async function deleteOrgRole(db: AgentosPgDb, id: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(orgRoles)
      .set({ reportsToRoleId: null, updatedAt: nowMs() })
      .where(eq(orgRoles.reportsToRoleId, id));
    await tx.delete(roleFunctions).where(eq(roleFunctions.roleId, id));
    await tx.delete(rolePeople).where(eq(rolePeople.roleId, id));
    await tx.delete(roleProcesses).where(eq(roleProcesses.roleId, id));
    await tx.delete(orgRoles).where(eq(orgRoles.id, id));
  });
}

// ── Funciones del rol ────────────────────────────────────────────────────────

export async function listRoleFunctions(db: AgentosPgDb, roleId: string): Promise<RoleFunction[]> {
  return await db
    .select()
    .from(roleFunctions)
    .where(eq(roleFunctions.roleId, roleId))
    .orderBy(asc(roleFunctions.position));
}

export interface RoleFunctionInput {
  id?: string;
  name: string;
  description?: string | null;
}

/** Conserva los ids dados, crea los nuevos, borra los ausentes; `position` = índice en la lista. */
export async function replaceRoleFunctions(
  db: AgentosPgDb,
  roleId: string,
  input: readonly RoleFunctionInput[],
): Promise<RoleFunction[]> {
  const role = await getOrgRole(db, roleId);
  if (!role) throw errors.notFound("org_role", roleId);

  await db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: roleFunctions.id })
      .from(roleFunctions)
      .where(eq(roleFunctions.roleId, roleId));
    const existingIds = new Set(existing.map((f) => f.id));
    const keepIds = new Set(input.filter((f) => f.id).map((f) => f.id!));
    for (const existingId of existingIds) {
      if (!keepIds.has(existingId)) {
        await tx.delete(roleFunctions).where(eq(roleFunctions.id, existingId));
      }
    }
    const now = nowMs();
    for (const [index, fn] of input.entries()) {
      if (fn.id && existingIds.has(fn.id)) {
        await tx
          .update(roleFunctions)
          .set({ name: fn.name, description: fn.description ?? null, position: index, updatedAt: now })
          .where(eq(roleFunctions.id, fn.id));
      } else {
        await tx.insert(roleFunctions).values({
          id: fn.id ?? newId(),
          roleId,
          name: fn.name,
          description: fn.description ?? null,
          position: index,
          createdAt: now,
          updatedAt: now,
        });
      }
    }
  });
  return listRoleFunctions(db, roleId);
}

// ── Personas que ocupan el rol ───────────────────────────────────────────────

export async function listRolePeople(db: AgentosPgDb, roleId: string): Promise<RolePerson[]> {
  return await db
    .select()
    .from(rolePeople)
    .where(eq(rolePeople.roleId, roleId))
    .orderBy(asc(rolePeople.createdAt));
}

export interface RolePersonInput {
  personId: string;
  dedicationPct?: number | null;
}

export async function replaceRolePeople(
  db: AgentosPgDb,
  roleId: string,
  input: readonly RolePersonInput[],
): Promise<RolePerson[]> {
  const role = await getOrgRole(db, roleId);
  if (!role) throw errors.notFound("org_role", roleId);

  await db.transaction(async (tx) => {
    await tx.delete(rolePeople).where(eq(rolePeople.roleId, roleId));
    const now = nowMs();
    if (input.length > 0) {
      await tx.insert(rolePeople).values(
        input.map((p) => ({
          roleId,
          personId: p.personId,
          dedicationPct: p.dedicationPct ?? null,
          createdAt: now,
        })),
      );
    }
  });
  return listRolePeople(db, roleId);
}

// ── Procesos en los que participa el rol ─────────────────────────────────────

export async function listRoleProcesses(db: AgentosPgDb, roleId: string): Promise<RoleProcess[]> {
  return await db
    .select()
    .from(roleProcesses)
    .where(eq(roleProcesses.roleId, roleId))
    .orderBy(asc(roleProcesses.createdAt));
}

export interface RoleProcessInput {
  processId: string;
  relation: RoleProcessRelation;
}

export async function replaceRoleProcesses(
  db: AgentosPgDb,
  roleId: string,
  input: readonly RoleProcessInput[],
): Promise<RoleProcess[]> {
  const role = await getOrgRole(db, roleId);
  if (!role) throw errors.notFound("org_role", roleId);

  await db.transaction(async (tx) => {
    await tx.delete(roleProcesses).where(eq(roleProcesses.roleId, roleId));
    const now = nowMs();
    if (input.length > 0) {
      await tx.insert(roleProcesses).values(
        input.map((p) => ({ roleId, processId: p.processId, relation: p.relation, createdAt: now })),
      );
    }
  });
  return listRoleProcesses(db, roleId);
}

// ── Snapshot completo ────────────────────────────────────────────────────────

export interface OrgGraphRole extends OrgRole {
  functions: RoleFunction[];
  people: { personId: string; dedicationPct: number | null }[];
  processes: { processId: string; relation: RoleProcessRelation }[];
}

export interface OrgGraph {
  units: OrgUnit[];
  roles: OrgGraphRole[];
}

export async function getOrgGraph(db: AgentosPgDb, orgId: string): Promise<OrgGraph> {
  const units = await listOrgUnits(db, orgId);
  const rolesBase = await listOrgRoles(db, orgId);
  const roles = await Promise.all(
    rolesBase.map(async (role) => ({
      ...role,
      functions: await listRoleFunctions(db, role.id),
      people: (await listRolePeople(db, role.id)).map((rp) => ({
        personId: rp.personId,
        dedicationPct: rp.dedicationPct,
      })),
      processes: (await listRoleProcesses(db, role.id)).map((rp) => ({
        processId: rp.processId,
        relation: rp.relation,
      })),
    })),
  );
  return { units, roles };
}
