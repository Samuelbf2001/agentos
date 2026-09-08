/**
 * "Convertir en agente" (ARCHITECTURE §"convertir en agente"): un rol del
 * organigrama nace agente heredando su área, su jefe, las funciones elegidas
 * y los procesos en los que participa. Nace supervisado por defecto y como
 * asistente de quien ocupe el rol — nunca lo reemplaza sin que un humano lo
 * decida explícitamente.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { errors } from "@agentos/shared";
import {
  appendAudit,
  createAgent,
  createPromptVersion,
  getAgentBySlug,
  getOrgRole,
  getOrgUnit,
  getOrganization,
  getPerson,
  listProcesses,
  listRoleFunctions,
  listRolePeople,
  listRoleProcesses,
  resolveAgentProvider,
  updateOrgRole,
} from "@agentos/db";
import type { ApiContext } from "../context.js";
import { parse } from "../http-errors.js";

const RoleAgentBody = z.object({
  function_ids: z.array(z.string()),
  autonomy: z.enum(["manual", "supervised"]),
  activate: z.boolean(),
  tools_allowlist: z.array(z.string()),
  name: z.string().min(1).optional(),
});

/** minúsculas, sin acentos, guiones — ids de agente legibles (ARCHITECTURE §8). */
function slugify(input: string): string {
  const slug = input
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "agente";
}

export function registerRoleAgentRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const { db } = ctx;

  const personActor = (req: { session?: { personId: string } | undefined }): string =>
    `person:${req.session!.personId}`;

  app.post("/api/roles/:id/agent", async (req) => {
    const { id } = req.params as { id: string };
    const role = await getOrgRole(db, id);
    if (!role) throw errors.notFound("org_role", id);
    if (role.agentId) {
      throw errors.conflict(`El rol ya tiene un agente asignado: ${role.agentId}`, {
        roleId: role.id,
        agentId: role.agentId,
      });
    }
    const body = parse(RoleAgentBody, req.body);

    const org = await getOrganization(db, role.orgId);
    if (!org) throw errors.notFound("organization", role.orgId);

    // Slug único: nombre pedido (o del rol), con -2, -3... si colisiona.
    const baseSlug = slugify(body.name ?? role.name);
    let slug = baseSlug;
    let suffix = 2;
    while (await getAgentBySlug(db, slug)) {
      slug = `${baseSlug}-${suffix}`;
      suffix += 1;
    }

    const resolved = await resolveAgentProvider(db);

    // Cadena de mando: reporta al AGENTE del rol jefe, si ya lo tiene.
    let reportsTo: string | null = null;
    if (role.reportsToRoleId) {
      const bossRole = await getOrgRole(db, role.reportsToRoleId);
      reportsTo = bossRole?.agentId ?? null;
    }

    const catalogNames = new Set(ctx.toolRuntime.catalog.keys());
    const toolsAllowlist = body.tools_allowlist.filter((t) => catalogNames.has(t));

    const agent = await createAgent(db, {
      slug,
      name: body.name ?? `Agente de ${role.name}`,
      layer: "operacion",
      runtime: resolved.runtime,
      providerProfileId: resolved.profile.id,
      model: resolved.model,
      toolsAllowlist,
      mcpAllowlist: [],
      autonomy: body.autonomy,
      status: body.activate ? "active" : "paused",
      reportsTo,
    });

    // ── Prompt v1: hereda propósito, funciones elegidas, procesos y personas ──
    const allFunctions = await listRoleFunctions(db, role.id);
    const chosenFunctions = allFunctions.filter((f) => body.function_ids.includes(f.id));
    const functionsBlock =
      chosenFunctions.length > 0
        ? chosenFunctions.map((f) => `- ${f.name}`).join("\n")
        : "- (sin funciones asignadas todavía)";

    const orgProcesses = await listProcesses(db, role.orgId);
    const processById = new Map(orgProcesses.map((p) => [p.id, p]));
    const roleProcesses = await listRoleProcesses(db, role.id);
    const processesText = roleProcesses
      .map((rp) => {
        const process = processById.get(rp.processId);
        if (!process) return null;
        return `${process.name} (${rp.relation === "owner" ? "responsable" : "participa"})`;
      })
      .filter((x): x is string => Boolean(x));

    const rolePeople = await listRolePeople(db, role.id);
    const peopleNames: string[] = [];
    for (const rp of rolePeople) {
      const person = await getPerson(db, rp.personId);
      if (person) peopleNames.push(person.fullName);
    }

    const unit = role.unitId ? await getOrgUnit(db, role.unitId) : undefined;
    const bossRoleForPrompt = role.reportsToRoleId ? await getOrgRole(db, role.reportsToRoleId) : undefined;

    const stable =
      `Eres el agente del rol «${role.name}» en ${org.name}. ` +
      `Propósito: ${role.purpose ?? "no definido"}. ` +
      `Funciones que asumes:\n${functionsBlock}\n` +
      `Procesos en los que participas: ${
        processesText.length > 0 ? processesText.join(", ") : "ninguno registrado todavía"
      }. ` +
      `Trabajas como asistente de ${
        peopleNames.length > 0 ? peopleNames.join(", ") : "la persona que ocupe este rol"
      }: nunca reemplazas su criterio; todo lo que produces se entrega a revisión humana. ` +
      `Toda afirmación sobre el cliente cita [doc:id] del Context Hub o se marca como no verificada.`;

    const context =
      `Organización: ${org.name}. Rubro: ${org.industry ?? "no definido"}. ` +
      `Área: ${unit?.name ?? "sin área"}. Reporta a: ${bossRoleForPrompt?.name ?? "nadie (raíz)"}.`;

    const promptVersion = await createPromptVersion(db, {
      agentId: agent.id,
      stable,
      context,
      volatileTpl: null,
      changelog: `Creado desde el rol ${role.name} (convertir en agente)`,
      createdBy: personActor(req),
    });

    const updatedRole = await updateOrgRole(db, role.id, { agentId: agent.id });

    await appendAudit(db, {
      actor: personActor(req),
      source: "ui",
      action: "agent.create_from_role",
      entityType: "agent",
      entityId: agent.id,
      after: { slug: agent.slug, name: agent.name, roleId: role.id, autonomy: agent.autonomy, status: agent.status },
    });
    await appendAudit(db, {
      actor: personActor(req),
      source: "ui",
      action: "org_role.update",
      entityType: "org_role",
      entityId: role.id,
      before: { agentId: role.agentId },
      after: { agentId: updatedRole.agentId },
    });

    return { agent, role: updatedRole, prompt_version: promptVersion };
  });
}
