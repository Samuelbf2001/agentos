/**
 * Snapshot seguro del "Cerebro" de 2brain.
 *
 * Esta ruta es deliberadamente de solo lectura: combina el estado local de
 * AgentOS con inventarios agregados de las fuentes heredadas (WhatsAppHub,
 * LLM Wiki y el snapshot de Notion), pero nunca devuelve contenido de páginas,
 * títulos, teléfonos, correos, tokens ni identificadores de Notion.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import {
  listAgents,
  listDocs,
  listPeople,
  listProjectSources,
  listProjects,
  listTasks,
  type Agent,
} from "@agentos/db";
import { computeOrgChainHealth, orgForCompany, type OrgNode } from "@agentos/core";
import { SourceConnectorError, type WhatsAppHubWikiPagesStatus, type WhatsAppHubWikiStats } from "@agentos/shared";
import type { ApiContext } from "../context.js";

export type BrainSourceStatus = "connected" | "degraded" | "not_configured" | "offline";

export interface BrainSource {
  id: "agentos" | "whatsapphub" | "llm_wiki" | "notion";
  label: string;
  status: BrainSourceStatus;
  mode: "local_sqlite" | "remote_read_only" | "filesystem_read_only" | "snapshot_read_only";
  last_checked_at: string | null;
  counts: Record<string, number>;
  detail: string;
  stages?: {
    tasks: readonly string[];
    projects: readonly string[];
  };
  /** Solo se usa para mostrar frescura; nunca contiene IDs ni URLs. */
  last_snapshot_at?: string | null;
}

export interface BrainOverview {
  generated_at: string;
  core: {
    counts: {
      projects: number;
      tasks: number;
      people: number;
      internal_people: number;
      agents: number;
      knowledge_docs: number;
      project_sources: number;
    };
    people: Array<{
      id: string;
      full_name: string;
      role: string | null;
      is_internal: boolean;
    }>;
  };
  agents: {
    items: BrainAgent[];
    tree: BrainOrgNode[];
    health: BrainAgentHealth[];
  };
  sources: BrainSource[];
  modules: BrainModule[];
}

export interface BrainAgent {
  id: string;
  slug: string;
  name: string;
  layer: Agent["layer"];
  runtime: Agent["runtime"];
  model: string | null;
  autonomy: Agent["autonomy"];
  status: Agent["status"];
  reports_to: string | null;
}

export interface BrainOrgNode {
  agent: BrainAgent;
  reports: BrainOrgNode[];
}

export interface BrainAgentHealth {
  id: string;
  slug: string;
  status: Agent["status"];
  reports_to: string | null;
  chain: Awaited<ReturnType<typeof computeOrgChainHealth>>;
}

export interface BrainModule {
  id: string;
  label: string;
  description: string;
  source_id: BrainSource["id"];
  status: "available" | "partial" | "offline";
}

const NOTION_TASK_STAGES = [
  "Sin empezar",
  "StandBy/Sin Información",
  "Realizando",
  "En validación",
  "Completada",
] as const;

const NOTION_PROJECT_STAGES = [
  "Sin empezar",
  "OnBoarding",
  "Implementacion",
  "En espera",
  "Finalizado",
  "Soporte Recurrente",
] as const;

function checkedAt(): string {
  return new Date().toISOString();
}

function mapAgent(agent: Agent): BrainAgent {
  return {
    id: agent.id,
    slug: agent.slug,
    name: agent.name,
    layer: agent.layer,
    runtime: agent.runtime,
    model: agent.model,
    autonomy: agent.autonomy,
    status: agent.status,
    reports_to: agent.reportsTo,
  };
}

function mapOrgNode(node: OrgNode): BrainOrgNode {
  return {
    agent: mapAgent(node.agent),
    reports: node.reports.map(mapOrgNode),
  };
}

function source(
  input: Omit<BrainSource, "last_checked_at"> & { last_checked_at?: string | null },
): BrainSource {
  return { ...input, last_checked_at: input.last_checked_at === undefined ? checkedAt() : input.last_checked_at };
}

function safeRemoteError(reason: unknown): string {
  if (reason instanceof SourceConnectorError) {
    if (reason.code === "timeout") return "WhatsAppHub no respondió a tiempo.";
    if (reason.code === "unreachable") return "WhatsAppHub no está disponible.";
    if (reason.code === "not_configured") return "El acceso agregado de WhatsAppHub no está configurado.";
    return "WhatsAppHub devolvió un error al consultar agregados.";
  }
  return "No fue posible leer los agregados de WhatsAppHub.";
}

function addWikiStats(counts: Record<string, number>, stats: WhatsAppHubWikiStats): void {
  for (const [key, value] of Object.entries(stats.counts)) {
    if (/^[a-z][a-z0-9_]{0,63}$/u.test(key) && Number.isSafeInteger(value) && value >= 0) {
      counts[key] = value;
    }
  }
}

