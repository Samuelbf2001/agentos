/**
 * Carga de definiciones semilla desde markdown con frontmatter
 * (`agents/*.md`, `methodologies/*.md` — ARCHITECTURE §8/§8b).
 * La fuente de verdad en ejecución es la DB; estos ficheros son el seed
 * versionado en git y `seed_hash` delata divergencia.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import {
  errors,
  AgentAutonomy,
  AgentLayer,
  AgentRuntime,
  blueprintHash,
  canonicalizeBlueprint,
  validateBlueprint,
  type ModuleBlueprint,
  type ModuleStatus,
  type ProjectType,
  type Stage,
} from "@agentos/shared";
import { z } from "zod";
import { REPO_ROOT } from "./client.js";

export const AGENTS_DIR = path.join(REPO_ROOT, "agents");
export const METHODOLOGIES_DIR = path.join(REPO_ROOT, "methodologies");
export const MODULES_DIR = path.join(REPO_ROOT, "modules");

const AgentFrontmatter = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  layer: AgentLayer,
  runtime: AgentRuntime,
  provider_profile: z.string().min(1),
  model: z.string().min(1),
  autonomy: AgentAutonomy.default("supervised"),
  tools: z.array(z.string()).default([]),
  /**
   * Manager en el organigrama (Fase 2): slug de otro agente, o `null`/omitido = raíz.
   * El seed lo resuelve a `agents.reports_to` en una segunda pasada (el id del
   * manager puede no existir aún al crear la fila).
   */
  reports_to: z.string().min(1).nullable().default(null),
});
export type AgentFrontmatter = z.infer<typeof AgentFrontmatter>;

export interface ParsedAgentSeed {
  file: string;
  hash: string;
  meta: AgentFrontmatter;
  prompt: { stable: string; context: string; volatile: string };
}

const MethodologyFrontmatter = z.object({
  slug: z.string().min(1),
  version: z.number().int().positive(),
});

export interface ParsedMethodologySeed {
  file: string;
  hash: string;
  slug: string;
  version: number;
  bodyMd: string;
}

export function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Separa frontmatter YAML y cuerpo. Exportada: `modules/*.md` la reutiliza (§13.2). */
export function splitFrontmatter(raw: string, file: string): { meta: unknown; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!match) throw errors.validation(`Seed sin frontmatter: ${file}`);
  return { meta: YAML.parse(match[1]!), body: match[2] ?? "" };
}

/** Extrae las secciones `## stable` / `## context` / `## volatile` del cuerpo. */
function splitPromptLayers(body: string): { stable: string; context: string; volatile: string } {
  const sections: Record<string, string> = {};
  const re = /^##\s+(stable|context|volatile)\s*$/gim;
  const headers: { name: string; headerStart: number; contentStart: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    headers.push({ name: m[1]!.toLowerCase(), headerStart: m.index, contentStart: re.lastIndex });
  }
  headers.forEach((h, i) => {
    const end = headers[i + 1]?.headerStart ?? body.length;
    sections[h.name] = body.slice(h.contentStart, end).trim();
  });
  return {
    stable: sections["stable"] ?? body.trim(),
    context: sections["context"] ?? "",
    volatile: sections["volatile"] ?? "",
  };
}

export function parseAgentSeed(file: string): ParsedAgentSeed {
  const raw = fs.readFileSync(file, "utf8");
  const { meta, body } = splitFrontmatter(raw, file);
  const parsed = AgentFrontmatter.safeParse(meta);
  if (!parsed.success) {
    throw errors.validation(`Frontmatter inválido en ${file}`, parsed.error.issues);
  }
  return {
    file: path.relative(REPO_ROOT, file).replaceAll("\\", "/"),
    hash: sha256(raw),
    meta: parsed.data,
    prompt: splitPromptLayers(body),
  };
}

export function loadAgentSeeds(dir: string = AGENTS_DIR): ParsedAgentSeed[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => parseAgentSeed(path.join(dir, f)));
}

export function parseMethodologySeed(file: string): ParsedMethodologySeed {
  const raw = fs.readFileSync(file, "utf8");
  const { meta, body } = splitFrontmatter(raw, file);
  const parsed = MethodologyFrontmatter.safeParse(meta);
  if (!parsed.success) {
    throw errors.validation(`Frontmatter inválido en ${file}`, parsed.error.issues);
  }
  return {
    file: path.relative(REPO_ROOT, file).replaceAll("\\", "/"),
    hash: sha256(raw),
    slug: parsed.data.slug,
    version: parsed.data.version,
    bodyMd: body.trim(),
  };
}

export function loadMethodologySeeds(dir: string = METHODOLOGIES_DIR): ParsedMethodologySeed[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => parseMethodologySeed(path.join(dir, f)));
}

// ── Módulos de fase (`modules/*.md` — §13.2) ────────────────────────────────

export interface ParsedModuleSeed {
  slug: string;
  version: number;
  name: string;
  phase: Stage;
  projectType: ProjectType;
  status?: ModuleStatus;
  methodology: { slug: string; version: number | null };
  /** Frontmatter completo CANONICALIZADO (claves ordenadas) — ES el blueprint. */
  blueprint: ModuleBlueprint;
  blueprintHash: string;
  bodyMd: string;
  seedFile: string;
  /** sha256 del archivo completo (frontmatter + cuerpo) — delata divergencia. */
  seedHash: string;
}

/**
 * Parsea y VALIDA una semilla de módulo (patrón `parseAgentSeed`): un blueprint
 * inválido LANZA con los issues en details — fail-closed desde el seed (§13.5 A).
 */
export function parseModuleSeed(file: string): ParsedModuleSeed {
  const raw = fs.readFileSync(file, "utf8");
  const { meta, body } = splitFrontmatter(raw, file);
  const result = validateBlueprint(meta);
  if (!result.ok || !result.blueprint) {
    throw errors.validation(`Blueprint de módulo inválido en ${file}`, result.issues);
  }
  const canonical = canonicalizeBlueprint(meta);
  // JSON.parse del canónico: objeto con claves YA ordenadas — lo que persiste la DB.
  const blueprint = JSON.parse(canonical) as ModuleBlueprint;
  const bp = result.blueprint;
  return {
    slug: bp.slug,
    version: bp.version,
    name: bp.name,
    phase: bp.phase,
    projectType: bp.project_type,
    ...(bp.status !== undefined ? { status: bp.status } : {}),
    methodology: { slug: bp.methodology.slug, version: bp.methodology.version },
    blueprint,
    blueprintHash: blueprintHash(canonical),
    bodyMd: body.trim(),
    seedFile: path.relative(REPO_ROOT, file).replaceAll("\\", "/"),
    seedHash: sha256(raw),
  };
}

export function loadModuleSeeds(dir: string = MODULES_DIR): ParsedModuleSeed[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => parseModuleSeed(path.join(dir, f)));
}
