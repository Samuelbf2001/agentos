import { describe, expect, it } from "vitest";
import { openDb, type AgentosSqliteDb } from "../src/client.js";
import { runMigrations } from "../src/migrate.js";
import { seed, seedCatalog, seedDemo } from "../src/seed.js";
import { countDomainTables } from "../src/repositories/stats.js";
import { getAgentBySlug, getActivePrompt } from "../src/repositories/agents.js";
import { getProviderProfile } from "../src/repositories/providers.js";
import { getProjectByName } from "../src/repositories/projects.js";
import { listTasks, listTaskEvents } from "../src/repositories/tasks.js";
import { getConfig, ConfigKeys } from "../src/repositories/config.js";
import { getMethodology, listMethodologies } from "../src/repositories/methodologies.js";
import { listLaunches } from "../src/repositories/modules.js";
import {
  getOrganizationByName,
  getPersonByFullName,
  listOrganizations,
} from "../src/repositories/organizations-people.js";
import { listPhaseModules } from "../src/repositories/modules.js";
import { listProcesses } from "../src/repositories/processes.js";
import {
  getOrgRoleByName,
  listOrgRoles,
  listOrgUnits,
  listRoleFunctions,
  listRolePeople,
  listRoleProcesses,
} from "../src/repositories/org-graph.js";

function freshDb(): AgentosSqliteDb {
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
  "task_assignees",
  "task_notification_log",
  "task_labels",
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
  "project_sources",
  "phase_modules",
  "module_launches",
  "org_units",
  "org_roles",
  "role_functions",
  "role_people",
  "role_processes",
  "canvas_notes",
];

describe("migración desde cero", () => {
  it("crea exactamente las 37 tablas de dominio (§5/§8b + responsables, avisos, etiquetas, linaje de Notion, grafo organizacional y notas manuscritas)", () => {
    const db = freshDb();
    const names = (
      db.$client
        .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
        .all() as { name: string }[]
    ).map((r) => r.name);
    for (const t of EXPECTED_TABLES) expect(names, `falta tabla ${t}`).toContain(t);
    expect(countDomainTables(db)).toBe(37);
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
    expect(countDomainTables(db)).toBe(37);
  });
});

