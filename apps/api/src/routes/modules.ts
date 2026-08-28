/**
 * REST de Módulos de Fase para el wizard "Nuevo proyecto" (ARCHITECTURE §13.7,
 * M4a): lista de módulos activos → formulario (inputs/toggles) → preview
 * (dry-run CA-M2.1) → Disparar (CA-M2.2, actor = persona de la sesión) →
 * recibos (CA-M2.4) y estado de cierre de fase (CA-M3.1).
 *
 * Mismo login/guard que el resto (hook global de server.ts). Los eventos del
 * launch salen POST-commit por ctx.sink (busSink) → topic board:<project_id>,
 * el mismo que sirve el WS multiplexado (ws.ts) — CA-8.3 sin wiring extra.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { errors } from "@agentos/shared";
import {
  getPerson,
  getPhaseModuleById,
  getProject,
  listLaunches,
  listPhaseModules,
  previewLaunch,
  type AgentosDb,
  type ModuleLaunch,
  type PhaseModule,
} from "@agentos/db";
import { launchModuleWithEvents, nextPhaseStatus, phaseClosureStatus } from "@agentos/core";
import type { ApiContext } from "../context.js";
import { parse } from "../http-errors.js";

const PreviewBody = z.object({
  inputs: z.record(z.string(), z.unknown()).default({}),
  toggles: z.record(z.string(), z.boolean()).optional(),
  /** Cadencias que el humano confirmó en el wizard (CA-M3.4 — M6a). */
  cadences_confirmed: z.array(z.string().min(1)).optional(),
  version: z.number().int().positive().optional(),
});

const LaunchBody = z.object({
  inputs: z.record(z.string(), z.unknown()),
  toggles: z.record(z.string(), z.boolean()).optional(),
  /** Cadencias que el humano confirmó en el wizard (CA-M3.4 — M6a). */
  cadences_confirmed: z.array(z.string().min(1)).optional(),
  idempotency_key: z.string().min(1).max(200),
  version: z.number().int().positive().optional(),
  /** Org destino explícita; sin ella se usa el input `empresa` como nombre. */
  org: z
    .object({
      org_id: z.string().min(1).optional(),
      name: z.string().min(1).optional(),
    })
    .optional(),
  /** Encadenado US-M3: el launch cae sobre el proyecto de este launch anterior. */
  previous_launch_id: z.string().optional(),
});

/** Resumen liviano para la lista del wizard. */
function moduleSummary(m: PhaseModule): Record<string, unknown> {
  return {
    slug: m.slug,
    version: m.version,
    name: m.name,
    phase: m.phase,
    project_type: m.projectType,
    status: m.status,
    methodology: { slug: m.methodologySlug, version: m.methodologyVersion },
    templates_count: m.blueprint.templates.length,
    blueprint_hash: m.blueprintHash,
  };
}

/** Recibo con nombre de persona resuelto (CA-M2.4: "... por Ernesto"). */
function launchReceipt(db: AgentosDb, launch: ModuleLaunch): Record<string, unknown> {
  let actorName: string | null = null;
  if (launch.actor.startsWith("person:")) {
    actorName = getPerson(db, launch.actor.slice("person:".length))?.fullName ?? null;
  }
  const moduleName = getPhaseModuleById(db, launch.moduleId)?.name ?? launch.moduleSlug;
  return {
    id: launch.id,
    module_slug: launch.moduleSlug,
    module_version: launch.moduleVersion,
    module_name: moduleName,
    phase: launch.phase,
    org_id: launch.orgId,
    project_id: launch.projectId,
    inputs: launch.inputs, // ya redactados en el recibo (§13.1)
    toggles: launch.toggles,
    task_count: launch.taskCount,
    budget_phase_usd: launch.budgetPhaseUsd,
    budget_per_run_usd: launch.budgetPerRunUsd,
    previous_launch_id: launch.previousLaunchId,
    actor: launch.actor,
    actor_name: actorName,
    label: `Disparado desde ${moduleName} v${launch.moduleVersion} por ${actorName ?? launch.actor}`,
    created_at: launch.createdAt,
  };
}

