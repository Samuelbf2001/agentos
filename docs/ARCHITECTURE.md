# ARCHITECTURE — AgentOS Sixteam

> **Plan canónico** (el *cómo*). Síntesis del orquestador (2026-08-27) sobre `proposal-opus.md`, `proposal-codex.md` y `referencias-openbot-grokbot.md`. La spec está en `PRD.md`.
> Donde Opus y Codex divergieron, la decisión final está marcada **[SÍNTESIS]** con su porqué.

## 1. Topología de procesos — 3 procesos Node

- **`apps/api`** — Fastify. **Dueño único de SQLite**, del bus de eventos, del despachador, del RunnerPool y del WebSocket. Proceso largo, sin hot-reload agresivo.
- **`apps/web`** — **Vite + React SPA**. Solo UI: HTTP + WS contra `apps/api`. No toca la base de datos.
- **`apps/mcp-admin`** — Servidor MCP (stdio + streamable HTTP en 127.0.0.1), capa fina sobre `packages/core`, perfiles `rw`/`ro`.

**[SÍNTESIS] API separada de la UI** (Opus sobre Codex): el hot-reload del framework web no puede matar runs largos ni procesos hijos, y SQLite con un único proceso escritor elimina la clase `SQLITE_BUSY`. El despachador/worker vive DENTRO de `apps/api` (Codex lo quería aparte; a esta escala un proceso menos gana, y la recuperación al boot cubre lo mismo).

**[SÍNTESIS] Vite SPA en vez de Next.js** (ambas propuestas decían Next): con la API separada no hay SSR que justifique Next; Vite tiene HMR más rápido y menos fricción en Windows, y OpenBot —la referencia más cercana— usa exactamente React/Vite. Stack UI: Tailwind + shadcn/ui, dnd-kit (kanban), @xyflow/react (mapa, solo lectura), Zustand (store alimentado por WS), react-markdown + shiki.

## 2. Transporte en vivo — WebSocket multiplexado

**[SÍNTESIS] WS, no SSE** (Opus sobre Codex): necesitamos bidireccionalidad (aprobar, cancelar, pausar) y fan-out multi-topic. Topics: `run:<id>`, `board:<project_id>`, `thread:<id>`, `swarm`, `approvals`, `channel:<name>`.

- Resume por `since_seq`: ring buffer por topic (500 eventos) + persistencia en `events`. Al reconectar, el cliente manda su último `seq` y recibe el hueco.
- Regla de OpenBot: **el WS es optimización, nunca fuente de verdad** — el cliente refetchea snapshot al reconectar si el hueco excede el buffer.
- Vocabulario de eventos: **AG-UI** (`RUN_STARTED`, `TEXT_MESSAGE_*`, `TOOL_CALL_*`, `STATE_SNAPSHOT`, `STATE_DELTA` JSON Patch, `RUN_FINISHED`, `RUN_ERROR`). Sin el runtime de CopilotKit (ambas propuestas coinciden; open-multi-agent-canvas y open-mcp-client se usan solo como patrón de UX).

## 3. Runtime de agentes — híbrido tras una interfaz

```ts
interface AgentRunner {
  run(input: RunInput, ctx: RunContext): AsyncIterable<AgUiEvent>
  cancel(runId: string): Promise<void>
}
```

- **`ClaudeCodeRunner`** — envuelve `query()` de `@anthropic-ai/claude-agent-sdk` (proceso hijo). Para agentes que necesitan **computadora** (ficheros, código, git): **Debbie, Vinnie, Quinn**. Detalles endurecidos tomados del driver Claude de OpenMausBot: persona vía system prompt append, continuidad por session id, **higiene de entorno** (limpiar `ANTHROPIC_API_KEY` heredada para no facturar API por accidente cuando se quiere suscripción; verificar login del CLI), tools built-in restringidas por allowlist, workspace por proyecto.
- **`AiSdkRunner`** — loop propio compacto sobre **Vercel AI SDK** (`streamText` + `stopWhen` + tools), in-process. Para agentes conversacionales/datos: **Alex, Sam, Sally, Clara**.
- `agents.runtime` es un **dato** ('claude_code' | 'ai_sdk'), igual que `provider_profile_id`. **Fallback de arranque**: si el proveedor de un agente `ai_sdk` no tiene credencial configurada, el seed lo deja en `claude_code` (suscripción) y la UI lo señala — así el MVP funciona con CERO API keys.
- Eventos internos normalizados estilo `RuntimeEvent` (patrón contracts.ts de OpenMausBot + transports de Hermes), con **flags de capacidad por driver** ("nunca mostrar un knob que el driver no puede girar").
- `RunnerPool`: semáforos independientes (`claude_code`: 3, `ai_sdk`: 10), timeouts, presupuesto por run/día, cola de espera **visible en la UI** como estado legítimo.

