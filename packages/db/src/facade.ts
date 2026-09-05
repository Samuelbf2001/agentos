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
import { AsyncLocalStorage } from "node:async_hooks";
import { AgentosError, ErrorCodes } from "@agentos/shared";
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
 * Ámbito de la transacción SQLite en curso. Es el **token de dueño**: se
 * propaga por la cadena de llamadas con `AsyncLocalStorage`, así que solo el
 * código que corre DENTRO del cuerpo lo ve. Cualquier otro llamante (otra
 * petición, otro tick del despachador) no lo ve y pasa por la cola.
 */
interface SqliteTxScope {
  /** Conexión better-sqlite3 sobre la que está abierta la transacción. */
  client: object;
  /** true en cuanto el cuerpo cedió al bucle de eventos con la transacción abierta. */
  yielded: boolean;
}
const sqliteTxScope = new AsyncLocalStorage<SqliteTxScope>();

/**
 * Cola de transacciones POR CONEXIÓN: la siguiente no hace `BEGIN` hasta que la
 * anterior hizo COMMIT o ROLLBACK. Es lo que impide que dos `withTransaction`
 * concurrentes se fusionen en una sola unidad de trabajo.
 */
const sqliteTxQueue = new WeakMap<object, Promise<unknown>>();

function noop(): void {
  /* la cola solo encadena, nunca propaga el error de la transacción anterior */
}

/**
 * ¿Guarda de desarrollo activa? Detecta cuerpos de transacción que ceden al
 * bucle de eventos (temporizador, red, disco). `AGENTOS_TX_GUARD=on|off` manda
 * sobre `NODE_ENV`.
 */
function txGuardEnabled(): boolean {
  const flag = process.env.AGENTOS_TX_GUARD;
  if (flag === "off") return false;
  if (flag === "on") return true;
  const env = process.env.NODE_ENV;
  return env === "test" || env === "development";
}

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
 * Garantía real en SQLite (una sola conexión, sin transacciones anidadas de
 * verdad — better-sqlite3 no tiene savepoints aquí), en tres piezas:
 *
 * 1. **Cola por conexión**: todas las transacciones se serializan. Antes,
 *    `Promise.all([withTransaction(A→throw), withTransaction(B→ok)])` fusionaba
 *    B dentro de A: B devolvía éxito y el ROLLBACK de A borraba sus filas en
 *    silencio. Ahora B espera a que A cierre y commitea lo suyo.
 * 2. **Token de dueño**: anidar solo se permite desde la MISMA cadena de
 *    llamadas (el `AsyncLocalStorage` del cuerpo). Si al empezar hay una
 *    transacción abierta por otro camino, se lanza `transaction_nesting_error`
 *    en vez de fusionar dos unidades de trabajo en silencio.
 * 3. **Guarda de dev/test**: un centinela `setImmediate` que NO debe llegar a
 *    ejecutarse antes del COMMIT. Si se ejecuta, el cuerpo esperó algo
 *    realmente asíncrono (red, disco, temporizador) con la transacción abierta
 *    y se lanza `transaction_yielded_error`. La cola cubre a las demás
 *    transacciones, pero una escritura suelta (fuera de `withTransaction`) sí
 *    caería dentro de esa ventana; la guarda hace ruidoso ese bug en vez de
 *    dejarlo latente. En producción está apagada (`NODE_ENV`), donde manda la
 *    condición de siempre: en el camino SQLite la fachada devuelve promesas ya
 *    resueltas y el cuerpo se agota en un solo drenaje de microtareas.
 */
export async function withTransaction<T>(db: AnyDb, fn: (tx: AnyDb) => Promise<T>): Promise<T> {
  if (isPgDb(db)) {
    return await (db as AgentosPgDb).transaction(async (tx) =>
      fn(markPgDb(tx as unknown as AnyDb)),
    );
  }
  const lite = db as AgentosSqliteDb;
  const client = lite.$client as unknown as object;

  // Anidamiento del MISMO dueño: se reutiliza la transacción abierta (y NO se
  // encola, o el cuerpo se esperaría a sí mismo).
  const scope = sqliteTxScope.getStore();
  if (scope?.client === client) return await fn(lite);

  const previous = sqliteTxQueue.get(client) ?? Promise.resolve();
  const started = previous.then(
    () => runSqliteTransaction(lite, client, fn),
    () => runSqliteTransaction(lite, client, fn),
  );
  sqliteTxQueue.set(client, started.then(noop, noop));
  return await started;
}

async function runSqliteTransaction<T>(
  lite: AgentosSqliteDb,
  client: object,
  fn: (tx: AnyDb) => Promise<T>,
): Promise<T> {
  const conn = lite.$client;
  if (conn.inTransaction) {
    // Con la cola esto ya no puede ser otra `withTransaction` en paralelo: es
    // una transacción abierta por otro camino. Fusionar sería pérdida silenciosa.
    throw new AgentosError(
      ErrorCodes.TRANSACTION_NESTING_ERROR,
      "Ya hay una transacción SQLite abierta por otro dueño: anidar aquí uniría dos " +
        "unidades de trabajo y un ROLLBACK borraría también las escrituras ajenas.",
    );
  }
  const scope: SqliteTxScope = { client, yielded: false };
  const sentinel = txGuardEnabled()
    ? setImmediate(() => {
        scope.yielded = true;
      })
    : undefined;
  conn.exec("BEGIN IMMEDIATE");
  try {
    const out = await sqliteTxScope.run(scope, () => fn(lite));
    if (scope.yielded) {
      throw new AgentosError(
        ErrorCodes.TRANSACTION_YIELDED,
        "El cuerpo de una transacción SQLite cedió al bucle de eventos (esperó algo " +
          "realmente asíncrono). Con la transacción abierta, cualquier escritura suelta " +
          "de otra petición caería dentro y el ROLLBACK la borraría.",
      );
    }
    conn.exec("COMMIT");
    return out;
  } catch (err) {
    try {
      if (conn.inTransaction) conn.exec("ROLLBACK");
    } catch {
      /* la transacción ya se cerró sola: el error original manda */
    }
    throw err;
  } finally {
    if (sentinel) clearImmediate(sentinel);
  }
}
