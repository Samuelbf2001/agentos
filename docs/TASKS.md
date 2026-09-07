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
| F5 | Postgres + pgvector | Entrypoint `@agentos/db/pg`, 25 tablas espejo, tsvector + pgvector con `EmbeddingProvider` (OpenAI o mock), herramienta `migrate-to-pg`. Capa de datos ✅; app NO corría end-to-end en Postgres (repos SQLite síncronos vs PG asíncronos; motor de launch no portado) — **resuelto en F6** | merge cf9d822 | suite PG dedicada, 28 tests, probada con Docker `pgvector/pgvector:pg16` |
| F6 | **App entera sobre Postgres** (rama `feat/postgres-async`) | Una sola interfaz **asíncrona** de repositorios con dos implementaciones (`src/facade.ts` + `src/repos.ts`); `pg/repositories/modules.ts` que faltaba; `launchModule` y `seed` reescritos UNA vez sobre `withTransaction` (BEGIN IMMEDIATE en SQLite, `db.transaction(async tx)` en PG); los 13 usos de `db.$client` fuera de la capa de datos sustituidos por funciones de repositorio duales; `openConfiguredDb/applyMigrations/closeAnyDb` leen `AGENTOS_DB_DRIVER`/`AGENTOS_PG_URL`; `knowledge.search` usa tsvector en PG y FTS5 en SQLite | (esta rama) | typecheck 11/11 paquetes. Suite **sin** `AGENTOS_PG_URL`: 553 verdes + 32 omitidos. Suite **con** `AGENTOS_PG_URL`: **584 verdes + 1 omitido** (los 28 de `pg-backend` ya no se omiten). Test end-to-end nuevo `apps/api/test/pg-end-to-end.test.ts` + paridad de motores en `packages/db/test/dual-facade.test.ts`. `migrate-to-pg` verificado: 66 filas / 25 tablas, integridad OK e idempotente al repetir |

Estado de master: `cf9d822`, 47 commits (2026-08-27/28). Suite: 513 tests verdes + 28 omitidos (suite Postgres, se activa con `AGENTOS_PG_URL`) + 1 skip; typecheck 10/10 paquetes. Esquema commiteado: 23 tablas (migraciones 0000–0004).

## En curso — otra sesión (sin commitear, 2026-09-01→03)

No verificado por esta sesión; se documenta como trabajo en progreso, no como hecho.

- **Módulo operativo de Proyectos y Tareas** (`docs/PRD-MODULO-PROYECTOS-TAREAS.md`, 2026-09-01): responsables humanos múltiples (`task_assignees`), vencimientos, 2 avisos de correo con proveedor falso por defecto, vistas "Mis tareas". En el árbol de trabajo hay una migración 0005 sin commitear (`task_assignees`, `task_notification_log`) → 25 tablas en la DB viva local, aunque el esquema commiteado sigue en 23.
- **Plan de despliegue a EasyPanel**: `Dockerfile.api` + `docs/PLAN-DESPLIEGUE-EASYPANEL.md` (plan, no ejecutado).
- **Plan de migración desde Notion**: `docs/PLAN-MIGRACION-NOTION-EASYPANEL.md` y `docs/MIGRACION-NOTION-TASKS-PROJECTS.md` (Fase 1 preparada, solo lectura, nada escrito).

## Oleada "Tareas usables" — rama `feat/tareas-ui` (2026-09-05)

El módulo de Proyectos/Tareas tenía la lógica construida pero la interfaz no permitía el uso diario:
`api.createTask` existía sin ningún botón que lo llamara, la ficha no dejaba adjuntar evidencia (así que
arrastrar a DONE devolvía `missing_artifact` y se revertía), no había campo para la definición de terminado,
ni etiquetas, ni búsqueda, ni vista transversal por persona, y `processDue` no lo programaba nadie.

