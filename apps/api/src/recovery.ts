/**
 * Recuperación al arrancar (NFR-4): al reiniciar el servidor,
 * - runs 'running'/'queued' huérfanos → 'interrupted' (el proceso que los
 *   ejecutaba ya no existe; la cola en memoria del pool tampoco),
 * - sus tareas con lease vuelven a READY (transición de sistema permitida por
 *   la matriz: IN_PROGRESS→READY), el resto lo cubre el reaper (30 s),
 * - las aprobaciones pendientes quedan INTACTAS (sobreviven por persistencia).
 */
import { nowMs } from "@agentos/shared";
import {
  getTask,
  listRunsByStatus,
  updateRun,
  type AgentosDb,
} from "@agentos/db";
import type { BoardEngine } from "@agentos/core";

export interface RecoveryReport {
  interruptedRuns: string[];
  requeuedTasks: string[];
}

export function recoverOnBoot(db: AgentosDb, engine: BoardEngine): RecoveryReport {
  const report: RecoveryReport = { interruptedRuns: [], requeuedTasks: [] };
  const zombies = [...listRunsByStatus(db, "running"), ...listRunsByStatus(db, "queued")];

  for (const run of zombies) {
    updateRun(db, run.id, {
      status: "interrupted",
      error:
        run.status === "running"
          ? "interrupted: el servidor se reinició con el run en ejecución"
          : "interrupted: el servidor se reinició con el run en cola",
      finishedAt: nowMs(),
    });
    report.interruptedRuns.push(run.id);
  }

  for (const run of zombies) {
    if (!run.taskId) continue;
    const task = getTask(db, run.taskId);
    if (!task || task.status !== "IN_PROGRESS") continue;
    if (report.requeuedTasks.includes(task.id)) continue;
    try {
      engine.moveTask({
        taskId: task.id,
        to: "READY",
        expectedVersion: task.version,
        actor: "system:recovery",
        runId: run.id,
        note: "run interrumpido por reinicio del servidor",
      });
      report.requeuedTasks.push(task.id);
    } catch {
      // Conflicto: alguien la movió entre lectura y update — el reaper la cubrirá.
    }
  }

  return report;
}
