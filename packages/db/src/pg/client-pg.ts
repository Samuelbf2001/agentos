/**
 * Cliente Postgres/Supabase (backend ALTERNATIVO — SQLite sigue siendo el default).
 * Espejo de `src/client.ts`; misma forma (`openPgDb` / `closePgDb` / `$client`).
 */
import postgres, { type Sql } from "postgres";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as pgSchema from "./schema-pg.js";

export type AgentosPgDb = PostgresJsDatabase<typeof pgSchema> & { $client: Sql };

export interface OpenPgOptions {
  /** Tamaño del pool. Default 10 (1 en el pooler de transacción de Supabase). */
  max?: number;
  /**
   * `false` desactiva prepared statements. OBLIGATORIO detrás de PgBouncer en
   * modo *transaction* (Supabase puerto 6543): se autodetecta por `?pgbouncer=true`
   * o por el puerto 6543, pero se puede forzar aquí.
   */
  prepare?: boolean;
  /** Segundos de inactividad antes de cerrar una conexión del pool. */
  idleTimeout?: number;
}

/** Lee la URL de conexión; lanza si el driver es postgres y falta la variable. */
export function resolvePgUrl(url?: string): string {
  const raw = url ?? process.env.AGENTOS_PG_URL;
  if (!raw) {
    throw new Error(
      "AGENTOS_PG_URL no está configurada. Con AGENTOS_DB_DRIVER=postgres es obligatoria " +
        "(p.ej. postgres://usuario:clave@localhost:5432/agentos). Ver docs/POSTGRES.md.",
    );
  }
  return raw;
}

/**
 * ¿La URL apunta a un pooler en modo transacción? En ese caso los prepared
 * statements con nombre NO sobreviven entre sentencias y hay que apagarlos.
 */
export function looksLikeTransactionPooler(url: string): boolean {
  return /[?&]pgbouncer=true/i.test(url) || /:6543(\/|$|\?)/.test(url);
}

export function openPgDb(url?: string, opts: OpenPgOptions = {}): AgentosPgDb {
  const connection = resolvePgUrl(url);
  const pooled = looksLikeTransactionPooler(connection);
  const client = postgres(connection, {
    max: opts.max ?? (pooled ? 1 : 10),
    prepare: opts.prepare ?? !pooled,
    idle_timeout: opts.idleTimeout ?? 20,
    // epoch ms viaja como bigint; drizzle (mode:"number") lo convierte.
    onnotice: () => {},
  });
  return drizzle(client, { schema: pgSchema }) as AgentosPgDb;
}

export async function closePgDb(db: AgentosPgDb): Promise<void> {
  await db.$client.end({ timeout: 5 });
}

export { pgSchema };
