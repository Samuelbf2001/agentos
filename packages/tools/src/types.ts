/**
 * Contratos del catálogo de tools (ARCHITECTURE §4):
 * cada tool se declara UNA vez y se materializa por adaptadores.
 */
import type { z } from "zod";
import type { WhatsAppHubConnector } from "@agentos/shared";
import type { AgentosDb } from "@agentos/db";
import type { BoardEngine, EventSink } from "@agentos/core";

/** Flags de política de una tool. */
export interface ToolFlags {
  read_only: boolean;
  external_effect: boolean;
  requires_approval: boolean;
}

/**
 * Contexto de una llamada (ARCHITECTURE §10):
 * `ctx = {run_id, span_id, agent_id, task_id, project_id, actor}`.
 */
export interface ToolCallContext {
  run_id: string | null;
  span_id?: string | null;
  /** id de DB o slug del agente que llama. */
  agent_id: string;
  task_id?: string | null;
  project_id?: string | null;
  /** ActorRef: agent:<slug> | person:<id> | system:<comp>. */
  actor: string;
}

/** Contexto que reciben los handlers: llamada + infraestructura inyectada. */
export interface ToolExecutionContext extends ToolCallContext {
  db: AgentosDb;
  sink: EventSink;
  engine: BoardEngine;
  /** Base para workspaces de proyecto sin `workspace_path` propio. */
  workspaceRoot: string;
  /** Conector WhatsAppHub (Fuentes del proyecto). Ausente = no configurado. */
  whatsappHub?: WhatsAppHubConnector | undefined;
}

/** Una tool del catálogo: nombre, schema Zod, handler y flags. */
export interface ToolDefinition<S extends z.ZodObject<z.ZodRawShape> = z.ZodObject<z.ZodRawShape>> {
  name: string;
  description: string;
  schema: S;
  flags: ToolFlags;
  handler: (ctx: ToolExecutionContext, args: z.infer<S>) => unknown | Promise<unknown>;
}

/** Resultado del gateway. Una tool de efecto externo NUNCA devuelve 'ok' directo. */
export type GatewayResult =
  | { status: "ok"; result: unknown }
  | { status: "pending_approval"; approval_id: string };

export interface ToolRuntime {
  catalog: ReadonlyMap<string, ToolDefinition>;
  engine: BoardEngine;
  db: AgentosDb;
  /** Gateway único fail-closed (política → audit → handler). */
  execute(ctx: ToolCallContext, name: string, args: unknown): Promise<GatewayResult>;
  /** Ejecuta el payload de una aprobación tool_call YA aprobada (reanudación B4). */
  executeApproved(ctx: ToolCallContext, approvalId: string): Promise<GatewayResult>;
}
