import { describe, expect, it } from "vitest";
import { isAgentosError } from "@agentos/shared";
import { openDb, type AgentosDb } from "../src/client.js";
import { runMigrations } from "../src/migrate.js";
import {
  createOrganization,
  createPerson,
  getOrganizationByName,
  listInternalPeople,
} from "../src/repositories/organizations-people.js";
import { createProject, getProject, setGateState, updateProject } from "../src/repositories/projects.js";
import { upsertProviderProfile } from "../src/repositories/providers.js";
import {
  activatePromptVersion,
  createAgent,
  createPromptVersion,
  getActivePrompt,
  listPromptVersions,
  updateAgent,
} from "../src/repositories/agents.js";
import {
  attachArtifact,
  claimTask,
  countArtifacts,
  createTask,
  getTask,
  listArtifacts,
  reapExpiredLeases,
  renewLease,
} from "../src/repositories/tasks.js";
import { addSpan, createRun, endSpan, listRunsByRoot, listSpans, updateRun } from "../src/repositories/runs.js";
import { appendEvent, lastSeq, listEventsSince } from "../src/repositories/events.js";
import {
  appendMessage,
  buildSessionKey,
  getOrCreateThread,
  listMessages,
} from "../src/repositories/threads.js";
import {
  createApproval,
  decideApproval,
  digestPayload,
  getApproval,
  listPendingApprovals,
  verifyApprovalDigest,
} from "../src/repositories/approvals.js";
import { appendAudit, queryAudit } from "../src/repositories/audit.js";
import { createDoc, listDocs, searchDocs, upsertDoc } from "../src/repositories/knowledge.js";
import { createProcess, linkSource, listProcesses } from "../src/repositories/processes.js";
import { getMethodology, upsertMethodology } from "../src/repositories/methodologies.js";
import { getConfig, setConfig } from "../src/repositories/config.js";
import { searchMessages } from "../src/search.js";

function freshDb(): AgentosDb {
  const db = openDb(":memory:");
  runMigrations(db);
  return db;
}

/** Fixture mínima: org + proyecto + agente. */
function fixture(db: AgentosDb) {
  const org = createOrganization(db, { name: "Org Test", kind: "client" });
  const project = createProject(db, {
    orgId: org.id,
    name: "Proyecto Test",
    type: "assessment",
    stage: "ENTENDER",
  });
  const provider = upsertProviderProfile(db, {
    slug: "test_provider",
    name: "Test",
    kind: "openai_compatible",
    apiKeyEnv: "TEST_KEY",
  });
  const agent = createAgent(db, {
    slug: "tester",
    name: "Tester",
    layer: "meta",
    runtime: "ai_sdk",
    providerProfileId: provider.id,
    model: "test-1",
    toolsAllowlist: ["tasks.claim"],
    mcpAllowlist: [],
  });
  return { org, project, provider, agent };
}

