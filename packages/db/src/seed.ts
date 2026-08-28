/**
 * Seeds de AgentOS (B1): orgs, personas, proveedores, agentes desde `agents/*.md`,
 * metodología desde `methodologies/*.md`, proyecto demo con 12 tareas y config base.
 * Idempotente: re-ejecutar no duplica nada (upserts por clave natural).
 *
 * Regla del fallback de arranque (ARCHITECTURE §3): un agente `ai_sdk` cuyo
 * proveedor no tiene credencial configurada se seedea apuntando a
 * `claude_subscription` con runtime `claude_code` — el MVP funciona con CERO API keys.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ProviderCapabilities, Stage, TaskPriority, TaskStatus } from "@agentos/shared";
import { openDb, resolveDbPath, type AgentosDb } from "./client.js";
import { runMigrations } from "./migrate.js";
import { loadAgentSeeds, loadMethodologySeeds, sha256 } from "./seed-sources.js";
import {
  createPromptVersion,
  getActivePrompt,
  upsertAgentFromSeed,
} from "./repositories/agents.js";
import { ConfigKeys, getConfig, setConfig } from "./repositories/config.js";
import { upsertMethodology } from "./repositories/methodologies.js";
import {
  createOrganization,
  createPerson,
  getOrganizationByName,
  getPersonByFullName,
} from "./repositories/organizations-people.js";
import { createProject, getProjectByName } from "./repositories/projects.js";
import {
  getProviderProfileBySlug,
  isProviderConfigured,
  upsertProviderProfile,
} from "./repositories/providers.js";
import { appendTaskEvent, createTask, listTasks } from "./repositories/tasks.js";

export interface SeedCounts {
  organizations: number;
  people: number;
  providerProfiles: number;
  agents: number;
  agentsFallback: string[];
  promptVersions: number;
  methodologies: number;
  projects: number;
  tasks: number;
  tables: number;
}

const caps = (over: Partial<ProviderCapabilities> = {}): ProviderCapabilities => ({
  tool_calling: true,
  streaming: true,
  vision: false,
  computer_use: false,
  prompt_cache: false,
  ...over,
});

/** Perfiles de proveedor del MVP (US-9). Costes null = no reportado, nunca cero inferido. */
const PROVIDER_SEEDS = [
  {
    slug: "claude_subscription",
    name: "Claude Code (suscripción)",
    kind: "claude_subscription" as const,
    baseUrl: null,
    apiKeyEnv: null, // usa el login del CLI, jamás una API key heredada (higiene de entorno §3)
    capabilities: caps({ vision: true, computer_use: true, prompt_cache: true }),
    isDefault: true,
  },
  {
    slug: "anthropic_api",
    name: "Anthropic API",
    kind: "anthropic_api" as const,
    baseUrl: "https://api.anthropic.com",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    capabilities: caps({ vision: true, prompt_cache: true }),
    isDefault: false,
  },
  {
    slug: "openai",
    name: "OpenAI",
    kind: "openai_compatible" as const,
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_API_KEY",
    capabilities: caps({ vision: true }),
    isDefault: false,
  },
  {
    slug: "kimi",
    name: "Kimi (Moonshot)",
    kind: "openai_compatible" as const,
    baseUrl: "https://api.moonshot.ai/v1",
    apiKeyEnv: "KIMI_API_KEY",
    capabilities: caps(),
    isDefault: false,
  },
  {
    slug: "minimax",
    name: "MiniMax",
    kind: "openai_compatible" as const,
    baseUrl: "https://api.minimax.io/v1",
    apiKeyEnv: "MINIMAX_API_KEY",
    capabilities: caps(),
    isDefault: false,
  },
  {
    slug: "glm",
    name: "GLM (Z.ai)",
    kind: "openai_compatible" as const,
    baseUrl: "https://api.z.ai/api/paas/v4",
    apiKeyEnv: "GLM_API_KEY",
    capabilities: caps(),
    isDefault: false,
  },
];

const PEOPLE_SEEDS = [
  { fullName: "Samuel Burgos", role: "Estratega" },
  { fullName: "Sebastián", role: "Equipo ejecutor" },
  { fullName: "Jorge", role: "Equipo ejecutor" },
  { fullName: "Jefferson", role: "Equipo ejecutor" },
  { fullName: "Ernesto", role: "Operador", email: "ernesto@sixteam.pro" },
];

interface TaskSeed {
  title: string;
  description: string;
  definitionOfDone: string;
  status: TaskStatus;
  stage: Stage;
  activityType: string;
  priority: TaskPriority;
  assignee: string; // slug de agente
  orderKey: string;
  requiresApproval?: boolean;
}