| # | Entrega | Piezas clave |
|---|---------|--------------|
| 1 | Crear tarea desde la interfaz | `apps/web/src/views/CreateTaskDialog.tsx` (validación en línea), botón `＋ Nueva tarea` en `BoardView` |
| 2 | Cerrar tarea desde la interfaz | `POST /api/tasks/:id/artifacts/upload` (multipart, `apps/api/src/artifact-files.ts`), `GET /api/artifacts/:id/download`; `ArtifactAttacher`, `TaskFieldsEditor` y `DefinitionOfDoneEditor` en `TaskDrawer`; `blockedMove` en el store explica el rechazo del motor y ofrece reintentar en vez de revertir en silencio |
| 3 | Etiquetas | Migración **SQLite 0006 / Postgres 0002** (`task_labels`, tabla de unión para poder filtrar en ambos motores); repos duales `repositories/task-labels.ts` + `pg/repositories/task-labels.ts`; `PUT /api/tasks/:id/labels`, `GET /api/labels`; chips en la tarjeta y filtro en el tablero |
| 4 | Búsqueda de tareas | `GET /api/tasks/search`; FTS5 (`tasks_fts` + `task_comments_fts` en `search.ts`) y tsvector con plan B ILIKE (`searchTasksPg`); `TaskSearchBox` en tablero y en Mis tareas |
| 5 | Vista "Mis tareas" | `apps/web/src/views/MyTasksView.tsx`, ruta `/my-tasks`, agrupación por vencimiento con los mismos cortes que la píldora de la tarjeta |
| 6 | Reloj de recordatorios | `createNotificationScheduler` en `notifications.ts`, arrancado por `createApiContext`; `AGENTOS_NOTIFICATIONS_INTERVAL_MS` (0/`off` lo apaga) |
| 7 | MCP admin alineado | `agentos.tasks.create` acepta `due_at`, `assignee_person_ids` y `labels`; `tasks.list` filtra por persona y etiqueta; `tasks.update` acepta `due_at` y `labels` |

Extras necesarios para que lo anterior funcione de verdad: `GET /api/projects/:id/people` (el selector de
responsables sólo ofrece personas de la organización del proyecto, que es lo único que la regla de
aislamiento humano acepta) y `AGENTOS_WEB_ORIGIN` para CORS con la web en otro puerto.

**Hallazgo abierto:** en la DB seedeada, todas las personas pertenecen a la organización *Sixteam* y el
proyecto demo a *ACME S.A.*; como el PRD exige que un responsable pertenezca a la organización del
proyecto, en el demo **no se puede asignar a nadie del equipo interno**. El código respeta el PRD; lo que
está desalineado es el seed. Decidir: o el seed crea personas de la organización cliente, o la regla admite
al equipo interno. No se tocó la regla sin visto bueno.

## Migración desde Notion (rama `feat/notion-import`, 2026-09-05)

| # | Bloque | Contenido | Estado |
|---|---|---|---|
| N-A | Linaje | Migración `0007_notion_linaje` (SQLite) y `0003_notion_linaje` (Postgres): `notion_migration_runs`, `notion_page_archives`, `notion_import_links`, `notion_identity_mappings`, `notion_import_quarantine` + repos duales | ✅ hecho |
| N-B | Mapa de campos | `packages/notion-migration/src/field-map.ts`: estados, prioridad, fechas, identidad por correo confirmado, relaciones por esquema (no por rótulo), defaults de `stage`/`type` | ✅ hecho |
| N-C | Importador | CLI idempotente `--snapshot --db [--pilot t,p] [--dry-run] [--identity-map]`, dos pasadas, informe de conciliación en `notion_migration_runs` | ✅ hecho |
| N-D | Capturador ampliado | Adjuntos con SHA-256 dentro del snapshot + segunda pasada de páginas archivadas con excepción explícita si Notion la rechaza | ✅ hecho |
| N-E | Ficha de origen | `GET /api/tasks/:id/notion-origin` y `GET /api/projects/:id/notion-origin` (solo lectura). `apps/web` NO tocado: la UI es de la ola siguiente | ✅ hecho (contrato listo) |
| N-F | Piloto y conciliación | Piloto e importación completa ejecutados sobre COPIAS de la DB viva. La importación a producción está **pendiente de la aprobación de Ernesto** | ⏳ ver §11 de `docs/MIGRACION-NOTION-TASKS-PROJECTS.md` |
| N-G | Corte de escrituras de WhatsAppHub | Inventario verificado y documentado (§12 del mismo documento). **No implementado**: es la fase N5 | ⏳ pendiente |