describe("seeds", () => {
  it("carga los conteos esperados con CERO API keys (fallback de arranque)", async () => {
    const db = freshDb();
    const counts = await seed(db, { env: {} });
    expect(counts.organizations).toBe(2);
    expect(counts.people).toBe(9);
    expect(counts.providerProfiles).toBe(6);
    expect(counts.agents).toBe(7);
    expect(counts.promptVersions).toBe(7);
    expect(counts.methodologies).toBe(5); // assessment-14d, transform, ops + iso9001-prep, iso9001-clausulas (F2-3)
    expect(counts.phaseModules).toBe(3); // consultoria, implementacion, operacion (§13 CA-M1.1)
    expect(counts.projects).toBe(1);
    expect(counts.tasks).toBe(12);
    expect(counts.tables).toBe(37);
    // ai_sdk sin credencial → claude_subscription/claude_code (ARCHITECTURE §3)
    expect([...counts.agentsFallback].sort()).toEqual(["alex", "clara", "sally", "sam"]);
    const alex = getAgentBySlug(db, "alex")!;
    expect(alex.runtime).toBe("claude_code");
    expect(getProviderProfile(db, alex.providerProfileId!)!.slug).toBe("claude_subscription");
    expect(getActivePrompt(db, alex.id)?.stable).toContain("Alex");
  });

  it("respeta la credencial configurada (sam queda en ai_sdk/openai con su modelo)", async () => {
    const db = freshDb();
    const counts = await seed(db, { env: { OPENAI_API_KEY: "sk-test" } });
    expect(counts.agentsFallback).not.toContain("sam");
    const sam = getAgentBySlug(db, "sam")!;
    expect(sam.runtime).toBe("ai_sdk");
    expect(sam.model).toBe("gpt-5");
    expect(getProviderProfile(db, sam.providerProfileId!)!.slug).toBe("openai");
  });

  // Fix H5: el fallback de arranque dejaba runtime claude_code con modelos que
  // el CLI de Claude no puede correr (gpt-5, kimi, MiniMax) → modelo y runtime
  // caen JUNTOS a la suscripción.
  it("fallback sin credencial: los modelos no-Anthropic caen a un alias Claude válido", async () => {
    const db = freshDb();
    await seed(db, { env: {} });
    for (const slug of ["sam", "sally", "clara"]) {
      const agent = getAgentBySlug(db, slug)!;
      expect(agent.runtime).toBe("claude_code");
      expect(agent.model).toBe("sonnet");
    }
    // alex ya venía con modelo Anthropic: se respeta.
    expect(getAgentBySlug(db, "alex")!.model).toBe("claude-sonnet-4-5");
    // Aparece la credencial → re-seed restaura el modelo declarado en el .md.
    await seed(db, { env: { OPENAI_API_KEY: "sk-test" } });
    expect(getAgentBySlug(db, "sam")!.model).toBe("gpt-5");
  });

  it("es idempotente: re-ejecutar no duplica nada (ni el launch demo)", async () => {
    const db = freshDb();
    await seed(db, { env: {} });
    const counts = await seed(db, { env: {} });
    expect(counts.agents).toBe(7);
    expect(counts.tasks).toBe(12);
    expect(counts.people).toBe(9);
    expect(counts.promptVersions).toBe(7);
    // El launch demo (§13.6) tampoco se re-dispara: mismo proyecto, mismo recibo.
    expect(counts.projects).toBe(1);
    expect(
      (db.$client.prepare(`SELECT count(*) n FROM module_launches`).get() as { n: number }).n,
    ).toBe(1);
  });

  it("re-seed con cambio solo de proveedor no crea versiones de prompt redundantes", async () => {
    const db = freshDb();
    await seed(db, { env: {} });
    // Aparece la credencial de OpenAI: sam cambia de perfil (seed_hash efectivo
    // cambia) pero su prompt es idéntico → no debe nacer una versión nueva.
    const counts = await seed(db, { env: { OPENAI_API_KEY: "sk-test" } });
    expect(counts.promptVersions).toBe(7);
  });

  it("proyecto demo: ENTENDER, gate pending, 3 READY + 9 BACKLOG, DoD y asignado en todas", async () => {
    const db = freshDb();
    await seed(db, { env: {} });
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
    // 7 con requires_approval: el demo ahora es un launch real y aplica la
    // política determinista (computeRequiresApproval, NM-5) — org_profile,
    // process_map ×2, leak_analysis, iso_gap, report y roadmap. El seed
    // hardcodeado decía 2 y CONTRADECÍA esa política; §13.6 corrige el demo.
    expect(tasks.filter((t) => t.requiresApproval)).toHaveLength(7);
  });

  it("seed demo = launch de consultoria v1: recibo en module_launches (§13.6, CA-M2.4)", async () => {
    const db = freshDb();
    await seed(db, { env: {} });
    const project = getProjectByName(db, "Assessment ACME")!;
    const launches = listLaunches(db, { projectId: project.id });
    expect(launches).toHaveLength(1);
    const launch = launches[0]!;
    expect(launch.moduleSlug).toBe("consultoria");
    expect(launch.moduleVersion).toBe(1);
    expect(launch.actor).toBe("system:seed");
    expect(launch.idempotencyKey).toBe("seed:demo:consultoria:acme");
    expect(launch.taskCount).toBe(12);
    // Las 3 READY del §13.6 con su asignado histórico: kickoff/alex,
    // perfil_org/sam, inventario_sistemas/clara.
    const tasks = listTasks(db, { projectId: project.id });
    const assignee = (activityType: string) => {
      const t = tasks.find((x) => x.activityType === activityType)!;
      expect(t.status, activityType).toBe("READY");
      return t.assigneeAgentId;
    };
    expect(assignee("kickoff")).toBe(getAgentBySlug(db, "alex")!.id);
    expect(assignee("org_profile")).toBe(getAgentBySlug(db, "sam")!.id);
    expect(assignee("systems_inventory")).toBe(getAgentBySlug(db, "clara")!.id);
  });

  it("las tareas del demo llevan depends_on coherente (ids reales, CA-M2.3)", async () => {
    const db = freshDb();
    await seed(db, { env: {} });
    const project = getProjectByName(db, "Assessment ACME")!;
    const tasks = listTasks(db, { projectId: project.id });
    // Las 3 entrevistas dependen del id del kickoff.
    const kickoff = tasks.find((t) => t.activityType === "kickoff")!;
    const entrevistas = tasks.filter((t) => t.activityType === "interview");
    expect(entrevistas).toHaveLength(3);
    for (const t of entrevistas) expect(t.dependsOn, t.title).toEqual([kickoff.id]);
    // El roadmap cierra la cadena: depende del informe.
    const informe = tasks.find((t) => t.activityType === "report")!;
    const roadmap = tasks.find((t) => t.activityType === "roadmap")!;
    expect(roadmap.dependsOn).toEqual([informe.id]);
    // Las READY nacen sin dependencias (por eso son READY — CA-M2.3).
    for (const t of tasks.filter((x) => x.status === "READY")) {
      expect(t.dependsOn, t.title).toEqual([]);
    }
  });

  it("provider_profiles guardan NOMBRE de env var, jamás un valor", async () => {
    const db = freshDb();
    await seed(db, { env: { OPENAI_API_KEY: "sk-super-secreta" } });
    const raw = db.$client.prepare(`SELECT * FROM provider_profiles`).all();
    const dump = JSON.stringify(raw);
    expect(dump).not.toContain("sk-super-secreta");
    expect(dump).toContain("OPENAI_API_KEY");
  });

  it("jerarquía de mando: Alex y Quinn raíces; el resto reporta a Alex", async () => {
    const db = freshDb();
    await seed(db, { env: {} });
    const alex = getAgentBySlug(db, "alex")!;
    const quinn = getAgentBySlug(db, "quinn")!;
    // Alex = raíz operacional; Quinn = raíz meta/QA (independencia del auditor).
    expect(alex.reportsTo).toBeNull();
    expect(quinn.reportsTo).toBeNull();
    // Los especialistas reportan a Alex.
    for (const slug of ["sam", "debbie", "vinnie", "sally", "clara"]) {
      expect(getAgentBySlug(db, slug)!.reportsTo, slug).toBe(alex.id);
    }
  });

  it("jerarquía: re-seed es idempotente (no re-escribe reports_to ya correcto)", async () => {
    const db = freshDb();
    await seed(db, { env: {} });
    const samV1 = getAgentBySlug(db, "sam")!.version;
    await seed(db, { env: {} });
    // reports_to ya correcto → la segunda pasada no bombea la versión del agente.
    expect(getAgentBySlug(db, "sam")!.version).toBe(samV1);
  });

  it("Fuentes del proyecto (F2): el re-seed aplica sources.list/ingest a alex y sam", async () => {
    const db = freshDb();
    await seed(db, { env: {} });
    for (const slug of ["alex", "sam"]) {
      const agent = getAgentBySlug(db, slug)!;
      expect(agent.toolsAllowlist, slug).toContain("sources.list");
      expect(agent.toolsAllowlist, slug).toContain("sources.ingest");
    }
    // Re-seed idempotente: la allowlist se mantiene sin duplicar ni bombear versión.
    const samV1 = getAgentBySlug(db, "sam")!.version;
    await seed(db, { env: {} });
    const sam = getAgentBySlug(db, "sam")!;
    expect(sam.version).toBe(samV1);
    expect(sam.toolsAllowlist.filter((t) => t === "sources.ingest")).toHaveLength(1);
  });

  it("config base: seguro por defecto (kill switch activo) y presupuestos definidos", async () => {
    const db = freshDb();
    await seed(db, { env: {} });
    // Arranque en frío PAUSADO: el despachador no dispara los runs de las tareas
    // READY del seed hasta que un humano haga resume_all.
    expect(getConfig(db, ConfigKeys.KILL_SWITCH)).toBe(true);
    expect(getConfig(db, ConfigKeys.BUDGET_MAX_COST_PER_RUN_USD)).toBe(2);
    expect(getConfig(db, ConfigKeys.BUDGET_MAX_COST_PER_DAY_USD)).toBe(10);
  });

  it("organigrama de demostración de ACME: 6 roles, 4 áreas, 2 procesos, sin duplicados tras re-seed", async () => {
    const db = freshDb();
    await seed(db, { env: {} });
    await seed(db, { env: {} });
    const acme = getOrganizationByName(db, "ACME S.A.")!;
    expect(listOrgUnits(db, acme.id)).toHaveLength(4);
    expect(listOrgRoles(db, acme.id)).toHaveLength(6);
    expect(listProcesses(db, acme.id)).toHaveLength(2);

    const gerente = getOrgRoleByName(db, acme.id, "Gerente General")!;
    const jefeProduccion = getOrgRoleByName(db, acme.id, "Jefe de Producción")!;
    expect(jefeProduccion.reportsToRoleId).toBe(gerente.id);
    expect(listRoleFunctions(db, jefeProduccion.id)).toHaveLength(3);
    expect(listRolePeople(db, gerente.id)).toHaveLength(1);
    // Roles vacantes a propósito.
    const vendedor = getOrgRoleByName(db, acme.id, "Vendedor")!;
    expect(listRolePeople(db, vendedor.id)).toHaveLength(0);

    const proceso = listProcesses(db, acme.id).find((p) => p.name === "Control de calidad en planta")!;
    expect(listRoleProcesses(db, jefeProduccion.id).map((rp) => rp.processId)).toContain(proceso.id);
  });
});

