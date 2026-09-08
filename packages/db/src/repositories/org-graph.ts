/**
 * Grafo organizacional del cliente (PRD v1.1 §3.1 y Parte II §5.3): el ROL es
 * el centro. Cuelga de un área (`org_units`), reporta a otro rol, lo ocupan
 * personas (`role_people`), tiene funciones (`role_functions`) y participa en
 * procesos (`role_processes`, dueño único o participante).
 */
import { and, asc, eq, sql } from "drizzle-orm";
import { errors, newId, nowMs, type RoleProcessRelation } from "@agentos/shared";
import type { AgentosSqliteDb } from "../client.js";
import { orgRoles, orgUnits, roleFunctions, rolePeople, roleProcesses } from "../schema.js";
import type {
  NewOrgRole,
  NewOrgUnit,
  OrgRole,
  OrgUnit,
  RoleFunction,
  RolePerson,
  RoleProcess,
} from "../types.js";

/** Corre `work` en una transacción propia salvo que ya haya una abierta (igual que `replaceTaskLabels`). */
function runInTransaction(db: AgentosSqliteDb, work: () => void): void {
  const inTransaction = (db.$client as unknown as { inTransaction?: boolean }).inTransaction === true;
  if (inTransaction) work();
  else db.$client.transaction(work)();
}

// ── Áreas ────────────────────────────────────────────────────────────────────

export function createOrgUnit(
  db: AgentosSqliteDb,
  input: Omit<NewOrgUnit, "id" | "createdAt" | "updatedAt"> & { id?: string },
): OrgUnit {
  const now = nowMs();
  const row: NewOrgUnit = { ...input, id: input.id ?? newId(), createdAt: now, updatedAt: now };
  db.insert(orgUnits).values(row).run();
  return getOrgUnit(db, row.id!)!;
}

export function getOrgUnit(db: AgentosSqliteDb, id: string): OrgUnit | undefined {
  return db.select().from(orgUnits).where(eq(orgUnits.id, id)).get();
}

export function getOrgUnitByName(db: AgentosSqliteDb, orgId: string, name: string): OrgUnit | undefined {
  return db
    .select()
    .from(orgUnits)
    .where(and(eq(orgUnits.orgId, orgId), eq(orgUnits.name, name)))
    .get();
}

export function listOrgUnits(db: AgentosSqliteDb, orgId: string): OrgUnit[] {
  return db.select().from(orgUnits).where(eq(orgUnits.orgId, orgId)).orderBy(asc(orgUnits.name)).all();
}

export function updateOrgUnit(
  db: AgentosSqliteDb,
  id: string,
  patch: Partial<Omit<OrgUnit, "id" | "orgId" | "createdAt">>,
): OrgUnit {
  const current = getOrgUnit(db, id);
  if (!current) throw errors.notFound("org_unit", id);
  db.update(orgUnits)
    .set({ ...patch, updatedAt: nowMs() })
    .where(eq(orgUnits.id, id))
    .run();
  return getOrgUnit(db, id)!;
}

/** Los roles del área quedan sin área; las sub-áreas quedan sin padre. */
export function deleteOrgUnit(db: AgentosSqliteDb, id: string): void {
  runInTransaction(db, () => {
    const now = nowMs();
    db.update(orgRoles).set({ unitId: null, updatedAt: now }).where(eq(orgRoles.unitId, id)).run();
    db.update(orgUnits).set({ parentUnitId: null, updatedAt: now }).where(eq(orgUnits.parentUnitId, id)).run();
    db.delete(orgUnits).where(eq(orgUnits.id, id)).run();
  });
}

// ── Roles ────────────────────────────────────────────────────────────────────