## Oleada "Amputación de estructura" — rama `feat/amputacion-ux` (2026-09-05)

Revisión de estructura y UX de `apps/web` tras la sensación de desorden: las mismas cosas en varios
sitios, jerarquía escondida en sub-pestañas sin URL, restos de la navegación anterior y un solo rol real.
Mapa completo (módulos, pantallas, conexiones, duplicaciones, matriz de roles) en el artifact
"AgentOS, mapa y amputación". Solo cliente: ninguna ruta de la API ni invariante del tablero cambió.

| # | Corte | Piezas clave |
|---|-------|--------------|
| C1 | Hoy sin la tabla de proyectos | `HoyView` queda en decisiones + pulso; la tabla vive solo en `/proyectos` |
| C2 | Tareas solo en modo tabla | Fuera el kanban por estado de `TareasView` y `leerVista/guardarVista`; el único tablero es el del proyecto |
| C3 | Una sola búsqueda | Fuera el `TaskSearchBox` embebido del Tablero; queda la global (`/` y botón de cabecera) |
| C4 | Kill switch en un solo control | Banner solo informativo; el botón de cabecera pausa y reanuda; Configuración muestra el estado |
| C5 | Equipo absorbe Agentes | `AgentsSection.tsx` (tabla editable, columna "Reporta a") dentro de `SystemTeamView`; `ajustes` → `configuracion` con redirección |
| C6 | Reuniones sale del proyecto | `MeetingProcessingView` se monta en Sistema › Fuentes; Contexto conserva las fuentes asociadas |
| C7 | Salud pasa a Fuentes | Sin los seis contadores; `salud` → `fuentes` con redirección |
| C8 | Activo sin Capacidades | "Lanzar este módulo" pasa `?modulo=<slug>` y el wizard arranca en el paso 2 |
| C9 | Sub-pestañas de Contexto en la URL | `/proyectos/:id/contexto/documentos\|procesos`, `paths.contexto()`, `CONTEXT_SUBTABS` |
| C10 | Proyecto solo desde la URL | Sin `agentos_project` en localStorage; los enlaces de la ficha usan `task.projectId`; `/board`, `/chat`, `/context` → `/proyectos` |
| C11 | El wizard aterriza en Ruta | Única entrada al proyecto que caía en otra pestaña |
| C14 | Estados vacíos obsoletos fuera | "Entra por un proyecto" y "Elige un proyecto (en el tablero)" |
| C15 | Código huérfano fuera | `store.myTasks`, `GateMissing.to`, wrappers de `api.ts` sin uso, `patchTask` duplicado |
| C16 | Shell por capacidades | `lib/capabilities.ts`: nav, pestañas de proyecto y sistema, buscar y pausar se filtran por un conjunto de capacidades; hoy todo el mundo las tiene todas |

Descartados por ahora: C12 (filtros del Tablero en la URL) y C13 (pulso sin el contador de decisiones).
La suite web queda en 24 archivos / 201 tests tras integrar la ficha estilo Notion de master.

## Oleada Rediseño UI (rama `feat/amputacion-ux`, 2026-09-05)

Segunda pasada sobre la misma rama, ya con la estructura amputada: lenguaje visual propio, el shell lateral
con cambio de perspectiva Sixteam/cliente, Hoy y Clientes como tableros, 2brain integrado como módulo y
Tareas/Tablero/Ruta con lo secundario plegado por defecto.

