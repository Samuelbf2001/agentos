/**
 * Topics del bus (ARCHITECTURE §2):
 * `run:<id>` | `board:<project_id>` | `thread:<id>` | `swarm` | `approvals` | `channel:<name>`.
 * Helpers para no repartir strings mágicos por el código.
 */

export const SWARM_TOPIC = "swarm" as const;
export const APPROVALS_TOPIC = "approvals" as const;

export function runTopic(runId: string): string {
  return `run:${runId}`;
}

export function boardTopic(projectId: string): string {
  return `board:${projectId}`;
}

export function threadTopic(threadId: string): string {
  return `thread:${threadId}`;
}

export function channelTopic(name: string): string {
  return `channel:${name}`;
}

const TOPIC_RE = /^(run:[^\s:]+|board:[^\s:]+|thread:[^\s:]+|channel:[^\s:]+|swarm|approvals)$/;

/** Valida la forma de un topic (fail-closed: topic desconocido = inválido). */
export function isValidTopic(topic: string): boolean {
  return TOPIC_RE.test(topic);
}
