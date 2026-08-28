/**
 * Helpers de tiempo. Convención no opcional (ARCHITECTURE §5):
 * todo timestamp es INTEGER epoch en milisegundos.
 */

/** Ahora, en epoch ms. */
export function nowMs(): number {
  return Date.now();
}

/** epoch ms → Date. */
export function toDate(epochMs: number): Date {
  return new Date(epochMs);
}

/** Date → epoch ms. */
export function fromDate(date: Date): number {
  return date.getTime();
}

/** epoch ms → ISO 8601 (solo para logs/UI, jamás para persistir). */
export function toIso(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

/** Suma milisegundos a un instante. */
export function addMs(epochMs: number, ms: number): number {
  return epochMs + ms;
}

/**
 * ¿Expiró un lease? Un lease NULL/undefined se considera expirado
 * (semántica del claim atómico: lease vencido o nulo = reclamable).
 */
export function isExpired(leaseUntil: number | null | undefined, at: number = nowMs()): boolean {
  return leaseUntil == null || leaseUntil < at;
}

export const SECOND_MS = 1_000;
export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;
