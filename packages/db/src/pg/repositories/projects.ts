/** Espejo Postgres de src/repositories/projects.ts — misma superficie, asíncrona (§NFR-9). */
import { and, eq, sql } from "drizzle-orm";
import { errors, newId, nowMs, type GateState } from "@agentos/shared";
import type { AgentosPgDb } from "../client-pg.js";
import { projects } from "../schema-pg.js";
import type { NewProject, Project } from "../types-pg.js";

export async function createProject(
  db: AgentosPgDb,
  input: Omit<NewProject, "id" | "createdAt" | "updatedAt" | "version"> & { id?: string },
): Promise<Project> {
  const now = nowMs();
  const row: NewProject = { ...input, id: input.id ?? newId(), createdAt: now, updatedAt: now };
  await db.insert(projects).values(row);
  return (await getProject(db, row.id!))!;
}

export async function getProject(db: AgentosPgDb, id: string): Promise<Project | undefined> {
  const [row] = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
  return row;
}

export async function getProjectByName(db: AgentosPgDb, name: string): Promise<Project | undefined> {
  const [row] = await db.select().from(projects).where(eq(projects.name, name)).limit(1);
  return row;
}

/**
 * Proyecto por (org, nombre exacto) — el get-or-create del motor de launch
 * (§13.3): el mismo cliente + mismo `name_tpl` renderizado reutiliza el
 * proyecto (y ahí `uq(project_id, phase)` impide re-disparar la misma fase;
 * el redo legítimo es proyecto nuevo).
 */
export async function getProjectByOrgAndName(
  db: AgentosPgDb,
  orgId: string,
  name: string,
): Promise<Project | undefined> {
  const [row] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.orgId, orgId), eq(projects.name, name)))
    .limit(1);
  return row;
}

export async function listProjects(db: AgentosPgDb, orgId?: string): Promise<Project[]> {
  if (orgId) return await db.select().from(projects).where(eq(projects.orgId, orgId));
  return await db.select().from(projects);
}

/**
 * Actualización con optimistic locking: `expectedVersion` obligatoria.
 * Conflicto → AgentosError(version_conflict); el llamador relee, nunca last-write-wins.
 */
export async function updateProject(
  db: AgentosPgDb,
  id: string,
  patch: Partial<Omit<Project, "id" | "createdAt" | "version">>,
  expectedVersion: number,
): Promise<Project> {
  const rows = await db
    .update(projects)
    .set({ ...patch, updatedAt: nowMs(), version: sql`${projects.version} + 1` })
    .where(sql`${projects.id} = ${id} AND ${projects.version} = ${expectedVersion}`)
    .returning({ id: projects.id });
  if (rows.length === 0) {
    if (!(await getProject(db, id))) throw errors.notFound("project", id);
    throw errors.versionConflict("project", id, expectedVersion);
  }
  return (await getProject(db, id))!;
}

/** Gate 1 (nivel proyecto): cerrar ENTENDER exige aprobación humana. */
export async function setGateState(
  db: AgentosPgDb,
  id: string,
  gateState: GateState,
  expectedVersion: number,
): Promise<Project> {
  return await updateProject(db, id, { gateState }, expectedVersion);
}
