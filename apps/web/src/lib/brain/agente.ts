/**
 * 2brain › Agente 2brain: cliente del módulo (estado, configuración y edición
 * del prompt del agente conversacional/extractor de WhatsAppHub). Habla SOLO
 * con `apps/api` (`/api/brain/agente/*`), que a su vez proxea el hub.
 */
import { apiRequest } from "../api";

export interface AgentTool {
  name: string;
  description: string | null;
  input_schema?: unknown;
}

export interface AgentStatus {
  notion: boolean;
  kapso: boolean;
  whatsapp_reminders: boolean;
  wiki_notes: boolean;
}

export interface AgentConfig {
  prompt_default: string;
  prompt_override: string | null;
  prompt_effective: string;
  tools: AgentTool[];
  chat_tools: AgentTool[];
  chat_enabled: boolean;
}

/** Mismo tope que el hub (`agent.controller.js`): un solo lugar de verdad. */
export const AGENT_PROMPT_MAX_LENGTH = 50_000;

export function fetchAgentStatus(): Promise<AgentStatus> {
  return apiRequest<AgentStatus>("/api/brain/agente/status");
}

export function fetchAgentConfig(): Promise<AgentConfig> {
  return apiRequest<AgentConfig>("/api/brain/agente/config");
}

/** `prompt: null` restablece el prompt por defecto (mismo contrato que el hub). */
export function updateAgentPrompt(prompt: string | null): Promise<AgentConfig> {
  return apiRequest<AgentConfig>("/api/brain/agente/config", { method: "PUT", body: { prompt } });
}
