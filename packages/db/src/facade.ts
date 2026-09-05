/**
 * Fachada ASÍNCRONA de la capa de datos — la ÚNICA superficie que ve el resto
 * del monorepo (core, tools, api, mcp-admin).
 *
 * Por qué existe (docs/POSTGRES.md §5, "Lo que NO es portable tal cual"):
 * `better-sqlite3` es síncrono por diseño y no hay driver Postgres síncrono en
 * Node. Antes eso obligaba a que el llamante supiera qué motor había debajo.
 * Aquí se resuelve de una vez: **una sola interfaz asíncrona con dos
 * implementaciones**. Los nombres, los argumentos y los tipos de fila son los
 * mismos de siempre (NFR-9); lo único que cambia para el llamante es que
 * ahora hay que `await`.
 *
 * Cómo despacha: cada función mira el `db` que recibe. Si es Postgres delega en
 * `pg/repositories/*` (asíncronas de verdad); si es SQLite llama a
 * `repositories/*` (síncronas) y envuelve el resultado en una promesa ya
 * resuelta. `postgres-js` NO se carga jamás en el camino SQLite: el backend PG
 * se registra a sí mismo cuando alguien importa `@agentos/db/pg`, y la fachada
 * solo lo importa dinámicamente si le llega un handle de Postgres.
 */
import type { AgentosSqliteDb } from "./client.js";
import type { AgentosPgDb } from "./pg/client-pg.js";

/** Handle de base de datos, del motor que sea. Es el `AgentosDb` público. */
export type AnyDb = AgentosSqliteDb | AgentosPgDb;

/**
 * Marca de "esto es Postgres". Se pone en `openPgDb` y en cada transacción PG
 * (el objeto `tx` de drizzle no tiene `$client`, así que no hay forma de
 * detectarlo por estructura).
 */
export const PG_DB_TAG: unique symbol = Symbol.for("agentos.db.postgres");

export function markPgDb<T>(db: T): T {
  if (db !== null && typeof db === "object" && !(PG_DB_TAG in (db as object))) {
    Object.defineProperty(db, PG_DB_TAG, { value: true, enumerable: false });
  }
  return db;
}

/** ¿El handle es de Postgres? (incluye transacciones PG marcadas). */
export function isPgDb(db: unknown): db is AgentosPgDb {
  if (db === null || typeof db !== "object") return false;
  if ((db as Record<symbol, unknown>)[PG_DB_TAG] === true) return true;
  // Reserva estructural: el cliente de postgres-js es una FUNCIÓN (plantilla
  // etiquetada); el de better-sqlite3 es un objeto.
  return typeof (db as { $client?: unknown }).$client === "function";
}

/** El `db` como SQLite; lanza si no lo es (rutas que solo existen en SQLite). */
export function asSqliteDb(db: AnyDb): AgentosSqliteDb {
  if (isPgDb(db)) {
    throw new Error("Esta operación solo existe en el backend SQLite.");
  }
  return db as AgentosSqliteDb;
}

// ── Registro del backend Postgres ───────────────────────────────────────────

/** Todo lo que exporta `@agentos/db/pg`. Import de SOLO TIPO: se borra al compilar. */
export type PgBackend = typeof import("./pg/index.js");

let pgBackend: PgBackend | undefined;

/** Lo llama `pg/index.ts` al cargarse. Nadie más. */
export function registerPgBackend(backend: PgBackend): void {
  pgBackend = backend;
}

/** Backend PG, cargándolo perezosamente si aún nadie importó `@agentos/db/pg`. */
export async function requirePgBackend(): Promise<PgBackend> {
  if (!pgBackend) {
    // Import dinámico: en el camino SQLite esta línea nunca se ejecuta y
    // `postgres-js` no entra al proceso.
    await import("./pg/index.js");
  }
  if (!pgBackend) {
    throw new Error(
      "El backend Postgres no se registró. Importa `@agentos/db/pg` antes de usar un handle PG.",
    );
  }
  return pgBackend;
}

// ── Fábrica de funciones duales ─────────────────────────────────────────────

type Tail<T extends readonly unknown[]> = T extends readonly [unknown, ...infer R] ? R : never;

/** Firma pública de una función dual: mismos argumentos, resultado en promesa. */
export type Dual<S extends (db: never, ...args: never[]) => unknown> = (
  db: AnyDb,
  ...args: Tail<Parameters<S>>
) => Promise<Awaited<ReturnType<S>>>;

/**
 * Construye la función dual: `sqliteFn` para SQLite, `pg[key]` para Postgres.
 * El nombre de la clave lo verifica el compilador contra `@agentos/db/pg`, así
 * que una función que exista en un motor y no en el otro no compila.
 */
export function dual<S extends (db: never, ...args: never[]) => unknown>(
  sqliteFn: S,
  key: keyof PgBackend,
): Dual<S> {
  return async (db: AnyDb, ...args: unknown[]): Promise<Awaited<ReturnType<S>>> => {
    if (isPgDb(db)) {
      const pg = await requirePgBackend();
      const fn = pg[key] as unknown as (...a: unknown[]) => unknown;
      return (await fn(db, ...args)) as Awaited<ReturnType<S>>;
    }
    return (sqliteFn as unknown as (...a: unknown[]) => unknown)(
      db,
      ...args,
    ) as Awaited<ReturnType<S>>;
  };
}

// ── Transacciones ───────────────────────────────────────────────────────────

/**
 * Ejecuta `fn` dentro de UNA transacción, en el motor que sea. Cualquier throw
 * revierte todo (NM-1).
 *
 * - **Postgres**: `db.transaction(async tx => …)` de drizzle. Revierte también
 *   en asíncrono, que es estrictamente mejor que lo que daba better-sqlite3.
 * - **SQLite**: `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK` a mano sobre la
 *   conexión. `db.$client.transaction(cb)` de better-sqlite3 solo admite
 *   callbacks SÍNCRONOS y aquí el callback es asíncrono, así que no sirve.
 *
 *   Por qué abrir la transacción a mano es seguro en SQLite: en el camino
 *   SQLite todas las funciones de la fachada devuelven promesas YA RESUELTAS,
 *   así que el cuerpo de `fn` se agota entero en un solo drenaje de la cola de
 *   microtareas. Los temporizadores (despachador, reaper) y la E/S son
 *   macrotareas: no pueden colarse entre dos `await` de este bloque, y por
 *   tanto no hay forma de que otra escritura caiga dentro de nuestra
 *   transacción. La condición es no esperar nada realmente asíncrono (red,
 *   disco) dentro de `fn` — el motor de launch no lo hace.
 *
 * Anidar es no-op deliberado: si ya hay transacción abierta se reutiliza (mismo
 * criterio que los repositorios SQLite con `inTransaction`).
 */
export async function withTransaction<T>(db: AnyDb, fn: (tx: AnyDb) => Promise<T>): Promise<T> {
  if (isPgDb(db)) {
    return await (db as AgentosPgDb).transaction(async (tx) =>
      fn(markPgDb(tx as unknown as AnyDb)),
    );
  }
  const lite = db as AgentosSqliteDb;
  const client = lite.$client;
  if (client.inTransaction) return await fn(lite);
  client.exec("BEGIN IMMEDIATE");
  try {
    const out = await fn(lite);
    client.exec("COMMIT");
    return out;
  } catch (err) {
    try {
      if (client.inTransaction) client.exec("ROLLBACK");
    } catch {
      /* la transacción ya se cerró sola: el error original manda */
    }
    throw err;
  }
}