function addWikiPagesStatus(counts: Record<string, number>, status: WhatsAppHubWikiPagesStatus): void {
  if (Number.isSafeInteger(status.total) && status.total >= 0) counts.wiki_pages = status.total;
  for (const [type, value] of Object.entries(status.byType)) {
    if (/^[a-z0-9_-]{1,64}$/u.test(type) && Number.isSafeInteger(value) && value >= 0) {
      counts[`wiki_pages_${type}`] = value;
    }
  }
}

async function inspectWhatsAppHub(ctx: ApiContext, at: string): Promise<BrainSource> {
  const connector = ctx.whatsappHub;
  const configured = connector.isOverviewConfigured?.() ?? connector.isConfigured();
  if (!configured) {
    return source({
      id: "whatsapphub",
      label: "2brain / WhatsAppHub",
      status: "not_configured",
      mode: "remote_read_only",
      counts: {},
      detail: "Configura AGENTOS_WHATSAPPHUB_URL para consultar agregados remotos.",
      last_checked_at: null,
    });
  }

  const statsReader = connector.getWikiStats;
  const pagesReader = connector.getWikiPagesStatus;
  if (!statsReader && !pagesReader) {
    return source({
      id: "whatsapphub",
      label: "2brain / WhatsAppHub",
      status: "degraded",
      mode: "remote_read_only",
      counts: {},
      detail: "El conector está configurado, pero aún no expone lecturas agregadas.",
      last_checked_at: at,
    });
  }

  const results = await Promise.all([
    statsReader ? statsReader().then((value) => ({ kind: "stats" as const, value })).catch((reason: unknown) => ({ kind: "stats" as const, reason })) : Promise.resolve(null),
    pagesReader ? pagesReader().then((value) => ({ kind: "pages" as const, value })).catch((reason: unknown) => ({ kind: "pages" as const, reason })) : Promise.resolve(null),
  ]);

  const counts: Record<string, number> = {};
  let successes = 0;
  const failures: string[] = [];
  for (const result of results) {
    if (!result) continue;
    if ("reason" in result) {
      failures.push(safeRemoteError(result.reason));
      continue;
    }
    successes += 1;
    if (result.kind === "stats") addWikiStats(counts, result.value);
    else addWikiPagesStatus(counts, result.value);
  }

  const attempted = results.filter((result) => result !== null).length;
  const status: BrainSourceStatus = successes === attempted ? "connected" : "degraded";
  const detail =
    status === "connected"
      ? "Agregados remotos disponibles en modo solo lectura."
      : failures.length > 0
        ? failures[0]!
        : "La lectura agregada está incompleta.";
  return source({
    id: "whatsapphub",
    label: "2brain / WhatsAppHub",
    status,
    mode: "remote_read_only",
    counts,
    detail,
    last_checked_at: at,
  });
}

async function countMarkdownFiles(root: string): Promise<number> {
  const rootStat = await stat(root);
  if (rootStat.isFile()) return root.toLowerCase().endsWith(".md") ? 1 : 0;
  if (!rootStat.isDirectory()) return 0;

  let count = 0;
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      // No seguimos symlinks: el inventario solo recorre el árbol explícito y
      // evita sorpresas si el wiki contiene enlaces fuera de su raíz.
      if (entry.isSymbolicLink()) continue;
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(child);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) count += 1;
    }
  }
  return count;
}

async function inspectLlmWiki(at: string): Promise<BrainSource> {
  const configuredPath = process.env.AGENTOS_LLM_WIKI_PATH?.trim();
  if (!configuredPath) {
    return source({
      id: "llm_wiki",
      label: "LLM Wiki local",
      status: "not_configured",
      mode: "filesystem_read_only",
      counts: {},
      detail: "Configura AGENTOS_LLM_WIKI_PATH para inventariar el wiki local.",
      last_checked_at: null,
    });
  }

  try {
    const markdownFiles = await countMarkdownFiles(path.resolve(configuredPath));
    return source({
      id: "llm_wiki",
      label: "LLM Wiki local",
      status: "connected",
      mode: "filesystem_read_only",
      counts: { markdown_files: markdownFiles },
      detail: "Inventario local disponible; no se leen ni se exponen contenidos.",
      last_checked_at: at,
    });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    return source({
      id: "llm_wiki",
      label: "LLM Wiki local",
      status: "offline",
      mode: "filesystem_read_only",
      counts: {},
      detail: code === "ENOENT" ? "La ruta configurada del LLM Wiki no existe." : "No se pudo leer el inventario del LLM Wiki.",
      last_checked_at: at,
    });
  }
}

