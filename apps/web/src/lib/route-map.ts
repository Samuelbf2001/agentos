/**
 * Mapa del ciclo (PLAN-v1.5 §Cómo se representa el avance).
 *
 * Tres columnas —Entender, Construir y Operar— con los hitos en vertical y los
 * gates intercalados como candados. Se dibuja con rejilla CSS, no con React
 * Flow: no es un grafo libre, es una secuencia conocida.
 *
 * Todo sale de datos que la API ya devuelve: la fase del proyecto, el estado
 * del gate, el recibo de lanzamiento y el estado de cierre de fase. Aquí sólo
 * viven las funciones puras que los combinan.
 */
import type { PhaseClosureItem, PhaseClosureStatus, Project, Stage, Task } from "./types";
import { STAGES } from "./types";
import type { GateState } from "../components/system";

export interface Milestone {
  key: string;
  label: string;
  total: number;
  done: number;
  /** `done` = todas cerradas, `now` = hay trabajo en curso, `open` = sin empezar. */
  state: "done" | "now" | "open";
  taskIds: string[];
}

export interface CycleGate {
  code: string;
  /** Etapa que cierra este gate. */
  stage: Stage;
  state: GateState;
  caption: string;
}

export interface CycleColumn {
  stage: Stage;
  status: "closed" | "active" | "blocked";
  milestones: Milestone[];
  gate: CycleGate | null;
}

/** Códigos estables por etapa; el gate cierra la etapa que lleva su nombre. */
export const GATE_CODES: Record<Stage, string> = {
  ENTENDER: "G1",
  CONSTRUIR: "G2",
  OPERAR: "G3",
};

const STAGE_WORD: Record<Stage, string> = {
  ENTENDER: "Entender",
  CONSTRUIR: "Construir",
  OPERAR: "Operar",
};

export function normalizeKind(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[_\-.]+/g, " ")
    .trim();
}

/**
 * Vocabulario de la metodología en castellano. Las claves son las que usan los
 * módulos (`modules/*.md`) y el cierre de fase; lo que no esté aquí cae en una
 * versión legible del propio identificador, nunca en la enumeración cruda.
 */
export const KIND_LABELS: Record<string, string> = {
  // Entender
  kickoff: "Arranque con el cliente",
  org_profile: "Perfil de la organización",
  systems_inventory: "Inventario de sistemas",
  interview: "Entrevistas",
  process_map: "Mapas de proceso",
  proceso_asis: "Procesos as-is",
  leak_analysis: "Análisis de fugas",
  iso_gap: "Brecha ISO 9001",
  iso_clause: "Cláusulas ISO",
  finding: "Hallazgos",
  report: "Informe de assessment",
  resumen_ejecutivo: "Resumen ejecutivo",
  roadmap: "Roadmap priorizado",
  decision: "Decisiones",
  evidence: "Evidencia",
  template: "Plantillas",
  note: "Notas",
  // Construir
  design: "Diseño de la solución",
  build: "Construcción",
  integration: "Integraciones",
  uat: "Pruebas con el cliente",
  deploy: "Puesta en marcha",
  // Operar
  marketing_ops: "Operación de marketing",
  sales_ops: "Operación comercial",
  service_ops: "Operación de servicio",
  reporting_ops: "Reportería",
  sprint: "Sprint",
  checkin: "Seguimiento",
};

