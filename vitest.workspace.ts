import { defineWorkspace } from "vitest/config";

// Cada workspace que tenga tests declara su propio vitest.config.ts.
export default defineWorkspace([
  "packages/*/vitest.config.ts",
  "apps/*/vitest.config.ts",
]);