describe("round-trip por repositorio", () => {
  it("organizations/people", () => {
    const db = freshDb();
    const org = createOrganization(db, {
      name: "ACME Test",
      kind: "client",
      industry: "manufactura",
      employeeCount: 40,
    });
    expect(getOrganizationByName(db, "ACME Test")?.id).toBe(org.id);
    createPerson(db, { orgId: org.id, fullName: "Ana Prueba", isInternal: true });
    createPerson(db, { orgId: org.id, fullName: "Luis Externo", isInternal: false });
    expect(listInternalPeople(db, org.id)).toHaveLength(1);
  });

  it("projects: update versionado y gate", () => {
    const db = freshDb();
    const { project } = fixture(db);
    const updated = updateProject(db, project.id, { stage: "CONSTRUIR" }, project.version);
    expect(updated.version).toBe(project.version + 1);
    const gated = setGateState(db, project.id, "approved", updated.version);
    expect(gated.gateState).toBe("approved");
    expect(getProject(db, project.id)?.version).toBe(project.version + 2);
  });

  it("projects: expected_version incorrecta falla explícitamente (no last-write-wins)", () => {
    const db = freshDb();
    const { project } = fixture(db);
    try {
      updateProject(db, project.id, { name: "X" }, 999);
      expect.unreachable("debió lanzar version_conflict");
    } catch (err) {
      expect(isAgentosError(err, "version_conflict")).toBe(true);
    }
  });

  it("agents + prompt_versions: editar crea versión, rollback reactiva", () => {
    const db = freshDb();
    const { agent } = fixture(db);
    const v1 = createPromptVersion(db, { agentId: agent.id, stable: "v1 stable" });
    const v2 = createPromptVersion(db, { agentId: agent.id, stable: "v2 stable" });
    expect(v2.version).toBe(2);
    expect(getActivePrompt(db, agent.id)?.id).toBe(v2.id);
    activatePromptVersion(db, agent.id, v1.id); // rollback
    expect(getActivePrompt(db, agent.id)?.id).toBe(v1.id);
    expect(listPromptVersions(db, agent.id)).toHaveLength(2);
  });

  it("agents: optimistic locking", () => {
    const db = freshDb();
    const { agent } = fixture(db);
    updateAgent(db, agent.id, { model: "test-2" }, agent.version);
    try {
      updateAgent(db, agent.id, { model: "test-3" }, agent.version); // versión ya vieja
      expect.unreachable("debió lanzar version_conflict");
    } catch (err) {
      expect(isAgentosError(err, "version_conflict")).toBe(true);
    }
  });

  it("runs/spans: root_run_id desnormalizado y árbol sin recursión", () => {
    const db = freshDb();
    const { agent, project } = fixture(db);
    const root = createRun(db, {
      agentId: agent.id,
      projectId: project.id,
      trigger: "chat",
      runtime: "ai_sdk",
    });
    expect(root.rootRunId).toBe(root.id);
    const child = createRun(db, {
      parentRunId: root.id,
      agentId: agent.id,
      trigger: "dispatcher",
      runtime: "ai_sdk",
    });
    expect(child.rootRunId).toBe(root.id);
    expect(listRunsByRoot(db, root.id)).toHaveLength(2);

    const span = addSpan(db, { runId: root.id, name: "llm.call", kind: "llm", attrs: { "gen_ai.request.model": "test-1" } });
    endSpan(db, span.id, { status: "ok" });
    expect(listSpans(db, root.id)[0]?.endedAt).toBeTruthy();

    const done = updateRun(db, root.id, { status: "succeeded", tokensIn: 100, costUsd: 0.01 });
    expect(done.status).toBe("succeeded");
    expect(done.tokensOut).toBeNull(); // null = no reportado, nunca cero inferido
  });

  it("events: seq monotónico por topic y resume por since_seq", () => {
    const db = freshDb();
    appendEvent(db, { topic: "swarm", type: "RUN_STARTED" });
    appendEvent(db, { topic: "swarm", type: "RUN_FINISHED" });
    appendEvent(db, { topic: "approvals", type: "STATE_SNAPSHOT" });
    expect(lastSeq(db, "swarm")).toBe(2);
    expect(lastSeq(db, "approvals")).toBe(1);
    const gap = listEventsSince(db, "swarm", 1);
    expect(gap).toHaveLength(1);
    expect(gap[0]?.type).toBe("RUN_FINISHED");
  });

  it("knowledge: docs tipados + búsqueda FTS", () => {
    const db = freshDb();
    const { org, project } = fixture(db);
    const doc = createDoc(db, {
      orgId: org.id,
      projectId: project.id,
      kind: "interview",
      title: "Entrevista con gerencia",
      bodyMd: "La facturación se retrasa por aprobaciones manuales en papel.",
      sourceRefs: [{ type: "interview", who: "Gerente General" }],
      tags: ["facturacion"],
    });
    upsertDoc(db, { id: doc.id, kind: "interview", title: doc.title, bodyMd: doc.bodyMd + " (rev)" });
    expect(listDocs(db, { kind: "interview" })).toHaveLength(1);
    const hits = searchDocs(db, "facturación");
    expect(hits.some((h) => h.id === doc.id)).toBe(true);
  });

  it("processes: entidad de primera clase con provenance", () => {
    const db = freshDb();
    const { org } = fixture(db);
    const doc = createDoc(db, { orgId: org.id, kind: "interview", title: "Fuente", bodyMd: "..." });
    const proc = createProcess(db, {
      orgId: org.id,
      name: "Facturación",
      variant: "as_is",
      steps: [{ step: "Emitir factura", responsible: "Admin", system: "ERP" }],
      systems: ["ERP"],
      painPoints: ["Aprobación en papel"],
      status: "draft",
    });
    const linked = linkSource(db, proc.id, doc.id);
    expect(linked.sourceDocIds).toEqual([doc.id]);
    expect(listProcesses(db, org.id)).toHaveLength(1);
  });

  it("methodologies: versionado por (slug, version) y última versión", () => {
    const db = freshDb();
    upsertMethodology(db, { slug: "m-test", version: 1, bodyMd: "v1" });
    upsertMethodology(db, { slug: "m-test", version: 2, bodyMd: "v2" });
    upsertMethodology(db, { slug: "m-test", version: 2, bodyMd: "v2 corregida" }); // refresh, no duplica
    expect(getMethodology(db, "m-test")?.bodyMd).toBe("v2 corregida");
    expect(getMethodology(db, "m-test", 1)?.bodyMd).toBe("v1");
  });

  it("audit: append-only con before/after", () => {
    const db = freshDb();
    appendAudit(db, {
      actor: "person:ernesto",
      source: "mcp",
      action: "task.move",
      entityType: "task",
      entityId: "t1",
      before: { status: "READY" },
      after: { status: "IN_PROGRESS" },
      reason: "test",
    });
    const rows = queryAudit(db, { entityType: "task", entityId: "t1" });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.before).toEqual({ status: "READY" });
  });

  it("config: round-trip", () => {
    const db = freshDb();
    setConfig(db, "kill_switch", true);
    setConfig(db, "kill_switch", false);
    expect(getConfig(db, "kill_switch")).toBe(false);
  });
});

