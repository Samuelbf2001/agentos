import type { AgentRuntime, RunTrigger } from "@agentos/shared";
import type { AgentosDb, ProviderProfile } from "@agentos/db";
import type { AgUiEvent } from "@agentos/events";
import type { ModelMessage, ToolSet } from "ai";

/**
 * Contratos del runtime de agentes (ARCHITECTURE §3).
 * La interfaz es el punto fijo; los runners (AiSdkRunner, ClaudeCodeRunner)
 * son intercambiables detrás de ella.
 */

/** Contexto de trazabilidad §10: viaja por TODO handler y cada span/evento. */
export interface RunTraceContext {
  runId: string;
  rootRunId: string;
  parentRunId?: string | null;
  taskId?: string | null;
  projectId?: string | null;
  agentId?: string | null;
  /** `agent:<slug>` | `person:<id>` | `system:<component>` */
  actor?: string;
  trigger?: RunTrigger;
}

/** Presupuesto por run; superarlo corta DURO con `budget_exceeded` (NFR-5). */
export interface RunBudget {
  /** Pasos del loop (stopWhen stepCountIs). */
  maxSteps?: number;
  /** Tokens totales (in+out) acumulados. */
  maxTokens?: number;
  /** Coste USD acumulado (solo aplicable si el perfil tiene tarifas). */
  maxUsd?: number;
  /** Tiempo de pared en ms. */
  maxMs?: number;
}

/**
 * Interfaz de inyección de tools de dominio (llegan del paquete tools, B3).
 * Tipada laxa a propósito: runners NO depende de @agentos/tools.
 */
export interface DomainTools {
  /** Materialización para AiSdkRunner: ToolSet del AI SDK. */
  asAiSdkTools(): Record<string, unknown>;
  /** Materialización para ClaudeCodeRunner: servidor MCP in-process (createSdkMcpServer). */
  asSdkMcpServer(): unknown;
}

/** Tarjeta mínima del agente que un runner necesita (subset de la fila `agents`). */
export interface AgentCard {
  slug: string;
  name?: string;
  model?: string | null;
  /** Allowlist de tools built-in (claude_code) o nombres de catálogo. */
  toolsAllowlist?: string[];
  /** Denylist explícita de tools built-in (claude_code). */
  disallowedTools?: string[];
  autonomy?: string;
}

export interface RunInput {
  agent: AgentCard;
  /** Prompt de 3 capas YA ensamblado (stable + context + volatile). */
  systemPrompt: string;
  /** Historial de mensajes (AiSdkRunner). */
  messages: ModelMessage[];
  /**
   * Prompt de usuario plano para ClaudeCodeRunner (query() recibe texto).
   * Si falta, se deriva del último mensaje user de `messages`.
   */
  prompt?: string;
  /** Tools YA filtradas por la allowlist del agente (AiSdkRunner). */
  tools?: ToolSet;
  /** Tools de dominio inyectadas por el paquete tools (B3). */
  domainTools?: DomainTools;
  /** Perfil de proveedor (fila de provider_profiles). */
  provider: ProviderProfile;
  /** Override del modelo (si falta: agent.model). */
  model?: string;
  budget?: RunBudget;
  /** Continuidad claude_code: session id de un run anterior. */
  resumeSessionId?: string;
  /** projects.workspace_path; si falta se deriva data/workspaces/<project_id>. */
  workspacePath?: string;
  /** permissionMode del CLI (default fail-closed: 'dontAsk'). */
  permissionMode?: string;
}

/** Interfaz canónica del runtime (ARCHITECTURE §3). */
export interface AgentRunner {
  readonly runtime: AgentRuntime;
  run(input: RunInput, ctx: RunTraceContext): AsyncIterable<AgUiEvent>;
  cancel(runId: string): Promise<void>;
}

export interface RunnerDeps {
  db: AgentosDb;
  now?: () => number;
}

/**
 * Texto sintético que cierra tool-calls huérfanos (presupuesto/cancelación)
 * para no romper el turno siguiente del proveedor (patrón OpenBot).
 */
export const NO_ANSWER_CAME = "NO_ANSWER_CAME" as const;
