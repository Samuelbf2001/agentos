/**
 * Selección del lote piloto.
 *
 * El plan (fase N3) no pide "las primeras 10 tareas": pide un piloto que
 * **cubra** multi-responsable, fecha, rango de fechas, dependencia, relación con
 * proyecto, tarea sin proyecto, adjunto, comentario y estado terminado. Un
 * prefijo alfabético del listado no garantiza nada de eso.
 *
 * Aquí se hace una cobertura voraz (greedy set cover): en cada paso se escoge la
 * tarea que aporta más rasgos todavía no cubiertos, con desempate por id para que
 * el resultado sea **determinista** y reproducible. Cuando ya no queda rasgo
 * nuevo que cubrir, se rellena en orden de id.
 *
 * Los proyectos del piloto salen de las tareas escogidas: así el lote es
 * coherente consigo mismo en vez de mandar a la bandeja tareas cuyo proyecto
 * quedó fuera por casualidad.
 */
import { mapTaskPage, type MappedTask, type TaskSchemaBinding } from "./field-map.js";
import type { SnapshotReader } from "./snapshot-reader.js";

/** Rasgos que el piloto debe ejercitar, en el orden en que se reportan. */
export type PilotFeature =
  | "con_responsable"
  | "multi_responsable"
  | "con_fecha"
  | "con_rango_de_fechas"
  | "con_dependencia"
  | "con_proyecto"
  | "sin_proyecto"
  | "con_adjunto"
  | "con_comentario"
  | "estado_terminado"
  | "estado_bloqueado"
  | "con_excepcion";

export interface PilotCandidate {
  notionPageId: string;
  features: Set<PilotFeature>;
  projectPageIds: string[];
}

function hasComments(comments: unknown): boolean {
  if (!Array.isArray(comments)) return false;
  return comments.some((page) => {
    const results = (page as { results?: unknown }).results;
    return Array.isArray(results) && results.length > 0;
  });
}

function hasAttachments(files: unknown): boolean {
  const attachments = (files as { attachments?: unknown } | null)?.attachments;
  return Array.isArray(attachments) && attachments.length > 0;
}

export function featuresOf(
  mapped: MappedTask,
  extras: { comments: unknown; files: unknown },
): Set<PilotFeature> {
  const features = new Set<PilotFeature>();
  if (mapped.assignees.length > 0) features.add("con_responsable");
  if (mapped.assignees.length > 1) features.add("multi_responsable");
  if (mapped.dueAt !== null) features.add("con_fecha");
  if (mapped.original.due.rangeEnd) features.add("con_rango_de_fechas");
  if (mapped.dependsOnPageIds.length > 0) features.add("con_dependencia");
  if (mapped.projectPageIds.length > 0) features.add("con_proyecto");
  else features.add("sin_proyecto");
  if (hasAttachments(extras.files)) features.add("con_adjunto");
  if (hasComments(extras.comments)) features.add("con_comentario");
  if (mapped.status === "DONE") features.add("estado_terminado");
  if (mapped.status === "BLOCKED") features.add("estado_bloqueado");
  if (mapped.exceptions.length > 0) features.add("con_excepcion");
  return features;
}

export interface PilotSelection {
  taskIds: string[];
  projectIds: string[];
  /** Rasgos efectivamente cubiertos por el lote elegido. */
  covered: PilotFeature[];
  /** Rasgos que SÍ existen en el snapshot pero el lote no alcanzó a cubrir. */
  missing: PilotFeature[];
  /** Rasgos que ninguna tarea del snapshot tiene: no es un fallo, es un dato. */
  absent: PilotFeature[];
}

const ALL_FEATURES: readonly PilotFeature[] = [
  "con_responsable",
  "multi_responsable",
  "con_fecha",
  "con_rango_de_fechas",
  "con_dependencia",
  "con_proyecto",
  "sin_proyecto",
  "con_adjunto",
  "con_comentario",
  "estado_terminado",
  "estado_bloqueado",
  "con_excepcion",
];

/** Lee y puntúa todas las tareas candidatas del snapshot. */
export async function readPilotCandidates(
  reader: SnapshotReader,
  binding: TaskSchemaBinding,
  taskIds: readonly string[],
): Promise<PilotCandidate[]> {
  const candidates: PilotCandidate[] = [];
  for (const notionPageId of taskIds) {
    const snapshot = await reader.page("tasks", notionPageId);
    const mapped = mapTaskPage(snapshot.page, binding);
    candidates.push({
      notionPageId,
      features: featuresOf(mapped, { comments: snapshot.comments, files: snapshot.files }),
      projectPageIds: mapped.projectPageIds,
    });
  }
  return candidates;
}

/**
 * Cobertura voraz determinista. `limits.tasks` acota el lote; los proyectos se
 * derivan de las tareas elegidas y solo después se rellenan por orden de id.
 */
export function selectPilot(
  candidates: readonly PilotCandidate[],
  allProjectIds: readonly string[],
  limits: { tasks: number; projects: number },
): PilotSelection {
  const pending = [...candidates].sort((a, b) => a.notionPageId.localeCompare(b.notionPageId));
  const covered = new Set<PilotFeature>();
  const chosen: PilotCandidate[] = [];

  while (chosen.length < limits.tasks && pending.length > 0) {
    let bestIndex = 0;
    let bestGain = -1;
    for (let index = 0; index < pending.length; index += 1) {
      let gain = 0;
      for (const feature of pending[index]!.features) if (!covered.has(feature)) gain += 1;
      // Empate → gana el id menor, que ya es el orden de `pending`.
      if (gain > bestGain) {
        bestGain = gain;
        bestIndex = index;
      }
    }
    const [picked] = pending.splice(bestIndex, 1);
    if (!picked) break;
    for (const feature of picked.features) covered.add(feature);
    chosen.push(picked);
  }

  const projectIds: string[] = [];
  const known = new Set(allProjectIds.map((id) => id.toLowerCase()));
  for (const candidate of chosen) {
    for (const projectPageId of candidate.projectPageIds) {
      if (projectIds.length >= limits.projects) break;
      // Un proyecto referenciado pero ausente del snapshot no se inventa: se
      // ignora aquí y el importador lo registra como excepción.
      if (!known.has(projectPageId.toLowerCase())) continue;
      if (!projectIds.includes(projectPageId)) projectIds.push(projectPageId);
    }
  }
  for (const projectId of [...allProjectIds].sort((a, b) => a.localeCompare(b))) {
    if (projectIds.length >= limits.projects) break;
    if (!projectIds.includes(projectId)) projectIds.push(projectId);
  }

  return {
    taskIds: chosen.map((candidate) => candidate.notionPageId),
    projectIds,
    covered: ALL_FEATURES.filter((feature) => covered.has(feature)),
    missing: ALL_FEATURES.filter(
      (feature) =>
        !covered.has(feature) && candidates.some((candidate) => candidate.features.has(feature)),
    ),
    absent: ALL_FEATURES.filter(
      (feature) => !candidates.some((candidate) => candidate.features.has(feature)),
    ),
  };
}
