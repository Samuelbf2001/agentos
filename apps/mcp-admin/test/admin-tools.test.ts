/**
 * Tests del MCP admin (B6): perfiles, prompts versionados, expected_version,
 * providers sin secretos, digest de approvals, máquina de estados, auditoría,
 * kill switch y health — sobre DB temporal migrada + seedeada.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  ConfigKeys,
  createPerson,
  getAgentBySlug,
  getConfig,
  getTask,
  listPromptVersions,
  queryAudit,
  type Agent,
  type Task,
} from "@agentos/db";
import { adminFixture, type AdminFixture } from "./helpers.js";

let f: AdminFixture;
beforeEach(async () => {
  f = await adminFixture();
});

async function alex(): Promise<Agent> {
  return (await getAgentBySlug(f.db, "alex"))!;
}

// ── Perfil ro ───────────────────────────────────────────────────────────────

describe("perfil ro", () => {
  it("rechaza toda mutación con read_only_profile", async () => {
    await expect(
      f.callRo("agentos.agents.set_status", {
        agent: "alex",
        status: "paused",
        expected_version: (await alex()).version,
      }),
    ).rejects.toMatchObject({ code: "read_only_profile" });
    // Y el agente no cambió (fail-closed de verdad).
    expect((await alex()).status).toBe("active");
  });

  it("rechaza system.pause_all y config.set en ro", async () => {
    await expect(f.callRo("agentos.system.pause_all", {})).rejects.toMatchObject({
      code: "read_only_profile",
    });
    await expect(
      f.callRo("agentos.config.set", { key: "agents_enabled", value: false }),
    ).rejects.toMatchObject({ code: "read_only_profile" });
  });

  it("permite las tools de lectura", async () => {
    const agents = (await f.callRo("agentos.agents.list")) as Agent[];
    expect(agents.length).toBeGreaterThanOrEqual(7);
    const health = (await f.callRo("agentos.system.health")) as { status: string };
    expect(health.status).toBe("ok");
  });
});

// ── Agentes y prompts ───────────────────────────────────────────────────────

describe("agents.update", () => {
  it("actualizar el prompt CREA prompt_version y la activa (nunca sobrescribe)", async () => {
    const before = (await alex());
    const versionsBefore = await listPromptVersions(f.db, before.id);
    const result = (await f.call("agentos.agents.update", {
      agent: "alex",
      expected_version: before.version,
      prompt: { stable: "Identidad nueva de Alex.", changelog: "test B6" },
      reason: "prueba de versionado",
    })) as { agent: Agent; prompt_version: { id: string; version: number } };

    const versionsAfter = await listPromptVersions(f.db, before.id);
    expect(versionsAfter.length).toBe(versionsBefore.length + 1);
    expect(result.prompt_version.version).toBe(versionsBefore.length + 1);
    expect(result.agent.activePromptVersionId).toBe(result.prompt_version.id);
    // La versión anterior sigue intacta.
    const v1 = versionsAfter.find((v) => v.version === 1)!;
    expect(v1.stable).toBe(versionsBefore.find((v) => v.version === 1)!.stable);
  });

  it("respeta expected_version: conflicto explícito, no last-write-wins", async () => {
    const stale = (await alex()).version;
    await f.call("agentos.agents.update", {
      agent: "alex",
      expected_version: stale,
      patch: { model: "claude-sonnet-4-5" },
    });
    await expect(
      f.call("agentos.agents.update", {
        agent: "alex",
        expected_version: stale, // versión vieja
        patch: { model: "otro-modelo" },
      }),
    ).rejects.toMatchObject({ code: "version_conflict" });
  });

  it("agents.create + clone con idempotency_key no duplican", async () => {
    const created = (await f.call("agentos.agents.create", {
      slug: "tester",
      name: "Tester",
      layer: "meta",
      runtime: "ai_sdk",
      prompt: { stable: "Eres Tester." },
      idempotency_key: "crea-tester-1",
    })) as { agent: Agent };
    const repeat = (await f.call("agentos.agents.create", {
      slug: "tester",
      name: "Tester",
      layer: "meta",
      runtime: "ai_sdk",
      idempotency_key: "crea-tester-1",
    })) as { agent: Agent; idempotent?: boolean };
    expect(repeat.idempotent).toBe(true);
    expect(repeat.agent.id).toBe(created.agent.id);

    const clone = (await f.call("agentos.agents.clone", {
      agent: "tester",
      new_slug: "tester-2",
    })) as { agent: Agent; prompt_version: { version: number } | null };
    expect(clone.agent.slug).toBe("tester-2");
    expect(clone.prompt_version?.version).toBe(1);
  });
});

describe("prompts", () => {
  it("diff unificado entre versiones y rollback en una llamada", async () => {
    await f.call("agentos.agents.update", {
      agent: "alex",
      expected_version: (await alex()).version,
      prompt: { stable: "LINEA-NUEVA-DE-PROMPT", changelog: "v2" },
    });
    const diff = (await f.call("agentos.prompts.diff", {
      agent: "alex",
      from_version: 1,
      to_version: 2,
    })) as { unified: string; identical: boolean };
    expect(diff.identical).toBe(false);
    expect(diff.unified).toContain("+LINEA-NUEVA-DE-PROMPT");
    expect(diff.unified).toContain("--- alex/prompt v1");

    const v1 = (await listPromptVersions(f.db, (await alex()).id)).find((v) => v.version === 1)!;
    const rolled = (await f.call("agentos.prompts.rollback", {
      agent: "alex",
      to_version: 1,
      expected_version: (await alex()).version,
      reason: "el v2 rompió el tono",
    })) as { agent: Agent };
    expect(rolled.agent.activePromptVersionId).toBe(v1.id);
    // Rollback auditado (CA-8.2).
    const audit = await queryAudit(f.db, { action: "prompts.rollback", entityId: (await alex()).id });
    expect(audit.length).toBe(1);
  });

  it("agents.test es DRY-RUN: ensambla 3 capas sin crear run ni llamar LLM", async () => {
    const result = (await f.call("agentos.agents.test", {
      agent: "alex",
      project_id: f.project.id,
    })) as { dry_run: boolean; layers: { stable: string; context: string; volatile: string }; full: string };
    expect(result.dry_run).toBe(true);
    expect(result.layers.stable.length).toBeGreaterThan(0);
    expect(result.layers.context).toContain("Assessment ACME");
    expect(result.full).toContain(result.layers.stable);
    const runs = (await f.call("agentos.runs.list", {})) as unknown[];
    expect(runs.length).toBe(0);
  });
});

// ── Providers ───────────────────────────────────────────────────────────────

describe("providers", () => {
  it("upsert rechaza un valor que parece clave real (sk-like)", async () => {
    await expect(
      f.call("agentos.providers.upsert", {
        slug: "kimi",
        name: "Kimi",
        kind: "openai_compatible",
        api_key_env: "sk-ant-api03-abcdef123456",
      }),
    ).rejects.toMatchObject({ code: "validation_error" });
    await expect(
      f.call("agentos.providers.upsert", {
        slug: "kimi",
        name: "Kimi",
        kind: "openai_compatible",
        api_key_env: "minúsculas-no-son-env-var",
      }),
    ).rejects.toMatchObject({ code: "validation_error" });
  });

  it("upsert acepta el NOMBRE de la env var y test devuelve configured sin valor", async () => {
    await f.call("agentos.providers.upsert", {
      slug: "kimi",
      name: "Kimi K2",
      kind: "openai_compatible",
      base_url: "https://api.moonshot.ai/v1",
      api_key_env: "KIMI_API_KEY",
    });
    const test = (await f.call("agentos.providers.test", { provider: "kimi" })) as Record<string, unknown>;
    expect(test.api_key_env).toBe("KIMI_API_KEY");
    expect(typeof test.configured).toBe("boolean");
    expect(JSON.stringify(test)).not.toContain("sk-");
    const sub = (await f.call("agentos.providers.test", {
      provider: "claude_subscription",
    })) as { configured: boolean };
    expect(sub.configured).toBe(true);
  });
});

// ── Approvals (Gate 2) ──────────────────────────────────────────────────────

describe("approvals.decide", () => {
  it("falla con digest inválido (payload alterado tras pedir aprobación)", async () => {
    const approval = await f.rw.engine.requestApproval({
      kind: "tool_call",
      payload: { tool: "email.send", args: { to: "cliente@acme.com" } },
    });
    // Alguien altera los argumentos por debajo: el digest ya no coincide.
    f.db.$client
      .prepare(`UPDATE approvals SET payload = ? WHERE id = ?`)
      .run(JSON.stringify({ tool: "email.send", args: { to: "atacante@evil.com" } }), approval.id);

    await expect(
      f.call("agentos.approvals.decide", {
        approval_id: approval.id,
        decision: "approved",
        person_id: f.person.id,
      }),
    ).rejects.toMatchObject({ code: "approval_invalidated" });
  });

  it("con digest válido devuelve el payload literal a ejecutar", async () => {
    const approval = await f.rw.engine.requestApproval({
      kind: "tool_call",
      payload: { tool: "email.send", args: { to: "cliente@acme.com" } },
    });
    const result = (await f.call("agentos.approvals.decide", {
      approval_id: approval.id,
      decision: "approved",
      person_id: f.person.id,
      note: "ok",
    })) as { approval: { status: string }; execute_payload: Record<string, unknown> };
    expect(result.approval.status).toBe("approved");
    expect(result.execute_payload).toEqual({ tool: "email.send", args: { to: "cliente@acme.com" } });
  });

  it("exige un person_id que exista", async () => {
    const approval = await f.rw.engine.requestApproval({
      kind: "deliverable",
      payload: { entregable: "informe" },
    });
    await expect(
      f.call("agentos.approvals.decide", {
        approval_id: approval.id,
        decision: "approved",
        person_id: "no-existe",
      }),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});

// ── Tablero ─────────────────────────────────────────────────────────────────

describe("tablero", () => {
  async function createTask(): Promise<Task> {
    const { task } = (await f.call("agentos.tasks.create", {
      project_id: f.project.id,
      title: "Tarea B6",
      stage: "ENTENDER",
      definition_of_done: "Todo verde",
      assignee_agent: "sam",
    })) as { task: Task };
    return task;
  }

  it("tasks.move ilegal devuelve el error de dominio del core", async () => {
    const task = await createTask();
    await expect(
      f.call("agentos.tasks.move", {
        task_id: task.id,
        to: "DONE", // BACKLOG→DONE no existe en la matriz para humanos
        expected_version: task.version,
      }),
    ).rejects.toMatchObject({ code: "invalid_transition" });
  });

  it("flujo humano completo: READY → IN_PROGRESS → REVIEW → reject → REVIEW → approve", async () => {
    let task = await createTask();
    const move = async (to: string, note?: string) => {
      task = (await getTask(f.db, task.id))!;
      return (await f.call("agentos.tasks.move", {
        task_id: task.id,
        to,
        expected_version: task.version,
        note,
      })) as Task;
    };
    await move("READY");
    await move("IN_PROGRESS");
    // Anti-teatro: REVIEW sin artefacto se rechaza.
    task = (await getTask(f.db, task.id))!;
    await expect(
      f.call("agentos.tasks.move", { task_id: task.id, to: "REVIEW", expected_version: task.version }),
    ).rejects.toMatchObject({ code: "missing_artifact" });
    await f.call("agentos.tasks.attach_artifact", {
      task_id: task.id,
      kind: "document",
      title: "Evidencia",
      content: "# listo",
    });
    await move("REVIEW");

    task = (await getTask(f.db, task.id))!;
    const rejected = (await f.call("agentos.tasks.reject", {
      task_id: task.id,
      expected_version: task.version,
      person_id: f.person.id,
      note: "Falta la sección de riesgos",
    })) as Task;
    expect(rejected.status).toBe("IN_PROGRESS");

    await move("REVIEW");
    task = (await getTask(f.db, task.id))!;
    const approved = (await f.call("agentos.tasks.approve", {
      task_id: task.id,
      expected_version: task.version,
      person_id: f.person.id,
    })) as Task;
    expect(approved.status).toBe("DONE");
  });

  it("tasks.create es idempotente con idempotency_key", async () => {
    const first = (await f.call("agentos.tasks.create", {
      project_id: f.project.id,
      title: "Única",
      stage: "ENTENDER",
      idempotency_key: "task-unica",
    })) as { task: Task };
    const second = (await f.call("agentos.tasks.create", {
      project_id: f.project.id,
      title: "Única",
      stage: "ENTENDER",
      idempotency_key: "task-unica",
    })) as { task: Task; idempotent?: boolean };
    expect(second.idempotent).toBe(true);
    expect(second.task.id).toBe(first.task.id);
  });

  it("board.get agrupa por stage × status y events.tail devuelve lo publicado", async () => {
    await createTask();
    const board = (await f.call("agentos.board.get", { project_id: f.project.id })) as {
      stages: Record<string, Record<string, unknown[]>>;
      total: number;
    };
    expect(board.total).toBeGreaterThanOrEqual(13); // 12 seed + 1 nuestra
    expect(Object.keys(board.stages)).toContain("ENTENDER");
    expect(board.stages.ENTENDER?.BACKLOG?.length).toBeGreaterThanOrEqual(1);

    const tail = (await f.call("agentos.events.tail", {
      topic: `board:${f.project.id}`,
      n: 10,
    })) as { last_seq: number; events: { type: string }[] };
    expect(tail.last_seq).toBeGreaterThanOrEqual(1);
    expect(tail.events.some((e) => e.type === "task.created")).toBe(true);
  });

  it("projects.set_gate aprueba G1 con person_id", async () => {
    const result = (await f.call("agentos.projects.set_gate", {
      project_id: f.project.id,
      person_id: f.person.id,
      note: "Diagnóstico y roadmap aprobados",
    })) as { project: { gateState: string } };
    expect(result.project.gateState).toBe("approved");
    const audit = await queryAudit(f.db, { action: "gate.approve", entityId: f.project.id });
    expect(audit.length).toBe(1);
  });
});

// ── Etiquetas y responsables múltiples ──────────────────────────────────────

describe("etiquetas y responsables múltiples", () => {
  // Las personas del seed (Ernesto, Sebastián…) cuelgan de la org interna
  // "Sixteam"; el proyecto demo "Assessment ACME" cuelga de la org cliente
  // "ACME S.A.". replaceTaskAssignees exige que responsable y proyecto
  // compartan organización, así que estos tests crean personas ad-hoc en la
  // org del proyecto en vez de reutilizar las del seed.
  async function makePerson(fullName: string) {
    return await createPerson(f.db, {
      orgId: f.project.orgId,
      fullName,
      isInternal: false,
      role: "Cliente",
    });
  }

  it("tasks.create acepta due_at + assignee_person_ids + labels", async () => {
    const ana = await makePerson("Ana de prueba");
    const seb = await makePerson("Sebastián de prueba");
    const dueAtIso = "2026-12-01T10:00:00.000Z";
    const result = (await f.call("agentos.tasks.create", {
      project_id: f.project.id,
      title: "Tarea con metadatos",
      stage: "ENTENDER",
      assignee_person_ids: [ana.id, seb.id],
      primary_assignee_person_id: seb.id,
      due_at: dueAtIso,
      // Mayúsculas y duplicado para probar la normalización de replaceTaskLabels.
      labels: ["Cliente", "urgente", "cliente"],
    })) as {
      task: Task & { assignees?: { personId: string; isPrimary: boolean }[] };
      labels: string[];
    };
    expect(result.task.dueAt).toBe(Date.parse(dueAtIso));
    expect(result.task.assigneePersonId).toBe(seb.id);
    expect(result.task.assignees?.map((a) => a.personId).sort()).toEqual([ana.id, seb.id].sort());
    expect(result.task.assignees?.find((a) => a.isPrimary)?.personId).toBe(seb.id);
    expect(result.labels).toEqual(["cliente", "urgente"]);
  });

  it("tasks.list filtra por assignee_person_id (tabla puente)", async () => {
    const seb = await makePerson("Sebastián de prueba");
    const { task } = (await f.call("agentos.tasks.create", {
      project_id: f.project.id,
      title: "Tarea de Sebastián",
      stage: "ENTENDER",
      assignee_person_id: seb.id,
    })) as { task: Task };
    const rows = (await f.call("agentos.tasks.list", {
      project_id: f.project.id,
      assignee_person_id: seb.id,
    })) as (Task & { labels: string[] })[];
    expect(rows.some((r) => r.id === task.id)).toBe(true);
    expect(rows.every((r) => Array.isArray(r.labels))).toBe(true);
  });

  it("tasks.list filtra por label normalizada", async () => {
    await f.call("agentos.tasks.create", {
      project_id: f.project.id,
      title: "Con etiqueta",
      stage: "ENTENDER",
      labels: ["Facturación"],
    });
    await f.call("agentos.tasks.create", {
      project_id: f.project.id,
      title: "Sin esa etiqueta",
      stage: "ENTENDER",
      labels: ["otra"],
    });
    const rows = (await f.call("agentos.tasks.list", {
      project_id: f.project.id,
      // Entrada en mayúsculas: normalizeLabel debe igualarla a "facturación".
      label: "FACTURACIÓN",
    })) as { title: string; labels: string[] }[];
    expect(rows.length).toBe(1);
    expect(rows[0]!.title).toBe("Con etiqueta");
    expect(rows[0]!.labels).toEqual(["facturación"]);
  });

  it("tasks.update reemplaza el conjunto completo de etiquetas y actualiza due_at", async () => {
    const { task } = (await f.call("agentos.tasks.create", {
      project_id: f.project.id,
      title: "Tarea a reetiquetar",
      stage: "ENTENDER",
      labels: ["a", "b"],
    })) as { task: Task };
    const first = (await f.call("agentos.tasks.update", {
      task_id: task.id,
      expected_version: task.version,
      patch: { labels: ["c"] },
    })) as Task & { labels: string[] };
    // Reemplazo completo: "a" y "b" desaparecen, no se acumulan con "c".
    expect(first.labels).toEqual(["c"]);
    // Etiquetar no consume expected_version: sigue siendo la misma tras el patch.
    expect(first.version).toBe(task.version);

    const dueAtIso = "2026-11-15T00:00:00.000Z";
    const second = (await f.call("agentos.tasks.update", {
      task_id: task.id,
      expected_version: first.version,
      patch: { due_at: dueAtIso },
    })) as Task & { labels: string[] };
    expect(second.dueAt).toBe(Date.parse(dueAtIso));
    // El patch de due_at no tocó etiquetas: siguen igual que antes.
    expect(second.labels).toEqual(["c"]);
  });
});

// ── Auditoría ───────────────────────────────────────────────────────────────

describe("auditoría", () => {
  it("audit.query devuelve la mutación con before/after", async () => {
    const a = (await alex());
    await f.call("agentos.agents.set_status", {
      agent: "alex",
      status: "paused",
      expected_version: a.version,
      reason: "mantenimiento",
    });
    const rows = (await f.call("agentos.audit.query", {
      entity_type: "agent",
      entity_id: a.id,
      action: "agents.set_status",
    })) as { before: Record<string, unknown>; after: Record<string, unknown>; reason: string; source: string }[];
    expect(rows.length).toBe(1);
    expect(rows[0]!.before.status).toBe("active");
    expect(rows[0]!.after.status).toBe("paused");
    expect(rows[0]!.reason).toBe("mantenimiento");
    expect(rows[0]!.source).toBe("mcp");
  });

  it("audit.revert aplica el before como nueva mutación auditada", async () => {
    const a = (await alex());
    await f.call("agentos.agents.set_status", {
      agent: "alex",
      status: "paused",
      expected_version: a.version,
    });
    const [entry] = await queryAudit(f.db, { action: "agents.set_status", entityId: a.id });
    const result = (await f.call("agentos.audit.revert", {
      audit_id: entry!.id,
      reason: "falsa alarma",
    })) as { applied: Record<string, unknown> };
    expect(result.applied.status).toBe("active");
    expect((await alex()).status).toBe("active");
    const revertRows = await queryAudit(f.db, { action: "audit.revert", entityId: a.id });
    expect(revertRows.length).toBe(1);
  });
});

// ── Config / sistema ────────────────────────────────────────────────────────

describe("config y sistema", () => {
  it("system.pause_all cambia app_config y resume_all lo revierte", async () => {
    // El seed arranca seguro por defecto (kill switch activo); resume primero.
    await f.call("agentos.system.resume_all", {});
    expect(await getConfig(f.db, ConfigKeys.KILL_SWITCH)).toBe(false);
    await f.call("agentos.system.pause_all", { reason: "incidente" });
    expect(await getConfig(f.db, ConfigKeys.KILL_SWITCH)).toBe(true);
    expect(await f.rw.engine.isKillSwitchActive()).toBe(true);
    await f.call("agentos.system.resume_all", {});
    expect(await getConfig(f.db, ConfigKeys.KILL_SWITCH)).toBe(false);
  });

  it("config.set solo acepta claves permitidas", async () => {
    await f.call("agentos.config.set", { key: "agents_enabled", value: false });
    expect(await getConfig(f.db, "agents_enabled")).toBe(false);
    await expect(
      f.call("agentos.config.set", { key: "kill_switch", value: true }),
    ).rejects.toMatchObject({ code: "validation_error" });
    await expect(
      f.call("agentos.config.set", { key: "cualquier_cosa", value: 1 }),
    ).rejects.toMatchObject({ code: "validation_error" });
  });

  it("system.health reporta ok con conteos y DB", async () => {
    const health = (await f.call("agentos.system.health")) as Record<string, unknown>;
    expect(health.status).toBe("ok");
    expect(health.db_ok).toBe(true);
    expect(health.tables).toBeGreaterThanOrEqual(20);
    expect(health.agents).toBeGreaterThanOrEqual(7);
    // Seguro por defecto: un seed nuevo arranca con el kill switch ACTIVO.
    expect(health.kill_switch_active).toBe(true);
  });

  it("people.upsert actualiza por nombre y crea con org_id", async () => {
    const updated = (await f.call("agentos.people.upsert", {
      full_name: "Ernesto",
      role: "Operador jefe",
    })) as { person: { role: string }; created: boolean };
    expect(updated.created).toBe(false);
    expect(updated.person.role).toBe("Operador jefe");

    await expect(
      f.call("agentos.people.upsert", { full_name: "Persona Nueva" }),
    ).rejects.toMatchObject({ code: "validation_error" });
  });

  it("methodology.update crea versión nueva sin pisar la anterior", async () => {
    const result = (await f.call("agentos.methodology.update", {
      slug: "assessment-14d",
      body_md: "# Assessment v2\nNueva fase.",
      changelog: "v2 de prueba",
    })) as { methodology: { version: number }; previous_version: number };
    expect(result.methodology.version).toBe(result.previous_version + 1);
    const v1 = (await f.call("agentos.methodology.get", {
      slug: "assessment-14d",
      version: result.previous_version,
    })) as { bodyMd: string };
    expect(v1.bodyMd).not.toContain("Assessment v2");
  });

  it("tool desconocida → unknown_tool", async () => {
    await expect(f.call("agentos.no.existe", {})).rejects.toMatchObject({ code: "unknown_tool" });
  });
});