describe("unicidad e idempotencia", () => {
  it("threads.session_key es única y getOrCreateThread no duplica", () => {
    const db = freshDb();
    const key = buildSessionKey("web", "chat-1");
    const t1 = getOrCreateThread(db, { channel: "web", sessionKey: key });
    const t2 = getOrCreateThread(db, { channel: "web", sessionKey: key });
    expect(t2.id).toBe(t1.id);
    expect(() =>
      db.$client
        .prepare(`INSERT INTO threads (id, channel, session_key, created_at, updated_at) VALUES ('x', 'web', ?, 0, 0)`)
        .run(key),
    ).toThrow(/UNIQUE/);
  });

  it("messages: misma idempotency_key no duplica (CA-1.5)", () => {
    const db = freshDb();
    const t = getOrCreateThread(db, { channel: "web", sessionKey: buildSessionKey("web", "c1") });
    const r1 = appendMessage(db, {
      threadId: t.id,
      role: "user",
      content: "Arranca un assessment para ACME",
      idempotencyKey: "msg-001",
    });
    const r2 = appendMessage(db, {
      threadId: t.id,
      role: "user",
      content: "Arranca un assessment para ACME",
      idempotencyKey: "msg-001",
    });
    expect(r1.inserted).toBe(true);
    expect(r2.inserted).toBe(false);
    expect(r2.message.id).toBe(r1.message.id);
    expect(listMessages(db, t.id)).toHaveLength(1);
    // el índice único también protege a nivel SQL
    expect(() =>
      db.$client
        .prepare(
          `INSERT INTO messages (id, thread_id, role, content, idempotency_key, created_at) VALUES ('y', ?, 'user', 'dup', 'msg-001', 0)`,
        )
        .run(t.id),
    ).toThrow(/UNIQUE/);
  });

  it("messages_fts se mantiene por triggers espejo", () => {
    const db = freshDb();
    const t = getOrCreateThread(db, { channel: "web", sessionKey: buildSessionKey("web", "c2") });
    appendMessage(db, { threadId: t.id, role: "user", content: "quiero certificarme en ISO 9001" });
    const hits = searchMessages(db, "9001");
    expect(hits).toHaveLength(1);
  });

  it("approvals: digest literal + unicidad (digest, run) + invalidación por cambio de args", () => {
    const db = freshDb();
    const { agent, project } = fixture(db);
    const run = createRun(db, { agentId: agent.id, projectId: project.id, trigger: "chat", runtime: "ai_sdk" });
    const payload = { tool: "email.send", args: { to: "cliente@acme.com", subject: "Informe" } };
    const approval = createApproval(db, { kind: "tool_call", runId: run.id, payload, requestedBy: "agent:sally" });
    expect(approval.status).toBe("pending");
    expect(approval.actionDigest).toBe(digestPayload(payload));
    // mismo payload, mismo run → violación del unique
    expect(() =>
      createApproval(db, { kind: "tool_call", runId: run.id, payload, requestedBy: "agent:sally" }),
    ).toThrow(/UNIQUE/);
    // cambiar argumentos invalida la aprobación (digest distinto)
    expect(verifyApprovalDigest(approval, payload)).toBe(true);
    expect(
      verifyApprovalDigest(approval, { ...payload, args: { ...payload.args, to: "otro@x.com" } }),
    ).toBe(false);
    // decisión
    const org2 = createOrganization(db, { name: "Sixteam T", kind: "internal" });
    const person = createPerson(db, { orgId: org2.id, fullName: "Ernesto T", isInternal: true });
    const decided = decideApproval(db, approval.id, { status: "approved", decidedByPersonId: person.id });
    expect(decided.status).toBe("approved");
    expect(decided.decidedAt).toBeTruthy();
    expect(listPendingApprovals(db)).toHaveLength(0);
  });

  it("decideApproval es atómico: la segunda decisión falla con conflict (no last-write-wins)", () => {
    const db = freshDb();
    const { agent, project } = fixture(db);
    const run = createRun(db, { agentId: agent.id, projectId: project.id, trigger: "chat", runtime: "ai_sdk" });
    const org2 = createOrganization(db, { name: "Sixteam A", kind: "internal" });
    const person = createPerson(db, { orgId: org2.id, fullName: "Ernesto A", isInternal: true });
    const approval = createApproval(db, {
      kind: "tool_call",
      runId: run.id,
      payload: { tool: "email.send", args: { to: "cliente@acme.com" } },
      requestedBy: "agent:sally",
    });
    const first = decideApproval(db, approval.id, { status: "approved", decidedByPersonId: person.id });
    expect(first.status).toBe("approved");
    // Segunda decisión (p. ej. desde el otro proceso escritor) NO pisa la primera:
    // el UPDATE condicional (status='pending') deja changes=0 → conflict.
    expect(() =>
      decideApproval(db, approval.id, { status: "rejected", decidedByPersonId: person.id }),
    ).toThrow(/ya fue decidida/);
    // El estado quedó intacto: sigue 'approved', jamás sobrescrito a 'rejected'.
    expect(getApproval(db, approval.id)!.status).toBe("approved");
  });

  it("digestPayload es canónico (orden de claves irrelevante)", () => {
    expect(digestPayload({ a: 1, b: [1, 2], c: { d: "x" } })).toBe(
      digestPayload({ c: { d: "x" }, b: [1, 2], a: 1 }),
    );
    expect(digestPayload({ a: 1 })).not.toBe(digestPayload({ a: 2 }));
  });
});

