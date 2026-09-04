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

**PRD Módulos de Fase: COMPLETO.** Suite completa 493 verdes (60 archivos) + typecheck 10/10 en `feat/modulos-fase`. Mergeado a master en d0ae5de (2026-08-28). Pendiente: visto bueno de Ernesto sobre `requiresApproval` 2→7 del demo (§13.6).

## Fase 2 (aterrizada 2026-08-28)

| # | Bloque | Contenido | Commit | Tests/evidencia |
|---|---|---|---|---|
| F1 | Jerarquía de agentes | Columna `agents.reports_to`; salud de cadena gobierna asignabilidad; `GET /api/agents/org`; MCP `agentos.agents.set_manager`; Quinn raíz independiente | d53b0f7 | incluido en la suite de 513 verdes |
| F2 | ISO 9001 profundo | `methodologies/iso9001-prep.md` (cláusulas 4–10), `iso9001-clausulas.md`, tool `iso.gap_matrix_template`, Sam ampliado | merge 9382a61 | incluido en la suite de 513 verdes |
| F3 | Fuentes del proyecto | Migración 0004 tabla `project_sources`, conector REST a WhatsAppHub (`apps/api/src/connectors/whatsapphub.ts`, env `AGENTOS_WHATSAPPHUB_URL/KEY`), rutas sources/ingest/browse, tools `sources.list/ingest`, sección Fuentes en Contexto (reuniones y hilos de WhatsApp de 2brain → `knowledge_docs` con provenance) | merge e7cd3aa | incluido en la suite de 513 verdes |
| F4 | Módulos de Fase | Ver tabla M0–M6b arriba; merge d0ae5de (11 commits de la sesión par 2brain-0d); spec `docs/PRD-modulos-fase.md`, diseño `ARCHITECTURE.md` §13. Fix posterior: `sanitizeWorkspacePath` (68540f3) — bug real hallado en vivo: nombre de cliente con punto/espacio final rompía el spawn del runner en Windows | d0ae5de + 68540f3 | seed ACME = launch real; 13 tareas en 29ms, 3 runs succeeded ($1.46), idempotencia OK |
| F5 | Postgres + pgvector | Entrypoint `@agentos/db/pg`, 23 tablas espejo, tsvector + pgvector con `EmbeddingProvider` (OpenAI o mock), herramienta `migrate-to-pg`. Capa de datos ✅; app NO corre end-to-end en Postgres todavía (repos SQLite síncronos vs PG asíncronos; motor de launch no portado) — ver `docs/POSTGRES.md` §5 | merge cf9d822 | suite PG dedicada, 28 tests, probada con Docker `pgvector/pgvector:pg16` |

Estado de master: `cf9d822`, 47 commits (2026-08-27/28). Suite: 513 tests verdes + 28 omitidos (suite Postgres, se activa con `AGENTOS_PG_URL`) + 1 skip; typecheck 10/10 paquetes. Esquema commiteado: 23 tablas (migraciones 0000–0004).

## En curso — otra sesión (sin commitear, 2026-09-01→03)

No verificado por esta sesión; se documenta como trabajo en progreso, no como hecho.

- **Módulo operativo de Proyectos y Tareas** (`docs/PRD-MODULO-PROYECTOS-TAREAS.md`, 2026-09-01): responsables humanos múltiples (`task_assignees`), vencimientos, 2 avisos de correo con proveedor falso por defecto, vistas "Mis tareas". En el árbol de trabajo hay una migración 0005 sin commitear (`task_assignees`, `task_notification_log`) → 25 tablas en la DB viva local, aunque el esquema commiteado sigue en 23.
- **Plan de despliegue a EasyPanel**: `Dockerfile.api` + `docs/PLAN-DESPLIEGUE-EASYPANEL.md` (plan, no ejecutado).
- **Plan de migración desde Notion**: `docs/PLAN-MIGRACION-NOTION-EASYPANEL.md` y `docs/MIGRACION-NOTION-TASKS-PROJECTS.md` (Fase 1 preparada, solo lectura, nada escrito).

## Pendientes

- `AGENTOS_WHATSAPPHUB_KEY` (WIKI_SYNC_KEY) en `.env` — pendiente de Ernesto.
- Cambio observable `requiresApproval` del demo 2→7 en DBs frescas (revert de 1 línea) — pendiente visto bueno de Ernesto.
- Q5 `order_key` unique — diferido.
- H12 / `projects.create` con approval — diferido.
- Fase 2 sin construir: WhatsApp (adaptador, el contrato de gateway ya existe), entrevistas IA masivas, auto-mejora de prompts, portal del cliente, MCPs externos reales, catálogo completo de ~50 actividades.
- Postgres: portar la app (repos async, motor de launch) para correr end-to-end sobre PG.
