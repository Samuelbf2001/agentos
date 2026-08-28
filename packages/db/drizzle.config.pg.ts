import { defineConfig } from "drizzle-kit";

/**
 * Migraciones de Postgres — carpeta APARTE (`drizzle-pg/`) para que el
 * historial de SQLite (`drizzle/`) no se contamine. `pnpm --filter @agentos/db generate:pg`.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/pg/schema-pg.ts",
  out: "./drizzle-pg",
  strict: true,
  verbose: true,
});
