/**
 * EventSink — interfaz propia inyectable para publicar eventos de dominio.
 * El bus real vive en packages/events y se conecta en B4; packages/core NO lo
 * importa (límite de propiedad). Quien orquesta inyecta una implementación.
 */

export interface DomainEvent {
  type: string;
  payload?: Record<string, unknown>;
  runId?: string | null;
}

export interface EventSink {
  /**
   * Puede ser síncrona (sinks de test) o asíncrona (el bus real, que persiste
   * en la DB antes de emitir). Los llamantes hacen `await`: con SQLite la
   * promesa ya está resuelta y no cuesta nada; con Postgres garantiza el orden.
   */
  publish(topic: string, event: DomainEvent): void | Promise<void>;
}

/** Sink por defecto: descarta todo (tests y usos sin bus). */
export const noopEventSink: EventSink = {
  publish() {
    /* no-op */
  },
};

/** Sink de grabación para tests. */
export function recordingEventSink(): EventSink & {
  published: { topic: string; event: DomainEvent }[];
} {
  const published: { topic: string; event: DomainEvent }[] = [];
  return {
    published,
    publish(topic, event) {
      published.push({ topic, event });
    },
  };
}