describe("seedCatalog / seedDemo (endurecimiento para producción — sembrado)", () => {
  it("seedCatalog deja agentes, metodologías, módulos, proveedores, org Sixteam y personas, y CERO proyectos/tareas", async () => {
    const db = freshDb();
    const { agentsFallback } = await seedCatalog(db, { env: {} });
    expect(agentsFallback.length).toBeGreaterThan(0); // fallback de arranque, cero API keys
    expect(getAgentBySlug(db, "alex")).toBeDefined();
    expect(listMethodologies(db).length).toBe(5);
    expect(listPhaseModules(db, { status: "active" }).length).toBe(3);
    expect(getProviderProfile(db, getAgentBySlug(db, "alex")!.providerProfileId!)).toBeDefined();
    expect(getOrganizationByName(db, "Sixteam")).toBeDefined();
    expect(getPersonByFullName(db, "Ernesto")).toBeDefined();
    // NUNCA la demo: ni la org ACME ni ningún proyecto/tarea.
    expect(getOrganizationByName(db, "ACME S.A.")).toBeUndefined();
    expect(getProjectByName(db, "Assessment ACME")).toBeUndefined();
    expect(listTasks(db)).toHaveLength(0);
    // Config base sí es catálogo: arranque en frío pausado (kill switch activo).
    expect(getConfig(db, ConfigKeys.KILL_SWITCH)).toBe(true);
  });

  it("seedCatalog es idempotente (re-ejecutar no duplica nada)", async () => {
    const db = freshDb();
    await seedCatalog(db, { env: {} });
    const counts1 = { people: listMethodologies(db).length, tables: countDomainTables(db) };
    await seedCatalog(db, { env: {} });
    expect(listMethodologies(db).length).toBe(counts1.people);
    expect(countDomainTables(db)).toBe(counts1.tables);
    expect(listTasks(db)).toHaveLength(0);
  });

  it("seedCatalog sin demo y luego seedDemo: la demo aparece sin duplicar el catálogo", async () => {
    const db = freshDb();
    await seedCatalog(db, { env: {} });
    expect(listTasks(db)).toHaveLength(0);
    await seedDemo(db, { env: {} });
    const project = getProjectByName(db, "Assessment ACME");
    expect(project).toBeDefined();
    expect(listTasks(db, { projectId: project!.id })).toHaveLength(12);
    // seedDemo no re-siembra el catálogo: sigue habiendo un solo Sixteam.
    expect(listOrganizations(db).filter((o) => o.name === "Sixteam")).toHaveLength(1);
  });

  it("una base que ya tiene la demo no se altera al re-sembrar catálogo+demo (seed completo)", async () => {
    const db = freshDb();
    await seedCatalog(db, { env: {} });
    await seedDemo(db, { env: {} });
    const project = getProjectByName(db, "Assessment ACME")!;
    const tasksBefore = listTasks(db, { projectId: project.id });
    // seed() = seedCatalog + seedDemo, de nuevo: nada se duplica ni se pierde.
    await seed(db, { env: {} });
    const tasksAfter = listTasks(db, { projectId: project.id });
    expect(tasksAfter).toHaveLength(tasksBefore.length);
    expect(getProjectByName(db, "Assessment ACME")!.id).toBe(project.id);
  });
});

