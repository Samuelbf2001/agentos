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
import { launchModule, type AgentosDb, type LaunchModuleInput, type LaunchModuleResult } from "@agentos/db";
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