| # | Área | Piezas clave |
|---|------|--------------|
| 1 | Lenguaje visual | Tokens propios, primitivas de `components/system.tsx`/`ui.tsx` sin borde, pastillas de estado en vez de texto plano |
| 2 | Shell lateral con perspectiva | `Sidebar`/`Topbar`/`PerspectiveSwitch`: cambio Sixteam ↔ cliente por URL, selector de cliente con buscador |
| 3 | Hoy y Clientes como tableros | `HoyView` y `ProjectsView` pintan tarjetas, no listas planas |
| 4 | 2brain como módulo | Panorama y reuniones (`BrainView`/`BrainMeetingsView`) viven dentro de AgentOS; lo que no migró queda como enlace externo a WhatsAppHub |
| 5 | Tareas/Tablero/Ruta más limpios y previsualización de cliente | Filtros plegados en Tareas, carriles fuera de la fase activa plegados en el Tablero, recibo de lanzamiento plegado en Ruta; botón "Ver como cliente" (`PreviewRole`, previsualización local, no un permiso real) que reduce el shell a Resumen/Contexto/Decisiones |

Estado de la suite tras esta oleada: 29 archivos / 229 tests verdes, typecheck limpio.

## Pendientes

- **Decisiones de la migración de Notion que Ernesto debe confirmar**: §13 de `docs/MIGRACION-NOTION-TASKS-PROJECTS.md` (stage/type uniformes, organización destino, `description` vacía, tabla de prioridad, correos de `people`).
- `AGENTOS_WHATSAPPHUB_KEY` (WIKI_SYNC_KEY) en `.env` — pendiente de Ernesto.
- Cambio observable `requiresApproval` del demo 2→7 en DBs frescas (revert de 1 línea) — pendiente visto bueno de Ernesto.
- Q5 `order_key` unique — diferido.
- H12 / `projects.create` con approval — diferido.
- Fase 2 sin construir: WhatsApp (adaptador, el contrato de gateway ya existe), entrevistas IA masivas, auto-mejora de prompts, portal del cliente, MCPs externos reales, catálogo completo de ~50 actividades.
- Postgres: ~~portar la app (repos async, motor de launch)~~ ✅ hecho en `feat/postgres-async`. Queda: RLS por cliente (disparador 4 de `POSTGRES.md` §1) y `FOR UPDATE SKIP LOCKED` como mejora opcional de rendimiento del claim en lote.

## Entorno de pruebas (rama `feat/sandbox`, 2026-09-05)

Modo pruebas reutilizable ✅ hecho: `AGENTOS_SANDBOX=1` habilita `POST
/api/auth/sandbox-login` (fail-closed en producción, `resolveSandbox` en
`apps/api/src/context.ts`); LoginView y el chip "Pruebas" del shell reaccionan
a `sandbox` en `GET /api/health`; `scripts/sandbox.mjs` (+ `pnpm sandbox:*` y
`.claude/launch.json`) copia `data/agentos.db` a `data/sandbox.db` y arranca
api/web en `:4310`/`:4311`. Detalle de uso en `docs/SANDBOX.md`.

## Grafo organizacional (rama `feat/organigrama`, 2026-09-07)

Modelo (PRD v1.1 §3.1 y Parte II §5.3): **el rol es el centro**. Cuelga de un área, reporta a otro rol, lo
ocupan personas, tiene funciones y participa en procesos (dueño único o participante). `apps/web` NO se
tocó en esta rama: la construye en paralelo otro worktree contra este mismo contrato de API.

**Índices de migración reservados**: SQLite `0008_grafo_organizacional` (idx 8) y Postgres
`0004_grafo_organizacional` (idx 4), ambos con `when: 1788120000000` — ver
`packages/db/drizzle/meta/_journal.json` y `packages/db/drizzle-pg/meta/_journal.json`.

