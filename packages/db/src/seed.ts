/**
 * Seeds de AgentOS (B1): orgs, personas, proveedores, agentes desde `agents/*.md`,
 * metodología desde `methodologies/*.md`, módulos desde `modules/*.md`, config
 * base y el proyecto demo ACME como LAUNCH del módulo consultoria v1 (§13.6):
 * el seed ya no hardcodea tareas — dispara el módulo con inputs demo fijos.
 * Idempotente: re-ejecutar no duplica nada (upserts por clave natural +
 * idempotency_key del launch).
 *
 * Regla del fallback de arranque (ARCHITECTURE §3): un agente `ai_sdk` cuyo
 * proveedor no tiene credencial configurada se seedea apuntando a
 * `claude_subscription` con runtime `claude_code` — el MVP funciona con CERO API keys.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ProviderCapabilities } from "@agentos/shared";
import { resolveDbPath } from "./client.js";
import type { AnyDb } from "./facade.js";
import { applyMigrations, closeAnyDb, openConfiguredDb } from "./open.js";
import { launchModule } from "./modules/launch.js";
import { loadAgentSeeds, loadMethodologySeeds, loadModuleSeeds, sha256 } from "./seed-sources.js";
import {
  ConfigKeys,
  countDomainTables,
  createOrganization,
  createPerson,
  createPromptVersion,
  domainCounts,
  getActivePrompt,
  getAgent,
  getConfig,
  getOrganizationByName,
  getPersonByFullName,
  getProjectByName,
  getProviderProfileBySlug,
  isProviderConfigured,
  listTasks,
  setConfig,
  updateAgent,
  upsertAgentFromSeed,
  upsertMethodology,
  upsertPhaseModuleFromSeed,
  upsertProviderProfile,
} from "./repos.js";

export interface SeedCounts {
  organizations: number;
  people: number;
  providerProfiles: number;
  agents: number;
  agentsFallback: string[];
  promptVersions: number;
  methodologies: number;
  phaseModules: number;
  projects: number;
  tasks: number;
  tables: number;
}

/** Modelo por defecto cuando el fallback de arranque cae a claude_subscription (H5). */
export const FALLBACK_CLAUDE_MODEL = "sonnet";