interface NotionManifestSource {
  key?: unknown;
  pages_captured?: unknown;
  exceptions?: unknown;
}

interface NotionManifest {
  captured_at?: unknown;
  status?: unknown;
  sources?: unknown;
}

function nonNegativeCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function validIso(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

async function findNotionManifests(root: string): Promise<string[]> {
  const result: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(child);
      else if (entry.isFile() && entry.name === "manifest.json") result.push(child);
    }
  }
  return result;
}

async function readManifest(filePath: string): Promise<{ manifest: NotionManifest; mtime: number } | null> {
  try {
    const [raw, fileStat] = await Promise.all([readFile(filePath, "utf8"), stat(filePath)]);
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const manifest = value as NotionManifest;
    if (!Array.isArray(manifest.sources)) return null;
    return { manifest, mtime: fileStat.mtimeMs };
  } catch {
    return null;
  }
}

async function inspectNotion(at: string): Promise<BrainSource> {
  const configuredPath = process.env.AGENTOS_NOTION_SNAPSHOT_PATH?.trim();
  const root = path.resolve(configuredPath || path.join(process.cwd(), "data", "notion-snapshots"));
  const stages = { tasks: NOTION_TASK_STAGES, projects: NOTION_PROJECT_STAGES } as const;
  let files: string[];
  try {
    files = await findNotionManifests(root);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    return source({
      id: "notion",
      label: "Notion · Projects & Tasks (1)",
      status: code === "ENOENT" ? "not_configured" : "offline",
      mode: "snapshot_read_only",
      counts: {},
      detail: code === "ENOENT" ? "Aún no existe un snapshot de las dos páginas de Notion." : "No se pudo leer el directorio de snapshots de Notion.",
      stages,
      last_checked_at: code === "ENOENT" ? null : at,
    });
  }

  const candidates = (await Promise.all(files.map(readManifest))).filter(
    (value): value is { manifest: NotionManifest; mtime: number } => value !== null,
  );
  candidates.sort((a, b) => {
    const capturedA = validIso(a.manifest.captured_at);
    const capturedB = validIso(b.manifest.captured_at);
    return (capturedB ? Date.parse(capturedB) : b.mtime) - (capturedA ? Date.parse(capturedA) : a.mtime);
  });
  const selected = candidates[0];
  if (!selected) {
    return source({
      id: "notion",
      label: "Notion · Projects & Tasks (1)",
      status: "not_configured",
      mode: "snapshot_read_only",
      counts: {},
      detail: "No se encontró un manifest válido de las dos páginas de Notion.",
      stages,
      last_checked_at: null,
    });
  }

  const counts: Record<string, number> = {};
  const recognizedSources = new Set<"tasks" | "projects">();
  let duplicateSource = false;
  let exceptions = 0;
  for (const rawSource of selected.manifest.sources as unknown[]) {
    if (!rawSource || typeof rawSource !== "object" || Array.isArray(rawSource)) continue;
    const item = rawSource as NotionManifestSource;
    const key = item.key;
    const pages = nonNegativeCount(item.pages_captured);
    if ((key !== "tasks" && key !== "projects") || pages === undefined) continue;
    if (recognizedSources.has(key)) duplicateSource = true;
    counts[key] = pages;
    recognizedSources.add(key);
    if (Array.isArray(item.exceptions)) exceptions += item.exceptions.length;
  }
  if (recognizedSources.size !== 2 || duplicateSource) {
    return source({
      id: "notion",
      label: "Notion · Projects & Tasks (1)",
      status: "degraded",
      mode: "snapshot_read_only",
      counts,
      detail: duplicateSource
        ? "El snapshot contiene fuentes duplicadas y no puede considerarse completo."
        : "El snapshot existe, pero no contiene ambas fuentes Tasks y Projects esperadas.",
      stages,
      last_checked_at: at,
    });
  }
  if (exceptions > 0) counts.exceptions = exceptions;
  const capturedAt = validIso(selected.manifest.captured_at);
  const manifestStatus = selected.manifest.status;
  const validManifestStatus = manifestStatus === "completed" || manifestStatus === "completed_with_exceptions";
  const status: BrainSourceStatus =
    validManifestStatus && manifestStatus === "completed" && exceptions === 0 && capturedAt
      ? "connected"
      : "degraded";
  return source({
    id: "notion",
    label: "Notion · Projects & Tasks (1)",
    status,
    mode: "snapshot_read_only",
    counts,
    detail:
      status === "connected"
        ? "Snapshot de Tasks y Projects disponible en modo solo lectura."
        : !validManifestStatus
          ? "El manifest tiene un estado desconocido; el snapshot se conserva, pero no se declara completo."
          : !capturedAt
            ? "El snapshot no tiene una fecha de captura válida; se conserva, pero no se declara completo."
            : "Snapshot disponible con excepciones; conserva el origen sin escrituras.",
    stages,
    ...(capturedAt ? { last_snapshot_at: capturedAt } : {}),
    last_checked_at: at,
  });
}

