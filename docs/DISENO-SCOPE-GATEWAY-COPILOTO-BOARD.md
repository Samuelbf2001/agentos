# Diseño — Guarda de scope por proyecto + copiloto del tablero (Trabajo B)

**Fecha:** 2026-09-05 · **Origen:** `docs/HANDOFF-COPILOTKIT-AGUI.md` §4 Trabajo B · **Estado:** diseño verificado contra el código, pendiente de implementar.

## 1. Cómo llega hoy `project_id` al gateway (la cadena ya existe)

`POST /v1/channels/web/events` (`apps/api/src/routes/channel-web.ts:43`) acepta `project_id` (`InboundMessage`, l.36) → `getOrCreateThread({projectId})` (l.57-61) → `dispatcher.enqueueChatRun` (l.103) → `apps/api/src/dispatcher.ts:553` lee `thread.projectId` → `buildRunInput` (l.584) y `RunTraceContext.projectId` (l.594) → `bindRunInput` arma el `ToolCallContext` con `project_id` (l.271-278) → `bindDomainTools` (`apps/api/src/domain-tools.ts:28`) → `runtime.execute(ctx, name, args)`.

`threads.projectId` ya existe (`packages/db/src/schema.ts:419`) y hay `setThreadProject` (`packages/db/src/repositories/threads.ts:45`). **No se persiste nada nuevo.**

**Agujero real:** `getOrCreateThread` solo fija `projectId` al crear. Si la `session_key` ya existía con `projectId` null o de otro proyecto, los `project_id` posteriores se ignoran en silencio. Reconciliar en `channel-web.ts:57`: si `thread.projectId == null && body.project_id` → `setThreadProject`; si ambos existen y difieren → 409 `conflict` (no reasignar hilos vivos).

## 2. La guarda (fail-closed)

**Dónde:** en `execute()` de `packages/tools/src/gateway.ts`, después de `tool.schema.safeParse` (l.151) y antes del Gate 2 (l.157): una llamada fuera de scope no debe ni crear una aprobación. Replicar tras el parse de `executeApproved` (l.206-209): una aprobación vieja no ejecuta fuera de scope.

**Sujeto:** solo `actorKind(ctx.actor) === "agent"` (misma frontera que la allowlist, l.111). Humanos, sistema y `apps/mcp-admin` no pasan por aquí.

**Metadato, no lista dura.** Nuevo campo en `ToolDefinition` (`packages/tools/src/types.ts:52`):

```ts
projectScope:
  | { by: "task"; arg: string; fallback?: "ctx.task_id" }
  | { by: "project"; arg: string }
  | "ctx"    // sin objetivo propio: hereda ctx.project_id
  | "none";  // no aplica (tools sin proyecto)
```

Resolución: `by:"task"` → `getTask(db, args[arg])` (404 si no existe) → `task.projectId`; `by:"project"` → `args[arg]`; `"ctx"` → sin objetivo. **Regla: denegar si `ctx.project_id` es null o distinto del objetivo.**

| Tool | projectScope |
|---|---|
| `tasks.create` | `{by:"project", arg:"project_id"}` |
| `tasks.claim/move/comment/attach_artifact/assign_people/set_due_date/get` | `{by:"task", arg:"task_id"}` |
| `board.get` | `{by:"project", arg:"project_id"}` (también lectura: si no, el copiloto descubre ids ajenos) |
| `tasks.list` | forzar `args.project_id = ctx.project_id` cuando el ctx lo tiene, en vez de denegar |
| `delegate` | `{by:"task", arg:"parent_task_id", fallback:"ctx.task_id"}` — la hija hereda el proyecto del padre en `engine.delegate` |
| `ask_human` | `task_id` presente → `{by:"task"}`; ausente → `"ctx"`. Corregir de paso `task?.projectId ?? ctx.project_id` (delegation.ts:64), que hoy puede colgar una aprobación de otro proyecto |

**Error:** `ErrorCodes.POLICY_DENIED` de `@agentos/shared` vía el `deny()` existente (gateway.ts:90) → queda auditado y conserva el mapeo HTTP y el manejo de `warning` en channel-web.ts:111-115. Detalle: `{ scope:"project", ctx_project_id, target_project_id, tool, task_id }`.

**Sin agujeros:** test de catálogo que exija `projectScope` en toda tool con `flags.read_only === false` (16 hoy: `tasks.*`, `delegate`, `ask_human`, `artifacts.write`, `projects.update`, `knowledge.upsert_doc`, `processes.*`, `sources.ingest`, `email.send`). Una tool nueva sin declarar rompe el test.

