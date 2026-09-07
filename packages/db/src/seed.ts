/**
 * Seeds de AgentOS (B1), separados en dos funciones (endurecimiento para
 * producción):
 *
 *   `seedCatalog(db)` — TODO lo que no es demo: organización interna Sixteam,
 *   personas del equipo, proveedores, agentes desde `agents/*.md`, metodología
 *   desde `methodologies/*.md`, módulos desde `modules/*.md` y config base
 *   (kill switch activo por defecto). Es lo único que debe sembrarse contra
 *   una base de producción vacía.
 *
 *   `seedDemo(db)` — organización ACME y el proyecto demo como LAUNCH del
 *   módulo consultoria v1 (§13.6): el seed ya no hardcodea tareas, dispara el
 *   módulo con inputs demo fijos. Depende del catálogo (agentes, módulos) ya
 *   sembrado.
 *
 *   `seed(db)` — llama a ambas, en orden; es el comportamiento histórico
 *   (`pnpm --filter @agentos/db seed`, tests que no distinguen).
 *
 * Ambas son idempotentes: re-ejecutar no duplica nada (upserts por clave
 * natural + idempotency_key del launch).
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
  createOrgRole,
  createOrgUnit,
  createPerson,
  createProcess,
  createPromptVersion,
  domainCounts,
  getActivePrompt,
  getAgent,
  getConfig,
  getOrganizationByName,
  getOrgRole,
  getOrgRoleByName,
  getOrgUnitByName,
  getPersonByFullName,
  getProjectByName,
  getProviderProfileBySlug,
  isProviderConfigured,
  listProcesses,
  listTasks,
  replaceRoleFunctions,
  replaceRolePeople,
  replaceRoleProcesses,
  setConfig,
  updateAgent,
  updateOrgRole,
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

// ── Organigrama de demostración de ACME (grafo organizacional) ─────────────
// El rol es el centro (PRD v1.1 §3.1 y Parte II §5.3): cuelga de un área,
// reporta a otro rol, lo ocupan personas y tiene funciones. Dos roles quedan
// vacantes (Supervisor de Planta, Vendedor) para mostrar ese estado en la UI.

const ACME_UNIT_SEEDS = ["Dirección", "Producción", "Comercial", "Administración"] as const;

const ACME_PEOPLE_SEEDS = ["María Restrepo", "Carlos Pérez", "Laura Gómez", "Andrés Mora"] as const;

interface AcmeRoleSeed {
  name: string;
  unit: (typeof ACME_UNIT_SEEDS)[number];
  canvasX: number;
  canvasY: number;
  personFullName?: (typeof ACME_PEOPLE_SEEDS)[number];
  reportsTo?: string;
  functions: readonly string[];
}

const ACME_ROLE_SEEDS: readonly AcmeRoleSeed[] = [
  {
    name: "Gerente General",
    unit: "Dirección",
    canvasX: 400,
    canvasY: 40,
    personFullName: "María Restrepo",
    functions: ["Definir prioridades del trimestre", "Aprobar inversiones y contrataciones"],
  },
  {
    name: "Jefe de Producción",
    unit: "Producción",
    canvasX: 120,
    canvasY: 220,
    personFullName: "Carlos Pérez",
    reportsTo: "Gerente General",
    functions: [
      "Planificar la producción semanal",
      "Controlar calidad y mermas",
      "Coordinar mantenimiento",
    ],
  },
  {
    name: "Jefe Comercial",
    unit: "Comercial",
    canvasX: 400,
    canvasY: 220,
    personFullName: "Laura Gómez",
    reportsTo: "Gerente General",
    functions: ["Gestionar la cartera de clientes", "Cotizar y cerrar pedidos"],
  },
  {
    name: "Administrador",
    unit: "Administración",
    canvasX: 680,
    canvasY: 220,
    personFullName: "Andrés Mora",
    reportsTo: "Gerente General",
    functions: ["Facturación y cobranza", "Nómina y proveedores"],
  },
  {
    // Vacante a propósito: muestra el estado "sin ocupar" en el lienzo.
    name: "Supervisor de Planta",
    unit: "Producción",
    canvasX: 120,
    canvasY: 400,
    reportsTo: "Jefe de Producción",
    functions: ["Asignar operarios por turno", "Registrar avance de órdenes"],
  },
  {
    // Vacante a propósito.
    name: "Vendedor",
    unit: "Comercial",
    canvasX: 400,
    canvasY: 400,
    reportsTo: "Jefe Comercial",
    functions: ["Atender pedidos y consultas", "Hacer seguimiento a cotizaciones"],
  },
];

interface AcmeProcessSeed {
  name: string;
  ownerRoleName: string;
  steps: { step: string; responsible: string }[];
  relations: readonly { role: string; relation: "owner" | "participant" }[];
}

const ACME_PROCESS_SEEDS: readonly AcmeProcessSeed[] = [
  {
    name: "Recepción y planificación de pedidos",
    ownerRoleName: "Jefe Comercial",
    steps: [
      { step: "Recibir el pedido del cliente", responsible: "Vendedor" },
      { step: "Verificar disponibilidad y precio", responsible: "Jefe Comercial" },
      { step: "Programar la producción con planta", responsible: "Jefe de Producción" },
    ],
    relations: [
      { role: "Jefe Comercial", relation: "owner" },
      { role: "Vendedor", relation: "participant" },
      { role: "Jefe de Producción", relation: "participant" },
    ],
  },
  {
    name: "Control de calidad en planta",
    ownerRoleName: "Jefe de Producción",
    steps: [
      { step: "Inspeccionar materia prima al ingreso", responsible: "Supervisor de Planta" },
      { step: "Verificar el producto en proceso", responsible: "Jefe de Producción" },
      { step: "Registrar no conformidades y mermas", responsible: "Supervisor de Planta" },
    ],
    relations: [
      { role: "Jefe de Producción", relation: "owner" },
      { role: "Supervisor de Planta", relation: "participant" },
    ],
  },
];

/**
 * Organigrama de demostración: SOLO para ACME, idempotente (get-or-create por
 * nombre natural; `replace*` sobrescribe con el mismo contenido, nunca crece).
 */
