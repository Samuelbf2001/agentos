/**
 * Selección de backend de persistencia (Fase 2).
 *
 * `AGENTOS_DB_DRIVER=sqlite` (default, cero fricción) | `postgres`.
 * NADIE fuera de `packages/db` decide esto: el resto del monorepo pide una
 * conexión y recibe la del driver configurado (NFR-9).
 *
 * ⚠️ Límite honesto y documentado (docs/POSTGRES.md §"Qué NO es portable"):
 * los repositorios SQLite son SÍNCRONOS (better-sqlite3) y los de Postgres son
 * ASÍNCRONOS (no existe driver PG síncrono en Node). La *forma* de la API es
 * idéntica (mismos nombres, mismos argumentos, mismos tipos de fila) pero el
 * llamante debe `await` en Postgres. Por eso el default sigue siendo SQLite y
 * el switch es por configuración, no un corte forzoso.
 */

export type DbDriver = "sqlite" | "postgres";

const VALID: readonly DbDriver[] = ["sqlite", "postgres"];

/** Driver configurado. Valor desconocido = error explícito (fail-closed). */
export function resolveDriver(raw?: string): DbDriver {
  const value = (raw ?? process.env.AGENTOS_DB_DRIVER ?? "sqlite").trim().toLowerCase();
  if (value === "pg" || value === "supabase") return "postgres";
  if (!VALID.includes(value as DbDriver)) {
    throw new Error(
      `AGENTOS_DB_DRIVER="${value}" no es válido. Valores admitidos: ${VALID.join(" | ")}.`,
    );
  }
  return value as DbDriver;
}

export function isPostgresDriver(raw?: string): boolean {
  return resolveDriver(raw) === "postgres";
}