/** 12 tareas realistas de assessment (metodología assessment-14d). */
const TASK_SEEDS: TaskSeed[] = [
  {
    title: "Kickoff con sponsor de ACME",
    description: "Reunión inicial: alcance del assessment, expectativas, accesos y calendario.",
    definitionOfDone:
      "Agenda enviada, asistentes confirmados y acta de kickoff registrada en el Context Hub como nota tipada con fecha y participantes.",
    status: "READY",
    stage: "ENTENDER",
    activityType: "kickoff",
    priority: "high",
    assignee: "alex",
    orderKey: "a0",
  },
  {
    title: "Perfil de organización ACME",
    description: "Levantar el org_profile: estructura, roles, productos y contexto de manufactura.",
    definitionOfDone:
      "Documento `org_profile` en el Context Hub con industria, tamaño (40 empleados), estructura y sistemas declarados, citando su fuente.",
    status: "READY",
    stage: "ENTENDER",
    activityType: "org_profile",
    priority: "high",
    assignee: "sam",
    orderKey: "a1",
  },
  {
    title: "Inventario de sistemas y herramientas",
    description: "Qué usa ACME hoy: ERP, hojas de cálculo, mensajería, control de producción.",
    definitionOfDone:
      "Lista de sistemas en uso registrada como documento tipado en el Context Hub, con fuente por sistema y responsable que lo declaró.",
    status: "READY",
    stage: "ENTENDER",
    activityType: "systems_inventory",
    priority: "normal",
    assignee: "clara",
    orderKey: "a2",
  },
  {
    title: "Entrevista: Gerencia General",
    description: "Entrevista al gerente general: visión, dolores, prioridades e interés en ISO 9001.",
    definitionOfDone:
      "Nota `interview` en el Context Hub con hallazgos clave y citas atribuidas a la persona entrevistada.",
    status: "BACKLOG",
    stage: "ENTENDER",
    activityType: "interview",
    priority: "high",
    assignee: "sam",
    orderKey: "a3",
  },
  {
    title: "Entrevista: Jefe de Producción",
    description: "Flujo de planta, planificación, mermas, calidad y registros actuales.",
    definitionOfDone:
      "Nota `interview` en el Context Hub con el flujo de producción descrito y dolores citados con fuente.",
    status: "BACKLOG",
    stage: "ENTENDER",
    activityType: "interview",
    priority: "normal",
    assignee: "sam",
    orderKey: "a4",
  },
  {
    title: "Entrevista: Ventas y Comercial",
    description: "Ciclo de venta, cotizaciones, seguimiento de pedidos y postventa.",
    definitionOfDone:
      "Nota `interview` en el Context Hub cubriendo el ciclo comercial completo, con citas atribuidas.",
    status: "BACKLOG",
    stage: "ENTENDER",
    activityType: "interview",
    priority: "normal",
    assignee: "sam",
    orderKey: "a5",
  },
  {
    title: "Mapa de proceso as-is: Producción",
    description: "Mapear el proceso de producción actual con base en las entrevistas.",
    definitionOfDone:
      "Proceso en `processes` (variant as_is) con pasos SIPOC, sistemas implicados y dolores, enlazado a sus entrevistas fuente.",
    status: "BACKLOG",
    stage: "ENTENDER",
    activityType: "process_map",
    priority: "high",
    assignee: "sam",
    orderKey: "a6",
  },
  {
    title: "Mapa de proceso as-is: Ventas → Facturación",
    description: "Mapear el flujo desde cotización hasta factura y cobro.",
    definitionOfDone:
      "Proceso en `processes` (variant as_is) con pasos, responsables y sistemas, enlazado a sus fuentes.",
    status: "BACKLOG",
    stage: "ENTENDER",
    activityType: "process_map",
    priority: "normal",
    assignee: "sam",
    orderKey: "a7",
  },
  {
    title: "Análisis de fugas y cuellos de botella",
    description: "Consolidar retrabajos, esperas y fugas de margen detectadas en entrevistas y mapas.",
    definitionOfDone:
      "Un `finding` por fuga con impacto estimado y fuente; toda afirmación sin fuente marcada como no verificada.",
    status: "BACKLOG",
    stage: "ENTENDER",
    activityType: "leak_analysis",
    priority: "high",
    assignee: "sam",
    orderKey: "a8",
  },
  {
    title: "Matriz de brechas ISO 9001 (cláusulas 4-10)",
    description: "Contrastar procesos mapeados contra requisitos ISO 9001 e identificar huecos.",
    definitionOfDone:
      "Matriz cláusula↔proceso↔evidencia registrada como documento `iso_clause` con huecos identificados y priorizados.",
    status: "BACKLOG",
    stage: "ENTENDER",
    activityType: "iso_gap",
    priority: "normal",
    assignee: "sam",
    orderKey: "a9",
  },
  {
    title: "Informe de assessment (borrador)",
    description: "Redactar el informe de diagnóstico consolidando perfil, mapas, fugas y brechas.",
    definitionOfDone:
      "Informe adjunto como artefacto citando doc ids del Context Hub (provenance); pasa a REVIEW para aprobación humana.",
    status: "BACKLOG",
    stage: "ENTENDER",
    activityType: "report",
    priority: "urgent",
    assignee: "sam",
    orderKey: "b0",
    requiresApproval: true,
  },
  {
    title: "Roadmap de transformación priorizado",
    description: "Proponer el roadmap Entender → Construir → Operar con prioridades y esfuerzo.",
    definitionOfDone:
      "Roadmap adjunto como artefacto, coherente con el informe; su aprobación humana habilita el Gate 1 y cierra ENTENDER.",
    status: "BACKLOG",
    stage: "ENTENDER",
    activityType: "roadmap",
    priority: "urgent",
    assignee: "alex",
    orderKey: "b1",
    requiresApproval: true,
  },
];

