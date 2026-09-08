/**
 * Grafo organizacional (PRD v1.1 §3.1 y Parte II §5.3) para agentes: leer el
 * organigrama del cliente y proponer altas/cambios de áreas y roles POR
 * NOMBRE (sin ids), como haría un consultor durante una entrevista. Toda
 * escritura queda `status: "draft"` — un humano la valida en el Organigrama
 * antes de que cuente como definitiva.
 */
import { z } from "zod";
import { RoleProcessRelation } from "@agentos/shared";
import {
  createOrgRole,
  createOrgUnit,
  getOrgGraph,
  getOrgRole,
  getOrgRoleByName,
  getOrgUnitByName,
  listPeople,
  listProcesses,
  listRoleFunctions,
  replaceRoleFunctions,
  replaceRolePeople,
  replaceRoleProcesses,
  updateOrgRole,
  updateOrgUnit,
  type AgentosDb,
  type OrgRole,
  type OrgUnit,
} from "@agentos/db";
import type { ToolDefinition } from "../types.js";
import { defineTool as def } from "../catalog.js";

// ── Lectura: snapshot con nombres resueltos (nada de ids para el agente) ────

export interface OrgGraphUnitView {
  id: string;
  name: string;
  parent_name: string | null;
}

export interface OrgGraphRoleView {
  id: string;
  name: string;
  unit_name: string | null;
  reports_to_name: string | null;
  purpose: string | null;
  status: string;
  functions: string[];
  people: string[];
  processes: { name: string; relation: string }[];
}

export interface OrgGraphView {
  units: OrgGraphUnitView[];
  roles: OrgGraphRoleView[];
}

export async function buildOrgGraphView(db: AgentosDb, orgId: string): Promise<OrgGraphView> {
  const graph = await getOrgGraph(db, orgId);
  const unitById = new Map(graph.units.map((u) => [u.id, u]));
  const roleById = new Map(graph.roles.map((r) => [r.id, r]));
  const peopleById = new Map((await listPeople(db, orgId)).map((p) => [p.id, p]));
  const processById = new Map((await listProcesses(db, orgId)).map((p) => [p.id, p]));

  const units: OrgGraphUnitView[] = graph.units.map((u) => ({
    id: u.id,
    name: u.name,
    parent_name: u.parentUnitId ? (unitById.get(u.parentUnitId)?.name ?? null) : null,
  }));

  const roles: OrgGraphRoleView[] = graph.roles.map((r) => ({
    id: r.id,
    name: r.name,
    unit_name: r.unitId ? (unitById.get(r.unitId)?.name ?? null) : null,
    reports_to_name: r.reportsToRoleId ? (roleById.get(r.reportsToRoleId)?.name ?? null) : null,
    purpose: r.purpose,
    status: r.status,
    functions: r.functions.map((f) => f.name),
    people: r.people
      .map((p) => peopleById.get(p.personId)?.fullName)
      .filter((name): name is string => Boolean(name)),
    processes: r.processes.map((p) => ({
      name: processById.get(p.processId)?.name ?? p.processId,
      relation: p.relation,
    })),
  }));

  return { units, roles };
}

// ── Escritura por nombre: crea lo que falte, resuelve el resto ─────────────

export interface UpsertOrgUnitByNameInput {
  orgId: string;
  name: string;
  parentName?: string;
  description?: string;
}

