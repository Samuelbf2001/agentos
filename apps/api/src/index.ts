/**
 * Entrada de apps/api: `pnpm --filter @agentos/api dev` (tsx watch) o `start`.
 * Puerto 4300; CORS para http://localhost:4301 (apps/web).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_PORT } from "./context.js";
import { buildApi } from "./server.js";

export { buildApi, type Api } from "./server.js";
export { createApiContext, type ApiContext, type ApiOptions } from "./context.js";
export { createDispatcher, type Dispatcher } from "./dispatcher.js";
export { recoverOnBoot, type RecoveryReport } from "./recovery.js";
export { createBus, busSink, publishRaw, domainPayload } from "./bus-bridge.js";
export { bindDomainTools, claudeCodeAllowlist } from "./domain-tools.js";
export { createAuthService, extractToken, type Session } from "./auth.js";

async function main(): Promise<void> {
  const port = Number(process.env.AGENTOS_API_PORT ?? DEFAULT_PORT);
  // AGENTOS_DISPATCHER_DISABLED=1 → API viva sin bucles (diagnóstico/smoke:
  // el canal chat sigue encolando runs, pero el tablero no despacha solo).
  const loopsDisabled =
    process.env.AGENTOS_DISPATCHER_DISABLED === "1" ||
    process.env.AGENTOS_DISPATCHER_DISABLED === "true";
  const { app, ctx } = await buildApi({ logger: true, autoStartLoops: !loopsDisabled });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`Señal ${signal}: cerrando apps/api...`);
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({ port, host: "127.0.0.1" });
  app.log.info(
    {
      recovery: ctx.recovery,
      killSwitch: ctx.engine.isKillSwitchActive(),
    },
    `AgentOS API escuchando en http://127.0.0.1:${port}`,
  );
}

const isMain =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main().catch((err) => {
    console.error("apps/api no pudo arrancar:", err);
    process.exit(1);
  });
}