async function seedOrgGraphAcme(db: AnyDb, orgId: string): Promise<void> {
  const unitIdByName = new Map<string, string>();
  for (const name of ACME_UNIT_SEEDS) {
    const unit = (await getOrgUnitByName(db, orgId, name)) ?? (await createOrgUnit(db, { orgId, name }));
    unitIdByName.set(name, unit.id);
  }

  for (const fullName of ACME_PEOPLE_SEEDS) {
    if (!(await getPersonByFullName(db, fullName))) {
      await createPerson(db, { orgId, fullName, isInternal: false });
    }
  }

  const roleIdByName = new Map<string, string>();
  for (const roleSeed of ACME_ROLE_SEEDS) {
    const role =
      (await getOrgRoleByName(db, orgId, roleSeed.name)) ??
      (await createOrgRole(db, {
        orgId,
        name: roleSeed.name,
        unitId: unitIdByName.get(roleSeed.unit) ?? null,
        canvasX: roleSeed.canvasX,
        canvasY: roleSeed.canvasY,
      }));
    roleIdByName.set(roleSeed.name, role.id);
  }

  // Segunda pasada: resuelve `reports_to` por nombre (el manager puede
  // haberse creado después en la lista) — mismo patrón que la jerarquía de agentes.
  for (const roleSeed of ACME_ROLE_SEEDS) {
    if (!roleSeed.reportsTo) continue;
    const roleId = roleIdByName.get(roleSeed.name)!;
    const managerId = roleIdByName.get(roleSeed.reportsTo);
    if (!managerId) continue;
    const current = await getOrgRole(db, roleId);
    if (current && current.reportsToRoleId !== managerId) {
      await updateOrgRole(db, roleId, { reportsToRoleId: managerId }, current.version);
    }
  }

  for (const roleSeed of ACME_ROLE_SEEDS) {
    const roleId = roleIdByName.get(roleSeed.name)!;
    await replaceRoleFunctions(
      db,
      roleId,
      roleSeed.functions.map((name) => ({ name })),
    );
    const person = roleSeed.personFullName ? await getPersonByFullName(db, roleSeed.personFullName) : undefined;
    await replaceRolePeople(db, roleId, person ? [{ personId: person.id }] : []);
  }

  const processIdByName = new Map<string, string>();
  for (const procSeed of ACME_PROCESS_SEEDS) {
    const existing = (await listProcesses(db, orgId)).find((p) => p.name === procSeed.name);
    const process =
      existing ??
      (await createProcess(db, {
        orgId,
        name: procSeed.name,
        variant: "as_is",
        ownerPerson: procSeed.ownerRoleName,
        steps: procSeed.steps,
      }));
    processIdByName.set(procSeed.name, process.id);
  }

  const roleProcessesByRole = new Map<string, { processId: string; relation: "owner" | "participant" }[]>();
  for (const procSeed of ACME_PROCESS_SEEDS) {
    const processId = processIdByName.get(procSeed.name)!;
    for (const rel of procSeed.relations) {
      const list = roleProcessesByRole.get(rel.role) ?? [];
      list.push({ processId, relation: rel.relation });
      roleProcessesByRole.set(rel.role, list);
    }
  }
  for (const [roleName, relations] of roleProcessesByRole) {
    const roleId = roleIdByName.get(roleName);
    if (!roleId) continue;
    await replaceRoleProcesses(db, roleId, relations);
  }
}

