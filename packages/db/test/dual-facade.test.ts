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
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/client.js";
import { isPgDb, withTransaction } from "../src/facade.js";
import { applyMigrations, closeAnyDb, openConfiguredDb } from "../src/open.js";
import {
  activateModuleVersion,
  createModuleVersion,
  createOrganization,
  getActiveModule,
  listOrganizations,
  listTasks,
} from "../src/repos.js";
import { launchModule } from "../src/modules/launch.js";
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

describe("withTransaction en SQLite — aislamiento entre transacciones (B2)", () => {
  const guardPrevio = process.env.AGENTOS_TX_GUARD;
  afterEach(() => {
    if (guardPrevio === undefined) delete process.env.AGENTOS_TX_GUARD;
    else process.env.AGENTOS_TX_GUARD = guardPrevio;
  });

  it("Promise.all: la que lanza revierte SOLO lo suyo y la que escribe persiste", async () => {
    const db = openDb(":memory:");
    runMigrations(db);

    // Antes se fusionaban: la segunda devolvía éxito y el ROLLBACK de la
    // primera se llevaba sus filas por delante (pérdida silenciosa).
    const [fallida, buena] = await Promise.allSettled([
      withTransaction(db, async (tx) => {
        await createOrganization(tx, { name: "Revertida A", kind: "client" });
        throw new Error("fallo de A");
      }),
      withTransaction(db, async (tx) => {
        await createOrganization(tx, { name: "Commiteada B", kind: "client" });
      }),
    ]);

    expect(fallida!.status).toBe("rejected");
    expect(buena!.status).toBe("fulfilled");
    expect((await listOrganizations(db)).map((o) => o.name)).toEqual(["Commiteada B"]);
    db.$client.close();
  });

  it("con la guarda apagada, la cola hace ESPERAR a la escritura externa (nada se pierde)", async () => {
    process.env.AGENTOS_TX_GUARD = "off";
    const db = openDb(":memory:");
    runMigrations(db);

    const lenta = withTransaction(db, async (tx) => {
      await createOrganization(tx, { name: "Lenta 1", kind: "client" });
      await sleep(20); // await REAL: cede el bucle de eventos
      await createOrganization(tx, { name: "Lenta 2", kind: "client" });
    });
    const externa = withTransaction(db, async (tx) => {
      await createOrganization(tx, { name: "Externa", kind: "client" });
    });

    await Promise.all([lenta, externa]);
    const nombres = (await listOrganizations(db)).map((o) => o.name).sort();
    expect(nombres).toEqual(["Externa", "Lenta 1", "Lenta 2"]);
    db.$client.close();
  });

  it("con la guarda encendida, un cuerpo que cede al bucle de eventos se rechaza", async () => {
    process.env.AGENTOS_TX_GUARD = "on";
    const db = openDb(":memory:");
    runMigrations(db);

    const lenta = withTransaction(db, async (tx) => {
      await createOrganization(tx, { name: "Lenta 1", kind: "client" });
      await sleep(20);
    });
    const externa = withTransaction(db, async (tx) => {
      await createOrganization(tx, { name: "Externa", kind: "client" });
    });

    await expect(lenta).rejects.toMatchObject({ code: "transaction_yielded_error" });
    await externa;
    // La externa NO se pierde; la culpable revierte entera.
    expect((await listOrganizations(db)).map((o) => o.name)).toEqual(["Externa"]);
    db.$client.close();
  });

  it("anidar desde el MISMO dueño reutiliza la transacción (y revierte entera)", async () => {
    const db = openDb(":memory:");
    runMigrations(db);

    await withTransaction(db, async (tx) => {
      await createOrganization(tx, { name: "Nivel 1", kind: "client" });
      await withTransaction(tx, async (tx2) => {
        await createOrganization(tx2, { name: "Nivel 2", kind: "client" });
      });
    });
    expect(await listOrganizations(db)).toHaveLength(2);

    await expect(
      withTransaction(db, async (tx) => {
        await createOrganization(tx, { name: "No commiteada", kind: "client" });
        await withTransaction(tx, async () => {
          throw new Error("fallo del nivel anidado");
        });
      }),
    ).rejects.toThrow("fallo del nivel anidado");
    expect(await listOrganizations(db)).toHaveLength(2);
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

      // Todos los conteos coinciden, `tables` incluido: se cuenta con catálogos
      // distintos (sqlite_master vs information_schema) y aun así da 31 en ambos
      // (25 originales + task_labels de la 0006 + las 5 de linaje de Notion de la 0007).
      expect(conteosPg).toEqual(conteosLite);
      expect(conteosPg.tables).toBe(31);
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

  it(
    "activar una versión nueva NUNCA deja el slug sin módulo activo (I4)",
    async () => {
      const pg = await openConfiguredDb({ driver: "postgres", pgUrl: PG_URL });
      const { PG_TABLE_ORDER } = await import("../src/pg/schema-pg.js");
      const client = (pg as unknown as { $client: { unsafe(q: string): Promise<unknown> } }).$client;
      await applyMigrations(pg);
      await client.unsafe(
        `TRUNCATE TABLE ${PG_TABLE_ORDER.map((t) => `"${t}"`).join(", ")} CASCADE`,
      );
      await seed(pg, { env: {} });

      const v1 = (await getActiveModule(pg, "consultoria"))!;
      const versiones = [v1.version + 1, v1.version + 2, v1.version + 3];
      for (const version of versiones) {
        await createModuleVersion(pg, {
          slug: v1.slug,
          version,
          name: v1.name,
          phase: v1.phase,
          projectType: v1.projectType,
          methodologySlug: v1.methodologySlug,
          methodologyVersion: v1.methodologyVersion,
          blueprint: v1.blueprint,
          bodyMd: v1.bodyMd,
          createdBy: "test",
        });
      }

      // Lector en bucle mientras se activan tres versiones seguidas: antes,
      // entre el "archivar la activa" y el "activar la nueva" había una ventana
      // con CERO activas y un launchModule concurrente moría con module_not_active.
      let activando = true;
      const huecos: number[] = [];
      const lector = (async () => {
        while (activando) {
          if (!(await getActiveModule(pg, "consultoria"))) huecos.push(Date.now());
        }
      })();

      const launch = launchModule(pg, {
        moduleSlug: "consultoria",
        org: { name: "Concurrente S.A.", kind: "client", industria: "manufactura", employeeCount: 40 },
        inputs: {
          empresa: "Concurrente S.A.",
          alias: "Concurrente",
          industria: "manufactura",
          empleados: 40,
          sponsor: "Gerente General",
          objetivo: "Diagnóstico del ciclo Entender.",
          areas: ["direccion", "operaciones", "ventas"],
          procesos_core: ["Producción", "Ventas → Facturación"],
          fecha_objetivo: "2026-09-15",
        },
        actor: "person:test",
        idempotencyKey: "launch:test:i4",
      }).catch((err: unknown) => err);

      for (const version of versiones) {
        await activateModuleVersion(pg, "consultoria", version);
      }
      activando = false;
      await lector;
      const resultado = await launch;

      expect(huecos).toEqual([]);
      expect(resultado).not.toBeInstanceOf(Error);
      expect((await getActiveModule(pg, "consultoria"))!.version).toBe(v1.version + 3);
      await closeAnyDb(pg);
    },
    180_000,
  );
});
