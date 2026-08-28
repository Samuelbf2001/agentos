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
import { errors, AgentAutonomy, AgentLayer, AgentRuntime } from "@agentos/shared";
import { z } from "zod";
import { REPO_ROOT } from "./client.js";

export const AGENTS_DIR = path.join(REPO_ROOT, "agents");
export const METHODOLOGIES_DIR = path.join(REPO_ROOT, "methodologies");

const AgentFrontmatter = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  layer: AgentLayer,
  runtime: AgentRuntime,
  provider_profile: z.string().min(1),
  model: z.string().min(1),
  autonomy: AgentAutonomy.default("supervised"),
  tools: z.array(z.string()).default([]),
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

function splitFrontmatter(raw: string, file: string): { meta: unknown; body: string } {
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
