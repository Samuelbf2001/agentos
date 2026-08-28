/**
 * Costura core↔events (B4): el motor del tablero y el gateway de tools publican
 * `DomainEvent` ({type, payload, runId}) por la interfaz EventSink de
 * @agentos/core, pero el EventBus de @agentos/events valida contra el
 * vocabulario AG-UI/plataforma. El puente:
 *
 * - crea el bus con `validate:false` (la DB persiste type+payload tal cual;
 *   los eventos AG-UI de los runners ya llegan validados por sus schemas), y
 * - envuelve cada DomainEvent en un sobre estable
 *   `{ type, timestamp, payload, runId }` antes de publicarlo.
 *
 * Regla del repo: NO se editan packages/{core,events} — la adaptación vive aquí.
 */
import { nowMs } from "@agentos/shared";
import type { AgentosDb, PersistedEvent } from "@agentos/db";
import { EventBus, type BusPayload } from "@agentos/events";
import type { DomainEvent, EventSink } from "@agentos/core";

export function createBus(db: AgentosDb): EventBus {
  // validate:false — el bus transporta tanto AG-UI (runners) como eventos de
  // dominio del tablero (task.moved, approval.requested, ...).
  return new EventBus(db, { validate: false });
}

/** Publica un payload arbitrario (evento de dominio o de canal) en el bus. */
export function publishRaw(
  bus: EventBus,
  topic: string,
  event: { type: string; [k: string]: unknown },
  runId?: string | null,
): PersistedEvent {
  const withTs = { timestamp: nowMs(), ...event };
  return bus.publish(topic, withTs as unknown as BusPayload, {
    ...(runId ? { runId } : {}),
  });
}

/** EventSink (core) → EventBus (events): el adaptador que exige ARCHITECTURE §2. */
export function busSink(bus: EventBus): EventSink {
  return {
    publish(topic: string, event: DomainEvent): void {
      publishRaw(
        bus,
        topic,
        { type: event.type, payload: event.payload ?? {} },
        event.runId ?? null,
      );
    },
  };
}

/** Lee el payload de dominio de un PersistedEvent publicado vía busSink. */
export function domainPayload(event: PersistedEvent): Record<string, unknown> {
  const raw = event.payload as { payload?: unknown } | null;
  if (raw && typeof raw === "object" && raw.payload && typeof raw.payload === "object") {
    return raw.payload as Record<string, unknown>;
  }
  return (raw ?? {}) as Record<string, unknown>;
}