export function createOrgRole(
  db: AgentosSqliteDb,
  input: Omit<NewOrgRole, "id" | "createdAt" | "updatedAt" | "version" | "status"> & { id?: string },
): OrgRole {
  const now = nowMs();
  const row: NewOrgRole = {
    ...input,
    id: input.id ?? newId(),
    status: "draft",
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
  db.insert(orgRoles).values(row).run();
  return getOrgRole(db, row.id!)!;
}

export function getOrgRole(db: AgentosSqliteDb, id: string): OrgRole | undefined {
  return db.select().from(orgRoles).where(eq(orgRoles.id, id)).get();
}

export function getOrgRoleByName(db: AgentosSqliteDb, orgId: string, name: string): OrgRole | undefined {
  return db
    .select()
    .from(orgRoles)
    .where(and(eq(orgRoles.orgId, orgId), eq(orgRoles.name, name)))
    .get();
}

export function listOrgRoles(db: AgentosSqliteDb, orgId: string): OrgRole[] {
  return db.select().from(orgRoles).where(eq(orgRoles.orgId, orgId)).orderBy(asc(orgRoles.name)).all();
}

/** ¿Asignar `newManagerId` como manager de `roleId` cerraría un ciclo? (incluye auto-reporte). */
function wouldCreateReportingCycle(
  db: AgentosSqliteDb,
  roleId: string,
  newManagerId: string,
): boolean {
  const seen = new Set<string>();
  let current: string | null = newManagerId;
  while (current) {
    if (current === roleId) return true;
    if (seen.has(current)) return false;
    seen.add(current);
    current = getOrgRole(db, current)?.reportsToRoleId ?? null;
  }
  return false;
}

/**
 * Optimistic locking salvo cuando el patch SOLO trae `canvasX`/`canvasY`
 * (arrastrar en el lienzo) o `agentId` (convertir el rol en agente): eso ni
 * sube `version` ni exige `expectedVersion`, porque no es una transición de
 * dominio del rol — es la posición de un dibujo o el enlace con su agente.
 */
export function updateOrgRole(
  db: AgentosSqliteDb,
  id: string,
  patch: Partial<Omit<OrgRole, "id" | "orgId" | "createdAt" | "version">>,
  expectedVersion?: number,
): OrgRole {
  const current = getOrgRole(db, id);
  if (!current) throw errors.notFound("org_role", id);

  const keys = Object.keys(patch);
  const canvasOnly =
    keys.length > 0 && keys.every((k) => k === "canvasX" || k === "canvasY" || k === "agentId");

  if (patch.reportsToRoleId !== undefined && patch.reportsToRoleId !== null) {
    if (patch.reportsToRoleId === id || wouldCreateReportingCycle(db, id, patch.reportsToRoleId)) {
      throw errors.validation("Un rol no puede reportar a sí mismo ni a uno de sus subordinados");
    }
  }

  if (canvasOnly) {
    db.update(orgRoles)
      .set({ ...patch, updatedAt: nowMs() })
      .where(eq(orgRoles.id, id))
      .run();
    return getOrgRole(db, id)!;
  }

  if (expectedVersion !== undefined) {
    const res = db
      .update(orgRoles)
      .set({ ...patch, updatedAt: nowMs(), version: sql`${orgRoles.version} + 1` })
      .where(and(eq(orgRoles.id, id), eq(orgRoles.version, expectedVersion)))
      .run();
    if (res.changes === 0) throw errors.versionConflict("org_role", id, expectedVersion);
  } else {
    db.update(orgRoles)
      .set({ ...patch, updatedAt: nowMs(), version: sql`${orgRoles.version} + 1` })
      .where(eq(orgRoles.id, id))
      .run();
  }
  return getOrgRole(db, id)!;
}

/** Sus subordinados quedan sin manager; se borran sus funciones y uniones. */
export function deleteOrgRole(db: AgentosSqliteDb, id: string): void {
  runInTransaction(db, () => {
    db.update(orgRoles)
      .set({ reportsToRoleId: null, updatedAt: nowMs() })
      .where(eq(orgRoles.reportsToRoleId, id))
      .run();
    db.delete(roleFunctions).where(eq(roleFunctions.roleId, id)).run();
    db.delete(rolePeople).where(eq(rolePeople.roleId, id)).run();
    db.delete(roleProcesses).where(eq(roleProcesses.roleId, id)).run();
    db.delete(orgRoles).where(eq(orgRoles.id, id)).run();
  });
}

// ── Funciones del rol ────────────────────────────────────────────────────────

export function listRoleFunctions(db: AgentosSqliteDb, roleId: string): RoleFunction[] {
  return db
    .select()
    .from(roleFunctions)
    .where(eq(roleFunctions.roleId, roleId))
    .orderBy(asc(roleFunctions.position))
    .all();
}

export interface RoleFunctionInput {
  id?: string;
  name: string;
  description?: string | null;
}

/** Conserva los ids dados, crea los nuevos, borra los ausentes; `position` = índice en la lista. */
export function replaceRoleFunctions(
  db: AgentosSqliteDb,
  roleId: string,
  input: readonly RoleFunctionInput[],
): RoleFunction[] {
  const role = getOrgRole(db, roleId);
  if (!role) throw errors.notFound("org_role", roleId);

  runInTransaction(db, () => {
    const existingIds = new Set(listRoleFunctions(db, roleId).map((f) => f.id));
    const keepIds = new Set(input.filter((f) => f.id).map((f) => f.id!));
    for (const existingId of existingIds) {
      if (!keepIds.has(existingId)) {
        db.delete(roleFunctions).where(eq(roleFunctions.id, existingId)).run();
      }
    }
    const now = nowMs();
    input.forEach((fn, index) => {
      if (fn.id && existingIds.has(fn.id)) {
        db.update(roleFunctions)
          .set({ name: fn.name, description: fn.description ?? null, position: index, updatedAt: now })
          .where(eq(roleFunctions.id, fn.id))
          .run();
      } else {
        db.insert(roleFunctions)
          .values({
            id: fn.id ?? newId(),
            roleId,
            name: fn.name,
            description: fn.description ?? null,
            position: index,
            createdAt: now,
            updatedAt: now,
          })
          .run();
      }
    });
  });
  return listRoleFunctions(db, roleId);
}

// ── Personas que ocupan el rol ───────────────────────────────────────────────

export function listRolePeople(db: AgentosSqliteDb, roleId: string): RolePerson[] {
  return db
    .select()
    .from(rolePeople)
    .where(eq(rolePeople.roleId, roleId))
    .orderBy(asc(rolePeople.createdAt))
    .all();
}

export interface RolePersonInput {
  personId: string;
  dedicationPct?: number | null;
}

export function replaceRolePeople(
  db: AgentosSqliteDb,
  roleId: string,
  input: readonly RolePersonInput[],
): RolePerson[] {
  const role = getOrgRole(db, roleId);
  if (!role) throw errors.notFound("org_role", roleId);

  runInTransaction(db, () => {
    db.delete(rolePeople).where(eq(rolePeople.roleId, roleId)).run();
    const now = nowMs();
    for (const p of input) {
      db.insert(rolePeople)
        .values({ roleId, personId: p.personId, dedicationPct: p.dedicationPct ?? null, createdAt: now })
        .run();
    }
  });
  return listRolePeople(db, roleId);
}

// ── Procesos en los que participa el rol ─────────────────────────────────────

export function listRoleProcesses(db: AgentosSqliteDb, roleId: string): RoleProcess[] {
  return db
    .select()
    .from(roleProcesses)
    .where(eq(roleProcesses.roleId, roleId))
    .orderBy(asc(roleProcesses.createdAt))
    .all();
}

export interface RoleProcessInput {
  processId: string;
  relation: RoleProcessRelation;
}

export function replaceRoleProcesses(
  db: AgentosSqliteDb,
  roleId: string,
  input: readonly RoleProcessInput[],
): RoleProcess[] {
  const role = getOrgRole(db, roleId);
  if (!role) throw errors.notFound("org_role", roleId);

  runInTransaction(db, () => {
    db.delete(roleProcesses).where(eq(roleProcesses.roleId, roleId)).run();
    const now = nowMs();
    for (const p of input) {
      db.insert(roleProcesses)
        .values({ roleId, processId: p.processId, relation: p.relation, createdAt: now })
        .run();
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

export function getOrgGraph(db: AgentosSqliteDb, orgId: string): OrgGraph {
  const units = listOrgUnits(db, orgId);
  const roles = listOrgRoles(db, orgId).map((role) => ({
    ...role,
    functions: listRoleFunctions(db, role.id),
    people: listRolePeople(db, role.id).map((rp) => ({
      personId: rp.personId,
      dedicationPct: rp.dedicationPct,
    })),
    processes: listRoleProcesses(db, role.id).map((rp) => ({
      processId: rp.processId,
      relation: rp.relation,
    })),
  }));
  return { units, roles };
}