export function seed(db: AgentosDb, opts: { env?: NodeJS.ProcessEnv } = {}): SeedCounts {
  const env = opts.env ?? process.env;

  // 1) Proveedores
  for (const p of PROVIDER_SEEDS) upsertProviderProfile(db, p);

  // 2) Organizaciones
  const sixteam =
    getOrganizationByName(db, "Sixteam") ??
    createOrganization(db, { name: "Sixteam", kind: "internal" });
  const acme =
    getOrganizationByName(db, "ACME S.A.") ??
    createOrganization(db, {
      name: "ACME S.A.",
      kind: "client",
      industry: "manufactura",
      employeeCount: 40,
      notes: "Organización demo del MVP. Quieren preparación ISO 9001.",
    });

  // 3) Personas internas (nombre completo para asignaciones)
  for (const p of PEOPLE_SEEDS) {
    if (!getPersonByFullName(db, p.fullName)) {
      createPerson(db, { orgId: sixteam.id, isInternal: true, ...p });
    }
  }

  // 4) Agentes desde agents/*.md, con fallback de arranque
  const agentsFallback: string[] = [];
  const agentIdBySlug = new Map<string, string>();
  for (const seedDef of loadAgentSeeds()) {
    const desired = getProviderProfileBySlug(db, seedDef.meta.provider_profile);
    let runtime = seedDef.meta.runtime;
    let profile = desired;
    if (!desired || !isProviderConfigured(desired, env)) {
      // Sin credencial → suscripción Claude (runtime claude_code). La UI lo señalará.
      profile = getProviderProfileBySlug(db, "claude_subscription")!;
      if (seedDef.meta.runtime === "ai_sdk") {
        runtime = "claude_code";
        agentsFallback.push(seedDef.meta.slug);
      }
    }
    // El hash incluye el resultado del fallback: si aparece la credencial, el seed se re-aplica.
    const effectiveHash = sha256(`${seedDef.hash}|${profile!.slug}|${runtime}`);
    const { agent, seedChanged } = upsertAgentFromSeed(db, {
      slug: seedDef.meta.slug,
      name: seedDef.meta.name,
      layer: seedDef.meta.layer,
      runtime,
      providerProfileId: profile!.id,
      model: seedDef.meta.model,
      toolsAllowlist: seedDef.meta.tools,
      mcpAllowlist: [],
      autonomy: seedDef.meta.autonomy,
      status: "active",
      seedFile: seedDef.file,
      seedHash: effectiveHash,
    });
    agentIdBySlug.set(agent.slug, agent.id);
    // Prompt: versionado, nunca sobrescrito (US-8/CA-8.2). Se crea versión nueva
    // + active si (a) el agente no tiene prompt, o (b) el seed cambió Y el
    // contenido difiere del activo. Si el .md no cambió, las ediciones en
    // caliente por MCP se respetan; un cambio solo de proveedor no crea
    // versiones redundantes.
    const active = getActivePrompt(db, agent.id);
    const promptDiffers =
      !active ||
      active.stable !== seedDef.prompt.stable ||
      (active.context ?? "") !== seedDef.prompt.context ||
      (active.volatileTpl ?? "") !== seedDef.prompt.volatile;
    if (!active || (seedChanged && promptDiffers)) {
      createPromptVersion(db, {
        agentId: agent.id,
        stable: seedDef.prompt.stable,
        context: seedDef.prompt.context,
        volatileTpl: seedDef.prompt.volatile,
        changelog: active
          ? `Seed re-aplicado desde ${seedDef.file}`
          : `Seed inicial desde ${seedDef.file}`,
        createdBy: "system:seed",
      });
    }
  }

  // 5) Metodologías desde methodologies/*.md
  for (const m of loadMethodologySeeds()) {
    upsertMethodology(db, {
      slug: m.slug,
      version: m.version,
      bodyMd: m.bodyMd,
      changelog: `Seed desde ${m.file}`,
      seedFile: m.file,
      seedHash: m.hash,
    });
  }

  // 6) Proyecto demo con 12 tareas de assessment
  let project = getProjectByName(db, "Assessment ACME");
  if (!project) {
    project = createProject(db, {
      orgId: acme.id,
      name: "Assessment ACME",
      type: "assessment",
      stage: "ENTENDER",
      gateState: "pending",
      workspacePath: "workspaces/assessment-acme",
    });
    for (const t of TASK_SEEDS) {
      const task = createTask(db, {
        projectId: project.id,
        title: t.title,
        description: t.description,
        definitionOfDone: t.definitionOfDone,
        stage: t.stage,
        status: t.status,
        activityType: t.activityType,
        priority: t.priority,
        assigneeAgentId: agentIdBySlug.get(t.assignee) ?? null,
        requiresApproval: t.requiresApproval ?? false,
        orderKey: t.orderKey,
      });
      appendTaskEvent(db, {
        taskId: task.id,
        kind: "created",
        toStatus: t.status,
        actor: "system:seed",
        payload: { assignee: t.assignee },
      });
    }
  }

  // 7) Config base (no pisa valores editados a mano)
  if (getConfig(db, ConfigKeys.KILL_SWITCH) === undefined) {
    setConfig(db, ConfigKeys.KILL_SWITCH, false);
  }
  if (getConfig(db, ConfigKeys.BUDGET_MAX_COST_PER_RUN_USD) === undefined) {
    setConfig(db, ConfigKeys.BUDGET_MAX_COST_PER_RUN_USD, 2);
  }
  if (getConfig(db, ConfigKeys.BUDGET_MAX_COST_PER_DAY_USD) === undefined) {
    setConfig(db, ConfigKeys.BUDGET_MAX_COST_PER_DAY_USD, 20);
  }

  return collectCounts(db, agentsFallback);
}

