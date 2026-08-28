# TASKS — AgentOS Sixteam (MVP)

> Descomposición ejecutable. Fuente: `ARCHITECTURE.md` (plan) + `PRD.md` (criterios). Estado se actualiza aquí.
> Roles: [GP]=general-purpose (Fable), [FW]=fast-worker (Sonnet), [DR]=deep-reasoner (Opus), [ORQ]=orquestador.

| # | Bloque | Contenido | Rol | Depende | Estado |
|---|---|---|---|---|---|
| B0 | Cimientos | pnpm workspaces (corepack; fallback npm -g pnpm), TS estricto, Vitest, `.env.example`, `packages/shared` (uuidv7, errores, zod base, tiempo) | GP | — | ✅ hecho (commit 487bdf5; pnpm 11.24 vía npm -g, corepack falló EPERM) |
| B1 | Datos | `packages/db`: esquema Drizzle 20 tablas + índices, migraciones, FTS5 en `search.ts`, repositorios por agregado, seeds (org Sixteam, 5 personas, 7 agentes desde `agents/*.md`, 6 provider_profiles, metodología assessment-14d, proyecto demo ACME con 12 tareas) | GP | B0 | ✅ hecho (commit 97a66a9; 31/31 tests; better-sqlite3 nativo; FTS5 ok; task_dependencies omitida a propósito) |
| B2 | Núcleo ejecución | `packages/events` (AG-UI, bus, ring buffer, persistencia), `packages/providers` (registry + createOpenAICompatible Kimi/MiniMax/GLM, coste, retries), `packages/runners` (AgentRunner, AiSdkRunner, ClaudeCodeRunner con higiene env, RunnerPool semáforos 3/10, presupuestos, kill switch) | GP | B1 | ✅ hecho (commit 74009ff; 61 tests: 11 events + 26 providers + 24 runners) |
| B3 | Tablero+tools | `packages/core/board` (máquina estados, claim atómico, lease+latido, reaper, política requires_approval, G1/G2, artefacto obligatorio, expected_version) + **tests obligatorios** (carrera doble claim, lease vencido, attempts>=3, gate bloqueando, resume por aprobación) + `packages/tools` (catálogo Zod + 2 adaptadores + gateway política→audit→actuar fail-closed + tools día 1 + contexto: knowledge/processes/methodology) | GP | B1 | ✅ hecho (commit 2f571aa; 64 tests: 44 core + 20 tools) |
| B4 | API | `apps/api` Fastify: REST (tablero, proyectos, agentes, runs, approvals, contexto), login simple, WS multiplexado con since_seq, canal `web` con dedup, despachador determinista + recuperación al boot | GP | B2,B3 | ✅ hecho (commit 6db42e2; 19 tests; smoke real: mensaje web → Alex vía ClaudeCodeRunner succeeded $0.24) |
| B5 | UI | `apps/web` Vite+React: shell, store Zustand+WS, Chat (streaming, tool calls, enlaces a tarjetas), Kanban dnd-kit (carriles stage × columnas status, optimista+reconciliación), Enjambre @xyflow solo lectura, vista Run (spans, coste, replay), bandeja "Esperando por ti", Context Hub (docs tipados, procesos), Admin mínimo | FW+GP | B4 | ✅ hecho (commit 0f1921c; 31 tests; smoke real con navegador; Tailwind 4 + Radix sin shadcn CLI) |
| B6 | MCP admin | `apps/mcp-admin`: perfiles rw/ro, ~35 tools sobre packages/core, idempotency+expected_version+audit; registro en Claude Code de Ernesto | GP | B3 | ✅ hecho (commit 0b754d6; 55 tools; 29 tests; README con snippets claude mcp add) |
| B7 | Agentes+demo | Prompts 3 capas de los 7 agentes (constitución Sixteam + PROVENANCE en plataforma), metodología assessment-14d completa, Quinn auto-crítica en REVIEW, guion E2E de aceptación (ver PRD criterio de éxito) | GP+ORQ | B4,B5,B6 | ✅ hecho (B7a commit e299af8; B7b demo E2E real ejecutada 2026-08-27/28: criterio de éxito PRD §1 cumplido, 13 runs $6.48, Gate 1/Gate 2/Quinn/kill switch verificados; 12 hallazgos para B8 — ver `docs/DEMO-E2E.md` + `docs/evidence/`) |
| B8 | QA agéntico | Agente QA dedicado ataca la plataforma corriendo (flujos reales por API/browser), reporte `QA-REPORT.md` con severidad+repro; ciclo de corrección | GP | B7 | ✅ hecho (paso1: 10/12 hallazgos; paso2: QA adversario, núcleo de seguridad resistió; paso3: Q1/Q2 integridad de gates corregidos + seed seguro por defecto; 259 tests verdes, typecheck limpio, merge a master) |

