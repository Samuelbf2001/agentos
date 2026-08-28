import path from "node:path";
import { AgentosError, ErrorCodes } from "@agentos/shared";
import { REPO_ROOT } from "@agentos/db";
import { resolveApiKey } from "@agentos/providers";
import type { RunInput, RunTraceContext } from "./types.js";

/** Workspaces por proyecto bajo la raíz del repo (ARCHITECTURE §3). */
export const DEFAULT_WORKSPACE_ROOT = path.join(REPO_ROOT, "data", "workspaces");

/**
 * Subset estructural de las Options del claude-agent-sdk que construimos.
 * Tipado propio para poder unit-testear la construcción sin depender del SDK
 * (el runner lo castea a `Options` al invocar `query()`).
 */
export interface BuiltClaudeCodeOptions {
  cwd: string;
  env: Record<string, string | undefined>;
  systemPrompt: { type: "preset"; preset: "claude_code"; append?: string };
  model?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  permissionMode: string;
  maxTurns?: number;
  resume?: string;
  mcpServers?: Record<string, unknown>;
  abortController?: AbortController;
}

export interface BuildClaudeCodeOptionsParams {
  input: RunInput;
  ctx: RunTraceContext;
  /** Entorno base (default process.env). El builder NUNCA lo muta. */
  baseEnv?: NodeJS.ProcessEnv;
  workspaceRoot?: string;
  abortController?: AbortController;
}

/** projects.workspace_path si viene; si falta, data/workspaces/<project_id>. */
export function resolveWorkspacePath(
  input: Pick<RunInput, "workspacePath">,
  ctx: Pick<RunTraceContext, "projectId">,
  workspaceRoot: string = DEFAULT_WORKSPACE_ROOT,
): string {
  if (input.workspacePath && input.workspacePath.trim().length > 0) {
    return path.resolve(input.workspacePath);
  }
  return path.join(workspaceRoot, ctx.projectId ?? "_sin-proyecto");
}

/**
 * Construye las opciones de `query()` (función PURA, unit-testeable sin CLI).
 *
 * Higiene de entorno (ARCHITECTURE §3, patrón OpenMausBot):
 * - `claude_subscription`: ELIMINA ANTHROPIC_API_KEY del env del hijo para que
 *   el CLI use el login de la suscripción y no facture API por accidente.
 * - `anthropic_api`: inyecta ANTHROPIC_API_KEY leída de process.env[api_key_env]
 *   (el valor jamás se persiste ni se loguea).
 * - Cualquier otro kind: el CLI solo habla Anthropic → rechazo fail-closed.
 */
export function buildClaudeCodeOptions(params: BuildClaudeCodeOptionsParams): BuiltClaudeCodeOptions {
  const { input, ctx } = params;
  const baseEnv = params.baseEnv ?? process.env;
  const profile = input.provider;

  const env: Record<string, string | undefined> = { ...baseEnv };
  if (profile.kind === "claude_subscription") {
    delete env.ANTHROPIC_API_KEY;
  } else if (profile.kind === "anthropic_api") {
    env.ANTHROPIC_API_KEY = resolveApiKey(profile, baseEnv);
  } else {
    throw new AgentosError(
      ErrorCodes.RUNNER_UNAVAILABLE,
      `ClaudeCodeRunner solo soporta perfiles claude_subscription | anthropic_api (recibido: ${profile.kind})`,
      { slug: profile.slug, kind: profile.kind },
    );
  }

  const allowedTools = input.agent.toolsAllowlist;
  const disallowedTools = input.agent.disallowedTools;

  const options: BuiltClaudeCodeOptions = {
    cwd: resolveWorkspacePath(input, ctx, params.workspaceRoot),
    env,
    // Persona del agente vía append al preset del CLI (no lo reemplaza).
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      ...(input.systemPrompt ? { append: input.systemPrompt } : {}),
    },
    // Fail-closed: sin prompts interactivos; lo no pre-aprobado se niega.
    permissionMode: input.permissionMode ?? "dontAsk",
  };

  const model = input.model ?? input.agent.model ?? undefined;
  if (model) options.model = model;
  if (allowedTools && allowedTools.length > 0) options.allowedTools = [...allowedTools];
  if (disallowedTools && disallowedTools.length > 0) options.disallowedTools = [...disallowedTools];
  if (input.budget?.maxSteps !== undefined) options.maxTurns = input.budget.maxSteps;
  if (input.resumeSessionId) options.resume = input.resumeSessionId;
  if (input.domainTools) {
    // Las tools de dominio del catálogo (B3) llegan como servidor MCP in-process.
    options.mcpServers = { agentos: input.domainTools.asSdkMcpServer() };
  }
  if (params.abortController) options.abortController = params.abortController;

  return options;
}
