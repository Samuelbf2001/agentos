/**
 * Approvals (Gate 2): decidir exige person_id HUMANO y el digest del payload
 * literal lo verifica @agentos/core (payload alterado → approval_invalidated).
 */
import { z } from "zod";
import { defineAdminTool as def, type AdminToolDefinition } from "../registry.js";
import { mustGetPerson } from "../context.js";

export const approvalTools: AdminToolDefinition[] = [
  def({
    name: "agentos.approvals.list_pending",
    description: "Bandeja 'Esperando por ti': aprobaciones pendientes (tool_call | deliverable | gate).",
    schema: z.object({}),
    readOnly: true,
    handler(ctx) {
      return ctx.engine.listPendingApprovals();
    },
  }),

  def({
    name: "agentos.approvals.decide",
    description:
      "Decide una aprobación pendiente (approved|rejected) con person_id humano. " +
      "Core verifica el digest del payload literal, audita y fija el estado (atómico). " +
      "El MCP admin es capa fina y NO ejecuta efectos externos: la reconciliación " +
      "(ejecutar el efecto del tool_call aprobado + reanudar, o desbloquear la tarjeta) " +
      "la drena el despachador de apps/api en su siguiente tick, así la tarea nunca queda " +
      "huérfana (fix Q2). Si se aprueba un tool_call devuelve el payload exacto a ejecutar.",
    schema: z.object({
      approval_id: z.string().min(1),
      decision: z.enum(["approved", "rejected"]),
      person_id: z.string().min(1),
      note: z.string().optional(),
    }),
    readOnly: false,
    handler(ctx, args) {
      const person = mustGetPerson(ctx.db, args.person_id);
      const result = ctx.engine.decideApproval(
        args.approval_id,
        args.decision,
        person.id,
        args.note,
      );
      return {
        approval: result.approval,
        execute_payload: result.executePayload ?? null,
      };
    },
  }),
];
