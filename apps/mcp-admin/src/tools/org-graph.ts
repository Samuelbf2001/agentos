/**
 * Grafo organizacional del cliente (PRD v1.1 §3.1 y Parte II §5.3) por MCP.
 * Lectura y escritura POR NOMBRE — misma lógica de resolución que la tool de
 * dominio `org_graph.*` (@agentos/tools), reutilizada aquí para que la regla
 * de "crea lo que falte, avisa lo que no encuentra" no viva en dos sitios.
 */
import { z } from "zod";
import { RoleProcessRelation } from "@agentos/shared";
import { getOrgRole, getOrgRoleByName, getOrgUnit, getOrgUnitByName } from "@agentos/db";
import { buildOrgGraphView, upsertOrgRoleByName, upsertOrgUnitByName } from "@agentos/tools";
import { auditMutation, findIdempotentMutation } from "../context.js";
import { defineAdminTool as def, type AdminToolDefinition } from "../registry.js";

const Reason = z.string().max(2000).optional();
const IdempotencyKey = z.string().min(1).max(200).optional();

export const orgGraphTools: AdminToolDefinition[] = [
  def({
    name: "agentos.org_graph.get",
    description:
      "Lee el organigrama del cliente (áreas y roles, con nombres ya resueltos: área, jefe, " +
      "funciones, personas y procesos).",
    schema: z.object({ org_id: z.string().min(1) }),
    readOnly: true,
    async handler(ctx, args) {
      return await buildOrgGraphView(ctx.db, args.org_id);
    },
  }),

  def({
    name: "agentos.org_graph.upsert_unit",
    description:
      "Crea o actualiza un área del organigrama POR NOMBRE: si ya existe un área con ese nombre en " +
      "la organización, la actualiza; si no, la crea. Si `parent_name` no existe, también se crea.",
    schema: z.object({
      org_id: z.string().min(1),
      name: z.string().min(1),
      parent_name: z.string().min(1).optional(),
      description: z.string().optional(),
      reason: Reason,
      idempotency_key: IdempotencyKey,
    }),
    readOnly: false,
    async handler(ctx, args) {
      const previous = await findIdempotentMutation(ctx, "org_graph.upsert_unit", args.idempotency_key);
      if (previous?.entityId) {
        const existing = await getOrgUnit(ctx.db, previous.entityId);
        if (existing) return { unit: existing, idempotent: true };
      }
      const before = await getOrgUnitByName(ctx.db, args.org_id, args.name);
      const unit = await upsertOrgUnitByName(ctx.db, {
        orgId: args.org_id,
        name: args.name,
        parentName: args.parent_name,
        description: args.description,
      });
      await auditMutation(ctx, {
        action: "org_graph.upsert_unit",
        entityType: "org_unit",
        entityId: unit.id,
        before: before ? { name: before.name, parentUnitId: before.parentUnitId } : null,
        after: { name: unit.name, parentUnitId: unit.parentUnitId },
        reason: args.reason,
        idempotencyKey: args.idempotency_key,
      });
      return { unit };
    },
  }),

  def({
    name: "agentos.org_graph.upsert_role",
    description:
      "Crea o actualiza un ROL del organigrama POR NOMBRE: área, jefe, funciones, personas que lo " +
      "ocupan y procesos en los que participa se resuelven por nombre. Si `unit_name` o " +
      "`reports_to_name` no existen, se crean vacíos. Nombres de persona/proceso que no se encuentren " +
      "van en `warnings` (no rompen la llamada). El rol queda como BORRADOR: un humano lo valida " +
      "después en el Organigrama.",
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
      reason: Reason,
      idempotency_key: IdempotencyKey,
    }),
    readOnly: false,
    async handler(ctx, args) {
      const previous = await findIdempotentMutation(ctx, "org_graph.upsert_role", args.idempotency_key);
      if (previous?.entityId) {
        const existing = await getOrgRole(ctx.db, previous.entityId);
        if (existing) return { role: existing, warnings: [], idempotent: true };
      }
      const before = await getOrgRoleByName(ctx.db, args.org_id, args.name);
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
      await auditMutation(ctx, {
        action: "org_graph.upsert_role",
        entityType: "org_role",
        entityId: role.id,
        before: before
          ? { name: before.name, unitId: before.unitId, reportsToRoleId: before.reportsToRoleId }
          : null,
        after: { name: role.name, unitId: role.unitId, reportsToRoleId: role.reportsToRoleId },
        reason: args.reason,
        idempotencyKey: args.idempotency_key,
      });
      return { role, warnings };
    },
  }),
];