## 4. Catálogo de tools — una definición, dos adaptadores, un gateway

Cada tool se declara UNA vez (nombre, Zod schema, handler, flags `read_only` / `external_effect` / `requires_approval`) y se materializa: como `tool()` de AI SDK para `AiSdkRunner`, y como servidor MCP in-process (`createSdkMcpServer`, namespacing `mcp__agentos__<tool>`) para `ClaudeCodeRunner`. (Patrón `convert_tools` de Hermes; evita que el catálogo se bifurque.)

**Toda ejecución pasa por un gateway único** (patrón estrella de OpenBot): resolver target → evaluar política (allowlist del agente + flags + gates) → **escribir audit ANTES de actuar** → ejecutar; segunda fila si falla. **Fail-closed**: sin política no hay permiso; regla rota = rechazo. Política en JSON simple el día 1 (CEL es fase 2).

Tools de día 1: `tasks.{create,claim,move,comment,attach_artifact,list,get}`, `board.get`, `projects.{get,update}`, `knowledge.search`, `artifacts.write`, `delegate` (= `tasks.create` con padre), `ask_human` (crea approval), stub `email.send` (efecto externo, para ejercitar Gate 2).

## 5. Persistencia — SQLite día 1

`better-sqlite3` WAL + **Drizzle ORM**, propiedad exclusiva de `apps/api`. Reglas de portabilidad no opcionales: IDs `uuidv7` TEXT; timestamps INTEGER epoch ms; JSON en TEXT `mode:'json'`; todo acceso vía `packages/db/repositories/*`; FTS5 aislado en `search.ts` (equivalente tsvector documentado); sin triggers de negocio en SQL.

**Disparadores de migración a Postgres/Supabase** (cualquiera dispara, antes no): >1 proceso escritor; acceso remoto multi-usuario concurrente; DB >5 GB; autorización por fila por cliente; búsqueda vectorial.

> **Adenda 2026-08-28 — Postgres HABILITADO como backend alternativo** (spec y detalle en `POSTGRES.md`). SQLite sigue siendo el default; `AGENTOS_DB_DRIVER=postgres` + `AGENTOS_PG_URL` activa el otro motor desde el entrypoint separado `@agentos/db/pg` (las 25 tablas, migraciones en `drizzle-pg/`, tsvector en vez de FTS5, y **pgvector** para la búsqueda semántica del Context Hub — el quinto disparador). Se respetan las convenciones de esta sección al pie de la letra, y por eso la traducción del esquema fue mecánica.
>
> **Adenda 2026-09-05 — la aplicación ENTERA corre sobre Postgres.** Lo que no era portable tal cual (los repositorios SQLite son **síncronos** —better-sqlite3— y no existe driver PG síncrono) se resolvió eligiendo el denominador común: `@agentos/db` expone **una sola superficie ASÍNCRONA** con dos implementaciones, y el despacho por motor vive dentro de la capa de datos (`src/facade.ts`). Mismos nombres, mismos argumentos, mismos tipos de fila; lo único que cambió fuera de `packages/db` es que las llamadas llevan `await` — **ningún llamante ramifica por motor**, y ya no queda ni un `db.$client` fuera de la capa de datos. El motor de launch de Módulos de Fase (§13.3) y el seed se escriben UNA vez sobre `withTransaction`, que da `BEGIN IMMEDIATE` en SQLite y `db.transaction(async tx => …)` en Postgres. `docs/POSTGRES.md` §5 lo detalla junto con la mejora opcional `FOR UPDATE SKIP LOCKED` para el claim.

