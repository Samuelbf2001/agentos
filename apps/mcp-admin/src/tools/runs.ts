/**
 * Tools de runs y del stream de eventos persistido.
 * `runs.cancel` solo MARCA cancelled vía repositorio (la cancelación viva —
 * matar el proceso/stream — la hace la API en B4).
 */
import { z } from "zod";
import { AgentosError, ErrorCodes, errors, nowMs, RunStatus } from "@agentos/shared";
import {
  getRun,
  lastSeq,
  listEventsSince,
  listRunsByRoot,
  listRunsByStatus,
  listRunsForTask,
  listSpans,
  updateRun,
  type Run,
} from "@agentos/db";
import { auditMutation } from "../context.js";
import { defineAdminTool as def, type AdminToolDefinition } from "../registry.js";

const Reason = z.string().max(2000).optional();

const TERMINAL_RUN_STATUSES = new Set(["succeeded", "failed", "cancelled", "interrupted"]);

export const runTools: AdminToolDefinition[] = [
  def({
    name: "agentos.runs.list",
    description:
      "Lista runs por status, task_id o root_run_id (sin filtro: todos los estados, ordenados por fecha desc).",
    schema: z.object({
      status: RunStatus.optional(),
      task_id: z.string().optional(),
      root_run_id: z.string().optional(),
      limit: z.number().int().positive().max(500).optional(),
    }),
    readOnly: true,
    async handler(ctx, args) {
      const limit = args.limit ?? 50;
      let rows: Run[];
      if (args.task_id) {
        rows = await listRunsForTask(ctx.db, args.task_id);
      } else if (args.root_run_id) {
        rows = await listRunsByRoot(ctx.db, args.root_run_id);
      } else if (args.status) {
        rows = await listRunsByStatus(ctx.db, args.status);
      } else {
        const byStatus = await Promise.all(
          RunStatus.options.map((s) => listRunsByStatus(ctx.db, s)),
        );
        rows = byStatus.flat();
      }
      if (args.status) rows = rows.filter((r) => r.status === args.status);
      rows.sort((a, b) => b.createdAt - a.createdAt);
      return rows.slice(0, limit);
    },
  }),

  def({
    name: "agentos.runs.get",
    description: "Devuelve un run con sus spans (observabilidad §10).",
    schema: z.object({ run_id: z.string().min(1) }),
    readOnly: true,
    async handler(ctx, args) {
      const run = await getRun(ctx.db, args.run_id);
      if (!run) throw errors.notFound("run", args.run_id);
      return { run, spans: await listSpans(ctx.db, run.id) };
    },
  }),

  def({
    name: "agentos.runs.cancel",
    description:
      "Marca un run como cancelled (queued/running). La cancelación del proceso vivo la ejecuta la API (B4).",
    schema: z.object({ run_id: z.string().min(1), reason: Reason }),
    readOnly: false,
    async handler(ctx, args) {
      const run = await getRun(ctx.db, args.run_id);
      if (!run) throw errors.notFound("run", args.run_id);
      if (TERMINAL_RUN_STATUSES.has(run.status)) {
        throw new AgentosError(
          ErrorCodes.CONFLICT,
          `El run ${run.id} ya terminó (${run.status}): no se cancela`,
          { runId: run.id, status: run.status },
        );
      }
      const before = { status: run.status };
      const updated = await updateRun(ctx.db, run.id, {
        status: "cancelled",
        finishedAt: nowMs(),
        error: args.reason ? `cancelled via MCP: ${args.reason}` : "cancelled via MCP",
      });
      await auditMutation(ctx, {
        action: "runs.cancel",
        entityType: "run",
        entityId: run.id,
        before,
        after: { status: updated.status },
        reason: args.reason,
        runId: run.id,
      });
      await ctx.sink.publish(`run:${run.id}`, {
        type: "run.cancel_requested",
        payload: { runId: run.id, actor: ctx.actor },
        runId: run.id,
      });
      return updated;
    },
  }),

  def({
    name: "agentos.events.tail",
    description:
      "Últimos N eventos persistidos de un topic (run:<id> | board:<project_id> | approvals | swarm | ...).",
    schema: z.object({
      topic: z.string().min(1),
      n: z.number().int().positive().max(500).optional(),
    }),
    readOnly: true,
    async handler(ctx, args) {
      const n = args.n ?? 50;
      const last = await lastSeq(ctx.db, args.topic);
      const events = await listEventsSince(ctx.db, args.topic, Math.max(0, last - n), n);
      return { topic: args.topic, last_seq: last, events };
    },
  }),
];
