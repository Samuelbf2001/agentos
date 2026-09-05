/**
 * Fuentes del proyecto (F2): sources.list / sources.ingest por el gateway
 * (política+audit) con conector WhatsAppHub SIEMPRE mock — ninguna llamada
 * real sale de los tests.
 */
import { describe, expect, it } from "vitest";
import {
  isAgentosError,
  ErrorCodes,
  SourceConnectorError,
  type WhatsAppHubConnector,
} from "@agentos/shared";
import {
  createAgent,
  createOrganization,
  createProject,
  createProjectSource,
  createRun,
  getDoc,
  getProjectSource,
  listDocs,
  openDb,
  queryAudit,
  runMigrations,
  type AgentosDb,
  type ProjectSource,
} from "@agentos/db";
import { createBoardEngine, recordingEventSink } from "@agentos/core";
import { createToolRuntime } from "../src/gateway.js";
import type { ToolCallContext, ToolRuntime } from "../src/types.js";

const MEETING_MD = `# Reunión: Kickoff ACME — 2026-08-20

**Participantes:** Ernesto (Sixteam), Gerente General (ACME)

## Resumen
Se acordó el alcance del assessment de 14 días y los accesos requeridos.

## Acuerdos
- ACME entrega el organigrama esta semana.
- Sixteam agenda 3 entrevistas de proceso.
`;

const DOSSIER_MD = `# Dossier: Gerente ACME

## Transcript reciente
[2026-08-19 10:02] Gerente: ¿Podemos mover la reunión al jueves?
[2026-08-19 10:05] Ernesto: Claro, jueves 10am queda confirmado.
`;

interface MockOpts {
  isInternal?: boolean;
  failMarkdown?: boolean;
  failDossier?: boolean;
  markdown?: string;
}

function mockConnector(opts: MockOpts = {}): WhatsAppHubConnector & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    isConfigured: () => true,
    async listMeetings() {
      calls.push("listMeetings");
      return { meetings: [{ id: "m-1", title: "Kickoff ACME", client: "ACME" }] };
    },
    async getMeeting(meetingId: string) {
      calls.push(`getMeeting:${meetingId}`);
      return {
        id: meetingId,
        title: "Kickoff ACME",
        client: "ACME",
        is_internal: opts.isInternal ?? false,
        recordingId: "rec-77",
      };
    },
    async getMeetingMarkdown(meetingId: string) {
      calls.push(`getMeetingMarkdown:${meetingId}`);
      if (opts.failMarkdown) {
        throw new SourceConnectorError("timeout", "WhatsAppHub no respondió en 8000 ms (mock)");
      }
      return opts.markdown ?? MEETING_MD;
    },
    async listContacts() {
      calls.push("listContacts");
      return [{ id: "c-9", name: "Gerente ACME", phone: "+58 412 000 0000" }];
    },
    async getDossierMarkdown(contactId: string) {
      calls.push(`getDossier:${contactId}`);
      if (opts.failDossier) {
        throw new SourceConnectorError("unreachable", "No se pudo conectar con WhatsAppHub (mock)");
      }
      return DOSSIER_MD;
    },
  };
}

interface Fx {
  db: AgentosDb;
  runtime: ToolRuntime;
  projectId: string;
  ctx: ToolCallContext;
  denyCtx: ToolCallContext;
  connector: ReturnType<typeof mockConnector>;
}

async function fixture(opts: MockOpts = {}, withConnector = true): Promise<Fx> {
  const db = openDb(":memory:");
  runMigrations(db);
  const org = await createOrganization(db, { name: "ACME S.A.", kind: "client" });
  const project = await createProject(db, { orgId: org.id, name: "Assessment ACME", type: "assessment" });
  const sam = await createAgent(db, {
    slug: "sam",
    name: "Sam",
    layer: "consultoria",
    runtime: "ai_sdk",
    toolsAllowlist: ["sources.list", "sources.ingest", "knowledge.list"],
  });
  const quinn = await createAgent(db, {
    slug: "quinn",
    name: "Quinn",
    layer: "meta",
    runtime: "ai_sdk",
    toolsAllowlist: ["tasks.list"],
  });
  const run = await createRun(db, { trigger: "manual", runtime: "ai_sdk", agentId: sam.id });
  const sink = recordingEventSink();
  const engine = createBoardEngine({ db, sink });
  const connector = mockConnector(opts);
  const runtime = createToolRuntime({
    db,
    sink,
    engine,
    ...(withConnector ? { whatsappHub: connector } : {}),
  });
  const ctx: ToolCallContext = {
    run_id: run.id,
    agent_id: sam.id,
    task_id: null,
    project_id: project.id,
    actor: "agent:sam",
  };
  const denyCtx: ToolCallContext = { ...ctx, agent_id: quinn.id, actor: "agent:quinn" };
  return { db, runtime, projectId: project.id, ctx, denyCtx, connector };
}

async function linkMeeting(fx: Fx): Promise<ProjectSource> {
  return await createProjectSource(fx.db, {
    projectId: fx.projectId,
    kind: "meeting",
    externalRef: { system: "whatsapphub", meetingId: "m-1", title: "Kickoff ACME" },
    status: "linked",
    createdBy: "agent:sam",
  });
}