function collectCounts(db: AgentosDb, agentsFallback: string[]): SeedCounts {
  const one = (sql: string): number =>
    (db.$client.prepare(sql).get() as { n: number }).n;
  return {
    organizations: one("SELECT count(*) n FROM organizations"),
    people: one("SELECT count(*) n FROM people"),
    providerProfiles: one("SELECT count(*) n FROM provider_profiles"),
    agents: one("SELECT count(*) n FROM agents"),
    agentsFallback,
    promptVersions: one("SELECT count(*) n FROM prompt_versions"),
    methodologies: one("SELECT count(*) n FROM methodologies"),
    projects: one("SELECT count(*) n FROM projects"),
    tasks: one("SELECT count(*) n FROM tasks"),
    tables: countDomainTables(db),
  };
}

/** Tablas de dominio (excluye internas de SQLite, espejos FTS y la de migraciones). */
export function countDomainTables(db: AgentosDb): number {
  const row = db.$client
    .prepare(
      `SELECT count(*) n FROM sqlite_master
       WHERE type = 'table'
         AND name NOT LIKE 'sqlite_%'
         AND name NOT LIKE '%_fts%'
         AND name != '__drizzle_migrations'`,
    )
    .get() as { n: number };
  return row.n;
}

// Ejecutable: `pnpm --filter @agentos/db seed`
const isMain =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const db = openDb();
  runMigrations(db);
  const counts = seed(db);
  console.log(`Seed aplicado en ${resolveDbPath()}`);
  console.log(JSON.stringify(counts, null, 2));
  if (counts.agentsFallback.length > 0) {
    console.log(
      `Fallback de arranque: sin credencial para [${counts.agentsFallback.join(", ")}] → claude_subscription/claude_code (ARCHITECTURE §3).`,
    );
  }
  const ready = listTasks(db, { status: "READY" }).length;
  console.log(`Tareas READY: ${ready} (única cola del despachador — B3).`);
  db.$client.close();
}
