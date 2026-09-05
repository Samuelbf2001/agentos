import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "db",
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Seed y launch pasan por la fachada asíncrona: con la máquina cargada, los
    // 5s por defecto se quedan cortos (visto en local con varias suites en paralelo).
    testTimeout: 15_000,
    // Los ficheros van EN SERIE: con AGENTOS_PG_URL hay dos suites que apuntan a
    // la MISMA base Postgres y ambas la truncan (y recrean la columna vectorial).
    // En paralelo se pisan y Postgres reporta deadlock en el TRUNCATE.
    fileParallelism: false,
  },
});