/** ¿El modelo lo puede correr el CLI de Claude? (aliases sonnet/opus/haiku o ids claude-*). */
export function isAnthropicModel(model: string | null | undefined): boolean {
  if (!model) return false;
  return /^(sonnet|opus|haiku)\b/i.test(model) || /^claude[-_]/i.test(model);
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

/**
 * Timestamp FIJO del launch demo (§13.6): determinismo de due_at y `{{hoy}}`.
 * 14 días exactos antes de la fecha objetivo — el "assessment 14d" de manual.
 */
const SEED_DEMO_LAUNCH_NOW = Date.parse("2026-09-01T00:00:00.000Z");

/**
 * Inputs demo del launch de consultoria v1 (claves y tipos EXACTOS de
 * `modules/consultoria.md`). Constantes a nivel de módulo: mismo inputs_digest
 * en cada re-seed ⇒ la idempotencia por key (CA-M2.6) nunca ve un conflicto.
 * Con ISO on: 12 tareas, 3 READY + 9 BACKLOG — la aritmética histórica del demo.
 */
const SEED_DEMO_INPUTS: Record<string, unknown> = {
  empresa: "ACME S.A.",
  alias: "ACME",
  industria: "manufactura",
  empleados: 40,
  sponsor: "Gerente General",
  objetivo: "Diagnosticar la operación y preparar ISO 9001.",
  areas: ["direccion", "operaciones", "ventas"],
  procesos_core: ["Producción", "Ventas → Facturación"],
  fecha_objetivo: "2026-09-15",
  sistemas_conocidos: "ERP básico, hojas de cálculo, WhatsApp",
};

export async function seed(
  db: AnyDb,
  opts: { env?: NodeJS.ProcessEnv } = {},
): Promise<SeedCounts> {
  const env = opts.env ?? process.env;

  // 1) Proveedores
  for (const p of PROVIDER_SEEDS) await upsertProviderProfile(db, p);

  // 2) Organizaciones
  const sixteam =
    (await getOrganizationByName(db, "Sixteam")) ??
    (await createOrganization(db, { name: "Sixteam", kind: "internal" }));
  // La org demo se preserva con sus notas; el launch demo (paso 7) la
  // encuentra por nombre exacto (get-or-create §13.3), no la duplica.
  if (!(await getOrganizationByName(db, "ACME S.A."))) {
    await createOrganization(db, {
      name: "ACME S.A.",
      kind: "client",
      industry: "manufactura",
      employeeCount: 40,
      notes: "Organización demo del MVP. Quieren preparación ISO 9001.",
    });
  }

  // 3) Personas internas (nombre completo para asignaciones)
  for (const p of PEOPLE_SEEDS) {
    if (!(await getPersonByFullName(db, p.fullName))) {
      await createPerson(db, { orgId: sixteam.id, isInternal: true, ...p });
    }
  }

  // 4) Agentes desde agents/*.md, con fallback de arranque
  const agentsFallback: string[] = [];
  const agentIdBySlug = new Map<string, string>();
  for (const seedDef of loadAgentSeeds()) {
    const desired = await getProviderProfileBySlug(db, seedDef.meta.provider_profile);
    let runtime = seedDef.meta.runtime;
    let model = seedDef.meta.model;
    let profile = desired;
    if (!desired || !isProviderConfigured(desired, env)) {
      // Sin credencial → suscripción Claude (runtime claude_code). La UI lo señalará.
      profile = (await getProviderProfileBySlug(db, "claude_subscription"))!;
      if (seedDef.meta.runtime === "ai_sdk") {
        runtime = "claude_code";
        agentsFallback.push(seedDef.meta.slug);
      }
      // H5: el CLI de Claude no puede correr modelos no-Anthropic (gpt-5, kimi,
      // MiniMax...). Si el fallback cambia el proveedor, el modelo cae a un
      // alias Anthropic válido — modelo y runtime SIEMPRE coherentes.
      if (!isAnthropicModel(model)) model = FALLBACK_CLAUDE_MODEL;
    }
    // El hash incluye el resultado del fallback: si aparece la credencial, el seed se re-aplica.
    const effectiveHash = sha256(`${seedDef.hash}|${profile!.slug}|${runtime}|${model}`);
    const { agent, seedChanged } = await upsertAgentFromSeed(db, {
      slug: seedDef.meta.slug,
      name: seedDef.meta.name,
      layer: seedDef.meta.layer,
      runtime,
      providerProfileId: profile!.id,
      model,
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
    const active = await getActivePrompt(db, agent.id);
    const promptDiffers =
      !active ||
      active.stable !== seedDef.prompt.stable ||
      (active.context ?? "") !== seedDef.prompt.context ||
      (active.volatileTpl ?? "") !== seedDef.prompt.volatile;
    if (!active || (seedChanged && promptDiffers)) {
      await createPromptVersion(db, {
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

  // 4b) Jerarquía de mando (Fase 2): segunda pasada que resuelve reports_to por
  // slug → id. Va aparte porque el manager puede crearse DESPUÉS del report en
  // la primera pasada. Idempotente: solo escribe si el valor difiere (no bombea
  // versiones ni crea prompts). Un slug de manager inexistente se deja en null y
  // se avisa por stderr (fail-soft: el seed no se cae por un .md mal referenciado).
  for (const seedDef of loadAgentSeeds()) {
    const agentId = agentIdBySlug.get(seedDef.meta.slug);
    if (!agentId) continue;
    let desired: string | null = null;
    if (seedDef.meta.reports_to) {
      desired = agentIdBySlug.get(seedDef.meta.reports_to) ?? null;
      if (!desired) {
        process.stderr.write(
          `[seed] ${seedDef.meta.slug}.reports_to="${seedDef.meta.reports_to}" no existe en el roster; se deja como raíz.\n`,
        );
      }
    }
    const current = await getAgent(db, agentId);
    if (current && current.reportsTo !== desired) {
      await updateAgent(db, current.id, { reportsTo: desired }, current.version);
    }
  }

  // 5) Metodologías desde methodologies/*.md
  for (const m of loadMethodologySeeds()) {
    await upsertMethodology(db, {
      slug: m.slug,
      version: m.version,
      bodyMd: m.bodyMd,
      changelog: `Seed desde ${m.file}`,
      seedFile: m.file,
      seedHash: m.hash,
    });
  }

  // 5b) Módulos de fase desde modules/*.md (§13 — CA-M1.1): consultoria,
  // implementacion y operacion, validados fail-closed en el parse y ACTIVOS.
  // Idempotente por seed_hash; contenido cambiado sin subir `version` en el
  // archivo LANZA module_version_immutable (las versiones son inmutables).
  for (const m of loadModuleSeeds()) {
    await upsertPhaseModuleFromSeed(db, m);
  }

  // 6) Config base (no pisa valores editados a mano). Va ANTES del launch demo
  // a propósito: seguro por defecto, un arranque en frío queda PAUSADO. El
  // launch deja tareas en READY y el despachador las arrancaría (gastando
  // suscripción) al boot; con el kill switch ya activo cuando nacen, nada corre
  // hasta que un humano haga resume_all cuando esté listo para observar.
  if ((await getConfig(db, ConfigKeys.KILL_SWITCH)) === undefined) {
    await setConfig(db, ConfigKeys.KILL_SWITCH, true);
  }
  if ((await getConfig(db, ConfigKeys.BUDGET_MAX_COST_PER_RUN_USD)) === undefined) {
    await setConfig(db, ConfigKeys.BUDGET_MAX_COST_PER_RUN_USD, 2);
  }
  if ((await getConfig(db, ConfigKeys.BUDGET_MAX_COST_PER_DAY_USD)) === undefined) {
    await setConfig(db, ConfigKeys.BUDGET_MAX_COST_PER_DAY_USD, 10);
  }

  // 7) Proyecto demo = LAUNCH del módulo consultoria v1 (§13.6): las 12 tareas
  // salen de las plantillas del módulo, con la política de aprobación real
  // (NM-5). Motor directo (launchModule, no launchModuleWithEvents): el seed NO
  // publica eventos AG-UI. Cinturón y tirantes contra el re-seed: guard por
  // nombre de proyecto + idempotency_key fija (misma key + mismos inputs
  // devuelve lo ya creado sin duplicar — CA-M2.6).
  if (!(await getProjectByName(db, "Assessment ACME"))) {
    await launchModule(db, {
      moduleSlug: "consultoria",
      actor: "system:seed",
      idempotencyKey: "seed:demo:consultoria:acme",
      toggles: { iso9001: true },
      org: {
        name: "ACME S.A.",
        kind: "client",
        industria: "manufactura",
        employeeCount: 40,
        notes: "Organización demo del MVP. Quieren preparación ISO 9001.",
      },
      inputs: SEED_DEMO_INPUTS,
      now: SEED_DEMO_LAUNCH_NOW,
    });
  }

  return await collectCounts(db, agentsFallback);
}

async function collectCounts(db: AnyDb, agentsFallback: string[]): Promise<SeedCounts> {
  const counts = await domainCounts(db);
  return {
    organizations: counts.organizations,
    people: counts.people,
    providerProfiles: counts.providerProfiles,
    agents: counts.agents,
    agentsFallback,
    promptVersions: counts.promptVersions,
    methodologies: counts.methodologies,
    phaseModules: counts.phaseModules,
    projects: counts.projects,
    tasks: counts.tasks,
    tables: await countDomainTables(db),
  };
}

// Ejecutable: `pnpm --filter @agentos/db seed`
const isMain =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const db = await openConfiguredDb();
  await applyMigrations(db);
  const counts = await seed(db);
  console.log(
    `Seed aplicado en ${process.env.AGENTOS_DB_DRIVER === undefined ? resolveDbPath() : "el backend configurado (" + process.env.AGENTOS_DB_DRIVER + ")"}`,
  );
  console.log(JSON.stringify(counts, null, 2));
  if (counts.agentsFallback.length > 0) {
    console.log(
      `Fallback de arranque: sin credencial para [${counts.agentsFallback.join(", ")}] → claude_subscription/claude_code (ARCHITECTURE §3).`,
    );
  }
  const ready = (await listTasks(db, { status: "READY" })).length;
  console.log(`Tareas READY: ${ready} (única cola del despachador — B3).`);
  await closeAnyDb(db);
}