describe("sources.ingest (gateway)", () => {
  it("asociar→ingerir crea un doc tipado 'interview' con sourceRefs completos", async () => {
    const fx = await fixture({ isInternal: false });
    const source = await linkMeeting(fx);
    const res = await fx.runtime.execute(fx.ctx, "sources.ingest", { source_id: source.id });
    expect(res.status).toBe("ok");

    const after = (await getProjectSource(fx.db, source.id))!;
    expect(after.status).toBe("ingested");
    expect(after.knowledgeDocId).toBeTruthy();
    expect(after.lastIngestedAt).toBeTypeOf("number");
    expect(after.lastError).toBeNull();

    const doc = (await getDoc(fx.db, after.knowledgeDocId!))!;
    expect(doc.kind).toBe("interview"); // reunión con cliente (is_internal=false)
    expect(doc.projectId).toBe(fx.projectId);
    expect(doc.bodyMd).toContain("Kickoff ACME");
    const ref = doc.sourceRefs![0] as Record<string, unknown>;
    expect(ref.system).toBe("whatsapphub");
    expect(ref.meeting_id).toBe("m-1");
    expect(ref.project_source_id).toBe(source.id);
    // TODOS los ids de 2brain del detalle viajan en source_refs.
    expect((ref.ids as Record<string, unknown>).recordingId).toBe("rec-77");
  });

  it("reunión interna (is_internal=true) se ingesta como 'evidence'", async () => {
    const fx = await fixture({ isInternal: true });
    const source = await linkMeeting(fx);
    await fx.runtime.execute(fx.ctx, "sources.ingest", { source_id: source.id });
    const after = (await getProjectSource(fx.db, source.id))!;
    expect((await getDoc(fx.db, after.knowledgeDocId!))!.kind).toBe("evidence");
  });

  it("hilo de WhatsApp se ingesta como 'evidence' con contact_id en sourceRefs", async () => {
    const fx = await fixture();
    const source = await createProjectSource(fx.db, {
      projectId: fx.projectId,
      kind: "whatsapp_thread",
      externalRef: { system: "whatsapphub", contactId: "c-9", title: "Hilo Gerente ACME" },
      status: "linked",
    });
    await fx.runtime.execute(fx.ctx, "sources.ingest", { source_id: source.id });
    const after = (await getProjectSource(fx.db, source.id))!;
    const doc = (await getDoc(fx.db, after.knowledgeDocId!))!;
    expect(doc.kind).toBe("evidence");
    expect(doc.bodyMd).toContain("Transcript");
    expect((doc.sourceRefs![0] as Record<string, unknown>).contact_id).toBe("c-9");
  });

  it("re-ingerir actualiza el MISMO doc, no duplica", async () => {
    const fx = await fixture();
    const source = await linkMeeting(fx);
    await fx.runtime.execute(fx.ctx, "sources.ingest", { source_id: source.id });
    const docId1 = (await getProjectSource(fx.db, source.id))!.knowledgeDocId!;

    await fx.runtime.execute(fx.ctx, "sources.ingest", { source_id: source.id });
    const after = (await getProjectSource(fx.db, source.id))!;
    expect(after.knowledgeDocId).toBe(docId1);
    expect(await listDocs(fx.db, { projectId: fx.projectId })).toHaveLength(1);
  });

  it("fallo del conector → status 'error' legible SIN doc huérfano", async () => {
    const fx = await fixture({ failMarkdown: true });
    const source = await linkMeeting(fx);
    await expect(
      fx.runtime.execute(fx.ctx, "sources.ingest", { source_id: source.id }),
    ).rejects.toSatisfy((err) => isAgentosError(err, ErrorCodes.PROVIDER_ERROR));

    const after = (await getProjectSource(fx.db, source.id))!;
    expect(after.status).toBe("error");
    expect(after.lastError).toContain("no respondió");
    expect(after.knowledgeDocId).toBeNull();
    expect(await listDocs(fx.db, { projectId: fx.projectId })).toHaveLength(0);
    // La denegación/fallo deja huella en audit (segunda fila del gateway).
    const audit = await queryAudit(fx.db, { entityType: "tool" });
    expect(audit.some((a) => a.action === "tool.error" && a.entityId === "sources.ingest")).toBe(true);
  });

  it("sin conector configurado → provider_not_configured (falla legible, no cuelga)", async () => {
    const fx = await fixture({}, false);
    const source = await linkMeeting(fx);
    await expect(
      fx.runtime.execute(fx.ctx, "sources.ingest", { source_id: source.id }),
    ).rejects.toSatisfy((err) => isAgentosError(err, ErrorCodes.PROVIDER_NOT_CONFIGURED));
    // Falla ANTES de tocar la fuente: sigue 'linked' y reintentable al configurar.
    expect((await getProjectSource(fx.db, source.id))!.status).toBe("linked");
    expect(await listDocs(fx.db, { projectId: fx.projectId })).toHaveLength(0);
  });
});

describe("sources.list y política (gateway fail-closed)", () => {
  it("sources.list devuelve las fuentes del proyecto del run", async () => {
    const fx = await fixture();
    await linkMeeting(fx);
    const res = await fx.runtime.execute(fx.ctx, "sources.list", {});
    expect(res.status).toBe("ok");
    const rows = (res as { result: ProjectSource[] }).result;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("meeting");
  });

  it("agente sin sources.* en allowlist es rechazado (policy_denied)", async () => {
    const fx = await fixture();
    const source = await linkMeeting(fx);
    await expect(fx.runtime.execute(fx.denyCtx, "sources.list", {})).rejects.toSatisfy((err) =>
      isAgentosError(err, ErrorCodes.POLICY_DENIED),
    );
    await expect(
      fx.runtime.execute(fx.denyCtx, "sources.ingest", { source_id: source.id }),
    ).rejects.toSatisfy((err) => isAgentosError(err, ErrorCodes.POLICY_DENIED));
    expect((await getProjectSource(fx.db, source.id))!.status).toBe("linked");
  });
});
