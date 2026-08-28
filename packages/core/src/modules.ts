/**
 * Capa de core de los Módulos de Fase (ARCHITECTURE §13.3): el motor
 * transaccional vive en @agentos/db (`launchModule`) y NO publica nada; esta
 * capa publica sus `pendingEvents` AG-UI POST-commit por el `EventSink`
 * inyectable (mismo límite de propiedad que el motor del tablero: core no
 * conoce el bus real — apps/api inyecta `busSink`).
 *
 * Publicar dentro de la transacción dejaría eventos fantasma en rollback; por
 * eso el flush es estrictamente posterior al commit. Un retorno idempotente
 * llega con `pendingEvents` vacío y aquí no se re-publica nada.
 */
import { errors, type PlannedDeliverable } from "@agentos/shared";
import {
  getLatestLaunchForProject,
  getProject,
  launchModule,
  type AgentosDb,
  type LaunchModuleInput,
  type LaunchModuleResult,
} from "@agentos/db";
import type { EventSink } from "./events.js";

export function launchModuleWithEvents(
  db: AgentosDb,
  sink: EventSink,
  input: LaunchModuleInput,
): LaunchModuleResult {
  const result = launchModule(db, input);
  for (const pending of result.pendingEvents) {
    sink.publish(pending.topic, pending.event);
  }
  return result;
}

// ── Estado de cierre de fase (CA-M3.1 — §13.8) ─────────────────────────────

export interface PhaseClosureItem {
  kind: string;
  source: "knowledge_doc" | "process" | "artifact";
  required: number;
  found: number;
  /** Legible para la UI (es-ES); null cuando el mínimo está cubierto. */
  missing: string | null;
}

export interface PhaseClosureStatus {
  launchId: string | null;
  complete: boolean;
  items: PhaseClosureItem[];
  reason?: "no_launch";
}

const SOURCE_LABEL: Record<PhaseClosureItem["source"], string> = {
  knowledge_doc: "documento(s) en el Context Hub",
  process: "proceso(s) as-is mapeados",
  artifact: "artefacto(s) adjuntos a tareas del proyecto",
};

/**
 * Compara los `deliverables` EFECTIVOS del último launch del proyecto (recibo
 * `module_launches.result`, con `min_from_input` ya resuelto y toggles podados)
 * contra la realidad: knowledge_docs del proyecto por kind, processes as_is de
 * la organización, y artifacts por kind en tareas del proyecto. El gate de
 * fase no debe aprobarse con faltantes (CA-M3.1).
 */
export function phaseClosureStatus(db: AgentosDb, projectId: string): PhaseClosureStatus {
  const project = getProject(db, projectId);
  if (!project) throw errors.notFound("project", projectId);

  const launch = getLatestLaunchForProject(db, projectId);
  if (!launch) return { launchId: null, complete: false, items: [], reason: "no_launch" };

  const raw = (launch.result as { deliverables?: unknown }).deliverables;
  const deliverables: PlannedDeliverable[] = Array.isArray(raw)
    ? (raw as PlannedDeliverable[]).filter(
        (d) =>
          d !== null &&
          typeof d === "object" &&
          typeof d.kind === "string" &&
          (d.source === "knowledge_doc" || d.source === "process" || d.source === "artifact"),
      )
    : [];

  const count = (sql: string, ...params: unknown[]): number =>
    (db.$client.prepare(sql).get(...params) as { n: number }).n;

  const items: PhaseClosureItem[] = deliverables.map((d) => {
    const required = typeof d.min === "number" && Number.isFinite(d.min) && d.min > 0 ? d.min : 1;
    let found: number;
    switch (d.source) {
      case "knowledge_doc":
        found = count(
          `SELECT count(*) AS n FROM knowledge_docs WHERE project_id = ? AND kind = ?`,
          projectId,
          d.kind,
        );
        break;
      case "process":
        found = count(
          `SELECT count(*) AS n FROM processes WHERE org_id = ? AND variant = 'as_is'`,
          project.orgId,
        );
        break;
      case "artifact":
        found = count(
          `SELECT count(*) AS n FROM artifacts a JOIN tasks t ON t.id = a.task_id
           WHERE t.project_id = ? AND a.kind = ?`,
          projectId,
          d.kind,
        );
        break;
    }
    const missing =
      found >= required
        ? null
        : `Falta(n) ${required - found} de ${required} "${d.kind}" — ${SOURCE_LABEL[d.source]}` +
          (d.producedBy ? ` (los produce la plantilla "${d.producedBy}")` : "");
    return { kind: d.kind, source: d.source, required, found, missing };
  });

  return {
    launchId: launch.id,
    complete: items.every((i) => i.missing === null),
    items,
  };
}
