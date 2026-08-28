# TASKS — AgentOS Sixteam (MVP)

> Descomposición ejecutable. Fuente: `ARCHITECTURE.md` (plan) + `PRD.md` (criterios). Estado se actualiza aquí.
> Roles: [GP]=general-purpose (Fable), [FW]=fast-worker (Sonnet), [DR]=deep-reasoner (Opus), [ORQ]=orquestador.

| # | Bloque | Contenido | Rol | Depende | Estado |
|---|---|---|---|---|---|
| B0 | Cimientos | pnpm workspaces (corepack; fallback npm -g pnpm), TS estricto, Vitest, `.env.example`, `packages/shared` (uuidv7, errores, zod base, tiempo) | GP | — | pendiente |
| B1 | Datos | `packages/db`: esquema Drizzle 20 tablas + índices, migraciones, FTS5 en `search.ts`, repositorios por agregado, seeds (org Sixteam, 5 personas, 7 agentes desde `agents/*.md`, 6 provider_profiles, metodología assessment-14d, proyecto demo ACME con 12 tareas) | GP | B0 | pendiente |
| B2 | Núcleo ejecución | `packages/events` (AG-UI, bus, ring buffer, persistencia), `packages/providers` (registry + createOpenAICompatible Kimi/MiniMax/GLM, coste, retries), `packages/runners` (AgentRunner, AiSdkRunner, ClaudeCodeRunner con higiene env, RunnerPool semáforos 3/10, presupuestos, kill switch) | GP | B1 | pendiente |
| B3 | Tablero+tools | `packages/core/board` (máquina estados, claim atómico, lease+latido, reaper, política requires_approval, G1/G2, artefacto obligatorio, expected_version) + **tests obligatorios** (carrera doble claim, lease vencido, attempts>=3, gate bloqueando, resume por aprobación) + `packages/tools` (catálogo Zod + 2 adaptadores + gateway política→audit→actuar fail-closed + tools día 1 + contexto: knowledge/processes/methodology) | GP | B1 | pendiente |
| B4 | API | `apps/api` Fastify: REST (tablero, proyectos, agentes, runs, approvals, contexto), login simple, WS multiplexado con since_seq, canal `web` con dedup, despachador determinista + recuperación al boot | GP | B2,B3 | pendiente |
| B5 | UI | `apps/web` Vite+React: shell, store Zustand+WS, Chat (streaming, tool calls, enlaces a tarjetas), Kanban dnd-kit (carriles stage × columnas status, optimista+reconciliación), Enjambre @xyflow solo lectura, vista Run (spans, coste, replay), bandeja "Esperando por ti", Context Hub (docs tipados, procesos), Admin mínimo | FW+GP | B4 | pendiente |
| B6 | MCP admin | `apps/mcp-admin`: perfiles rw/ro, ~35 tools sobre packages/core, idempotency+expected_version+audit; registro en Claude Code de Ernesto | GP | B3 | pendiente |
| B7 | Agentes+demo | Prompts 3 capas de los 7 agentes (constitución Sixteam + PROVENANCE en plataforma), metodología assessment-14d completa, Quinn auto-crítica en REVIEW, guion E2E de aceptación (ver PRD criterio de éxito) | GP+ORQ | B4,B5,B6 | pendiente |
| B8 | QA agéntico | Agente QA dedicado ataca la plataforma corriendo (flujos reales por API/browser), reporte `QA-REPORT.md` con severidad+repro; ciclo de corrección | GP | B7 | pendiente |

**Orden de sacrificio si aprieta el tiempo** (de Opus, vigente): 1º mapa del enjambre, 2º vista de run detallada, 3º ClaudeCodeRunner (arrancar solo ai_sdk). **Nunca**: claim/lease, gates, artefacto obligatorio.

**Pendiente de integrar cuando llegue**: informe `referencia-paperclip.md` (afecta sobre todo visual/orquestación y Context Hub).
