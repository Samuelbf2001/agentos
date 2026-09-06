# Handoff — Qué tomar del ejemplo `mastra-pm` de CopilotKit

**Fecha:** 2026-09-05
**Para:** el agente que ejecute este trabajo
**Repo de trabajo:** `C:\Users\samue\2brain\agentos` (rama `master`, commit `13ac7e9`)
**Referencia clonada:** `C:\Users\samue\2brain\ref\CopilotKit` (MIT) — ejemplo en `examples/canvas/mastra-pm`

Este documento es autocontenido. No necesitas la conversación que lo originó.

---

## 1. Contexto en una frase

Se evaluó el ejemplo `examples/canvas/mastra-pm` de CopilotKit (un tablero kanban manejado
por un agente vía el protocolo AG-UI) para ver qué vale la pena incorporar al módulo de
proyectos/tareas de AgentOS. **La conclusión es que no adoptamos CopilotKit como dependencia
todavía**: tomamos dos ideas de UX y las implementamos sobre la infraestructura que ya
tenemos, dejando la puerta abierta a conectar clientes AG-UI de terceros más adelante.

---

## 2. Qué es el ejemplo (y por qué NO copiarlo tal cual)

Es un workshop de 3 pasos, ~700 líneas, no un producto. Lo commiteado en `main` mezcla los
tres pasos: UI del paso 3, system prompt del paso 2, y el agente todavía se llama
`weatherAgent` con un `weatherTool` de juguete.

Su mecanismo central:

- **No tiene tools de tareas.** El tablero entero (`projectName, projectDescription,
  users[], tasks[]`) es un schema Zod montado como *working memory* del agente Mastra. El
  LLM "mueve tareas" llamando al `updateWorkingMemory` interno.
- El frontend se sincroniza con eventos `STATE_SNAPSHOT` vía el hook `useCoAgent`.
- Una CLI de 90 líneas se conecta al **mismo agente** solo suscribiéndose a callbacks
  (`onToolCallStartEvent`, `onStateSnapshotEvent`…).

**Limitaciones que descalifican una copia directa:**

| Limitación | Consecuencia |
|---|---|
| Storage LibSQL `:memory:` | El tablero muere al reiniciar. No hay DB de verdad. |
| UI de solo lectura (no hay `setState`, no hay drag & drop que escriba) | Si un humano mueve una tarjeta, el agente nunca se entera. |
| Sin máquina de estados, sin versión optimista, sin permisos, sin auditoría | Nada de lo que AgentOS necesita para ser confiable. |
| Fija CopilotKit `1.10.3` y usa `useCoAgent`, ya en `v1-deprecated` | La versión actual es `1.70.1`; el reemplazo es `useAgent` de `@copilotkit/react-core/v2`. |

**Regla dura: no metas el tablero en la working memory del LLM.** Eso tira a la basura el
control de concurrencia por `expected_version`, los gates, las aprobaciones y la auditoría.
Nuestra DB es la fuente de verdad; AG-UI es solo transporte.

---

## 3. Estado verificado de AgentOS (todas las rutas comprobadas)

Lo que **ya existe** y hay que reutilizar, no reinventar:

- **Modelo:** `packages/db/src/schema.ts` — `projects` (l.86), `tasks` (l.174, ~20 campos,
  7 estados × 3 stages, `dependsOn`, `leaseUntil`, `requiresApproval`, `version`),
  `task_assignees`, `task_labels`, `task_events`, `artifacts`, `approvals`.
  Espejo Postgres en `packages/db/src/pg/schema-pg.ts`.
- **Dominio:** `packages/core/src/board/state-machine.ts` (guardas) y
  `packages/core/src/board/engine.ts` (`moveTask`, `claim` con lease, dependencias, gates).
- **API REST (Fastify):** `apps/api/src/routes/board.ts` — incluye
  `POST /api/tasks/:id/move` (l.567, con `expected_version`) y
  `POST /api/tasks/:id/approve|reject`.
- **Bus + WS:** `packages/events/src/bus.ts` (persiste en DB primero, luego notifica; `seq`
  monotónico por topic) y `apps/api/src/ws.ts` (WS multiplexado, control
  `subscribe/unsubscribe {topic, since_seq}`). Topics en `packages/events/src/topics.ts`:
  `run:<id>`, `board:<projectId>`, `thread:<id>`, `swarm`, `approvals`, `channel:<name>`.
