/**
 * Modelo de la bandeja "Hoy" (PLAN-v1.5 §La pantalla de entrada).
 *
 * La bandeja vieja concatenaba aprobaciones y entregables en el orden en que
 * llegaban. Aquí se convierten en decisiones comparables: cada una sabe qué
 * desbloquea, de qué proyecto es, cuánto riesgo tiene y desde cuándo espera.
 * Todo son funciones puras para poder probarlas sin montar la pantalla.
 */
import type { Approval, Artifact, Project, Stage, Task } from "./types";
import { STAGES } from "./types";

export type DecisionRisk = "alto" | "medio" | "bajo";

export type DecisionKind = "gate" | "tool_call" | "deliverable" | "review";

export interface Decision {
  /** Clave estable para React y para la selección en lote. */
  id: string;
  kind: DecisionKind;
  risk: DecisionRisk;
  /** Qué hay que decidir, en una frase. */
  title: string;
  /** Qué desbloquea la decisión. */
  unlocks: string;
  projectId: string | null;
  taskId: string | null;
  runId: string | null;
  /** Desde cuándo espera. */
  waitingSince: number;
  approval: Approval | null;
  task: Task | null;
  artifacts: Artifact[];
}

export const RISK_WEIGHT: Record<DecisionRisk, number> = { alto: 0, medio: 1, bajo: 2 };

export const RISK_LABELS: Record<DecisionRisk, string> = {
  alto: "Decidir ya",
  medio: "Decidir",
  bajo: "Puede esperar",
};

export const KIND_LABELS: Record<DecisionKind, string> = {
  gate: "Gate de fase",
  tool_call: "Efecto sobre el cliente",
  deliverable: "Entregable",
  review: "Entregable en revisión",
};

/** Etiqueta de la fase que sigue; null cuando ya no hay siguiente. */
export function nextStage(stage: Stage): Stage | null {
  const i = STAGES.indexOf(stage);
  return i >= 0 && i < STAGES.length - 1 ? (STAGES[i + 1] as Stage) : null;
}

const STAGE_WORD: Record<Stage, string> = {
  ENTENDER: "Entender",
  CONSTRUIR: "Construir",
  OPERAR: "Operar",
};

function approvalRisk(kind: Approval["kind"]): DecisionRisk {
  // Un gate habilita la etapa siguiente y un tool_call ejecuta un efecto real
  // sobre el cliente: ninguno de los dos se aprueba en lote.
  if (kind === "gate" || kind === "tool_call") return "alto";
  return "medio";
}

function approvalTool(approval: Approval): string | null {
  const tool = (approval.payload as { tool?: unknown }).tool;
  return typeof tool === "string" && tool ? tool : null;
}

function approvalTitle(approval: Approval, project: Project | undefined): string {
  if (approval.kind === "gate") {
    return project ? `Aprobar el gate de ${STAGE_WORD[project.stage]}` : "Aprobar el gate de fase";
  }
  if (approval.kind === "tool_call") {
    const tool = approvalTool(approval);
    return tool ? `Autorizar ${tool}` : "Autorizar una acción sobre el cliente";
  }
  return "Aprobar un entregable";
}

function approvalUnlocks(approval: Approval, project: Project | undefined): string {
  if (approval.kind === "gate") {
    const next = project ? nextStage(project.stage) : null;
    if (project && next) return `Cierra ${STAGE_WORD[project.stage]} y abre ${STAGE_WORD[next]}.`;
    return "Habilita la etapa siguiente del proyecto.";
  }
  if (approval.kind === "tool_call") {
    return "Al aprobar, la plataforma ejecuta el efecto sobre el sistema del cliente.";
  }
  return "Cierra el trabajo del agente y libera lo que dependía de él.";
}

export function decisionFromApproval(approval: Approval, project: Project | undefined): Decision {
  return {
    id: `approval:${approval.id}`,
    kind: approval.kind === "gate" ? "gate" : approval.kind === "tool_call" ? "tool_call" : "deliverable",
    risk: approvalRisk(approval.kind),
    title: approvalTitle(approval, project),
    unlocks: approvalUnlocks(approval, project),
    projectId: approval.projectId,
    taskId: approval.taskId,
    runId: approval.runId,
    waitingSince: approval.createdAt,
    approval,
    task: null,
    artifacts: [],
  };
}