### Modelo de datos (18 tablas de día 1)

Organización: `organizations`, `people`, `projects` (type assessment|transform|ops, stage ENTENDER|CONSTRUIR|OPERAR, `gate_state`, `workspace_path`).
Agentes: `agents` (slug, layer, **runtime**, provider_profile_id, model, active_prompt_version_id, tools/mcp allowlists JSON, limits JSON, autonomy, status, seed_file, seed_hash, **version** para optimistic locking), `prompt_versions` (3 capas: stable/context/volatile_tpl — orden deliberado para prefix cache, patrón Hermes), `provider_profiles` (kind claude_subscription|anthropic_api|openai_compatible, base_url, **api_key_env: nombre de variable, jamás el valor**, costes por Mtok, capability flags).
Tablero: `tasks` (parent_task_id, definition_of_done, stage, status, activity_type, priority, assignees, requires_approval, external_effect, lease_until, attempts, blocked_reason, **order_key** fraccionario, version), `task_events` (timeline append-only con run_id), `artifacts`.
Conversación: `threads` (channel, `session_key = channel:chat_id:thread_id`), `messages` (+`idempotency_key`, espejo `messages_fts`).
Observabilidad: `runs` (parent_run_id, **root_run_id** desnormalizado, trigger, runtime, provider, tokens, cost_usd, resume_of_run_id, replay_of_run_id), `spans` (attrs con nombres OTel GenAI, sin adoptar el SDK), `events` (stream AG-UI persistido, seq por topic).
Gobierno: `approvals` (kind tool_call|deliverable|gate, **payload literal + action_digest** — cambiar argumentos invalida la aprobación), `audit_log` (before/after, source ui|mcp|agent|system), `app_config` (kill switch, presupuestos).
Contexto y metodología (el activo — ver §8b): `knowledge_docs` (+`knowledge_fts`), `processes`, `methodologies`.

**No existe tabla `delegations`**: delegar ES `tasks.create(parent_task_id, …)` con **payload tipado** (tarea, límites, forma de una buena respuesta — nunca texto libre, patrón handoff de OpenBot), **depth máx 3 y fan-out máx 4 por run** (la plataforma rechaza, no trunca), y fallo terminal **anunciado en el chat**.

## 6. Kanban movido por agentes

Dos ejes: `stage` = carril (metodología Sixteam), `status` = columna (máquina de estados). **[SÍNTESIS] 7 estados** (Opus; el WAITING_HUMAN de Codex se representa como `BLOCKED` con `blocked_reason='approval'` + bandeja "Esperando por ti"):

`BACKLOG → READY → IN_PROGRESS → (BLOCKED | REVIEW) → DONE`, + `CANCELLED`.

- READY exige DoD + insumos + agente asignado; **es la única cola del despachador**.
- Claim atómico: `UPDATE … WHERE status='READY' AND (lease vencido o nulo)`; `changes=0` = carrera perdida. Lease renovado por latido (60 s); reaper (30 s) devuelve vencidas a READY; `attempts>=3` → BLOCKED `stuck`. (Semántica de work-queue de OpenBot, trivial en SQLite mono-proceso, migra limpia a `FOR UPDATE SKIP LOCKED`.)
- Toda transición usa `expected_version` (Codex); conflicto obliga a releer, no last-write-wins.
- Matriz de permisos de transición (quién mueve qué) según tabla de `proposal-opus.md` §2.6 — REVIEW→DONE solo humano; cualquiera→CANCELLED solo humano.
- **Regla anti-teatro**: nada llega a REVIEW/DONE sin fila en `artifacts`.
- `requires_approval` lo calcula una **política determinista** al crear (efecto externo, entregable de fase, actividad sensible) — un agente no puede rebajarse su propio control.