- **Tools del LLM:** `packages/tools/src/tools/tasks.ts` (`tasks.create/claim/move/comment/
  assign_people/...`, `board.get`), `tools/delegation.ts` (`delegate`, `ask_human`), todas
  detrás del gateway fail-closed `packages/tools/src/gateway.ts` (política → auditoría →
  handler).
- **Frontend:** Vite 7 + React 19 + Tailwind v4 + **Zustand** (`apps/web/src/state/store.ts`,
  con `moveTaskOptimistic` en l.586). Tablero en `apps/web/src/views/BoardView.tsx`
  (dnd-kit). Sin react-query, sin tRPC, **sin Next.js**.

### Hallazgo clave sobre AG-UI

`packages/events/src/ag-ui.ts` (214 líneas) ya define el vocabulario AG-UI completo con Zod.
Y **sí se emite en producción**: `packages/runners/src/claude-code-runner.ts:164` y
`packages/runners/src/ai-sdk-runner.ts:133` emiten `RUN_STARTED`, `TEXT_MESSAGE_*` y
`TOOL_CALL_*`; `apps/api/src/dispatcher.ts:500` los reenvía al topic del thread; y
`apps/web/src/state/reducer.ts:313` ya los consume.

**Lo único muerto es `STATE_SNAPSHOT` y `STATE_DELTA`**: cero usos fuera del schema y los
tests. Estamos mucho más cerca de AG-UI de lo que parece.

---

## 4. Qué SÍ tomar — trabajos concretos, en orden

### Trabajo A — Generative UI nativa en el stream (prioridad 1)

**La idea que se toma del ejemplo:** `useCopilotAction({ available: "frontend", render })`
asocia el *nombre de una tool call* a un componente React, de modo que el chat muestra una
tarjeta interactiva en vez de JSON crudo.

**Cómo implementarlo aquí (sin CopilotKit):** ya recibimos `TOOL_CALL_START` /
`TOOL_CALL_ARGS` / `TOOL_CALL_RESULT` en el reducer del web. Construye un **registro
`toolName → componente React`** en `apps/web` y renderízalo en el stream del run/thread.

Casos que valen la pena, en este orden:

1. `tasks.move` que dispara `requiresApproval` → tarjeta **Aprobar / Rechazar** inline, que
   llama a `POST /api/tasks/:id/approve|reject`. Hoy eso está enterrado en
   `TaskDrawer.tsx` (1145 líneas).
2. `ask_human` (`packages/tools/src/tools/delegation.ts`) → formulario inline en vez de que
   el humano tenga que buscar dónde responder.
3. `delegate` → tarjeta del agente destino con estado del sub-run.
4. `tasks.create` → mini-tarjeta de la tarea creada, con enlace al board.

**Por qué es la prioridad 1:** no toca el protocolo, no toca el backend, no añade
dependencias, y ataca el punto de fricción más real que tenemos (las aprobaciones son
invisibles). Riesgo bajo, valor alto.

**Criterio de aceptación:** un run que pide aprobación se puede aprobar sin salir del
stream, y el board refleja el movimiento por WS sin recargar.

---

### Trabajo B — Copiloto conversacional sobre el tablero (prioridad 2)

**El hueco que ilumina el ejemplo:** hoy los humanos arrastran tarjetas y los agentes
trabajan por su cuenta, pero no existe un "planifica el proyecto X y créame las tareas" al
lado del board. Ya tenemos todas las tools para hacerlo.

**Diseño:**

- Panel de chat en `BoardView.tsx` que abre un `thread` **con `projectId` en el scope**.
- El agente (`agents/alex.md`, el orquestador) usa `tasks.create`, `board.get`,
  `tasks.assign_people` a través del gateway existente.
- El board se actualiza solo: las mutaciones ya publican en `board:<projectId>` y el store
  las aplica. No hace falta estado compartido nuevo.

**Punto crítico de diseño — el scope:** el `projectId` del thread tiene que llegar a la
política del gateway para que el agente **no pueda tocar tareas de otro proyecto**. No lo
resuelvas solo con el system prompt; tiene que ser una guarda en
`packages/tools/src/gateway.ts`. Fail-closed: sin `projectId` en contexto, las tools de
escritura de tareas se deniegan.

