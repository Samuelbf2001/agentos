/**
 * Contratos del catálogo de tools (ARCHITECTURE §4):
 * cada tool se declara UNA vez y se materializa por adaptadores.
 */
import type { z } from "zod";
import type { WhatsAppHubConnector } from "@agentos/shared";
import type { AgentosDb, Task, TaskAssignee } from "@agentos/db";
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
  /** Hook opcional para avisos de responsables; apagado si no se inyecta. */
  notifyAssignment?: (input: {
    task: Task;
    beforePersonIds: readonly string[];
    beforePrimaryPersonId?: string | null;
    afterAssignees: readonly TaskAssignee[];
    actor: string;
  }) => unknown | Promise<unknown>;
}

/**
 * Scope de proyecto de una tool (guarda fail-closed del gateway, solo para
 * actores agente): cómo se resuelve el proyecto OBJETIVO de la llamada.
 *
 * - `{by:"task"}`: `args[arg]` es un task_id (o `ctx.task_id` como fallback) →
 *   el objetivo es `task.projectId` (404 si la tarea no existe).
 * - `{by:"project"}`: `args[arg]` es el project_id objetivo. Si el argumento
 *   es opcional y viene vacío, no hay objetivo propio (hereda el ctx).
 * - `{by:"source"}`: `args[arg]` es un project_source id → `source.projectId`.
 * - `"ctx"`: sin objetivo propio; solo exige que el run tenga proyecto.
 * - `"none"`: la tool no pertenece a un proyecto (no se guarda).
 *
 * Regla: se deniega si `ctx.project_id` es null o distinto del objetivo.
 * Toda tool con `flags.read_only === false` DEBE declararlo (test de catálogo).
 */
export type ToolProjectScope =
  | { by: "task"; arg: string; fallback?: "ctx.task_id" }
  | { by: "project"; arg: string }
  | { by: "source"; arg: string }
  | "ctx"
  | "none";

/** Una tool del catálogo: nombre, schema Zod, handler y flags. */
export interface ToolDefinition<S extends z.ZodObject<z.ZodRawShape> = z.ZodObject<z.ZodRawShape>> {
  name: string;
  description: string;
  schema: S;
  flags: ToolFlags;
  /** Scope de proyecto (obligatorio en tools de escritura; opcional en lectura). */
  projectScope?: ToolProjectScope;
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
