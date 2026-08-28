import { z } from "zod";

/**
 * Schemas Zod base — enums copiados de ARCHITECTURE.md (§3, §5, §6, §8b).
 * Son la fuente única para tipos de dominio; la capa de datos y las tools los reutilizan.
 */

// ── Organización ────────────────────────────────────────────────────────────
export const OrgKind = z.enum(["internal", "client"]);
export type OrgKind = z.infer<typeof OrgKind>;

export const ProjectType = z.enum(["assessment", "transform", "ops"]);
export type ProjectType = z.infer<typeof ProjectType>;

/** Etapa de la metodología Sixteam — carril del kanban (ARCHITECTURE §6). */
export const Stage = z.enum(["ENTENDER", "CONSTRUIR", "OPERAR"]);
export type Stage = z.infer<typeof Stage>;

/** Estado del Gate 1 a nivel proyecto (cerrar ENTENDER exige aprobación humana). */
export const GateState = z.enum(["pending", "approved", "rejected"]);
export type GateState = z.infer<typeof GateState>;

// ── Tablero (ARCHITECTURE §6: 7 estados) ────────────────────────────────────
export const TaskStatus = z.enum([
  "BACKLOG",
  "READY",
  "IN_PROGRESS",
  "BLOCKED",
  "REVIEW",
  "DONE",
  "CANCELLED",
]);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const BlockedReason = z.enum(["approval", "stuck", "manual", "dependency"]);
export type BlockedReason = z.infer<typeof BlockedReason>;

export const TaskPriority = z.enum(["low", "normal", "high", "urgent"]);
export type TaskPriority = z.infer<typeof TaskPriority>;

// ── Agentes y runtime (ARCHITECTURE §3) ─────────────────────────────────────
export const AgentRuntime = z.enum(["claude_code", "ai_sdk"]);
export type AgentRuntime = z.infer<typeof AgentRuntime>;

export const AgentLayer = z.enum(["consultoria", "implementacion", "operacion", "meta"]);
export type AgentLayer = z.infer<typeof AgentLayer>;

export const AgentStatus = z.enum(["active", "paused", "disabled"]);
export type AgentStatus = z.infer<typeof AgentStatus>;

export const AgentAutonomy = z.enum(["manual", "supervised", "auto"]);
export type AgentAutonomy = z.infer<typeof AgentAutonomy>;

// ── Proveedores LLM (ARCHITECTURE §5 provider_profiles) ─────────────────────
export const ProviderKind = z.enum(["claude_subscription", "anthropic_api", "openai_compatible"]);
export type ProviderKind = z.infer<typeof ProviderKind>;

/** Flags de capacidad por proveedor/driver: "nunca mostrar un knob que el driver no puede girar". */
export const ProviderCapabilities = z.object({
  tool_calling: z.boolean().default(false),
  streaming: z.boolean().default(false),
  vision: z.boolean().default(false),
  computer_use: z.boolean().default(false),
  prompt_cache: z.boolean().default(false),
});
export type ProviderCapabilities = z.infer<typeof ProviderCapabilities>;

// ── Observabilidad (ARCHITECTURE §5, §10) ───────────────────────────────────
export const RunStatus = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
]);
export type RunStatus = z.infer<typeof RunStatus>;

export const RunTrigger = z.enum(["chat", "dispatcher", "approval_resume", "manual", "system"]);
export type RunTrigger = z.infer<typeof RunTrigger>;

export const SpanKind = z.enum(["llm", "tool", "subrun", "internal"]);
export type SpanKind = z.infer<typeof SpanKind>;

// ── Gobierno (ARCHITECTURE §5, §6 G1/G2) ────────────────────────────────────
export const ApprovalKind = z.enum(["tool_call", "deliverable", "gate"]);
export type ApprovalKind = z.infer<typeof ApprovalKind>;

export const ApprovalStatus = z.enum(["pending", "approved", "rejected"]);
export type ApprovalStatus = z.infer<typeof ApprovalStatus>;

/** Origen de una mutación en audit_log. */
export const AuditSource = z.enum(["ui", "mcp", "agent", "system"]);
export type AuditSource = z.infer<typeof AuditSource>;

// ── Contexto y metodología (ARCHITECTURE §8b) ───────────────────────────────
export const KnowledgeKind = z.enum([
  "org_profile",
  "process_map",
  "interview",
  "finding",
  "decision",
  "iso_clause",
  "evidence",
  "template",
  "note",
]);
export type KnowledgeKind = z.infer<typeof KnowledgeKind>;

export const ProcessVariant = z.enum(["as_is", "to_be"]);
export type ProcessVariant = z.infer<typeof ProcessVariant>;

export const ProcessStatus = z.enum(["draft", "validated"]);
export type ProcessStatus = z.infer<typeof ProcessStatus>;

/** Paso de un proceso mapeado (base SIPOC). */
export const ProcessStep = z.object({
  step: z.string(),
  responsible: z.string().optional(),
  system: z.string().optional(),
  input: z.string().optional(),
  output: z.string().optional(),
});
export type ProcessStep = z.infer<typeof ProcessStep>;

// ── Canales / conversación (ARCHITECTURE §9) ────────────────────────────────
export const MessageRole = z.enum(["user", "assistant", "system", "tool"]);
export type MessageRole = z.infer<typeof MessageRole>;

/**
 * Actor canónico para atribución ("movida por Sam"):
 * `agent:<slug>` | `person:<id>` | `system:<component>`.
 */
export const ActorRef = z
  .string()
  .regex(/^(agent|person|system):[A-Za-z0-9_.-]+$/, "actor debe ser agent:|person:|system:<ref>");
export type ActorRef = z.infer<typeof ActorRef>;
