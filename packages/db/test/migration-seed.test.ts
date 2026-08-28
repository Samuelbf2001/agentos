import { describe, expect, it } from "vitest";
import { openDb, type AgentosDb } from "../src/client.js";
import { runMigrations } from "../src/migrate.js";
import { countDomainTables, seed } from "../src/seed.js";
import { getAgentBySlug, getActivePrompt } from "../src/repositories/agents.js";
import { getProviderProfile } from "../src/repositories/providers.js";
import { getProjectByName } from "../src/repositories/projects.js";
import { listTasks, listTaskEvents } from "../src/repositories/tasks.js";
import { getConfig, ConfigKeys } from "../src/repositories/config.js";

function freshDb(): AgentosDb {
  const db = openDb(":memory:");
  runMigrations(db);
  return db;
}

const EXPECTED_TABLES = [
  "organizations",
  "people",
  "projects",
  "agents",
  "prompt_versions",
  "provider_profiles",
  "tasks",
  "task_events",
  "artifacts",
  "threads",
  "messages",
  "runs",
  "spans",
  "events",
  "approvals",
  "audit_log",
  "app_config",
  "knowledge_docs",
  "processes",
  "methodologies",
];

describe("migración desde cero", () => {
  it("crea exactamente las 20 tablas de dominio de ARCHITECTURE §5/§8b", () => {
    const db = freshDb();
    const names = (
      db.$client
        .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
        .all() as { name: string }[]
    ).map((r) => r.name);
    for (const t of EXPECTED_TABLES) expect(names, `falta tabla ${t}`).toContain(t);
    expect(countDomainTables(db)).toBe(20);
  });

  it("crea las tablas FTS5 espejo (messages_fts, knowledge_fts)", () => {
    const db = freshDb();
    const names = (
      db.$client
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%_fts'`)
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(names).toContain("messages_fts");
    expect(names).toContain("knowledge_fts");
  });

  it("aplica los pragmas obligatorios (WAL/memoria, foreign_keys ON)", () => {
    const db = freshDb();
    expect(db.$client.pragma("foreign_keys", { simple: true })).toBe(1);
    // En :memory: el journal es 'memory'; en fichero sería 'wal'.
    expect(["wal", "memory"]).toContain(db.$client.pragma("journal_mode", { simple: true }));
  });

  it("es idempotente (migrar dos veces no falla)", () => {
    const db = freshDb();
    expect(() => runMigrations(db)).not.toThrow();
    expect(countDomainTables(db)).toBe(20);
  });
});

describe("seeds", () => {
  it("carga los conteos esperados con CERO API keys (fallback de arranque)", () => {
    const db = freshDb();
    const counts = seed(db, { env: {} });
    expect(counts.organizations).toBe(2);
    expect(counts.people).toBe(5);
    expect(counts.providerProfiles).toBe(6);
    expect(counts.agents).toBe(7);
    expect(counts.promptVersions).toBe(7);
    expect(counts.methodologies).toBe(3); // assessment-14d, transform, ops (B7a)
    expect(counts.projects).toBe(1);
    expect(counts.tasks).toBe(12);
    expect(counts.tables).toBe(20);
    // ai_sdk sin credencial → claude_subscription/claude_code (ARCHITECTURE §3)
    expect([...counts.agentsFallback].sort()).toEqual(["alex", "clara", "sally", "sam"]);
    const alex = getAgentBySlug(db, "alex")!;
    expect(alex.runtime).toBe("claude_code");
    expect(getProviderProfile(db, alex.providerProfileId!)!.slug).toBe("claude_subscription");
    expect(getActivePrompt(db, alex.id)?.stable).toContain("Alex");
  });

  it("respeta la credencial configurada (sam queda en ai_sdk/openai con su modelo)", () => {
    const db = freshDb();
    const counts = seed(db, { env: { OPENAI_API_KEY: "sk-test" } });
    expect(counts.agentsFallback).not.toContain("sam");
    const sam = getAgentBySlug(db, "sam")!;
    expect(sam.runtime).toBe("ai_sdk");
    expect(sam.model).toBe("gpt-5");
    expect(getProviderProfile(db, sam.providerProfileId!)!.slug).toBe("openai");
  });

  // Fix H5: el fallback de arranque dejaba runtime claude_code con modelos que
  // el CLI de Claude no puede correr (gpt-5, kimi, MiniMax) → modelo y runtime
  // caen JUNTOS a la suscripción.
  it("fallback sin credencial: los modelos no-Anthropic caen a un alias Claude válido", () => {
    const db = freshDb();
    seed(db, { env: {} });
    for (const slug of ["sam", "sally", "clara"]) {
      const agent = getAgentBySlug(db, slug)!;
      expect(agent.runtime).toBe("claude_code");
      expect(agent.model).toBe("sonnet");
    }
    // alex ya venía con modelo Anthropic: se respeta.
    expect(getAgentBySlug(db, "alex")!.model).toBe("claude-sonnet-4-5");
    // Aparece la credencial → re-seed restaura el modelo declarado en el .md.
    seed(db, { env: { OPENAI_API_KEY: "sk-test" } });
    expect(getAgentBySlug(db, "sam")!.model).toBe("gpt-5");
  });

  it("es idempotente: re-ejecutar no duplica nada", () => {
    const db = freshDb();
    seed(db, { env: {} });
    const counts = seed(db, { env: {} });
    expect(counts.agents).toBe(7);
    expect(counts.tasks).toBe(12);
    expect(counts.people).toBe(5);
    expect(counts.promptVersions).toBe(7);
  });

  it("re-seed con cambio solo de proveedor no crea versiones de prompt redundantes", () => {
    const db = freshDb();
    seed(db, { env: {} });
    // Aparece la credencial de OpenAI: sam cambia de perfil (seed_hash efectivo
    // cambia) pero su prompt es idéntico → no debe nacer una versión nueva.
    const counts = seed(db, { env: { OPENAI_API_KEY: "sk-test" } });
    expect(counts.promptVersions).toBe(7);
  });

  it("proyecto demo: ENTENDER, gate pending, 3 READY + 9 BACKLOG, DoD y asignado en todas", () => {
    const db = freshDb();
    seed(db, { env: {} });
    const project = getProjectByName(db, "Assessment ACME")!;
    expect(project.type).toBe("assessment");
    expect(project.stage).toBe("ENTENDER");
    expect(project.gateState).toBe("pending");
    const tasks = listTasks(db, { projectId: project.id });
    expect(tasks).toHaveLength(12);
    expect(tasks.filter((t) => t.status === "READY")).toHaveLength(3);
    expect(tasks.filter((t) => t.status === "BACKLOG")).toHaveLength(9);
    for (const t of tasks) {
      expect(t.definitionOfDone, t.title).toBeTruthy();
      expect(t.assigneeAgentId, t.title).toBeTruthy();
      expect(listTaskEvents(db, t.id).length).toBeGreaterThan(0);
    }
    // Entregables de fase requieren aprobación (política determinista)
    expect(tasks.filter((t) => t.requiresApproval)).toHaveLength(2);
  });

  it("provider_profiles guardan NOMBRE de env var, jamás un valor", () => {
    const db = freshDb();
    seed(db, { env: { OPENAI_API_KEY: "sk-super-secreta" } });
    const raw = db.$client.prepare(`SELECT * FROM provider_profiles`).all();
    const dump = JSON.stringify(raw);
    expect(dump).not.toContain("sk-super-secreta");
    expect(dump).toContain("OPENAI_API_KEY");
  });

  it("config base: seguro por defecto (kill switch activo) y presupuestos definidos", () => {
    const db = freshDb();
    seed(db, { env: {} });
    // Arranque en frío PAUSADO: el despachador no dispara los runs de las tareas
    // READY del seed hasta que un humano haga resume_all.
    expect(getConfig(db, ConfigKeys.KILL_SWITCH)).toBe(true);
    expect(getConfig(db, ConfigKeys.BUDGET_MAX_COST_PER_RUN_USD)).toBe(2);
    expect(getConfig(db, ConfigKeys.BUDGET_MAX_COST_PER_DAY_USD)).toBe(10);
  });
});