describe("claim atómico a nivel SQL (patrón de B3, CA-3.2)", () => {
  function readyTask(db: AgentosDb) {
    const { project, agent } = fixture(db);
    const task = createTask(db, {
      projectId: project.id,
      title: "Tarea reclamable",
      definitionOfDone: "test",
      stage: "ENTENDER",
      status: "READY",
      orderKey: "a0",
      assigneeAgentId: agent.id,
    });
    return { db, task, agent, project };
  }

  it("segunda llamada al claim pierde la carrera: UPDATE condicional devuelve changes=0", () => {
    const db = freshDb();
    const { task, agent } = readyTask(db);
    const first = claimTask(db, { taskId: task.id, agentId: agent.slug });
    expect(first.claimed).toBe(true);
    expect(first.task?.status).toBe("IN_PROGRESS");
    expect(first.task?.leaseUntil).toBeGreaterThan(Date.now());
    expect(first.task?.attempts).toBe(1);

    const second = claimTask(db, { taskId: task.id, agentId: "otro" });
    expect(second.claimed).toBe(false); // {claimed:false} — carrera perdida
  });

  it("una tarea BACKLOG no es reclamable (READY es la única cola)", () => {
    const db = freshDb();
    const { project, agent } = fixture(db);
    const task = createTask(db, {
      projectId: project.id,
      title: "No lista",
      stage: "ENTENDER",
      status: "BACKLOG",
      orderKey: "a1",
    });
    expect(claimTask(db, { taskId: task.id, agentId: agent.slug }).claimed).toBe(false);
  });

  it("lease vencido: reaper devuelve a READY y con attempts>=3 bloquea como stuck", () => {
    const db = freshDb();
    const { task, agent } = readyTask(db);
    claimTask(db, { taskId: task.id, agentId: agent.slug });
    // latido funciona
    expect(renewLease(db, task.id)).toBe(true);
    // forzar lease vencido
    db.$client.prepare(`UPDATE tasks SET lease_until = 1 WHERE id = ?`).run(task.id);
    const r1 = reapExpiredLeases(db, 3);
    expect(r1.requeued).toEqual([task.id]);
    expect(getTask(db, task.id)?.status).toBe("READY");

    // reclamar y vencer dos veces más → attempts llega a 3 → BLOCKED stuck
    for (let i = 0; i < 2; i++) {
      expect(claimTask(db, { taskId: task.id, agentId: agent.slug }).claimed).toBe(true);
      db.$client.prepare(`UPDATE tasks SET lease_until = 1 WHERE id = ?`).run(task.id);
      reapExpiredLeases(db, 3);
    }
    const final = getTask(db, task.id)!;
    expect(final.attempts).toBe(3);
    expect(final.status).toBe("BLOCKED");
    expect(final.blockedReason).toBe("stuck");
  });

  it("artefactos: adjuntar y contar (base de la regla anti-teatro)", () => {
    const db = freshDb();
    const { task } = readyTask(db);
    expect(countArtifacts(db, task.id)).toBe(0);
    attachArtifact(db, { taskId: task.id, kind: "markdown", title: "Informe", content: "# hola" });
    expect(countArtifacts(db, task.id)).toBe(1);
    expect(listArtifacts(db, task.id)[0]?.title).toBe("Informe");
  });
});