describe("metodologías ISO 9001 (F2-3)", () => {
  it("carga iso9001-prep e iso9001-clausulas junto a las 3 base (5 en total)", async () => {
    const db = freshDb();
    await seed(db, { env: {} });
    const slugs = listMethodologies(db).map((m) => m.slug);
    for (const s of ["assessment-14d", "transform", "ops", "iso9001-prep", "iso9001-clausulas"]) {
      expect(slugs, `falta metodología ${s}`).toContain(s);
    }
  });

  it("iso9001-prep e iso9001-clausulas incluyen el disclaimer de preparación (no certificación)", async () => {
    const db = freshDb();
    await seed(db, { env: {} });
    const disclaimer = "organismo de certificación acreditado";
    const prep = getMethodology(db, "iso9001-prep")!;
    const catalogo = getMethodology(db, "iso9001-clausulas")!;
    expect(prep.bodyMd).toContain(disclaimer);
    expect(prep.bodyMd).toContain("no certifica");
    expect(catalogo.bodyMd).toContain(disclaimer);
    // El catálogo cubre de 4.1 a 10.3.
    expect(catalogo.bodyMd).toContain("4.1");
    expect(catalogo.bodyMd).toContain("10.3");
  });

  it("re-seed aplica el prompt ISO 9001 de Sam (versión activa)", async () => {
    const db = freshDb();
    await seed(db, { env: {} });
    const sam = getAgentBySlug(db, "sam")!;
    const prompt = getActivePrompt(db, sam.id);
    expect(prompt?.stable).toContain("ISO 9001");
    expect(prompt?.stable).toContain("iso_gap");
    expect(prompt?.stable).toContain("iso.gap_matrix_template");
  });
});
