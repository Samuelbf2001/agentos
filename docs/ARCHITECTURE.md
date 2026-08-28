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
- **`methodologies`** — la metodología Sixteam como **datos versionados** que los agentes siguen: `slug` ('assessment-14d'|'iso9001-prep'|'transform'|...), `version`, `body_md` (fases, preguntas de entrevista, plantillas de entregable, criterios de calidad), `changelog`. Seeds en `methodologies/*.md` (mismo patrón que `agents/*.md`: git + carga a DB + edición en caliente por MCP + seed_hash). La capa *context* del prompt de un agente en un engagement se compone de: metodología activa + Context Hub del proyecto + DoD.

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