**Orden de sacrificio si aprieta el tiempo** (de Opus, vigente): 1º mapa del enjambre, 2º vista de run detallada, 3º ClaudeCodeRunner (arrancar solo ai_sdk). **Nunca**: claim/lease, gates, artefacto obligatorio.

**Referencias integradas**: `referencias-openbot-grokbot.md` y `referencia-paperclip.md` (síntesis hecha; roadmap fase 2: jerarquía reports_to con salud de cadena, goals con fallback, holds de árbol, presupuestos con incidentes, empaquetado de equipo TEAM.md).

## Módulos de Fase (rama `feat/modulos-fase` — spec `PRD-modulos-fase.md`, diseño `ARCHITECTURE.md` §13)

| # | Bloque | Contenido | Rol | Depende | Estado |
|---|---|---|---|---|---|
| M0 | Diseño | Adenda §13 (síntesis Opus verificada 12/12; 2ª opinión Codex en vuelo por limitación del runtime) | ORQ+DR | — | ✅ hecho |
| M1 | Persistencia+validación | Migración `0003_modulos_fase` (phase_modules, module_launches, tasks.depends_on/due_at); piezas puras en shared (ModuleBlueprint Zod, validateBlueprint, planLaunch, renderTemplate, canonicalize/hash, mudanza computeRequiresApproval); exportar splitFrontmatter; `modules/*.md` semillas de los 3 módulos; carga en seed | GP | M0 | ✅ hecho (7e98d95, rebasado sobre fuentes e7cd3aa; 368 tests) |
| M2 | Motor de launch | `launchModule` transaccional en db (pre-vuelo, org/proyecto/tareas/deps/presupuesto/fuentes/recibo/audit), idempotencia, `launchModuleWithEvents` en core; tests NM-1..NM-4 | GP | M1 | ✅ hecho (7bf5df8; 386 tests; NM-2 real 12ms/41ms; org-health puro extraído a shared) |
| M3 | Tablero: dependencias | `system: BACKLOG>READY` + guard fail-closed en moveTask, `promoteUnblockedTasks` en la transición del engine, `phaseClosureStatus`, dispatcher combina `budget:project:<id>` con corte de fase, MCP allowlist+health | GP | M1 | ✅ hecho (ff0d676; 410 tests; guard+hook en la transición de dominio, tick sin reordenar) |
| M4a | MCP+REST | 15 tools `agentos.modules.*` (8 ro + 7 rw), momento B con DB en el repositorio, `previewLaunch` compartido, REST del wizard con eventos por bus/WS | GP | M2,M3 | ✅ hecho (88239d3; 439 tests con M5) |
| M4b | Wizard UI | Wizard 3 pasos con formulario generado del blueprint, preview en vivo, idempotency por intento; badge del launch + panel de cierre de fase en el tablero | GP | M4a | ✅ hecho (7f5ec3a; web 46/46) |
| M5 | Seed ACME=launch | El seed dispara consultoria v1 (12 tareas, 3 READY/9 BACKLOG preservados); requiresApproval 2→7 ⚠️ pendiente visto bueno de Ernesto (revert de 1 línea) | GP | M2 | ✅ hecho (9f3792a) |
| M6a | Encadenado+cadencia (backend) | `prefillNextPhaseInputs`, REST/MCP next-phase, stage al reutilizar proyecto, `previous_launch_id`; cadencia consent-first por re-creación al cerrar instancia (sin dispatcher, sin migración); gate generalizado a fase actual (caso ENTENDER verificado sin regresión) | GP | M4a,M5 | ✅ hecho (a262006; 490 tests) |
| M6b | Cadencia en el wizard | Confirmación interactiva de las cadencias propuestas → `cadences_confirmed` en preview y launch | FW | M6a | ✅ hecho (a123725; incluye fix de desempate en prefillNextPhaseInputs hallado al integrar) |

**PRD Módulos de Fase: COMPLETO.** Suite completa 493 verdes (60 archivos) + typecheck 10/10 en `feat/modulos-fase`. Pendiente: aviso de merge a la sesión que mantiene master + visto bueno de Ernesto sobre `requiresApproval` 2→7 del demo (§13.6).
