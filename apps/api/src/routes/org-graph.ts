/**
 * Grafo organizacional del cliente (PRD v1.1 §3.1 y Parte II §5.3): el ROL es
 * el centro. Cuelga de un área, reporta a otro rol, lo ocupan personas, tiene
 * funciones y participa en procesos (dueño único o participante).
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { OrgRoleStatus, RoleProcessRelation, errors } from "@agentos/shared";
import {
  appendAudit,
  createOrgRole,
  createOrgUnit,
  deleteOrgRole,
  deleteOrgUnit,
  getOrgGraph,
  getOrganization,
  getOrgRole,
  getOrgUnit,
  getPerson,
  getProcess,
  listPeople,
  listProcesses,
  listRoleFunctions,
  listRolePeople,
  listRoleProcesses,
  replaceRoleFunctions,
  replaceRolePeople,
  replaceRoleProcesses,
  updateOrgRole,
  updateOrgUnit,
} from "@agentos/db";
import type { ApiContext } from "../context.js";
import { parse } from "../http-errors.js";

const CreateUnitBody = z.object({
  name: z.string().min(1),
  parent_unit_id: z.string().optional(),
  description: z.string().optional(),
});

const UpdateUnitBody = z.object({
  name: z.string().min(1).optional(),
  parent_unit_id: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
});

const CreateRoleBody = z.object({
  name: z.string().min(1),
  unit_id: z.string().optional(),
  purpose: z.string().optional(),
  reports_to_role_id: z.string().optional(),
  canvas_x: z.number().optional(),
  canvas_y: z.number().optional(),
});

const UpdateRoleBody = z.object({
  name: z.string().min(1).optional(),
  unit_id: z.string().nullable().optional(),
  purpose: z.string().nullable().optional(),
  reports_to_role_id: z.string().nullable().optional(),
  canvas_x: z.number().optional(),
  canvas_y: z.number().optional(),
  status: OrgRoleStatus.optional(),
  expected_version: z.number().int().positive().optional(),
});

const RoleFunctionsBody = z.object({
  functions: z.array(
    z.object({
      id: z.string().optional(),
      name: z.string().min(1),
      description: z.string().optional(),
    }),
  ),
});

const RolePeopleBody = z.object({
  people: z.array(
    z.object({
      person_id: z.string(),
      dedication_pct: z.number().int().min(0).max(100).optional(),
    }),
  ),
});

const RoleProcessesBody = z.object({
  processes: z.array(
    z.object({
      process_id: z.string(),
      relation: RoleProcessRelation,
    }),
  ),
});

export function registerOrgGraphRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const { db } = ctx;

  const personActor = (req: { session?: { personId: string } | undefined }): string =>
    `person:${req.session!.personId}`;

  // ── Snapshot completo ────────────────────────────────────────────────────

  app.get("/api/orgs/:orgId/graph", async (req) => {
    const { orgId } = req.params as { orgId: string };
    const org = await getOrganization(db, orgId);
    if (!org) throw errors.notFound("organization", orgId);

    const graph = await getOrgGraph(db, orgId);
    const processes = (await listProcesses(db, orgId)).map((p) => ({
      id: p.id,
      name: p.name,
      variant: p.variant,
      status: p.status,
      ownerPerson: p.ownerPerson,
    }));
    const people = (await listPeople(db, orgId)).map((p) => ({
      id: p.id,
      fullName: p.fullName,
      role: p.role,
      isInternal: p.isInternal,
    }));

    return { units: graph.units, roles: graph.roles, processes, people };
  });

  // ── Áreas ────────────────────────────────────────────────────────────────

  app.post("/api/orgs/:orgId/units", async (req) => {
    const { orgId } = req.params as { orgId: string };
    const org = await getOrganization(db, orgId);
    if (!org) throw errors.notFound("organization", orgId);
    const body = parse(CreateUnitBody, req.body);

    const unit = await createOrgUnit(db, {
      orgId,
      name: body.name,
      parentUnitId: body.parent_unit_id ?? null,
      description: body.description ?? null,
    });
    await appendAudit(db, {
      actor: personActor(req),
      source: "ui",
      action: "org_unit.create",
      entityType: "org_unit",
      entityId: unit.id,
      after: { name: unit.name, parentUnitId: unit.parentUnitId },
    });
    return { unit };
  });

  app.patch("/api/units/:id", async (req) => {
    const { id } = req.params as { id: string };
    const before = await getOrgUnit(db, id);
    if (!before) throw errors.notFound("org_unit", id);
    const body = parse(UpdateUnitBody, req.body);

    const unit = await updateOrgUnit(db, id, {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.parent_unit_id !== undefined ? { parentUnitId: body.parent_unit_id } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
    });
    await appendAudit(db, {
      actor: personActor(req),
      source: "ui",
      action: "org_unit.update",
      entityType: "org_unit",
      entityId: unit.id,
      before: { name: before.name, parentUnitId: before.parentUnitId, description: before.description },
      after: { name: unit.name, parentUnitId: unit.parentUnitId, description: unit.description },
    });
    return { unit };
  });

  app.delete("/api/units/:id", async (req) => {
    const { id } = req.params as { id: string };
    const before = await getOrgUnit(db, id);
    if (!before) throw errors.notFound("org_unit", id);
    await deleteOrgUnit(db, id);
    await appendAudit(db, {
      actor: personActor(req),
      source: "ui",
      action: "org_unit.delete",
      entityType: "org_unit",
      entityId: id,
      before: { name: before.name },
    });
    return { ok: true };
  });

  // ── Roles ────────────────────────────────────────────────────────────────

  app.post("/api/orgs/:orgId/roles", async (req) => {
    const { orgId } = req.params as { orgId: string };
    const org = await getOrganization(db, orgId);
    if (!org) throw errors.notFound("organization", orgId);
    const body = parse(CreateRoleBody, req.body);

    const role = await createOrgRole(db, {
      orgId,
      name: body.name,
      unitId: body.unit_id ?? null,
      purpose: body.purpose ?? null,
      reportsToRoleId: body.reports_to_role_id ?? null,
      canvasX: body.canvas_x ?? null,
      canvasY: body.canvas_y ?? null,
    });
    await appendAudit(db, {
      actor: personActor(req),
      source: "ui",
      action: "org_role.create",
      entityType: "org_role",
      entityId: role.id,
      after: { name: role.name, unitId: role.unitId, reportsToRoleId: role.reportsToRoleId },
    });
    return { role: { ...role, functions: [], people: [], processes: [] } };
  });

  app.patch("/api/roles/:id", async (req) => {
    const { id } = req.params as { id: string };
    const before = await getOrgRole(db, id);
    if (!before) throw errors.notFound("org_role", id);
    const body = parse(UpdateRoleBody, req.body);

    const role = await updateOrgRole(
      db,
      id,
      {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.unit_id !== undefined ? { unitId: body.unit_id } : {}),
        ...(body.purpose !== undefined ? { purpose: body.purpose } : {}),
        ...(body.reports_to_role_id !== undefined
          ? { reportsToRoleId: body.reports_to_role_id }
          : {}),
        ...(body.canvas_x !== undefined ? { canvasX: body.canvas_x } : {}),
        ...(body.canvas_y !== undefined ? { canvasY: body.canvas_y } : {}),
        ...(body.status !== undefined ? { status: body.status } : {}),
      },
      body.expected_version,
    );
    await appendAudit(db, {
      actor: personActor(req),
      source: "ui",
      action: "org_role.update",
      entityType: "org_role",
      entityId: role.id,
      before: { name: before.name, unitId: before.unitId, reportsToRoleId: before.reportsToRoleId },
      after: { name: role.name, unitId: role.unitId, reportsToRoleId: role.reportsToRoleId },
    });
    return { role };
  });

  app.delete("/api/roles/:id", async (req) => {
    const { id } = req.params as { id: string };
    const before = await getOrgRole(db, id);
    if (!before) throw errors.notFound("org_role", id);
    await deleteOrgRole(db, id);
    await appendAudit(db, {
      actor: personActor(req),
      source: "ui",
      action: "org_role.delete",
      entityType: "org_role",
      entityId: id,
      before: { name: before.name },
    });
    return { ok: true };
  });

  // ── Funciones, personas y procesos del rol ────────────────────────────────

  app.put("/api/roles/:id/functions", async (req) => {
    const { id } = req.params as { id: string };
    const role = await getOrgRole(db, id);
    if (!role) throw errors.notFound("org_role", id);
    const body = parse(RoleFunctionsBody, req.body);

    const before = await listRoleFunctions(db, id);
    const functions = await replaceRoleFunctions(
      db,
      id,
      body.functions.map((f) => ({ id: f.id, name: f.name, description: f.description ?? null })),
    );
    await appendAudit(db, {
      actor: personActor(req),
      source: "ui",
      action: "org_role.functions",
      entityType: "org_role",
      entityId: id,
      before: { functions: before.map((f) => f.name) },
      after: { functions: functions.map((f) => f.name) },
    });
    return { functions };
  });

  app.put("/api/roles/:id/people", async (req) => {
    const { id } = req.params as { id: string };
    const role = await getOrgRole(db, id);
    if (!role) throw errors.notFound("org_role", id);
    const body = parse(RolePeopleBody, req.body);

    for (const p of body.people) {
      const person = await getPerson(db, p.person_id);
      if (!person || person.orgId !== role.orgId) {
        throw errors.validation("La persona no pertenece a la organización del rol", {
          personId: p.person_id,
        });
      }
    }

    const before = await listRolePeople(db, id);
    const people = await replaceRolePeople(
      db,
      id,
      body.people.map((p) => ({ personId: p.person_id, dedicationPct: p.dedication_pct ?? null })),
    );
    await appendAudit(db, {
      actor: personActor(req),
      source: "ui",
      action: "org_role.people",
      entityType: "org_role",
      entityId: id,
      before: { people: before.map((p) => p.personId) },
      after: { people: people.map((p) => p.personId) },
    });
    return { people };
  });

  app.put("/api/roles/:id/processes", async (req) => {
    const { id } = req.params as { id: string };
    const role = await getOrgRole(db, id);
    if (!role) throw errors.notFound("org_role", id);
    const body = parse(RoleProcessesBody, req.body);

    for (const p of body.processes) {
      const process = await getProcess(db, p.process_id);
      if (!process || process.orgId !== role.orgId) {
        throw errors.validation("El proceso no pertenece a la organización del rol", {
          processId: p.process_id,
        });
      }
    }

    const before = await listRoleProcesses(db, id);
    const processes = await replaceRoleProcesses(
      db,
      id,
      body.processes.map((p) => ({ processId: p.process_id, relation: p.relation })),
    );
    await appendAudit(db, {
      actor: personActor(req),
      source: "ui",
      action: "org_role.processes",
      entityType: "org_role",
      entityId: id,
      before: { processes: before.map((p) => p.processId) },
      after: { processes: processes.map((p) => p.processId) },
    });
    return { processes };
  });
}