export function registerModuleRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const { db, sink } = ctx;

  // ── Catálogo para el wizard ───────────────────────────────────────────────

  app.get("/api/modules", async () => ({
    modules: listPhaseModules(db, { status: "active" }).map(moduleSummary),
  }));

  app.get("/api/modules/:slug", async (req) => {
    const { slug } = req.params as { slug: string };
    const module = listPhaseModules(db, { slug, status: "active" })[0];
    if (!module) throw errors.notFound("phase_module(active)", slug);
    const bp = module.blueprint;
    return {
      module: {
        ...moduleSummary(module),
        // Lo que el formulario necesita para pintarse y validar en vivo:
        inputs: bp.inputs,
        toggles: bp.toggles ?? [],
        budget: bp.budget,
        project: bp.project,
        body_md: module.bodyMd,
      },
    };
  });

  // ── Preview (dry-run CA-M2.1) ─────────────────────────────────────────────

  /**
   * Con inputs incompletos responde 200 {ok:false, missing, issues} — el wizard
   * deshabilita "Disparar" y lista los campos faltantes; no es un error HTTP.
   */
  app.post("/api/modules/:slug/preview", async (req) => {
    const { slug } = req.params as { slug: string };
    const body = parse(PreviewBody, req.body);
    return previewLaunch(db, {
      moduleSlug: slug,
      ...(body.version !== undefined ? { moduleVersion: body.version } : {}),
      inputs: body.inputs,
      ...(body.toggles ? { toggles: body.toggles } : {}),
      ...(body.cadences_confirmed ? { cadencesConfirmed: body.cadences_confirmed } : {}),
    });
  });

  // ── Launch (CA-M2.2 — disparar es siempre humano) ─────────────────────────

  app.post("/api/modules/:slug/launch", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const body = parse(LaunchBody, req.body);
    // Org: explícita, o get-or-create por el input `empresa` (el flujo del wizard).
    let org: { orgId: string } | { name: string };
    if (body.org?.org_id) {
      org = { orgId: body.org.org_id };
    } else if (body.org?.name) {
      org = { name: body.org.name };
    } else {
      const empresa = body.inputs["empresa"];
      if (typeof empresa !== "string" || empresa.trim() === "") {
        throw errors.validation(
          "launch: falta la organización destino (org.org_id, org.name o el input `empresa`)",
        );
      }
      org = { name: empresa.trim() };
    }
    // Actor = persona de la SESIÓN logueada (PRD §6: disparar es siempre humano).
    const result = launchModuleWithEvents(db, sink, {
      moduleSlug: slug,
      ...(body.version !== undefined ? { moduleVersion: body.version } : {}),
      org,
      inputs: body.inputs,
      ...(body.toggles ? { toggles: body.toggles } : {}),
      ...(body.cadences_confirmed ? { cadencesConfirmed: body.cadences_confirmed } : {}),
      actor: `person:${req.session!.personId}`,
      idempotencyKey: body.idempotency_key,
      ...(body.previous_launch_id ? { previousLaunchId: body.previous_launch_id } : {}),
    });
    reply.status(result.idempotent ? 200 : 201);
    return {
      launch: result.launch,
      project: result.project,
      organization: result.organization,
      tasks_count: result.tasks.length,
      idempotent: result.idempotent,
    };
  });

  // ── Recibos y cierre de fase por proyecto ─────────────────────────────────

  app.get("/api/projects/:id/launches", async (req) => {
    const { id } = req.params as { id: string };
    if (!getProject(db, id)) throw errors.notFound("project", id);
    return {
      launches: listLaunches(db, { projectId: id }).map((l) => launchReceipt(db, l)),
    };
  });

  app.get("/api/projects/:id/phase-status", async (req) => {
    const { id } = req.params as { id: string };
    return { status: phaseClosureStatus(db, id) };
  });

  /**
   * Encadenado US-M3 (CA-M3.2): con la fase cerrada (deliverables completos) Y
   * el gate del proyecto aprobado → {available:true, next_module, prefilled}
   * (el wizard pinta "Disparar Implementación/Operación" con los inputs
   * pre-llenados y pasa `previous_launch_id` al launch); si no →
   * {available:false, reason}. Cadena: ENTENDER→implementacion,
   * CONSTRUIR→operacion, OPERAR→null (módulo siguiente = el activo de esa fase).
   */
  app.get("/api/projects/:id/next-phase", async (req) => {
    const { id } = req.params as { id: string };
    return nextPhaseStatus(db, id);
  });
}
