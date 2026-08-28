/**
 * Ring buffer por topic (ARCHITECTURE §2): últimos N eventos en memoria para
 * resume barato por `since_seq`. Si el hueco excede el buffer, el bus cae a la
 * DB (la fuente de verdad SIEMPRE es la tabla `events`).
 */
export class RingBuffer<T extends { seq: number }> {
  private items: T[] = [];

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error(`RingBuffer capacity inválida: ${capacity}`);
    }
  }

  push(item: T): void {
    this.items.push(item);
    if (this.items.length > this.capacity) {
      this.items.splice(0, this.items.length - this.capacity);
    }
  }

  get size(): number {
    return this.items.length;
  }

  get oldestSeq(): number | undefined {
    return this.items[0]?.seq;
  }

  get newestSeq(): number | undefined {
    return this.items[this.items.length - 1]?.seq;
  }

  /**
   * Eventos con seq > sinceSeq, SOLO si el buffer puede garantizar que no hay
   * hueco (su elemento más viejo es <= sinceSeq + 1). Si no puede, devuelve
   * null y el llamador debe ir a la DB.
   */
  since(sinceSeq: number): T[] | null {
    if (this.items.length === 0) {
      // Buffer vacío: solo cubre el caso "no hay nada nuevo" si sinceSeq >= 0
      // y nunca se ha emitido nada — imposible de saber aquí. Fail-closed.
      return null;
    }
    const oldest = this.oldestSeq!;
    if (sinceSeq >= this.newestSeq!) return [];
    if (oldest > sinceSeq + 1) return null; // hueco: faltan eventos anteriores al buffer
    return this.items.filter((e) => e.seq > sinceSeq);
  }

  toArray(): readonly T[] {
    return this.items;
  }
}