**Coste aceptado conscientemente:** con `ctx.project_id === null` los agentes dejan de escribir tareas. Hoy el chat global solo manda `project_id` si hay `activeProjectId` (`apps/web/src/state/store.ts:995`). Es lo que pide el handoff; mitigación: `alex.md` pide elegir proyecto y la UI manda siempre uno. Revisar `packages/tools/test/*` y tests del dispatcher que crean tareas con ctx sin proyecto.

## 3. Escritura bidireccional: ya resuelta por diseño

Cada mensaje es un run nuevo y la capa *volatile* re-lee el tablero de la DB en cada ensamblado: `packages/core/src/prompt/assemble.ts:162-172` inyecta el índice de tareas reales (tope `maxBoardTasks` = 30). No depende del prompt. Acciones: (a) incluir `status` + `version` en esas líneas para que `tasks.move` tenga `expected_version` fresco, y valorar subir el tope; (b) en `alex.md`: "llama `board.get` antes de mover o reasignar"; (c) el cinturón real es `expected_version`: si el humano arrastró, el `move` falla con `version_conflict` y el agente re-lee. Documentarlo en el prompt como recuperación esperada, no como error.

## 4. Subtareas reales

`tasks.create` acepta `parent_task_id` (`packages/tools/src/tools/tasks.ts:92` → `engine.createTask`, l.119). En el chat del board `ctx.task_id` es null → **el prompt debe exigir `parent_task_id` explícito**: "una iniciativa se crea primero como tarea madre; cada pieza con `parent_task_id` = id de la madre; nunca tareas sueltas". Del `systemPrompt.ts` de `mastra-pm` tomar solo el sesgo a proponer y descomponer con mínima fricción.

**Bloqueante:** `agents/alex.md` (front-matter `tools:`) **no incluye `tasks.assign_people`** → "asígnalas" muere en la allowlist (gateway.ts:121). Añadirla (valorar `tasks.attach_artifact`). Editar `agents/*.md` crea versión por `seed_hash`.

## 5. Panel de chat en BoardView: sin API nueva

`POST /v1/channels/web/events` ya lleva `project_id`; el cliente lo expone (`apps/web/src/lib/api.ts:484`) y lo envía (`store.ts:995`). Mínimo:
1. `thread_hint` **determinista por proyecto** — `board:<projectId>` — en vez del `crypto.randomUUID()` de `store.ts:973`, para que la `session_key` sea `web:<personId>:board:<projectId>` y el panel reabra siempre el mismo hilo.
2. Al montar el panel, buscar en `get().threads` el hilo con esa `sessionKey` y `openThread(id)` (`store.ts:937`), o dejar null y que el primer `sendChatMessage` lo cree.
3. Renderizar el cuerpo de `ChatView` en un panel lateral de `BoardView.tsx`.

Cuidado: el store tiene **una sola** slice `chat`; panel y vista Chat comparten hilo. Extraer `sendChatMessage(text, opts?: {threadHint, projectId})` antes de duplicar estado. `GET /api/threads` (`apps/api/src/routes/ops.ts:257`) solo filtra por `channel`: filtrar por `projectId` en cliente o añadir `?project_id`.

## 6. Tests

`packages/tools/test/scope.test.ts` (fixture `toolsFixture` + segundo proyecto):
- **Negativo principal:** `tasks.move` sobre tarea de otro proyecto → `POLICY_DENIED`, la tarea no cambia de estado ni `version`, y `queryAudit({entityType:"tool", entityId:"tasks.move"})` tiene `tool.denied` con `target_project_id`.
- ctx sin `project_id` deniega toda escritura de tareas (fail-closed).
- `tasks.create` con `project_id` ajeno se deniega antes de tocar el engine (spy sin llamadas).
- La denegación ocurre ANTES del Gate 2 (tool con `external_effect` fuera de scope → sin aprobación creada).
- `executeApproved` re-valida el scope (aprobación creada en A, reanudada con ctx de B → denegado).
- `delegate` hereda el proyecto del padre y rechaza padres ajenos.
- `ask_human` sin `task_id` usa `ctx.project_id`; con `task_id` ajeno se deniega.
- Toda tool no `read_only` declara `projectScope` (guarda anti-agujero).
- `tasks.list` ignora un `project_id` ajeno y filtra por el del ctx.

`apps/api/test`: el hilo del board reconcilia `projectId` null y rechaza cambio de proyecto (channel-web); `enqueueChatRun` propaga `thread.projectId` al `ToolCallContext`.

## 7. Riesgos

- El corte con `ctx.project_id === null` es un cambio de comportamiento, no solo una guarda.
- Espejo `packages/db/src/pg/schema-pg.ts` no verificado línea a línea (se asume `threads.project_id`).
- Divergencia `ai@^5` en `packages/tools` vs `^7` en el resto: este trabajo no la toca.
