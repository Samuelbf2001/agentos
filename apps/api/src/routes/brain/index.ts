/**
 * Rutas de los módulos de 2brain internalizados en AgentOS (Conversaciones,
 * Notas de voz, Videos, Grafo, Agente 2brain). Este archivo solo cablea el
 * orden de registro; cada módulo llena su propio fichero cuando le toque.
 */
import type { FastifyInstance } from "fastify";
import type { ApiContext } from "../../context.js";
import { registerBrainConversacionesRoutes } from "./conversaciones.js";
import { registerBrainNotasVozRoutes } from "./notas-voz.js";
import { registerBrainVideosRoutes } from "./videos.js";
import { registerBrainGrafoRoutes } from "./grafo.js";
import { registerBrainAgenteRoutes } from "./agente.js";

export function registerBrainModuleRoutes(app: FastifyInstance, ctx: ApiContext): void {
  registerBrainConversacionesRoutes(app, ctx);
  registerBrainNotasVozRoutes(app, ctx);
  registerBrainVideosRoutes(app, ctx);
  registerBrainGrafoRoutes(app, ctx);
  registerBrainAgenteRoutes(app, ctx);
}
