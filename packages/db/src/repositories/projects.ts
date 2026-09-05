import { and, eq, sql } from "drizzle-orm";
import { errors, newId, nowMs, type GateState } from "@agentos/shared";
import type { AgentosSqliteDb } from "../client.js";
import { projects } from "../schema.js";
import type { NewProject, Project } from "../types.js";

export function createProject(
  db: AgentosSqliteDb,
  input: Omit<NewProject, "id" | "createdAt" | "updatedAt" | "version"> & { id?: string },
): Project {
  const now = nowMs();
  const row: NewProject = { ...input, id: input.id ?? newId(), createdAt: now, updatedAt: now };
  db.insert(projects).values(row).run();
  return getProject(db, row.id!)!;
}

export function getProject(db: AgentosSqliteDb, id: string): Project | undefined {
  return db.select().from(projects).where(eq(projects.id, id)).get();
}

export function getProjectByName(db: AgentosSqliteDb, name: string): Project | undefined {
  return db.select().from(projects).where(eq(projects.name, name)).get();
}

/**
 * Proyecto por (org, nombre exacto) — el get-or-create del motor de launch
 * (§13.3): el mismo cliente + mismo `name_tpl` renderizado reutiliza el
 * proyecto (y ahí `uq(project_id, phase)` impide re-disparar la misma fase;
 * el redo legítimo es proyecto nuevo).
 */
export function getProjectByOrgAndName(
  db: AgentosSqliteDb,
  orgId: string,
  name: string,
): Project | undefined {
  return db
    .select()
    .from(projects)
    .where(and(eq(projects.orgId, orgId), eq(projects.name, name)))
    .get();
}

export function listProjects(db: AgentosSqliteDb, orgId?: string): Project[] {
  if (orgId) return db.select().from(projects).where(eq(projects.orgId, orgId)).all();
  return db.select().from(projects).all();
}

/**
 * Actualización con optimistic locking: `expectedVersion` obligatoria.
 * Conflicto → AgentosError(version_conflict); el llamador relee, nunca last-write-wins.
 */
export function updateProject(
  db: AgentosSqliteDb,
  id: string,
  patch: Partial<Omit<Project, "id" | "createdAt" | "version">>,
  expectedVersion: number,
): Project {
  const res = db
    .update(projects)
    .set({ ...patch, updatedAt: nowMs(), version: sql`${projects.version} + 1` })
    .where(sql`${projects.id} = ${id} AND ${projects.version} = ${expectedVersion}`)
    .run();
  if (res.changes === 0) {
    if (!getProject(db, id)) throw errors.notFound("project", id);
    throw errors.versionConflict("project", id, expectedVersion);
  }
  return getProject(db, id)!;
}

/** Gate 1 (nivel proyecto): cerrar ENTENDER exige aprobación humana. */
export function setGateState(
  db: AgentosSqliteDb,
  id: string,
  gateState: GateState,
  expectedVersion: number,
): Project {
  return updateProject(db, id, { gateState }, expectedVersion);
}
