import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// apps/web — Vite + React SPA (ARCHITECTURE §1). Solo UI: HTTP + WS contra
// apps/api en http://localhost:4300 (CORS ya permite el origen 4301).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 4301,
    strictPort: true,
  },
});