**Del ejemplo se toma el system prompt, que es bueno** (`src/mastra/agents/systemPrompt.ts`):
sesga hacia proponer tareas que no están en el board con mínima intervención, y descompone
tareas grandes en subtareas. Adáptalo a `agents/alex.md` — ojo, nuestro modelo ya tiene
`parentTaskId`, así que la descomposición debe crear subtareas reales, no tareas sueltas.

**Criterio de aceptación:** desde el chat del board, "descompón esta iniciativa en tareas y
asígnalas" produce tareas reales en la DB, con `parentTaskId` correcto, visibles en el
tablero sin recargar, y ningún intento de escribir fuera del proyecto pasa el gateway.

---

### Trabajo C — Emitir `STATE_SNAPSHOT` / `STATE_DELTA` (prioridad 3, opcional)

**Qué desbloquea:** que un cliente AG-UI de terceros (CopilotKit con `HttpAgent` de
`@ag-ui/client`, la CLI, un cliente móvil) se conecte a nuestro backend sin conocer nuestro
vocabulario de eventos de dominio. **No lo necesita el board web**, que ya sincroniza bien
con los eventos de dominio. Hazlo solo cuando exista un segundo cliente que lo justifique.

**Diseño si se hace:**

- Al `subscribe` de `board:<projectId>`, tras servir el backlog, emitir un `STATE_SNAPSHOT`
  cuyo `snapshot` tenga la misma forma que `GET /api/board/:projectId` (`columns`, `cells`,
  `board_seq`).
- En cada mutación, publicar además un `STATE_DELTA` con parches RFC 6902.

**Trampa que hay que evitar:** deriva el parche **dentro de la transacción de
`engine.ts` que incrementa `version`**, no en un listener que vuelva a leer la DB. Un
listener que re-lee introduce una carrera y el cliente diverge silenciosamente.

**Criterio de aceptación:** un cliente que solo aplica snapshot + deltas converge al mismo
board que `GET /api/board/:projectId`. Hazlo con un test de propiedad, no con un caso feliz.

---

## 5. Qué NO tomar

- **El modelo de estado compartido en working memory.** Ya explicado arriba. Es la trampa
  principal del ejemplo.
- **CopilotKit como dependencia, por ahora.** Los Trabajos A y B se hacen nativos con lo que
  ya tenemos. CopilotKit solo se justifica si decidimos no construir la UI de chat y la
  maquinaria de generative UI nosotros — es una decisión de producto, no técnica, y le
  corresponde al usuario. Si se toma, ir a la **v2** (`useAgent`), nunca al `useCoAgent`
  del ejemplo.
- **Mastra.** No aporta nada sobre nuestros runners de Claude Agent SDK / Vercel AI SDK.
- **El `weatherTool` y el naming `weatherAgent`.** Son residuo del paso 1 del workshop.

---

## 6. Riesgos y cosas a verificar antes de comprometerse

1. **`apps/web` es Vite, no Next.js.** El `copilotRuntimeNextJSAppRouterEndpoint` del
   ejemplo no aplica. Si algún día se adopta CopilotKit, el runtime va montado en Fastify o
   se va directo con `@ag-ui/client`. El patrón correcto para nosotros está en
   `ref/CopilotKit/examples/integrations/claude-sdk-typescript` (backend que habla AG-UI por
   HTTP + `HttpAgent`), no en `mastra-pm`. Existe además un `@ag-ui/claude-agent-sdk`
   oficial que encaja con nuestro runner.
2. **Escritura bidireccional.** El ejemplo simplemente no la resuelve (su UI es read-only).
   Para el Trabajo B, cuando un humano arrastra una tarjeta mientras el agente trabaja, hay
   que decidir qué ve el agente. Propuesta: el agente re-lee con `board.get` al inicio de
   cada turno en vez de mantener una copia del board en contexto.
3. **`packages/tools` usa `ai@^5.0.0` mientras `apps/api`, `packages/providers` y
   `packages/runners` usan `ai@^7.0.83`.** Divergencia preexistente; revísala si tocas
   adaptadores de tools.

---

## 7. Orden recomendado

1. Trabajo A (generative UI de aprobaciones) — independiente, valor inmediato.
2. Trabajo B (copiloto sobre el board) — depende de A solo para la UX de aprobación.
3. Trabajo C (`STATE_*`) — solo cuando haya un segundo cliente.

No empieces por C aunque parezca el más "arquitectónico": el board ya funciona sin él.