describe("project_sources (Fuentes del proyecto, F2)", () => {
  it("crear/listar/actualizar y dedupe por referencia externa", async () => {
    const db = freshDb();
    const { project } = fixture(db);
    const { createProjectSource, findProjectSourceByExternalRef, listProjectSources, updateProjectSource } =
      await import("../src/repositories/project-sources.js");

    const meeting = createProjectSource(db, {
      projectId: project.id,
      kind: "meeting",
      externalRef: { system: "whatsapphub", meetingId: "m-1", title: "Kickoff ACME" },
      status: "linked",
      createdBy: "person:p1",
    });
    expect(meeting.status).toBe("linked");
    expect(meeting.externalRef.meetingId).toBe("m-1");

    const thread = createProjectSource(db, {
      projectId: project.id,
      kind: "whatsapp_thread",
      externalRef: { system: "whatsapphub", contactId: "c-9", title: "Hilo cliente" },
      status: "linked",
    });

    expect(listProjectSources(db, { projectId: project.id })).toHaveLength(2);
    expect(listProjectSources(db, { projectId: project.id, kind: "meeting" })).toHaveLength(1);

    // Dedupe: misma reunión → devuelve la existente; otro id → undefined.
    expect(
      findProjectSourceByExternalRef(db, project.id, "meeting", { meetingId: "m-1" })?.id,
    ).toBe(meeting.id);
    expect(findProjectSourceByExternalRef(db, project.id, "meeting", { meetingId: "m-2" })).toBeUndefined();
    expect(
      findProjectSourceByExternalRef(db, project.id, "whatsapp_thread", { contactId: "c-9" })?.id,
    ).toBe(thread.id);

    const updated = updateProjectSource(db, meeting.id, {
      status: "error",
      lastError: "VPS caído",
    });
    expect(updated.status).toBe("error");
    expect(updated.lastError).toBe("VPS caído");
    expect(listProjectSources(db, { projectId: project.id, status: "error" })).toHaveLength(1);
  });

  it("updateProjectSource de un id inexistente lanza not_found", async () => {
    const db = freshDb();
    const { updateProjectSource } = await import("../src/repositories/project-sources.js");
    expect(() => updateProjectSource(db, "no-existe", { status: "ingested" })).toThrowError(
      /project_source/,
    );
  });
});