function moduleStatus(status: BrainSourceStatus): BrainModule["status"] {
  if (status === "connected") return "available";
  if (status === "offline") return "offline";
  return "partial";
}

function buildModules(sources: BrainSource[]): BrainModule[] {
  const statusById = new Map(sources.map((item) => [item.id, item.status]));
  const moduleDefinitions: Array<[string, string, string, BrainSource["id"]]> = [
    ["board", "Tablero de proyectos y tareas", "Tareas y proyectos como verdad operativa.", "agentos"],
    ["agent-swarm", "Orquestación de agentes y subagentes", "Roster, jerarquía y salud de la cadena de mando.", "agentos"],
    ["meetings", "Reuniones y evidencias", "Reuniones y evidencias históricas del 2brain.", "whatsapphub"],
    ["wiki", "LLM Wiki / segundo cerebro", "Conocimiento y fuentes del 2brain.", "llm_wiki"],
    ["notion-migration", "Migración de Notion · Tasks y Projects", "Snapshot preservable de las dos páginas de origen.", "notion"],
    ["crm-whatsapp", "CRM y conversaciones de WhatsApp", "Conversaciones y agregados remotos en modo lectura.", "whatsapphub"],
    // Módulos internalizados de 2brain (cimientos): la lógica llega módulo por
    // módulo, pero ya cuentan en el panorama con su propia fuente.
    ["conversaciones", "Conversaciones", "Chats de WhatsApp del agente 2brain y sus acciones.", "whatsapphub"],
    ["voice_notes", "Notas de voz", "Notas transcritas y sincronizadas a Notion.", "whatsapphub"],
    ["recorder", "Grabadora", "Graba una nota de voz desde el móvil.", "whatsapphub"],
    ["videos", "Videos", "Transcripción de videos por URL.", "whatsapphub"],
    ["graph", "Grafo", "Contactos, empresas, reuniones y temas conectados.", "whatsapphub"],
    ["agent", "Agente 2brain", "Estado, prompt y herramientas del agente conversacional.", "whatsapphub"],
  ];
  return moduleDefinitions.map(([id, label, description, sourceId]) => ({
    id,
    label,
    description,
    source_id: sourceId,
    status: moduleStatus(statusById.get(sourceId) ?? "not_configured"),
  }));
}

async function localCore(db: ApiContext["db"]): Promise<BrainOverview["core"]> {
  const people = await listPeople(db);
  const projects = await listProjects(db);
  const tasks = await listTasks(db);
  const agents = await listAgents(db);
  const docs = await listDocs(db);
  const projectSources = await listProjectSources(db);
  return {
    counts: {
      projects: projects.length,
      tasks: tasks.length,
      people: people.length,
      internal_people: people.filter((person) => person.isInternal).length,
      agents: agents.length,
      knowledge_docs: docs.length,
      project_sources: projectSources.length,
    },
    people: people.map((person) => ({
      id: person.id,
      full_name: person.fullName,
      role: person.role,
      is_internal: person.isInternal,
    })),
  };
}

async function localAgents(db: ApiContext["db"]): Promise<BrainOverview["agents"]> {
  const agents = await listAgents(db);
  const tree = await orgForCompany(db);
  return {
    items: agents.map(mapAgent),
    tree: tree.map(mapOrgNode),
    health: await Promise.all(
      agents.map(async (agent) => ({
        id: agent.id,
        slug: agent.slug,
        status: agent.status,
        reports_to: agent.reportsTo,
        chain: await computeOrgChainHealth(db, agent.id),
      })),
    ),
  };
}

export function registerBrainRoutes(app: FastifyInstance, ctx: ApiContext): void {
  app.get("/api/brain/overview", async (): Promise<BrainOverview> => {
    const at = checkedAt();
    const [whatsapphub, llmWiki, notion, core, agents] = await Promise.all([
      inspectWhatsAppHub(ctx, at),
      inspectLlmWiki(at),
      inspectNotion(at),
      localCore(ctx.db),
      localAgents(ctx.db),
    ]);
    const sources: BrainSource[] = [
      source({
        id: "agentos",
        label: "AgentOS local",
        status: "connected",
        mode: "local_sqlite",
        counts: core.counts,
        detail: "Fuente de verdad local para tablero, agentes y contexto.",
        last_checked_at: at,
      }),
      whatsapphub,
      llmWiki,
      notion,
    ];
    return {
      generated_at: at,
      core,
      agents,
      sources,
      modules: buildModules(sources),
    };
  });
}
