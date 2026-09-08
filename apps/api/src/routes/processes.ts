/**
 * Procesos mapeados del cliente (ARCHITECTURE §8b): entidad de primera clase
 * de organización (no de proyecto). CRUD desde la UI del Organigrama, con el
 * mismo camino de auditoría que el resto del grafo organizacional.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ProcessStatus, ProcessStep, ProcessVariant, errors } from "@agentos/shared";
import {
  appendAudit,
  deleteProcess,
  getOrganization,
  getProcess,
  upsertProcess,
} from "@agentos/db";
import type { ApiContext } from "../context.js";
import { parse } from "../http-errors.js";

const CreateProcessBody = z.object({
  name: z.string().min(1),
  variant: ProcessVariant.optional(),
  owner_person: z.string().optional(),
  steps: z.array(ProcessStep).optional(),
  systems: z.array(z.string()).optional(),
  pain_points: z.array(z.string()).optional(),
  iso_refs: z.array(z.string()).optional(),
});

const UpdateProcessBody = z.object({
  name: z.string().min(1).optional(),
  variant: ProcessVariant.optional(),
  owner_person: z.string().nullable().optional(),
  steps: z.array(ProcessStep).optional(),
  systems: z.array(z.string()).optional(),
  pain_points: z.array(z.string()).optional(),
  iso_refs: z.array(z.string()).optional(),
  status: ProcessStatus.optional(),
});

export function registerProcessRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const { db } = ctx;

  const personActor = (req: { session?: { personId: string } | undefined }): string =>
    `person:${req.session!.personId}`;

  app.post("/api/orgs/:orgId/processes", async (req) => {
    const { orgId } = req.params as { orgId: string };
    const org = await getOrganization(db, orgId);
    if (!org) throw errors.notFound("organization", orgId);
    const body = parse(CreateProcessBody, req.body);

    const process = await upsertProcess(db, {
      orgId,
      name: body.name,
      variant: body.variant ?? "as_is",
      ownerPerson: body.owner_person ?? null,
      steps: body.steps ?? null,
      systems: body.systems ?? null,
      painPoints: body.pain_points ?? null,
      isoRefs: body.iso_refs ?? null,
    });
    await appendAudit(db, {
      actor: personActor(req),
      source: "ui",
      action: "process.create",
      entityType: "process",
      entityId: process.id,
      after: { name: process.name, variant: process.variant },
    });
    return { process };
  });

  app.patch("/api/processes/:id", async (req) => {
    const { id } = req.params as { id: string };
    const before = await getProcess(db, id);
    if (!before) throw errors.notFound("process", id);
    const body = parse(UpdateProcessBody, req.body);

    const process = await upsertProcess(db, {
      id,
      orgId: before.orgId,
      name: body.name ?? before.name,
      variant: body.variant ?? before.variant,
      ownerPerson: body.owner_person !== undefined ? body.owner_person : before.ownerPerson,
      steps: body.steps !== undefined ? body.steps : before.steps,
      systems: body.systems !== undefined ? body.systems : before.systems,
      painPoints: body.pain_points !== undefined ? body.pain_points : before.painPoints,
      isoRefs: body.iso_refs !== undefined ? body.iso_refs : before.isoRefs,
      status: body.status ?? before.status,
    });
    await appendAudit(db, {
      actor: personActor(req),
      source: "ui",
      action: "process.update",
      entityType: "process",
      entityId: process.id,
      before: { name: before.name, variant: before.variant, status: before.status },
      after: { name: process.name, variant: process.variant, status: process.status },
    });
    return { process };
  });

  app.delete("/api/processes/:id", async (req) => {
    const { id } = req.params as { id: string };
    const before = await getProcess(db, id);
    if (!before) throw errors.notFound("process", id);
    await deleteProcess(db, id);
    await appendAudit(db, {
      actor: personActor(req),
      source: "ui",
      action: "process.delete",
      entityType: "process",
      entityId: id,
      before: { name: before.name },
    });
    return { ok: true };
  });
}
