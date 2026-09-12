import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// apps/web — Vite + React SPA (ARCHITECTURE §1). Solo UI: HTTP + WS contra
// apps/api en http://localhost:4300 (CORS ya permite el origen 4301).
//
// El proxy de `/api` es la red de seguridad para lo que NO pasa por el cliente
// `fetch`: una `<img src="/api/uploads/…">` escrita a mano, un enlace pegado o
// cualquier ruta relativa que acabe en una descripción. El cliente de datos
// sigue hablando directo con 4300 (`API_BASE`) y las imágenes que sube se
// guardan ya absolutas, así que esto no cambia el camino normal: sólo evita
// que una ruta relativa se resuelva contra el puerto de Vite y muera en 404.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 4301,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://localhost:4300",
        changeOrigin: true,
      },
    },
  },
});