/** Resultado de `seedCatalog`: lo único que aún necesita `seed()` para el conteo final. */
export interface CatalogSeedResult {
  agentsFallback: string[];
}

/**
 * Siembra el CATÁLOGO: proveedores, organización interna Sixteam, personas del
 * equipo, agentes (+ jerarquía de mando), metodologías, módulos de fase y
 * config base (kill switch activo si no existe). NUNCA toca ACME ni dispara el
 * launch demo — es seguro correrlo contra una base de producción vacía.
 * Idempotente: re-ejecutar no duplica nada.
 */
export async function seedCatalog(
  db: AnyDb,
  opts: { env?: NodeJS.ProcessEnv } = {},
): Promise<CatalogSeedResult> {
  const env = opts.env ?? process.env;

  // 1) Proveedores
  for (const p of PROVIDER_SEEDS) await upsertProviderProfile(db, p);

  // 2) Organización interna
  const sixteam =
    (await getOrganizationByName(db, "Sixteam")) ??
    (await createOrganization(db, { name: "Sixteam", kind: "internal" }));

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

  return { agentsFallback };
}

/**
 * Siembra la DEMO: organización ACME + proyecto demo como LAUNCH del módulo
 * consultoria v1 (§13.6) — las 12 tareas salen de las plantillas del módulo,
 * con la política de aprobación real (NM-5). Motor directo (launchModule, no
 * launchModuleWithEvents): el seed NO publica eventos AG-UI. Cinturón y
 * tirantes contra el re-seed: guard por nombre de proyecto + idempotency_key
 * fija (misma key + mismos inputs devuelve lo ya creado sin duplicar — CA-M2.6).
 *
 * Depende del catálogo (agentes, módulo `consultoria`) ya sembrado — llamar
 * antes a `seedCatalog(db)`. NUNCA debe correr contra una base de producción
 * real (ver `AGENTOS_SEED_DEMO` en `apps/api/src/context.ts`).
 */
export async function seedDemo(
  db: AnyDb,
  _opts: { env?: NodeJS.ProcessEnv } = {},
): Promise<void> {
  // La org demo se preserva con sus notas; el launch (abajo) la encuentra por
  // nombre exacto (get-or-create §13.3), no la duplica.
  const acme =
    (await getOrganizationByName(db, "ACME S.A.")) ??
    (await createOrganization(db, {
      name: "ACME S.A.",
      kind: "client",
      industry: "manufactura",
      employeeCount: 40,
      notes: "Organización demo del MVP. Quieren preparación ISO 9001.",
    }));

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

  // Organigrama de demostración (grafo organizacional): SOLO ACME, idempotente.
  await seedOrgGraphAcme(db, acme.id);
}

/**
 * Siembra ambos: catálogo + demo. Comportamiento histórico de `seed()` —
 * `pnpm --filter @agentos/db seed` sigue sembrando los dos (demo local).
 */
export async function seed(
  db: AnyDb,
  opts: { env?: NodeJS.ProcessEnv } = {},
): Promise<SeedCounts> {
  const { agentsFallback } = await seedCatalog(db, opts);
  await seedDemo(db, opts);
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

/**
 * ¿La variable pide saltarse la demo? Mismo criterio de valores "apagado" que
 * `shouldSeedDemo` en `apps/api/src/context.ts` (0/false/off, sin distinguir
 * mayúsculas). El comando `pnpm --filter @agentos/db seed` siembra ambos por
 * defecto (es la demo local) salvo que se pase esta variable.
 */
function isDemoDisabledByEnv(env: NodeJS.ProcessEnv): boolean {
  const raw = env.AGENTOS_SEED_DEMO?.trim().toLowerCase();
  return raw === "0" || raw === "false" || raw === "off";
}

// Ejecutable: `pnpm --filter @agentos/db seed`
const isMain =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const db = await openConfiguredDb();
  await applyMigrations(db);
  const { agentsFallback } = await seedCatalog(db);
  const seedsDemo = !isDemoDisabledByEnv(process.env);
  if (seedsDemo) {
    await seedDemo(db);
  } else {
    console.log("AGENTOS_SEED_DEMO desactiva la demo: solo se sembró el catálogo.");
  }
  const counts = await collectCounts(db, agentsFallback);
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