/** Crea o actualiza un área por nombre; el padre (si llega) se crea si no existe. */
export async function upsertOrgUnitByName(db: AgentosDb, input: UpsertOrgUnitByNameInput): Promise<OrgUnit> {
  let parentUnitId: string | null = null;
  if (input.parentName) {
    const parent =
      (await getOrgUnitByName(db, input.orgId, input.parentName)) ??
      (await createOrgUnit(db, { orgId: input.orgId, name: input.parentName }));
    parentUnitId = parent.id;
  }

  const existing = await getOrgUnitByName(db, input.orgId, input.name);
  if (existing) {
    return await updateOrgUnit(db, existing.id, {
      ...(input.parentName !== undefined ? { parentUnitId } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
    });
  }
  return await createOrgUnit(db, {
    orgId: input.orgId,
    name: input.name,
    parentUnitId,
    description: input.description ?? null,
  });
}

export interface UpsertOrgRoleByNameInput {
  orgId: string;
  name: string;
  unitName?: string;
  reportsToName?: string;
  purpose?: string;
  functions?: string[];
  peopleNames?: string[];
  processes?: { name: string; relation: "owner" | "participant" }[];
}

export interface UpsertOrgRoleByNameResult {
  role: OrgRole;
  warnings: string[];
}

/**
 * Crea o actualiza un rol por nombre. `unit_name` crea el área si falta;
 * `reports_to_name` crea el rol jefe (vacío) si falta; `people_names` y
 * `processes` resuelven contra la organización — lo que no se encuentra NO
 * hace fallar la llamada, va en `warnings`.
 */
export async function upsertOrgRoleByName(
  db: AgentosDb,
  input: UpsertOrgRoleByNameInput,
): Promise<UpsertOrgRoleByNameResult> {
  const warnings: string[] = [];

  let unitId: string | null | undefined;
  if (input.unitName !== undefined) {
    const unit =
      (await getOrgUnitByName(db, input.orgId, input.unitName)) ??
      (await createOrgUnit(db, { orgId: input.orgId, name: input.unitName }));
    unitId = unit.id;
  }

  let reportsToRoleId: string | null | undefined;
  if (input.reportsToName !== undefined) {
    const manager =
      (await getOrgRoleByName(db, input.orgId, input.reportsToName)) ??
      (await createOrgRole(db, { orgId: input.orgId, name: input.reportsToName }));
    reportsToRoleId = manager.id;
  }

  const existing = await getOrgRoleByName(db, input.orgId, input.name);
  let role: OrgRole;
  if (existing) {
    role = await updateOrgRole(db, existing.id, {
      ...(unitId !== undefined ? { unitId } : {}),
      ...(reportsToRoleId !== undefined ? { reportsToRoleId } : {}),
      ...(input.purpose !== undefined ? { purpose: input.purpose } : {}),
    });
  } else {
    role = await createOrgRole(db, {
      orgId: input.orgId,
      name: input.name,
      unitId: unitId ?? null,
      reportsToRoleId: reportsToRoleId ?? null,
      purpose: input.purpose ?? null,
    });
  }

  if (input.functions !== undefined) {
    const current = await listRoleFunctions(db, role.id);
    const idByName = new Map(current.map((f) => [f.name, f.id]));
    await replaceRoleFunctions(
      db,
      role.id,
      input.functions.map((name) => ({ id: idByName.get(name), name })),
    );
  }

  if (input.peopleNames !== undefined) {
    const people = await listPeople(db, input.orgId);
    const byName = new Map(people.map((p) => [p.fullName.trim().toLowerCase(), p]));
    const resolved: { personId: string }[] = [];
    for (const name of input.peopleNames) {
      const person = byName.get(name.trim().toLowerCase());
      if (!person) {
        warnings.push(`Persona no encontrada en la organización: "${name}"`);
        continue;
      }
      resolved.push({ personId: person.id });
    }
    await replaceRolePeople(db, role.id, resolved);
  }

  if (input.processes !== undefined) {
    const processes = await listProcesses(db, input.orgId);
    const byName = new Map(processes.map((p) => [p.name.trim().toLowerCase(), p]));
    const resolved: { processId: string; relation: "owner" | "participant" }[] = [];
    for (const p of input.processes) {
      const process = byName.get(p.name.trim().toLowerCase());
      if (!process) {
        warnings.push(`Proceso no encontrado en la organización: "${p.name}"`);
        continue;
      }
      resolved.push({ processId: process.id, relation: p.relation });
    }
    await replaceRoleProcesses(db, role.id, resolved);
  }

  const final = await getOrgRole(db, role.id);
  return { role: final!, warnings };
}

// ── Tools del catálogo ───────────────────────────────────────────────────────

export const orgGraphTools: ToolDefinition[] = [
  def({
    name: "org_graph.get",
    description:
      "Lee el organigrama del cliente (áreas y roles, con nombres ya resueltos: área, jefe, " +
      "funciones, personas y procesos). Úsala para saber qué existe antes de proponer altas o cambios.",
    schema: z.object({ org_id: z.string().min(1) }),
    flags: { read_only: true, external_effect: false, requires_approval: false },
    async handler(ctx, args) {
      return buildOrgGraphView(ctx.db, args.org_id);
    },
  }),

  def({
    name: "org_graph.upsert_unit",
    description:
      "Crea o actualiza un área del organigrama POR NOMBRE (sin ids): si ya existe un área con ese " +
      "nombre en la organización, la actualiza; si no, la crea. Si das `parent_name` y esa área " +
      "padre no existe, también se crea. Úsala cuando el cliente mencione un área nueva o corrija una.",
    schema: z.object({
      org_id: z.string().min(1),
      name: z.string().min(1),
      parent_name: z.string().min(1).optional(),
      description: z.string().optional(),
    }),
    flags: { read_only: false, external_effect: false, requires_approval: false },
    // "none": las áreas son entidades de ORGANIZACIÓN, no de proyecto.
    projectScope: "none",
    async handler(ctx, args) {
      const unit = await upsertOrgUnitByName(ctx.db, {
        orgId: args.org_id,
        name: args.name,
        parentName: args.parent_name,
        description: args.description,
      });
      return { unit };
    },
  }),

  def({
    name: "org_graph.upsert_role",
    description:
      "Crea o actualiza un ROL del organigrama POR NOMBRE (sin ids): área, jefe, funciones, personas " +
      "que lo ocupan y procesos en los que participa se resuelven por nombre dentro de la organización. " +
      "Si `unit_name` o `reports_to_name` no existen, se crean vacíos. Nombres de persona/proceso que no " +
      "se encuentren van en `warnings` (no rompen la llamada). El rol queda como BORRADOR: un humano lo " +
      "valida después en el Organigrama.",
    schema: z.object({
      org_id: z.string().min(1),
      name: z.string().min(1),
      unit_name: z.string().min(1).optional(),
      reports_to_name: z.string().min(1).optional(),
      purpose: z.string().optional(),
      functions: z.array(z.string().min(1)).optional(),
      people_names: z.array(z.string().min(1)).optional(),
      processes: z
        .array(z.object({ name: z.string().min(1), relation: RoleProcessRelation }))
        .optional(),
    }),
    flags: { read_only: false, external_effect: false, requires_approval: false },
    // "none": los roles son entidades de ORGANIZACIÓN, no de proyecto.
    projectScope: "none",
    async handler(ctx, args) {
      const { role, warnings } = await upsertOrgRoleByName(ctx.db, {
        orgId: args.org_id,
        name: args.name,
        unitName: args.unit_name,
        reportsToName: args.reports_to_name,
        purpose: args.purpose,
        functions: args.functions,
        peopleNames: args.people_names,
        processes: args.processes,
      });
      return { role, warnings };
    },
  }),
];
