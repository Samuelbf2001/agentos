/**
 * Fachada dual (rama feat/postgres-async): una sola superficie ASÍNCRONA con
 * dos implementaciones. Lo que fija esta suite:
 *
 * - `openConfiguredDb` respeta `AGENTOS_DB_DRIVER` (y falla explícito si el
 *   driver es postgres y falta la URL).
 * - `withTransaction` REVIERTE en los dos motores (NM-1) y commitea el camino
 *   feliz — es la pieza sobre la que se apoya el motor de launch.
 * - `isPgDb` distingue los handles sin que el llamante tenga que saberlo.
 * - El seed y el launch producen EXACTAMENTE los mismos conteos en los dos
 *   motores (el bloque Postgres se auto-omite sin `AGENTOS_PG_URL`).
 */
import { describe, expect, it } from "vitest";
import { openDb } from "../src/client.js";
import { isPgDb, withTransaction } from "../src/facade.js";
import { applyMigrations, closeAnyDb, openConfiguredDb } from "../src/open.js";
import { createOrganization, listOrganizations, listTasks } from "../src/repos.js";
import { runMigrations } from "../src/migrate.js";
import { seed } from "../src/seed.js";

const PG_URL = process.env.AGENTOS_PG_URL;

describe("fachada dual — resolución de motor", () => {
  it("sin AGENTOS_DB_DRIVER abre SQLite y `isPgDb` dice que no", async () => {
    const db = await openConfiguredDb({ dbPath: ":memory:" });
    expect(isPgDb(db)).toBe(false);
    await applyMigrations(db);
    expect((await listOrganizations(db)).length).toBe(0);
    await closeAnyDb(db);
  });

  it("driver postgres sin AGENTOS_PG_URL falla explícito (fail-closed)", async () => {
    const previa = process.env.AGENTOS_PG_URL;
    delete process.env.AGENTOS_PG_URL;
    try {
      await expect(openConfiguredDb({ driver: "postgres" })).rejects.toThrow(/AGENTOS_PG_URL/);
    } finally {
      if (previa !== undefined) process.env.AGENTOS_PG_URL = previa;
    }
  });
});

describe("withTransaction en SQLite (NM-1)", () => {
  it("un throw dentro revierte TODO; el camino feliz commitea", async () => {
    const db = openDb(":memory:");
    runMigrations(db);

    await expect(
      withTransaction(db, async (tx) => {
        await createOrganization(tx, { name: "Revertida S.A.", kind: "client" });
        throw new Error("fallo deliberado dentro de la transacción");
      }),
    ).rejects.toThrow("fallo deliberado");
    expect(await listOrganizations(db)).toHaveLength(0);

    await withTransaction(db, async (tx) => {
      await createOrganization(tx, { name: "Commiteada S.A.", kind: "client" });
    });
    expect(await listOrganizations(db)).toHaveLength(1);
    db.$client.close();
  });
});

// El bloque Postgres se auto-omite si no hay `AGENTOS_PG_URL`: la suite sigue
// verde sin Docker. La base a la que apunte debe ser DESECHABLE (se trunca).
describe.skipIf(!PG_URL)("paridad SQLite ↔ Postgres", () => {
  it(
    "el seed produce los mismos conteos en los dos motores y withTransaction revierte igual",
    async () => {
      const lite = await openConfiguredDb({ driver: "sqlite", dbPath: ":memory:" });
      await applyMigrations(lite);
      const conteosLite = await seed(lite, { env: {} });
      const readyLite = (await listTasks(lite, { status: "READY" })).length;
      await closeAnyDb(lite);

      const pg = await openConfiguredDb({ driver: "postgres", pgUrl: PG_URL });
      expect(isPgDb(pg)).toBe(true);
      const { PG_TABLE_ORDER } = await import("../src/pg/schema-pg.js");
      const client = (pg as unknown as { $client: { unsafe(q: string): Promise<unknown> } }).$client;
      try {
        await applyMigrations(pg);
      } catch (err) {
        // Otra suite pudo dejar `embedding` con otra dimensión (pg-backend usa
        // 64 para probar el pipeline vectorial): recrear la columna es barato.
        if (!/dimensi/.test((err as Error).message)) throw err;
        await client.unsafe(`ALTER TABLE knowledge_docs DROP COLUMN IF EXISTS embedding`);
        await applyMigrations(pg);
      }
      await client.unsafe(
        `TRUNCATE TABLE ${PG_TABLE_ORDER.map((t) => `"${t}"`).join(", ")} CASCADE`,
      );
      const conteosPg = await seed(pg, { env: {} });
      const readyPg = (await listTasks(pg, { status: "READY" })).length;

      // Mismos números salvo `tables`, que se cuenta con catálogos distintos
      // (sqlite_master vs information_schema) pero debe dar 25 en ambos.
      expect(conteosPg).toEqual(conteosLite);
      expect(conteosPg.tables).toBe(25);
      expect(readyPg).toBe(readyLite);

      // NM-1 en Postgres.
      const antes = (await listOrganizations(pg)).length;
      await expect(
        withTransaction(pg, async (tx) => {
          await createOrganization(tx, { name: "Revertida PG S.A.", kind: "client" });
          throw new Error("fallo deliberado dentro de la transacción");
        }),
      ).rejects.toThrow("fallo deliberado");
      expect((await listOrganizations(pg)).length).toBe(antes);

      await closeAnyDb(pg);
    },
    180_000,
  );
});