/** Nombre legible de un `kind`; nunca la enumeración cruda. */
export function humanizeKind(kind: string): string {
  const key = normalizeKind(kind).replace(/\s+/g, "_");
  const known = KIND_LABELS[key];
  if (known) return known;
  const words = normalizeKind(kind);
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Hitos de una etapa: los tipos de actividad de sus tareas. Un hito está
 * cerrado cuando todas sus tareas lo están, y "en curso" cuando alguna avanza.
 */
export function milestonesFor(stage: Stage, tasks: Task[]): Milestone[] {
  const groups = new Map<string, Task[]>();
  for (const task of tasks) {
    if (task.stage !== stage) continue;
    if (task.status === "CANCELLED") continue;
    const key = task.activityType?.trim() || "Trabajo de la fase";
    const list = groups.get(key) ?? [];
    list.push(task);
    groups.set(key, list);
  }
  return [...groups.entries()].map(([key, list]) => {
    const done = list.filter((t) => t.status === "DONE").length;
    const active = list.some((t) => t.status === "IN_PROGRESS" || t.status === "REVIEW");
    return {
      key: `${stage}:${key}`,
      label: humanizeKind(key),
      total: list.length,
      done,
      state: done === list.length ? "done" : active || done > 0 ? "now" : "open",
      taskIds: list.map((t) => t.id),
    } satisfies Milestone;
  });
}

/**
 * Estado del candado que cierra `stage`. Las etapas ya recorridas quedan
 * aprobadas; la actual se abre en cuanto el cierre de fase está completo; las
 * futuras siguen cerradas porque falta el gate anterior.
 */
export function gateStateFor(
  stage: Stage,
  project: Pick<Project, "stage" | "gateState">,
  closureComplete: boolean,
): GateState {
  const index = STAGES.indexOf(stage);
  const current = STAGES.indexOf(project.stage);
  if (index < current) return "passed";
  if (index > current) return "locked";
  if (project.gateState === "approved") return "passed";
  return closureComplete ? "ready" : "locked";
}

export function gateCaption(stage: Stage, state: GateState): string {
  const next = STAGES[STAGES.indexOf(stage) + 1] as Stage | undefined;
  if (state === "passed") return next ? `${STAGE_WORD[stage]} cerrada` : "Ciclo cerrado";
  if (state === "ready") {
    return next ? `Cierra ${STAGE_WORD[stage]} y abre ${STAGE_WORD[next]}` : `Cierra ${STAGE_WORD[stage]}`;
  }
  return next ? `Falta cerrar ${STAGE_WORD[stage]}` : "Falta cerrar la fase";
}

export function buildCycle(
  project: Pick<Project, "stage" | "gateState">,
  tasks: Task[],
  closure: PhaseClosureStatus | null,
): CycleColumn[] {
  const current = STAGES.indexOf(project.stage);
  return STAGES.map((stage, index) => {
    const state = gateStateFor(stage, project, closure?.complete ?? false);
    return {
      stage,
      status: index < current ? "closed" : index === current ? "active" : "blocked",
      milestones: milestonesFor(stage, tasks),
      gate: {
        code: GATE_CODES[stage],
        stage,
        state,
        caption: gateCaption(stage, state),
      },
    } satisfies CycleColumn;
  });
}

/**
 * Tarea que produce un entregable que falta. Se busca por tipo de actividad,
 * luego por etiqueta y por último por el título. Devuelve null antes que
 * inventar un enlace: un camino falso es peor que ninguno.
 */
export function findProducingTask(item: PhaseClosureItem, tasks: Task[]): Task | null {
  const target = normalizeKind(item.kind);
  const open = tasks.filter((t) => t.status !== "DONE" && t.status !== "CANCELLED");
  const pools = [open, tasks];
  for (const pool of pools) {
    const byActivity = pool.find((t) => t.activityType && normalizeKind(t.activityType) === target);
    if (byActivity) return byActivity;
    const byLabel = pool.find((t) => (t.labels ?? []).some((l) => normalizeKind(l) === target));
    if (byLabel) return byLabel;
    const byTitle = pool.find((t) => normalizeKind(t.title).includes(target));
    if (byTitle) return byTitle;
  }
  return null;
}

export interface MissingDeliverable {
  key: string;
  item: PhaseClosureItem;
  label: string;
  text: string;
  task: Task | null;
}

export function missingDeliverables(
  closure: PhaseClosureStatus | null,
  tasks: Task[],
): MissingDeliverable[] {
  if (!closure) return [];
  return closure.items
    .filter((item) => item.missing !== null)
    .map((item) => ({
      key: `${item.kind}:${item.source}`,
      item,
      label: humanizeKind(item.kind),
      text: item.missing ?? "",
      task: findProducingTask(item, tasks),
    }));
}

export const CLOSURE_SOURCE_LABELS: Record<string, string> = {
  knowledge_doc: "Context Hub",
  process: "procesos as-is",
  artifact: "artefactos de tareas",
};