| Tabla | Contenido |
|---|---|
| `org_units` | Áreas del organigrama; `parent_unit_id` auto-FK para sub-áreas |
| `org_roles` | El centro del grafo: `unit_id`, `reports_to_role_id` (auto-FK, ciclo rechazado), `canvas_x`/`canvas_y` (posición en el lienzo), `status` (`draft`/`validated`), `version` (optimistic locking, salvo el arrastre de canvas) |
| `role_functions` | Funciones del rol, `position` ordena la lista |
| `role_people` | Personas que ocupan el rol (unión, PK compuesta), `dedication_pct` opcional |
| `role_processes` | Procesos en los que participa el rol (unión, PK compuesta), `relation` `owner`/`participant` |

`packages/shared/src/schemas.ts`: `OrgRoleStatus` y `RoleProcessRelation`. Repos duales
`packages/db/src/repositories/org-graph.ts` + `pg/repositories/org-graph.ts`, compuestos en `repos.ts`.
Total de tablas de dominio: 31 → **36**.

Rutas (`apps/api/src/routes/org-graph.ts`, `registerOrgGraphRoutes`), todas con sesión y `appendAudit`
(`source: "ui"`, acciones `org_unit.*` / `org_role.*`):

| Ruta | Contrato |
|---|---|
| `GET /api/orgs/:orgId/graph` | `{ units, roles, processes, people }` — 404 si la org no existe |
| `POST /api/orgs/:orgId/units` · `PATCH /api/units/:id` · `DELETE /api/units/:id` | `{unit}` / `{unit}` / `{ok:true}` |
| `POST /api/orgs/:orgId/roles` | `{role}` con `functions:[]`, `people:[]`, `processes:[]` |
| `PATCH /api/roles/:id` | `{role}`; ciclo de reporte → 400 `validation_error`; `expected_version` desalineada → 409 `version_conflict`; solo `canvas_x`/`canvas_y` no sube `version` ni la exige |
| `DELETE /api/roles/:id` | `{ok:true}`; subordinados quedan sin manager, se borran sus uniones |
| `PUT /api/roles/:id/functions` | `{functions}` — conserva ids dados |
| `PUT /api/roles/:id/people` | `{people}` — 400 si la persona no es de la organización del rol |
| `PUT /api/roles/:id/processes` | `{processes}` — 400 si el proceso no es de la organización del rol |

Seed (`packages/db/src/seed.ts`, `seedOrgGraphAcme`, SOLO org "ACME S.A.", idempotente): 4 áreas
(Dirección, Producción, Comercial, Administración), 4 personas de ACME (María Restrepo, Carlos Pérez,
Laura Gómez, Andrés Mora), 6 roles con posición en canvas y reporta-a (Gerente General en la raíz;
Supervisor de Planta y Vendedor quedan vacantes a propósito), 2 procesos (`createProcess` idempotente por
nombre) con sus uniones owner/participante.

**Tests**: `packages/db/test/org-graph.test.ts` (6, repositorio: CRUD de áreas/roles, `getOrgGraph`, ciclo
rechazado, conflicto de versión, borrado limpia uniones, `replaceRoleFunctions` conserva ids) +
`apps/api/test/org-graph.test.ts` (5, REST: flujo completo, ciclo 400, versión 409, persona/proceso de otra
org 400, auditoría) + caso nuevo en `migration-seed.test.ts` (ACME con 6 roles/4 áreas/2 procesos sin
duplicar tras re-seed) + conteos de tabla (31→36) actualizados en `pg-portability.test.ts`,
`pg-backend.test.ts`, `dual-facade.test.ts`, `apps/api/test/rest.test.ts` y `pg-end-to-end.test.ts`.
`pnpm -r typecheck` limpio; `@agentos/shared` (62), `@agentos/db` (140 + 41 PG auto-omitidos) y
`@agentos/api` (152 + 2 PG auto-omitidos) verdes.