**Gates**: **G1** (nivel proyecto): cerrar ENTENDER exige aprobación humana de diagnóstico+roadmap; sin ella, tareas de CONSTRUIR no salen de BACKLOG. **G2** (nivel tool call): la tool de efecto externo NO ejecuta — crea `approvals` con payload literal + digest y devuelve `pending_approval`; el agente mueve a BLOCKED y cierra el turno; al aprobar, el sistema ejecuta y encola run con `resume_of_run_id`. Sin suspender procesos: sobrevive reinicios.

## 7. MCP de administración — "editar casi todo"

Un servidor `agentos-admin`, doble transporte (stdio local + streamable HTTP en 127.0.0.1), **dos perfiles**: `rw` (humano, el que registra Ernesto en Claude Code) y `ro` (**el único expuesto a agentes**). Capa fina: llama a `packages/core`, pasa por el mismo gateway política+audit.

Tools (~35, namespacing `agentos.<dominio>.<acción>`): agentes (list/get/create/update/set_status/clone/**test** con sandbox), prompts (update/diff/**rollback** — editar crea versión, nunca sobrescribe), tablero (create/move/comment/assign/attach_artifact/approve/reject/board.get/reorder), proyectos (+set_gate), runs (get con spans/cancel/**replay**/events.tail), approvals (list_pending/decide), providers (upsert solo nombre de env var/test), config (kill switch pause_all/resume_all/health), knowledge, people, auditoría (query/**revert** usando before).

Reglas duras: mutaciones con `idempotency_key` + `expected_version` + `reason`; sin tools de secretos, SQL arbitrario ni hard delete; toda mutación audita before/after; las tools de efecto externo NO viven aquí (van por el catálogo de ejecución y sus approvals).

## 8. Prompt de plataforma (3 capas + guías compartidas)

Capa *stable* (identidad + constitución Sixteam + guía de tools) / *context* (proyecto, org, DoD) / *volatile* (tarea, eventos recientes, timestamp) — orden para prefix cache (Hermes). La plataforma inyecta a TODOS los agentes (no en el YAML de cada uno): **PROVENANCE_GUIDANCE** (citar origen o marcar "no verificado"; nuestro guardrail Charlie generalizado) y cierre de tool-calls huérfanos (**NO_ANSWER_CAME**) para que el proveedor no rechace el turno siguiente (ambos de OpenBot).

Definiciones semilla en `agents/*.md` (markdown + frontmatter, versionadas en git) → se cargan a la tabla al arrancar; **la fuente de verdad en ejecución es la DB** (edición en caliente por MCP); `seed_hash` delata divergencia; `agents.export` escribe de vuelta.

## 8b. Capa de contexto y metodología (el activo de la plataforma)

Principio 8 de la constitución: el valor está en el **contexto organizado de la empresa cliente** y la **metodología codificada**, no en el chat. Tres tablas la materializan (20 tablas en total):

- **`knowledge_docs`** — Context Hub por organización/proyecto: `kind` ('org_profile'|'process_map'|'interview'|'finding'|'decision'|'iso_clause'|'evidence'|'template'|'note'), `title`, `body_md`, `source_refs` JSON (de dónde salió: entrevista, documento, run), `tags`, espejo FTS. **Todo artefacto relevante de un agente se registra aquí tipado** — la conversación es efímera, el contexto no.
- **`processes`** — un proceso mapeado es una **entidad de primera clase**, no un párrafo: `org_id`, `name`, `owner_person`, `variant` ('as_is'|'to_be'), `steps` JSON (paso, responsable, sistema, entrada/salida — base SIPOC), `systems` JSON, `pain_points` JSON, `iso_refs` JSON (cláusulas relacionadas), `source_doc_ids` (qué entrevistas/documentos lo sustentan), `status` ('draft'|'validated'). Es la unidad sobre la que se hace mejora, ISO 9001 y transformación digital.
- **`methodologies`** — la metodología Sixteam como **datos versionados** que los agentes siguen: `slug` ('assessment-14d'|'iso9001-prep'|'transform'|...), `version`, `body_md` (fases, preguntas de entrevista, plantillas de entregable, criterios de calidad), `changelog`. Seeds en `methodologies/*.md` (mismo patrón que `agents/*.md`: git + carga a DB + edición en caliente por MCP + seed_hash). La capa *context* del prompt de un agente en un engagement se compone de: metodología activa + Context Hub del proyecto + DoD. (Con §13 el dominio pasa de 20 a 22 tablas.)

Tools de contexto (mismo catálogo/gateway): `knowledge.{search,get,upsert_doc,list}`, `processes.{list,get,upsert,link_source}`, `methodology.{get,list}`. Regla de provenance (PROVENANCE_GUIDANCE) aplicada: los entregables citan doc ids del Context Hub.

## 9. Gateway de canales (WhatsApp después)

El chat web ES el canal `web` del contrato desde el día 1 (Opus §2.10, 4 piezas): registro+capabilities, entrada `InboundMessage` con HMAC + **idempotencia por `(channel, message_id)`**, salida por topic WS `channel:<name>` con borradores `final=false` (canal sin edición ignora parciales), ack/typing. Añadir WhatsApp = un proceso adaptador nuevo, cero cambios en núcleo.

## 10. Observabilidad

run → span → event; `root_run_id` desnormalizado para árboles sin recursión; `ctx = {run_id, span_id, agent_id, task_id, project_id, actor}` en todo handler → cada tarjeta dice "movida por Sam" con clic al run exacto y su coste. Vista de coste por raíz → por tarea/proyecto/agente. Retención: `events` 30 días (después se compactan los deltas de texto); `runs`/`spans` no se borran. Replays sin LLM desde `events`.

## 11. Monorepo

```
agentos/
  apps/ api/ web/ mcp-admin/
  packages/ core/ db/ runners/ tools/ events/ providers/ shared/
  agents/  alex.md sam.md debbie.md vinnie.md sally.md clara.md quinn.md
  docs/
```

pnpm workspaces (instalar vía corepack; **sin Turborepo** — [SÍNTESIS] Codex sobre Opus: menos piezas). TypeScript estricto, Vitest. Pruebas obligatorias SOLO donde el fallo es silencioso y destructivo: máquina de estados, claim/lease/reaper, gates, idempotencia (ambas propuestas coinciden).

## 12. Riesgos (consolidado, top 5)

1. **Términos/coste suscripción Claude** → proveedor y runtime son datos; presupuesto duro por run/día; aviso en UI; cambio a API key/Team sin código.
2. **Teatro agéntico** → artefacto obligatorio + gates + Quinn auditando cierres sin evidencia.
3. **Saturación de la máquina** → semáforos (3 procesos hijos), timeouts, cola visible.
4. **Corrupción por concurrencia** → claim atómico + lease + reaper + expected_version + tests de carrera obligatorios.
5. **MCP admin como superficie de escalada** → agentes solo `ro`; gateway política+audit fail-closed; prompts versionados con rollback; sin secretos/SQL/hard delete.

## 13. Módulos de Fase (adenda 2026-08-28 — spec en `PRD-modulos-fase.md`)

> Síntesis del orquestador sobre DOS diseños independientes (Opus deep-reasoner y Codex, sin verse), con **verificación fáctica 12/12 contra el código** (matriz de transiciones, dirección de dependencias, aritmética del seed, patrón de transacciones). Divergencias resueltas marcadas **[SÍNTESIS]**. Rechazado de Codex, con porqué: motor en core vía BoardEngine (crea el ciclo db↔core que su propio plan de seed exige; verificado en package.json), `agents.role_key` global (migración extra en tabla compartida; el roster module-local con fallback por capa cubre v1), "todo depende del kickoff" con 1 READY/11 BACKLOG (rompe la aritmética del demo 3/9 sin ganancia) y su regla "toda tarea alcanzable desde kickoff" (incompatible con raíces paralelas legítimas).

### 13.1 Esquema — 2 tablas + 2 columnas

- **`phase_modules`** — versión INMUTABLE de un módulo: `slug`, `version` (semántico Y token de `expected_version`), `name`, `phase` (Stage), `project_type`, `status` ('draft'|'active'|'archived'), `methodology_slug`+`methodology_version` (null = la más alta al disparar), `blueprint` JSON canónico, `blueprint_hash` (sha256 del canónico), `body_md`, `changelog`, `seed_file`, `seed_hash`, `created_by`, `activated_at`. Índices: `uq(slug,version)`, **parcial `uq(slug) WHERE status='active'`** (una sola activa por slug), `(phase,status)`. Editar = insertar version+1 (patrón `prompt_versions`); nada se sobrescribe (CA-M1.2).
- **`module_launches`** — recibo INMUTABLE append-only: FK a la **fila de versión concreta** + `module_slug`/`module_version` desnormalizados + **`blueprint_snapshot` (copia literal)** + `blueprint_hash` — triple candado NM-3: editar el módulo después no puede tocar un proyecto disparado. Además: `org_id`, `project_id`, **`phase` desnormalizada + `uq(project_id, phase)`** ([SÍNTESIS] Codex: una fase se dispara UNA vez por proyecto — el retry idéntico lo cubre la idempotencia CA-M2.6; el redo legítimo es proyecto nuevo), `inputs` (literales, campos `sensitive` redactados) + `inputs_digest` (sha256 sin redactar), `toggles`, `methodology_id` (la capa *context* del prompt lee la metodología PINNEADA del último launch del proyecto, con fallback legacy por project_type — wiring en M3/M4; [SÍNTESIS] Codex), `result` JSON (qué se materializó: tasks con key→taskId, gate, budget), `task_count`, `budget_phase_usd`/`budget_per_run_usd`, **`previous_launch_id`** (encadenado US-M3), `idempotency_key` (único), `actor`, `duration_ms`.
- **`tasks` gana 2 columnas nullable** (misma migración `0003_modulos_fase.sql`): `depends_on` JSON `string[]` (default `[]`) y `due_at` (SLAs CA-M4.2 y fecha objetivo). **[SÍNTESIS] Sin tabla `task_dependencies`**: la dependencia es propiedad de la tarjeta (mismo patrón que `processes.source_doc_ids`); el tablero la lee sin join, el promotor filtra en JS (≤40 tareas/proyecto) y normalizar a tabla es mecánico si algún día hace falta el grafo inverso.

### 13.2 Formato del módulo — `modules/<slug>.md`

Markdown + frontmatter YAML, idéntico al patrón `agents/`+`methodologies/` (git → DB → edición por MCP → `seed_hash`); `splitFrontmatter` de `seed-sources.ts` se **exporta** y reutiliza. El frontmatter ES el blueprint, y abre con **`schema_version: 1`** ([SÍNTESIS] Codex: versiona el FORMATO aparte del contenido; versión no soportada = rechazo). Contiene: `project` (name_tpl/workspace_tpl), `roster` (rol lógico → slug agente + `layer` de fallback + tope por run — **nunca ids de DB**), `inputs` tipados (text/textarea/number/date/multi_select/list_text/source_refs, con required/min_items/options/`default_from`/`sensitive`), `budget` gana `warning_thresholds_pct` opcional (default `[70,90,100]` — los "semáforos" del PRD §2; [SÍNTESIS] Codex, Opus los omitía; enforcement en el dispatcher, §13.4), `toggles` (`enables_templates`, `enables_deliverables`, `methodology_add`), `templates` (key, title/description/dod con `{{variables}}`, stage, activity_type, priority, `assign:{role}`, `depends_on` por clave, `produces`, `gate`, `when_toggle`, `fan_out:{over,as}` para "una entrevista por área", `due_offset_days`/`due_from_input`), `gates` y `closing_deliverables` (kind, source knowledge_doc|process|artifact, min/`min_from_input`, `produced_by`). Variables permitidas: inputs ∪ toggles ∪ var de fan_out ∪ built-ins (`{{cliente}}`=alias??empresa, `{{sponsor}}`, `{{hoy}}`, `{{fecha_objetivo}}`); cualquier otra → `undeclared_variable`, nunca se renderiza vacío.

### 13.3 Motor de launch — en `packages/db`, transacción única

**[SÍNTESIS] El launch es el seed generalizado y vive en `@agentos/db`** (`src/modules/launch.ts`): ponerlo en core crearía el ciclo `db → core → db` en cuanto `seed.ts` lo llame (verificado: core depende de db, no al revés). Lo único de core que necesita es `computeRequiresApproval`, que es **pura** (cero imports) y se muda a `@agentos/shared` con re-export en el barrel de core (verificado: cero imports profundos en el monorepo — rotura imposible). Core conserva su capa: `launchModuleWithEvents` (flush AG-UI **post-commit** — publicar dentro de la transacción dejaría eventos fantasma en rollback), `phaseClosureStatus` (CA-M3.1), `promoteUnblockedTasks` (CA-M2.3), `prefillNextPhaseInputs` (CA-M3.2).

Piezas puras en `@agentos/shared` (100% testeables sin DB): `ModuleBlueprint` (Zod), `validateBlueprint`, `canonicalizeBlueprint`+`blueprintHash`, `renderTemplate`, `validateLaunchInputs`, `planLaunch` (fan-out, deps por clave→instancia, due_at), `computeRequiresApproval`.

Secuencia de `launchModule` (asíncrona desde 2026-09-05; una sola `withTransaction(db, async tx => …)` que da `BEGIN IMMEDIATE` en SQLite y `db.transaction` en Postgres — ver `POSTGRES.md` §5): pre-vuelo FUERA de la transacción (idempotencia: launch existente con mismo `inputs_digest` → retorno idempotente, distinto → `idempotency_conflict`; módulo activo; blueprint + inputs + roster + metodología válidos) → org (get-or-create) → proyecto → tareas en orden (`requiresApproval = computeRequiresApproval(...) || template.gate` — **solo sube**; `status='READY'` si sin deps, si no `'BACKLOG'`) → segunda pasada `depends_on` a ids → `task_events` 'created' con `{launchId, templateKey}` → presupuesto en `app_config['budget:project:<id>']` → fuentes (threads→projectId) → insert del recibo → audit `modules.launch` (NM-5: misma auditoría de siempre). NM-1: cualquier throw revierte todo. NM-2: ~40 inserts síncronos ≈ ms, test con timestamps.

### 13.4 Dependencias en el tablero

- El launch deja dependientes en **BACKLOG** (letra de CA-M2.3); el dispatcher no cambia — solo tira de READY.
- La matriz de `state-machine.ts` gana **`system: BACKLOG>READY`** con guard en el motor (mismo patrón que el guard "solo orquestador" de `agent`): el sistema solo la ejercita cuando TODAS las `depends_on` están DONE. Complemento fail-closed en `moveTask`: BACKLOG→READY con deps insatisfechas se rechaza salvo actor humano (override auditado). Alternativa descartada (nacer en BLOCKED 'dependency'): rompería el tablero demo (3 READY + 9 BACKLOG) y la letra del PRD.
- `promoteUnblockedTasks` corre al llegar una tarea a DONE (hook en el motor del board — área compartida con la rama de fuentes: coordinar al tocar).
- Presupuesto de fase: el launch lo declara en `app_config`; `dispatcher.budgetFromLimits` pasa a combinar límites del agente con `budget:project:<id>` (hoy solo lee `agents.limits` — verificado; sin esta lectura el tope de $15/fase sería declarativo).

### 13.5 Validación fail-closed — 3 momentos

Devuelve **issues con código y path**, nunca booleano. Puras: `schema_invalid`, `duplicate_template_key`, `unknown_dependency`, `circular_dependency` (Kahn), `missing_dod`, `unknown_role`/`unknown_layer`, `undeclared_variable`, `fan_out_over_unknown_input`, `unknown_toggle_ref`, `deliverable_without_producer` (CA-M1.3), `gate_without_deliverable`, `stage_mismatch`, `budget_invalid`. Con DB: `unknown_methodology`, `unknown_agent_slug`, `agent_not_assignable` (usa `computeOrgChainHealth` de jerarquía), `module_not_active`, `too_many_tasks` (>40 instancias tras fan-out — guardia NM-2; [SÍNTESIS] Codex), `input_*`. Momentos: **(A)** parse/seed y `modules.create|update` — el draft se guarda con issues (iterar), pero queda inactivable; en seed, mismo `(slug,version)` con hash distinto = **error `module_version_immutable`** que exige subir versión en el archivo — sin auto-bump, la versión del archivo y la de DB no divergen jamás ([SÍNTESIS] Codex sobre Opus); **(B)** `modules.publish` — draft→active rechazado con un solo issue; **(C)** `launch` — TODO se re-ejecuta (entre activar y disparar el roster cambia; validar solo al activar sería fail-open), y módulo-activo + idempotencia se RE-verifican dentro de la transacción (cierra el TOCTOU; [SÍNTESIS] Codex). Resolución de asignaciones: agente preferido del roster si asignable → si no, activo+asignable de la `layer` con menos tareas abiertas (desempate por slug) → si no, rechazo entero. `depends_on` a plantilla apagada por toggle se **poda** (no es error).

### 13.6 Seed ACME = launch (paso 4 del PRD §7)

`seed.ts` carga `modules/*.md` (paso 5b) y el proyecto demo pasa a ser `launchModule({moduleSlug:'consultoria', actor:'system:seed', idempotencyKey:'seed:demo:consultoria:acme', toggles:{iso9001:true}, inputs:{...ACME, areas:[direccion,operaciones,ventas], procesos_core:[Producción, Ventas→Facturación], fecha_objetivo:'2026-09-15'}})`. Aritmética preservada: 12 tareas, 3 READY (kickoff/alex, perfil_org/sam, inventario/clara) + 9 BACKLOG, mismos activity_type y asignados. Deltas de test SOLO en `migration-seed.test.ts`: tablas 20→22 (3 sitios), `EXPECTED_TABLES` +2, y **`requiresApproval` 2→7** — el seed hardcodeado contradecía la política determinista (`computeRequiresApproval` ya marca org_profile, process_map, leak_analysis, iso_gap, report, roadmap); el launch la aplica (NM-5) y el demo deja de mentir. ⚠️ Único cambio de comportamiento observable: 7 tarjetas del demo exigirán REVIEW humano — pendiente de visto bueno de Ernesto. Nota: `procesos_core` es input opcional añadido (no está en PRD §4) con `default_from: areas`; sin él, el nº de mapas as-is no sería determinista y el demo no reproduciría sus 12 tareas.

### 13.7 MCP `agentos.modules.*` y wizard

ro: `list`, `get`, `diff`, `validate`, `preview` (**dry-run de `planLaunch`** — alimenta el resumen del wizard CA-M2.1), `launches.list/get` (CA-M2.4), `phase_status` (CA-M3.1). rw: `create`, `update` (`expected_version` → versión draft nueva), `publish` (rechaza con issues), `rollback`, `archive`, `export`, **`launch`** (`person_id` obligatorio: el perfil `ro` de los agentes lo bloquea antes de validar argumentos ⇒ "disparar es siempre humano" se impone en la entrada). Convenciones idénticas a `tools/projects.ts` (idempotency + expected_version + audit before/after + `AgentosError`). El wizard "Nuevo proyecto" (apps/web) consume REST equivalente: módulo → inputs (validación en vivo, Disparar deshabilitado con faltantes) → resumen (preview) → Disparar.

### 13.8 Encadenado y cadencia (pasos 5 del PRD §7 — diseño fino al construir)

`phaseClosureStatus` compara `closing_deliverables` del snapshot del launch contra knowledge_docs/processes/artifacts reales; el gate de fase no aprueba con faltantes (CA-M3.1). "Disparar Implementación" pre-llena inputs desde el Context Hub vía `prefillNextPhaseInputs` y enlaza `previous_launch_id` (mismo proyecto: cambia `stage` y backlog activo, el Context Hub persiste — CA-M3.3). Cadencia de Operación **consent-first** (CA-M3.4): el blueprint declara plantillas recurrentes, el wizard las propone, el humano confirma cuáles activar; el mecanismo de recurrencia se decide al construir ese paso (candidatos: re-creación al cerrar instancia vs tick diario del dispatcher).