export function decisionFromReview(task: Task, artifacts: Artifact[]): Decision {
  // Un entregable que además pide aprobación o toca fuera vale más que una
  // revisión rutinaria: sólo las rutinarias entran en el lote. Un REVIEW sin
  // artefacto no puede ser "bajo": el motor rechaza REVIEW/DONE sin evidencia,
  // así que llegar aquí sin artefactos ya es una anomalía que pide mirar (M5).
  const sensitive = task.requiresApproval || task.externalEffect;
  const risk: DecisionRisk = artifacts.length === 0 ? "medio" : sensitive ? "medio" : "bajo";
  return {
    id: `review:${task.id}`,
    kind: "review",
    risk,
    title: task.title,
    unlocks: sensitive
      ? "Cierra la tarea y confirma un entregable marcado como sensible."
      : "Cierra la tarea y libera lo que depende de ella.",
    projectId: task.projectId,
    taskId: task.id,
    runId: null,
    waitingSince: task.updatedAt,
    approval: null,
    task,
    artifacts,
  };
}

export function buildDecisions(
  approvals: Approval[],
  reviews: { task: Task; artifacts: Artifact[] }[],
  projects: Project[] = [],
): Decision[] {
  const byId = new Map(projects.map((p) => [p.id, p]));
  return [
    ...approvals.map((a) => decisionFromApproval(a, a.projectId ? byId.get(a.projectId) : undefined)),
    ...reviews.map((r) => decisionFromReview(r.task, r.artifacts)),
  ];
}

/** Riesgo primero; a igual riesgo, la que lleva más tiempo esperando. */
export function sortByRisk(decisions: Decision[]): Decision[] {
  return [...decisions].sort((a, b) => {
    const byRisk = RISK_WEIGHT[a.risk] - RISK_WEIGHT[b.risk];
    if (byRisk !== 0) return byRisk;
    return a.waitingSince - b.waitingSince;
  });
}

export interface DecisionGroup {
  /** `${projectId}|${kind}` */
  key: string;
  projectId: string | null;
  projectName: string;
  kind: DecisionKind;
  decisions: Decision[];
}

/**
 * Agrupa por proyecto y, dentro, por gate (el tipo de decisión). El orden de
 * los grupos hereda el de la decisión más urgente que contienen.
 */
export function groupDecisions(decisions: Decision[], projects: Project[] = []): DecisionGroup[] {
  const names = new Map(projects.map((p) => [p.id, p.name]));
  const groups = new Map<string, DecisionGroup>();
  for (const decision of sortByRisk(decisions)) {
    const key = `${decision.projectId ?? "sin-proyecto"}|${decision.kind}`;
    const existing = groups.get(key);
    if (existing) {
      existing.decisions.push(decision);
      continue;
    }
    groups.set(key, {
      key,
      projectId: decision.projectId,
      projectName: decision.projectId
        ? (names.get(decision.projectId) ?? "Proyecto")
        : "Sin proyecto",
      kind: decision.kind,
      decisions: [decision],
    });
  }
  return [...groups.values()];
}

/** Las que se pueden aprobar en lote: sólo riesgo bajo. */
export function batchable(decisions: Decision[]): Decision[] {
  return sortByRisk(decisions).filter((d) => d.risk === "bajo");
}

export function daysWaiting(decision: Decision, now = Date.now()): number {
  return Math.max(0, Math.floor((now - decision.waitingSince) / 86_400_000));
}

// ── Resumen legible del payload: nunca JSON crudo como contenido principal ──

export interface PayloadLine {
  label: string;
  value: string;
}

function renderValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (Array.isArray(value)) return value.map((v) => renderValue(v)).join(", ");
  if (typeof value === "boolean") return value ? "sí" : "no";
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `${k}: ${renderValue(v)}`)
      .join(" · ");
  }
  return String(value);
}

/**
 * Convierte el payload de una aprobación en líneas legibles. El payload literal
 * sigue disponible bajo un desplegable: el digest liga la aprobación a él, pero
 * no es lo que la persona necesita leer para decidir.
 */
export function summarizePayload(payload: Record<string, unknown>): PayloadLine[] {
  const lines: PayloadLine[] = [];
  const args = payload.args;
  if (args && typeof args === "object" && !Array.isArray(args)) {
    for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
      lines.push({ label: k, value: renderValue(v) });
    }
  }
  for (const [k, v] of Object.entries(payload)) {
    if (k === "args" || k === "tool") continue;
    lines.push({ label: k, value: renderValue(v) });
  }
  return lines;
}
