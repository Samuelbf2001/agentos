import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "runners",
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
