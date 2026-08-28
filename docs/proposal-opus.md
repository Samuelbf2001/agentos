# AgentOS Sixteam — PRD y Arquitectura

> Propuesta de diseño (Opus). Insumo: `agentos/docs/research-brief.md`.
> Fecha: 2026-08-27. Estado: propuesta firme, lista para ejecutar.
> Metodología Spec Kit: la sección 1 es el *specify* (qué/porqué), la sección 2 es el *plan* (cómo), la sección 3 son los *tasks*.

---

## 1. PRD

### 1.1 Visión y porqué

Sixteam vende un ciclo de consultoría: **Entender → Construir → Operar**. Hoy ese ciclo lo ejecutan personas, y por eso escala linealmente con horas humanas: el Assessment ($2,500) consume semanas de entrevistas y mapeo, Transform (desde $1,500) depende de que un ingeniero traduzca procesos a software, y Ops (desde $299/mes) sólo es rentable si nadie tiene que mirarlo todos los días.

**AgentOS Sixteam es la fábrica que ejecuta ese ciclo con agentes trabajadores de IA, con humanos en los puntos de decisión y no en los puntos de esfuerzo.**

El producto no es "un chat con IA". El producto es un **tablero de trabajo que se mueve solo**: cada tarjeta del kanban tiene un dueño (agente o humano), una definición de terminado, un artefacto verificable y una traza completa de quién la movió y por qué. El chat es la puerta de entrada; el tablero es la evidencia; el visual en vivo es la confianza.

Tres razones para construirlo ahora:

1. **Reutilización comprobada.** El blueprint Charlie (orquestador + subagentes + máquina de estados + gates humanos) ya funciona en prospección. Generalizarlo a consultoría replica un patrón validado.
2. **Diferenciación comercial.** Vender transformación digital operada por la misma plataforma agéntica que se le va a implantar al cliente es la demo definitiva: *"esto que ves moverse es lo que te vamos a montar"*.
3. **Capacidad nueva (ISO 9001).** Certificar exige documentar procesos de forma exhaustiva y consistente: exactamente el trabajo que un agente hace mejor y más barato que un consultor junior.

**Criterio de éxito del MVP (una frase):** Ernesto abre el chat, pide un assessment para una empresa, y en la misma sesión ve el tablero poblarse, agentes tomar tarjetas, moverlas, producir un informe real y detenerse a pedirle aprobación — sin que él toque el tablero.

### 1.2 Usuarios

| Usuario | Quién | Qué necesita | Cómo mide valor |
|---|---|---|---|
| **Operador interno** (primario) | Ernesto (Process Engineer) | Lanzar trabajo por chat, aprobar/rechazar, ver dónde está todo, corregir agentes en caliente | Horas de consultoría que no tuvo que hacer |
| **Estratega** (primario) | Samuel (Revenue Strategist) | Estado de engagements y costes sin pedir reportes | El reporte de lunes ya está hecho |
| **Equipo ejecutor** | Sebastián, Jorge, Jefferson | Tarjetas asignadas con contexto e insumos ya preparados | Menos tiempo buscando contexto |
| **Administrador** | Ernesto vía Claude Code + MCP | Editar agentes, prompts, tareas y config desde fuera de la UI | Cambiar comportamiento sin tocar código |
| **Cliente final** (fase 2) | Contacto en la empresa cliente | Ver avance, responder entrevistas | Transparencia percibida |
| **Agentes** (usuarios de primera clase) | Alex, Sam, Debbie, Vinnie, Sally, Clara, Quinn | Tools tipadas, tablero como memoria compartida, forma de pedir ayuda humana | Tareas cerradas con artefacto |

**Roster del MVP** (7 agentes, alineados con la web V2 más uno nuevo):

- **Alex** — Estratega y Concierge. *Es el orquestador y la cara del chat.* Entiende la petición, crea proyecto y backlog, asigna, sintetiza.
- **Sam** — Diagnóstico. Entrevistas, mapeo de procesos, análisis de fugas, informe de assessment.
- **Debbie** — Constructora de Sistemas. Escribe código, monta plataformas, produce entregables técnicos.
- **Vinnie** — Integraciones. Conecta sistemas del cliente, APIs, MCP externos.
- **Sally** — Operadora de Revenue. Secuencias, seguimiento comercial, catálogo Ops.
- **Clara** — Analista. Datos, métricas, reportes, coste por engagement.
- **Quinn** — QA y Adversario (**nuevo**). Rompe lo que los demás producen: corre pruebas, audita cierres sin evidencia, abre tarjetas de bug, revisa el tablero buscando incoherencias.

### 1.3 User stories del MVP (criterios de aceptación verificables)

**US-1 — Iniciar un engagement desde el chat.** *Como operador quiero describir un encargo en lenguaje natural y que la plataforma cree el proyecto y su backlog, para no montar tableros a mano.*
- **CA-1.1** Con el chat vacío, al escribir "Arranca un assessment para ACME S.A., 40 empleados, manufactura, quieren ISO 9001", en ≤ 60 s existe una fila en `projects` con `type='assessment'`, `stage='ENTENDER'` y la org ACME creada.
- **CA-1.2** Se crean ≥ 6 tareas en `BACKLOG`, cada una con `title`, `definition_of_done` no vacía y `assignee_agent_id`.
- **CA-1.3** Toda tarea creada tiene `created_by_actor='agent:alex'` y un `run_id` navegable desde la UI.
- **CA-1.4** Ninguna tarea de `stage='CONSTRUIR'` sale de `BACKLOG` mientras el gate 1 del proyecto no esté aprobado (forzarlo por MCP devuelve `gate_not_passed`).

**US-2 — Ver el tablero moverse solo.** *Como operador quiero ver el kanban actualizarse en vivo cuando un agente mueve una tarjeta, para confiar sin supervisar.*
- **CA-2.1** Sin recargar, un movimiento hecho por un agente aparece en la UI en ≤ 500 ms (p95).
- **CA-2.2** La tarjeta muestra el avatar del agente que la movió y el timestamp; al abrirla, el timeline lista cada transición con `from_status → to_status`, actor y enlace al run.
- **CA-2.3** Tras 30 s de desconexión, el tablero se re-sincroniza por `since_seq` sin perder eventos ni recargar la página.
- **CA-2.4** Un humano puede arrastrar una tarjeta; el cambio persiste con `actor_type='human'`.

**US-3 — Un agente ejecuta una tarea y produce un artefacto.** *Como operador quiero que la tarjeta no se cierre con palabras sino con un entregable.*
- **CA-3.1** Con una tarea en `READY` y agente asignado, el despachador arranca un run en ≤ 5 s y la tarea pasa a `IN_PROGRESS` con `lease_until` futuro.
- **CA-3.2** Dos agentes no pueden tomar la misma tarea: la segunda llamada a `tasks.claim` devuelve `{claimed:false}` (test de carrera obligatorio).
- **CA-3.3** Una tarea no llega a `REVIEW` ni a `DONE` sin ≥ 1 fila en `artifacts`; el intento devuelve `missing_artifact`.
- **CA-3.4** Si el run muere o excede su timeout, el reaper devuelve la tarea a `READY` en ≤ 60 s e incrementa `attempts`; con `attempts >= 3` pasa a `BLOCKED` con `blocked_reason='stuck'`.

**US-4 — Gate humano sobre entregables.** *Como operador quiero aprobar los entregables antes de darlos por terminados.*
- **CA-4.1** Una tarea con `requires_approval=1` sólo llega a `REVIEW` por el agente; el intento de pasarla a `DONE` devuelve `human_approval_required`.
- **CA-4.2** La UI muestra una bandeja "Esperando por ti" con las tareas en `REVIEW` y el artefacto renderizado (markdown / PDF / diff).
- **CA-4.3** Al aprobar, la tarea pasa a `DONE` con `decided_by_person_id`; al rechazar con nota, vuelve a `IN_PROGRESS` y se encola un run del mismo agente que recibe la nota como input.
- **CA-4.4** La decisión queda en `audit_log` con `before`/`after`.

**US-5 — Gate sobre efectos externos (nivel tool call).** *Como operador quiero que nada salga hacia afuera sin mi visto bueno.*
- **CA-5.1** Toda tool con `external_effect=1` (`email.send`, `whatsapp.send`, `git.push`, `crm.write`) no ejecuta: crea `approvals` con el payload literal y devuelve `{status:'pending_approval', approval_id}`.
- **CA-5.2** El agente, al recibir ese resultado, mueve la tarea a `BLOCKED` con `blocked_reason='approval'` y cierra el turno limpiamente, sin bloquear el proceso.
- **CA-5.3** Al aprobar el humano, el sistema ejecuta el efecto y encola un run con `resume_of_run_id`; el agente continúa desde ahí.
- **CA-5.4** Reiniciando el servidor con una aprobación pendiente, ésta sobrevive y al aprobarla el flujo continúa (prueba de reanudabilidad).

**US-6 — Visual en vivo de agentes interactuando.** *Como operador y como demo comercial quiero ver el enjambre trabajando.*
- **CA-6.1** Un lienzo muestra un nodo por agente con estado visible: `idle | pensando | usando_tool | bloqueado | pausado`.
- **CA-6.2** Cuando Alex delega en Sam aparece una arista animada Alex→Sam durante ≥ 3 s, correspondiente a una tarea hija real (clic abre la tarjeta).
- **CA-6.3** Cada nodo muestra tokens y coste acumulados de la sesión, actualizados al cierre de cada run.
- **CA-6.4** El lienzo es de sólo lectura: no permite crear ni conectar nodos.

**US-7 — Inspeccionar y reproducir un run.** *Como operador quiero entender exactamente qué hizo un agente y cuánto costó.*
- **CA-7.1** La vista de run muestra el árbol de spans (llamadas LLM, tools, subagentes) con duración y estado.
- **CA-7.2** Muestra tokens in/out/cache, coste USD y modelo/proveedor efectivamente usados.
- **CA-7.3** El botón "reproducir" repinta la sesión evento por evento desde `events`, sin volver a llamar al LLM.
- **CA-7.4** Desde cualquier tarjeta se navega al run que la movió, y desde el run a su `parent_run_id` y a sus hijos.

**US-8 — Administrar todo desde MCP.** *Como administrador quiero editar casi todo desde Claude Code sin abrir la UI.*
- **CA-8.1** Registrando `agentos-admin-rw` en Claude Code puedo listar agentes, crear uno, cambiar su `system_prompt`, modelo y allowlist de tools; surte efecto en el siguiente run sin reiniciar la plataforma.
- **CA-8.2** Editar un prompt crea una fila en `prompt_versions`; `prompts.rollback` restaura la anterior; ambas acciones quedan en `audit_log`.
- **CA-8.3** Puedo crear, mover, comentar y aprobar tareas por MCP, y el tablero abierto en el navegador lo refleja en vivo.
- **CA-8.4** El perfil `agentos-admin-ro`, el expuesto a los agentes, rechaza toda mutación con `read_only_profile`.

**US-9 — Multi-proveedor LLM por agente.** *Como administrador quiero elegir el cerebro de cada agente sin tocar código.*
- **CA-9.1** `provider_profiles` incluye al menos: suscripción Claude Code, Anthropic API, OpenAI, Kimi, MiniMax y GLM/Z.ai.
- **CA-9.2** Cambiando `provider_profile_id` y `model` de Clara a GLM, su siguiente run aparece en `runs` con ese proveedor y responde correctamente, incluido tool calling.
- **CA-9.3** Si un proveedor falla o devuelve 429, el run se marca `failed` con error legible y la tarea vuelve a `READY`; no se pierde trabajo.
- **CA-9.4** Ninguna clave de API es legible por ningún tool ni por la UI: sólo referencias a variables de entorno.

**US-10 — Un agente dedicado a encontrar bugs.** *Como operador quiero un adversario interno que no deje pasar trabajo mal hecho.*
- **CA-10.1** Cuando una tarea técnica entra a `REVIEW`, Quinn arranca automáticamente un run de crítica.
- **CA-10.2** Si encuentra un fallo, crea una tarea hija `activity_type='bug'` enlazada a la original con pasos de reproducción, y la original vuelve a `IN_PROGRESS`.
- **CA-10.3** Bajo demanda, Quinn audita el tablero y reporta: `DONE` sin artefacto, `IN_PROGRESS` con lease vencido, y compromisos del chat sin tarjeta.
- **CA-10.4** Quinn nunca aprueba ni cierra tareas: su allowlist no incluye `tasks.approve`.

**US-11 — Freno de mano.** *Como operador quiero poder parar todo al instante.*
- **CA-11.1** "Pausar agentes" pone `config.agents_enabled=false`: no arrancan runs nuevos y los activos reciben cancelación; todo detenido en ≤ 10 s.
- **CA-11.2** Un agente concreto se pausa con `agents.set_status='paused'` sin afectar a los demás.
- **CA-11.3** Cancelar un run deja la tarea en `READY`, no en estado zombi, y el run en `cancelled`.

### 1.4 User stories de fase 2

- **US-12 — WhatsApp.** El cliente escribe por WhatsApp y habla con el mismo agente y el mismo hilo que en la web. *CA: el adaptador no requiere cambios en `apps/api`; se registra por el contrato de canal y declara sus capabilities.*
- **US-13 — Entrevistas IA masivas.** Sam entrevista en paralelo a todo el equipo del cliente por su canal preferido y consolida el mapa de procesos con fuente citada por respuesta.
- **US-14 — ISO 9001.** Matriz cláusula ↔ proceso ↔ evidencia; generación de documentación obligatoria (política de calidad, procedimientos, registros) con detección de huecos y plan de cierre.
- **US-15 — Cadencia automática.** Reporte de lunes 9am y sprint semanal generados solos; automatizaciones *consent-first*: se sugieren, nunca se auto-crean, máximo 5 sugerencias pendientes.
- **US-16 — Auto-mejora.** Revisión de fondo post-run (patrón Hermes) que propone mejoras de prompt como tarjeta en `REVIEW`; jamás se aplica sola.
- **US-17 — Postgres/Supabase + RAG vectorial.** Migración de datos y pgvector reemplazando FTS5, con multi-tenant real.
- **US-18 — Portal del cliente.** La empresa cliente ve su tablero filtrado, sube documentos y responde bloqueos.
- **US-19 — MCP externos.** Notion, GHL, Apollo y Drive conectados con allowlist de tools por agente.

### 1.5 Requisitos no funcionales

| # | NFR | Umbral verificable |
|---|---|---|
| NFR-1 | Latencia de chat | Primer token ≤ 2.5 s p95 en runtime `ai_sdk`; arranque de run `claude_code` ≤ 8 s p95 |
| NFR-2 | Latencia del tablero | Movimiento de agente visible en UI ≤ 500 ms p95 |
| NFR-3 | Concurrencia | 3 runs `claude_code` + 10 runs `ai_sdk` simultáneos sin degradar la UI en la máquina de desarrollo |
| NFR-4 | Durabilidad | Ningún run perdido: al reiniciar, los `running` pasan a `interrupted` y sus tareas vuelven a `READY` en ≤ 60 s |
| NFR-5 | Control de coste | Presupuesto por run y por día; al superarlo, corte duro con evento `RUN_ERROR: budget_exceeded` |
| NFR-6 | Seguridad de efectos | Cero ejecuciones de tools `external_effect` sin `approvals.status='approved'` (test automatizado) |
| NFR-7 | Auditabilidad | 100 % de mutaciones con fila en `audit_log`; todo movimiento del tablero atribuible a `run_id` o a `person_id` |
| NFR-8 | Reproducibilidad | Cualquier run se reproduce en UI desde `events` sin llamar al LLM |
| NFR-9 | Portabilidad de datos | Migrar SQLite a Postgres no toca código fuera de `packages/db` |
| NFR-10 | Windows-first | `pnpm dev` levanta todo en Windows 11 sin Docker ni WSL |
| NFR-11 | Observabilidad de coste | Coste acumulado por tarea, proyecto y agente consultable en ≤ 1 s |
| NFR-12 | Aislamiento | Cada proyecto tiene workspace de ficheros propio; un agente no lee ficheros de otro proyecto |

### 1.6 Fuera de alcance (explícito)

1. **Multi-tenancy real con aislamiento por cliente** (RLS, cifrado por org). Escala objetivo: una empresa; añadirlo ahora triplica el coste del modelo de datos.
2. **Deploy productivo, Docker, CI/CD, EasyPanel.** El VPS actual sufre CPU steal ~92 %: no es sitio para procesos hijos de Claude Code. El MVP corre local.
3. **Autenticación real** (SSO, RBAC granular). MVP: contraseña compartida y selección de persona del equipo al entrar, suficiente para poblar `actor_id`.
4. **RAG vectorial / embeddings.** FTS5 cubre la búsqueda a esta escala a coste cero; los vectores entran con Postgres en fase 2.
5. **Voz y telefonía** (Sofia/GHL): canal distinto, latencia distinta, problema distinto.
6. **Editor visual de flujos de agentes.** El visual es un mapa de observación, no un IDE; los agentes se editan por formulario y por MCP.
7. **Integraciones reales con sistemas externos** (Apollo, GHL, Notion, Drive). En MVP se usan stubs registrados en el catálogo de tools para ejercitar los gates.
8. **Facturación, contratos, firma electrónica.**
9. **Auto-modificación de prompts por los agentes sin humano.** Pueden proponer; sólo un humano aplica.
10. **App móvil y modo offline.**
11. **Emitir certificaciones ISO.** La plataforma prepara y documenta; certifica un organismo acreditado.
12. **Protocolo A2A entre agentes.** Los agentes no se hablan en tiempo real: se pasan trabajo creando tareas. Decisión de diseño, no omisión.

---

## 2. Arquitectura

### 2.0 Topología de procesos (decisión previa a todo lo demás)

**Decisión: dos procesos Node, no uno.**

- `apps/api` — **Fastify**. Es el dueño único de la base de datos, del bus de eventos, del despachador, de los runners y del WebSocket. Es un proceso largo, sin hot-reload agresivo.
- `apps/web` — **Next.js 15**. Es sólo UI: habla HTTP y WS con `apps/api`. No accede a la base de datos.

Justificación (dos razones, ambas de fondo):
1. El hot-reload de Next.js recarga módulos y destruiría el estado en memoria de runs largos y de procesos hijos. Un agente que lleva 4 minutos construyendo algo no puede morir porque guardaste un `.tsx`.
2. SQLite con un único proceso escritor elimina de raíz la clase de bugs `SQLITE_BUSY`. Con dos procesos tocando el fichero, WAL ayuda pero no salva.

Coste: una llamada HTTP más entre UI y datos. Beneficio: la misma frontera que después usan el gateway de WhatsApp, el servidor MCP y cualquier cliente externo. Es la frontera correcta de todos modos.

### 2.1 Componentes y responsabilidades

| Componente | Paquete | Responsabilidad | No hace |
|---|---|---|---|
| **API + WS Gateway** | `apps/api` | HTTP REST, WebSocket multiplexado, autenticación, contrato de canal | Lógica de dominio |
| **Orquestador / Despachador** | `packages/core` | Decide *qué run arrancar y cuándo*. Código determinista, sin LLM | Decidir *cómo* se hace el trabajo |
| **Runner Pool** | `packages/runners` | Ejecuta runs, aplica semáforos, timeouts, presupuestos y cancelación | Persistir dominio |
| **AgentRunner (x2)** | `packages/runners` | Traduce un agente + input en un flujo de eventos AG-UI | Conocer el kanban |
| **Catálogo de Tools** | `packages/tools` | Define cada tool una sola vez (Zod + handler + flags) y la adapta a los dos runtimes | Llamar al LLM |
| **Motor de Tablero** | `packages/core/board` | Máquina de estados, claim con lease, gates, política de aprobación, reaper | Renderizar |
| **Bus de Eventos** | `packages/events` | Publica/suscribe por topic, ring buffer con `seq` para resume, persistencia en `events` | Decidir nada |
| **Capa de Datos** | `packages/db` | Drizzle, esquema, migraciones, repositorios, FTS | Contener reglas de negocio |
| **Registro de Proveedores** | `packages/providers` | Instancia el modelo correcto por agente, calcula coste, aplica reintentos | Elegir agente |
| **MCP Admin** | `apps/mcp-admin` | Expone el dominio como tools MCP en dos perfiles (ro/rw) | Duplicar lógica: llama a `packages/core` |
| **UI** | `apps/web` | Chat, kanban, mapa vivo, vista de run, admin | Hablar con el LLM |

**Principio rector: el LLM no está en el camino crítico del despacho.** Los agentes *planifican* (crean tareas con dueño y DoD); el despachador que decide qué se ejecuta ahora es código determinista y testeable. Esto abarata, acelera y hace reproducible la operación.

### 2.2 DECISIÓN (a) — Runtime de agentes: **híbrido, con una única interfaz `AgentRunner`**

**Decisión.** Ni Claude Agent SDK puro ni loop propio puro: **dos implementaciones detrás de una misma interfaz, y la elección se guarda en datos** (`agents.runtime`).

```
interface AgentRunner {
  run(input: RunInput, ctx: RunContext): AsyncIterable<AgUiEvent>
  cancel(runId: string): Promise<void>
}
```

- **`ClaudeCodeRunner`** — envuelve `query()` de `@anthropic-ai/claude-agent-sdk` (spawn de proceso hijo). Se usa en los agentes que necesitan **computadora**: leer y escribir ficheros, ejecutar código, git, explorar un repo. En el MVP: **Debbie, Vinnie y Quinn**.
- **`AiSdkRunner`** — loop agéntico propio y compacto sobre **Vercel AI SDK** (`streamText` + `stopWhen: stepCountIs(n)` + tools). In-process, sin spawn. Se usa en los agentes **conversacionales y de datos**: **Alex, Sam, Sally, Clara**.

**Por qué híbrido y no uno solo:**

- *Claude Agent SDK puro* renuncia al multi-proveedor, que es requisito explícito (Kimi, MiniMax, GLM, OpenAI), y paga un proceso hijo (~150-300 MB y 1-3 s de arranque) por cada turno de chat. Absurdo para un agente que sólo lee el tablero y responde.
- *Loop propio puro* renuncia a la suscripción de Claude Code, que **es el presupuesto de tokens real del MVP**, y obliga a reconstruir edición de ficheros, ejecución de código sandboxeada, compactación de contexto y subagentes: semanas de trabajo para empatar algo que ya existe y está maduro.
- El híbrido pone el dinero de la suscripción donde rinde (trabajo pesado de construcción) y el loop barato donde está el volumen (chat, clasificación, movimientos de tablero).

**La costura crítica: un solo catálogo de tools, dos adaptadores.** Cada tool se declara una vez (nombre, Zod schema, handler, flags `external_effect` / `requires_approval` / `read_only`) y se materializa:
- para `AiSdkRunner`, como `tool()` de Vercel AI SDK;
- para `ClaudeCodeRunner`, como servidor MCP in-process vía `createSdkMcpServer()`, con namespacing `mcp__agentos__<tool>`.

Este es exactamente el patrón `convert_tools` de `agent/transports/base.py` de Hermes, y es lo que impide que el catálogo se bifurque.

**Control de recursos.** `RunnerPool` con dos semáforos independientes: `claude_code` (por defecto 3 concurrentes en la máquina de desarrollo) y `ai_sdk` (por defecto 10). Lo que no cabe se encola y **la cola es visible en la UI** — un agente "esperando turno" es un estado legítimo, no un cuelgue.

**Nota de licencia, explícita.** La suscripción de Claude Code es individual: en el MVP el runtime `claude_code` corre bajo el token de Ernesto y para uso interno de una persona. En cuanto haya uso de equipo o de cliente, se cambia `provider_profiles` a API key de Console o a seats Team — **cero cambios de código**, porque el proveedor es un dato. Diseñar esto como intercambiable no es elegancia, es la condición para no quedar atrapados.

### 2.3 DECISIÓN (b) — UI: **propia y ligera, con el vocabulario de eventos AG-UI sobre WebSocket. NO CopilotKit.**

**Decisión.** Se adopta **el protocolo AG-UI como formato de evento** y se descarta **el runtime y los componentes de CopilotKit**.

**Por qué no CopilotKit completo:**
- Su valor es el *chat sidebar* con generative UI y el puente hacia LangGraph/CrewAI. Nuestra superficie estrella no es un sidebar: son el **kanban** y el **mapa vivo**, que CopilotKit no aporta. Adoptaríamos un runtime entero (endpoint propio, adaptadores de proveedor, ciclo de vida) para obtener una lista de burbujas que se escribe en una tarde con shadcn/ui y react-markdown.
- `useCoAgent` asume que el estado del agente es un objeto compartido en memoria. El nuestro es una **base de datos** (el tablero) que ya tiene que sincronizarse por WS hacia varios clientes. Meter la capa de estado de CopilotKit duplica esa sincronización y crea dos fuentes de verdad.
- Dependencia de su ciclo de vida en el núcleo del producto, a cambio de ahorrar un día de UI.

**Por qué sí el vocabulario AG-UI:** estandariza gratis. Ambos runners emiten los mismos eventos (`RUN_STARTED`, `TEXT_MESSAGE_START/CONTENT/END`, `TOOL_CALL_START/ARGS/END/RESULT`, `STATE_SNAPSHOT`, `STATE_DELTA` como JSON Patch, `RUN_FINISHED`, `RUN_ERROR`), la UI tiene un solo reductor, y si algún día conviene enchufar componentes de CopilotKit o un cliente de terceros, encajan sin reescribir el backend. Coste de adoptar el vocabulario: casi cero. Coste de adoptar el runtime: acoplamiento estructural.

**Transporte: un único WebSocket multiplexado por topics**, no SSE.
- Topics: `run:<id>`, `board:<project_id>`, `thread:<id>`, `swarm`, `approvals`.
- Necesitamos **bidireccionalidad** (aprobar un gate, cancelar un run, pausar agentes) y fan-out multi-topic; con SSE haría falta un segundo canal para escribir.
- **Resume por `since_seq`**: el bus mantiene un ring buffer por topic (últimos 500 eventos) y persiste en `events`; al reconectar, el cliente manda su último `seq` y recibe el hueco. Esto es lo que hace verificable el CA-2.3.

**Stack de UI concreto:** Next.js 15 (App Router) + React 19, Tailwind + shadcn/ui, **dnd-kit** para el kanban (con actualización optimista y reconciliación por evento del servidor), **@xyflow/react** para el mapa vivo **en modo sólo lectura**, Zustand como store alimentado por el WS, react-markdown para artefactos y `shiki` para diffs.

**Cuatro vistas, nada más:** Chat, Tablero, Enjambre (mapa vivo), Run. Más una quinta de Admin (agentes, prompts, proveedores) que es el espejo mínimo del MCP.

### 2.4 DECISIÓN (c) — Persistencia: **SQLite día 1. Postgres/Supabase es una migración planificada, no un día 1.**

**Decisión.** `better-sqlite3` en modo WAL, **Drizzle ORM**, propiedad exclusiva del proceso `apps/api`.

**Por qué SQLite:**
1. La escala es una empresa y unos pocos engagements. SQLite sobra por órdenes de magnitud.
2. **Latencia de tool call.** Cada `tasks.move`, `tasks.claim` o `board.get` de un agente sería un round-trip de red contra Supabase. Un run hace decenas de tool calls: la diferencia entre microsegundos y ~50 ms se nota en cada turno y multiplica el coste de tiempo del agente. Las lecturas locales son gratis.
3. **Fricción cero en Windows sin Docker**, requisito NFR-10, y desarrollo offline.
4. **FTS5 gratis** para búsqueda de conversaciones, tareas y conocimiento a coste cero de LLM (patrón Hermes).
5. Nuestro tiempo real no lo da la base de datos: lo da nuestro propio bus. Los eventos de run son de granularidad de token; no queremos que eso pase por Realtime de Postgres.

**Qué se hace hoy para que la migración sea barata (esto no es opcional):**
- **IDs `uuidv7` en TEXT**, nunca autoincrement. Ordenables por tiempo y portables.
- **Timestamps como `INTEGER` epoch ms.** Sin ambigüedad de zona ni de formato.
- **JSON en columnas TEXT con `mode: 'json'` de Drizzle** → mapean a `jsonb` sin tocar el dominio.
- **Todo acceso a datos pasa por `packages/db/repositories/*.ts`.** Ni una consulta SQL fuera de ahí. Ni en tools, ni en runners, ni en la API.
- **FTS5 aislado en `packages/db/search.ts`** con su equivalente `tsvector` documentado al lado.
- **Sin triggers de negocio en SQL.** Las reglas viven en TypeScript y por tanto migran.

**Disparadores explícitos de la migración** (cuando ocurra cualquiera, se migra, no antes): más de un proceso escritor; acceso remoto multi-usuario concurrente; base > 5 GB; necesidad de autorización por fila por empresa cliente; necesidad de búsqueda vectorial.

### 2.5 Modelo de datos

Tablas de **día 1** (16). Convenciones: `id` TEXT uuidv7; `*_at` INTEGER epoch ms; JSON en TEXT con `mode:'json'`.

**Organización y personas**

- **`organizations`** — `id`, `name`, `slug`, `kind` ('internal' | 'client'), `industry`, `size`, `created_at`.
- **`people`** — `id`, `org_id` FK, `full_name`, `email`, `role`, `is_internal`, `created_at`. Semilla: Samuel, Sebastián, Jorge, Jefferson, Ernesto (nombre completo obligatorio al asignar).
- **`projects`** (engagements) — `id`, `org_id`, `name`, `type` ('assessment'|'transform'|'ops'), `stage` ('ENTENDER'|'CONSTRUIR'|'OPERAR'), `gate_state` JSON `{g1_plan:'pending|approved', g2_external:'...'}`, `status`, `owner_person_id`, `workspace_path`, `started_at`, `target_date`.

**Agentes y cerebros**

- **`agents`** — `id`, `slug`, `name`, `layer` ('consultoria'|'implementacion'|'operacion'|'meta'), `role_desc`, **`runtime`** ('claude_code'|'ai_sdk'), `provider_profile_id` FK, `model`, `active_prompt_version_id` FK, `tools` JSON (allowlist), `mcp_servers` JSON, `limits` JSON `{max_steps, max_usd_per_run, max_concurrent, timeout_s}`, `autonomy` ('suggest'|'act_with_gate'|'autonomous'), `status` ('active'|'paused'|'archived'), `seed_file`, `seed_hash`, `created_at`, `updated_at`.
- **`prompt_versions`** — `id`, `agent_id`, `version` INT, `layer_stable`, `layer_context`, `layer_volatile_tpl`, `changelog`, `author_actor`, `created_at`. Prompt en **3 capas** (patrón Hermes) en este orden deliberado para aprovechar prefix cache: *stable* (identidad + constitución Sixteam + guía de tools) → *context* (proyecto, org, procesos mapeados, DoD del engagement) → *volatile* (tarea actual, últimos eventos del tablero, timestamp).
- **`provider_profiles`** — `id`, `name`, `kind` ('claude_subscription'|'anthropic_api'|'openai_compatible'), `base_url`, `api_key_env` (**nombre** de la variable, nunca el valor), `default_model`, `headers` JSON, `cost_in_per_mtok`, `cost_out_per_mtok`, `enabled`.

**Tablero**

- **`tasks`** — `id`, `project_id`, `parent_task_id`, `title`, `description`, `definition_of_done`, `stage`, **`status`**, `activity_type` (taxonomía del catálogo de ~50 actividades por pilar), `priority`, `assignee_agent_id`, `assignee_person_id`, `requires_approval` BOOL, `external_effect` BOOL, `lease_until`, `attempts`, `blocked_reason`, `due_at`, **`order_key`** (índice fraccionario tipo LexoRank: reordenar una tarjeta no reindexa la columna), `created_by_actor`, `created_at`, `updated_at`, `closed_at`.
- **`task_events`** — `id`, `task_id`, `ts`, `actor_type` ('agent'|'human'|'system'), `actor_id`, `kind` ('created'|'moved'|'assigned'|'commented'|'blocked'|'approved'|'rejected'|'artifact_added'), `from_status`, `to_status`, `note`, `run_id`. **Es el timeline de la tarjeta y la fuente del "los agentes mueven el tablero".**
- **`artifacts`** — `id`, `task_id`, `project_id`, `kind` ('document'|'diagram'|'code_patch'|'dataset'|'report'), `title`, `path_or_url`, `mime`, `produced_by_run_id`, `version`, `created_at`.

**Conversación**

- **`threads`** — `id`, `channel` ('web'|'whatsapp'|...), `session_key` (`channel:chat_id:thread_id`, mismo esquema que `build_session_key` de Hermes), `project_id`, `person_id`, `agent_id`, `title`, `status`, `last_msg_at`.
- **`messages`** — `id`, `thread_id`, `role`, `content` JSON (multimodal), `actor_type`, `actor_id`, `run_id`, `tokens_in`, `tokens_out`, `created_at`. Espejo **`messages_fts`** (FTS5) mantenido por trigger.

**Observabilidad**

- **`runs`** — `id`, `parent_run_id`, **`root_run_id`** (desnormalizado: el árbol completo se consulta con un índice), `agent_id`, `task_id`, `thread_id`, `trigger` ('chat'|'task_queue'|'approval_resume'|'delegation'|'schedule'|'manual'), `runtime`, `provider_profile_id`, `model`, `status` ('queued'|'running'|'succeeded'|'failed'|'cancelled'|'interrupted'), `tokens_in`, `tokens_out`, `tokens_cache_read`, `cost_usd`, `started_at`, `ended_at`, `error`, `resume_of_run_id`, `replay_of_run_id`.
- **`spans`** — `id`, `run_id`, `parent_span_id`, `seq`, `type` ('llm_call'|'tool_call'|'subagent'|'gate'|'retry'), `name`, `started_at`, `ended_at`, `duration_ms`, `status`, `attrs` JSON (nombres estilo OTel GenAI: `gen_ai.system`, `gen_ai.request.model`, `gen_ai.usage.*` — sin adoptar el SDK de OTel), `error`.
- **`events`** — append-only, el stream AG-UI persistido: `id`, `topic`, `run_id`, `seq` (monótono por topic), `ts`, `type`, `payload` JSON. Es la fuente para el resume del WS y para la reproducción de un run.

**Gobierno**

- **`approvals`** — `id`, `kind` ('tool_call'|'deliverable'|'gate'), `run_id`, `task_id`, `project_id`, `tool_name`, `payload` JSON (el efecto literal que se ejecutará), `rationale`, `status` ('pending'|'approved'|'rejected'|'expired'), `requested_at`, `expires_at`, `decided_at`, `decided_by_person_id`, `decision_note`.
- **`audit_log`** — `id`, `ts`, `actor_type`, `actor_id`, `source` ('ui'|'mcp'|'agent'|'system'), `action`, `entity_type`, `entity_id`, `before` JSON, `after` JSON, `run_id`.
- **`knowledge_docs`** — `id`, `org_id`, `project_id`, `kind` ('process_map'|'interview'|'iso_clause'|'template'|'note'), `title`, `body_md`, `source_url`, `tags` JSON, `created_at`. Espejo **`knowledge_fts`**.
- **`app_config`** — `key`, `value` JSON, `updated_at`, `updated_by`. Contiene el kill switch `agents_enabled` y los presupuestos globales.

**Diferidas a fase 2:** `identities` (canal → persona, sólo hace falta con WhatsApp), `mcp_servers`, `schedules`, `embeddings`.

**Decisión de modelado importante: no existe tabla `delegations`.** Delegar es `tasks.create(parent_task_id, assignee_agent_id, payload)`. Cada handoff es una tarjeta visible en el tablero. Consecuencias, todas buenas: el grafo de interacción entre agentes es derivado (aristas padre→hijo), la delegación es auditable, reanudable tras reinicio y no puede producir deadlock. Es la versión operativa del "handoff como tarea, no A2A".

### 2.6 El tablero kanban movido por agentes

**Dos ejes, no uno.** `stage` (ENTENDER | CONSTRUIR | OPERAR) es el **carril**, refleja la metodología de Sixteam. `status` es la **columna**, es la máquina de estados. Mezclarlos daría un tablero de 15 columnas ilegible.

**Siete estados:**

`BACKLOG` → `READY` → `IN_PROGRESS` → (`BLOCKED` | `REVIEW`) → `DONE`, más `CANCELLED`.

- **BACKLOG**: existe la idea; puede no tener dueño ni DoD.
- **READY**: tiene `definition_of_done`, insumos y `assignee_agent_id`. **Es la única cola de la que el despachador tira.**
- **IN_PROGRESS**: un run la tiene tomada con lease vivo.
- **BLOCKED**: falta algo externo (dato del cliente, credencial, decisión, aprobación pendiente). Lleva `blocked_reason`.
- **REVIEW**: gate humano; hay entregable esperando aprobación.
- **DONE** / **CANCELLED**.

**Quién puede mover qué (esto es la mitad del diseño):**

| Transición | Agente | Humano |
|---|---|---|
| BACKLOG → READY | Sí (sólo el orquestador, y sólo con DoD y dueño) | Sí |
| READY → IN_PROGRESS | Sí, **únicamente vía `tasks.claim`** | Sí |
| IN_PROGRESS → BLOCKED | Sí | Sí |
| BLOCKED → READY | Sí (cuando se resuelve el bloqueo) | Sí |
| IN_PROGRESS → REVIEW | Sí, **exige ≥ 1 artefacto** | Sí |
| IN_PROGRESS → DONE | Sólo si `requires_approval = 0` **y** hay artefacto | Sí |
| REVIEW → DONE | **Nunca** | Sí |
| REVIEW → IN_PROGRESS (rechazo) | No | Sí, con nota obligatoria |
| cualquiera → CANCELLED | No | Sí |

**`requires_approval` no lo decide el agente.** Lo calcula una política determinista al crear la tarea: es `true` si `external_effect = 1`, si es entregable de fase (informe de assessment, roadmap, propuesta), o si el `activity_type` está en la lista de actividades sensibles. Un agente no puede rebajarse su propio control.

**Claim atómico con lease** (el mecanismo que impide que dos agentes trabajen la misma tarjeta):

```sql
UPDATE tasks SET status='IN_PROGRESS', assignee_agent_id=?, lease_until=?, attempts=attempts+1
WHERE id=? AND status='READY' AND (lease_until IS NULL OR lease_until < :now)
```
Si `changes = 0`, el agente perdió la carrera y recibe `{claimed:false}`. El runner **renueva el lease por latido** cada 60 s. Un **reaper** cada 30 s devuelve a `READY` las tareas con lease vencido; a `attempts >= 3` las manda a `BLOCKED` con `blocked_reason='stuck'` y notifica. Esto también es lo que arregla solo un reinicio del servidor.

**Dos gates humanos estilo Charlie:**

- **Gate 1 — Plan aprobado (nivel proyecto).** Al cerrar ENTENDER, el humano aprueba diagnóstico + roadmap. Hasta entonces, `tasks.move` sobre cualquier tarea de `stage='CONSTRUIR'` devuelve `gate_not_passed`. Impide que la plataforma se ponga a construir sobre un diagnóstico no validado.
- **Gate 2 — Efecto externo (nivel tool call).** Toda tool con `external_effect=1` **no ejecuta**: crea `approvals` con el payload literal, devuelve `{status:'pending_approval', approval_id}` y termina.

**Decisión concreta sobre el gate 2: no se suspende el proceso del agente.** Suspender un run a mitad de camino (sobre todo un proceso hijo) es frágil y no sobrevive a un reinicio. En su lugar: la tool devuelve pendiente, el agente mueve la tarea a `BLOCKED (approval)` y cierra el turno; cuando el humano aprueba, el sistema ejecuta el efecto y **encola un run nuevo con `resume_of_run_id`** que recibe el resultado como mensaje de sistema. Es robusto ante caídas, trivial de testear y deja la espera visible en el tablero en vez de escondida en memoria.

**Regla anti-teatro:** ninguna tarea llega a `REVIEW` ni a `DONE` sin fila en `artifacts`. Un agente no puede cerrar trabajo con un párrafo bonito. Esta única regla es la que convierte el tablero en evidencia en lugar de en decoración.

**Visual del enjambre.** Lienzo React Flow de sólo lectura alimentado por el topic `swarm`: nodos = agentes (halo de estado, tarea actual, tokens/coste), nodos secundarios = sistemas externos y servidores MCP, aristas = delegaciones vivas (tarea padre → hija, animadas 3 s) y llamadas a tools. Clic en arista abre la tarjeta; clic en nodo abre el run activo.

### 2.7 MCP de administración — "editar casi todo"

**Decisión.** Un solo servidor, `agentos-admin`, con **doble transporte** (stdio para Claude Code local, streamable HTTP para clientes remotos) y **dos perfiles de permiso** arrancados con la misma base de código:

- **`agentos-admin-rw`** — escritura completa. Es el que Ernesto registra en su Claude Code. Aquí vive el "editar casi todo".
- **`agentos-admin-ro`** — sólo lectura. **Es el único que se expone a los agentes internos.** Un agente puede consultar el estado del sistema; no puede reescribir su prompt ni el de otro.

El servidor MCP es una **capa fina**: no reimplementa reglas, llama a `packages/core`. Toda mutación pasa por las mismas validaciones que la UI.

**Tools expuestas** (namespacing `agentos.<dominio>.<acción>`):

| Dominio | Tools |
|---|---|
| Agentes | `agents.list`, `agents.get`, `agents.create`, `agents.update` (prompt, modelo, runtime, allowlist de tools, mcp_servers, limits, autonomy), `agents.set_status`, `agents.clone`, **`agents.test`** (dry-run con un input: devuelve el run completo con `sandbox=true`, que bloquea toda tool con `external_effect`) |
| Prompts | `prompts.list`, `prompts.get`, `prompts.update`, `prompts.diff`, `prompts.rollback` |
| Tablero | `tasks.list` (filtros), `tasks.get`, `tasks.create`, `tasks.update`, `tasks.move`, `tasks.comment`, `tasks.assign`, `tasks.attach_artifact`, `tasks.approve`, `tasks.reject`, `board.get` (snapshot), `board.reorder` |
| Proyectos | `projects.list/get/create/update`, `projects.set_gate` |
| Runs | `runs.list`, `runs.get` (con árbol de spans), `runs.cancel`, **`runs.replay`** (mismo input, nuevo `run_id`, `replay_of`), `events.tail` |
| Aprobaciones | `approvals.list_pending`, `approvals.decide` |
| Proveedores | `providers.list`, `providers.upsert` (**sólo nombre de variable de entorno, nunca el valor de la clave**), `providers.test` |
| Config | `config.get`, `config.set`, `system.pause_all`, `system.resume_all`, `system.health` |
| Conocimiento | `knowledge.search`, `knowledge.upsert_doc`, `knowledge.list` |
| Personas | `people.list`, `people.upsert` |
| Auditoría | `audit.query`, `audit.revert` (revierte una mutación concreta usando `before`) |

**Cinco reglas de seguridad, no negociables:**
1. Los agentes reciben el perfil `ro`; el `rw` es humano.
2. Toda mutación escribe `audit_log` con `before`/`after`; `audit.revert` la deshace.
3. Ninguna tool devuelve secretos. Las claves se referencian por nombre de variable de entorno.
4. `agents.update` sobre un prompt **crea versión**, nunca sobrescribe. `rollback` en un clic.
5. Las tools con efecto externo **no viven aquí**. Este servidor administra la plataforma; ejecutar hacia afuera pasa por el catálogo de ejecución y sus `approvals`.

### 2.8 Observabilidad: `run_id` / `parent_run_id`

Tres niveles encajados: **run** (una invocación de un agente) → **span** (una llamada LLM, tool o subagente) → **event** (el stream AG-UI, granularidad de token).

- Todo handler de tool recibe `ctx = { run_id, span_id, agent_id, task_id, project_id, actor }`. Ese `ctx` es lo que rellena `task_events.run_id` y `audit_log.run_id`. **Consecuencia práctica: cada tarjeta del tablero dice "movida por Sam" y el clic lleva al run exacto, con su coste y su razonamiento.**
- `root_run_id` desnormalizado permite `SELECT ... WHERE root_run_id = ?` para pintar el árbol completo de un encargo sin recursión.
- Coste agregado por subárbol: vista `run_costs_by_root`, y de ahí coste por tarea, por proyecto y por agente (NFR-11).
- Retención: `events` completo 30 días; después se compacta borrando los deltas `TEXT_MESSAGE_CONTENT` y conservando mensajes finales, tool calls y resultados. `runs` y `spans` no se borran.
- Se usan **nombres de atributo estilo OTel GenAI** sin adoptar el SDK de OpenTelemetry: si mañana hace falta exportar, es un mapeo, no una reescritura.

### 2.9 Layout del monorepo

```
agentos/
  apps/
    api/            Fastify: HTTP + WS, dueño de SQLite, despachador y runners
    web/            Next.js 15: chat, tablero, enjambre, run, admin
    mcp-admin/      Servidor MCP (stdio + HTTP), perfiles ro/rw
  packages/
    core/           orquestador, despachador, board (máquina de estados, lease,
                    gates, políticas), reaper, presupuestos
    db/             drizzle schema, migraciones, repositories/, search.ts (FTS5)
    runners/        AgentRunner, ClaudeCodeRunner, AiSdkRunner, RunnerPool
    tools/          catálogo (Zod + handler + flags) + adapters ai-sdk / sdk-mcp
    events/         tipos AG-UI, bus, ring buffer, persistencia
    providers/      registry multi-LLM, cálculo de coste, reintentos
    shared/         tipos y schemas Zod compartidos, uuidv7, errores
  agents/           definiciones semilla en markdown + frontmatter:
                    alex.md sam.md debbie.md vinnie.md sally.md clara.md quinn.md
  docs/
```

**Sobre `agents/`:** son ficheros versionados en git que se cargan a la tabla `agents` al arrancar. La **fuente de verdad en ejecución es la base de datos** (para poder editar en caliente por MCP), y `seed_hash` delata si la base se ha desviado del fichero. `agents.export` escribe de vuelta al fichero. Así se tienen las dos cosas: prompts en git y edición en caliente.

Herramientas: **pnpm workspaces + Turborepo** (configuración mínima), TypeScript estricto, Biome para lint/format, Vitest para pruebas.

### 2.10 Cómo se enchufa WhatsApp después: contrato de gateway estilo Hermes

**Decisión clave, y hay que tomarla el día 1 aunque WhatsApp sea fase 2: el chat web se implementa como el canal `web` del mismo contrato de canal.** Así WhatsApp no es un añadido posterior, es la **segunda** implementación de un contrato ya ejercitado a diario. Si el chat web fuese un caso especial, WhatsApp costaría un refactor.

A diferencia de Hermes (adaptadores Python in-process heredando de `BasePlatformAdapter`), aquí el adaptador es un **proceso separado que habla HTTP + WS con `apps/api`**. Motivo: aislar dependencias frágiles (WhatsApp Cloud API, sesiones, reintentos) del proceso que sostiene los runs y la base de datos.

**El contrato, cuatro piezas:**

1. **Registro y capabilities.** `POST /v1/channels/register` con `{ name, capabilities: { streaming_edit, media_kinds[], max_text_len, typing, buttons } }`. El núcleo adapta la salida a esas capabilities: trocea texto, degrada media, omite borradores si el canal no sabe editar. **Esto es lo que evita que aparezca un condicional por plataforma dentro del dominio** — la lección más portable de `gateway/platforms/base.py`.

2. **Entrada.** `POST /v1/channels/:name/events` con firma HMAC y cuerpo `InboundMessage { channel, external_user_id, external_chat_id, thread_id?, message_id, text, message_type, media[]{url|path, mime, kind}, reply_to?, ts }`. El núcleo resuelve `identities` (external_user_id a `people`), resuelve o crea el `thread` por `session_key = channel:chat_id:thread_id` (mismo esquema que `build_session_key` de Hermes), persiste el mensaje y encola un run de Alex. **Idempotencia obligatoria:** índice único `(channel, message_id)`; el duplicado se descarta en vez de contestarse dos veces — justo la clase de fallo que ya costó cara en el pipeline de reuniones.

3. **Salida.** El adaptador se suscribe al topic WS `channel:<name>` y recibe `OutboundMessage { thread_id, external_chat_id, text, media[], reply_to?, draft_seq?, final }`. Los borradores se emiten con `final=false`; un canal con `streaming_edit` (Telegram) edita el mensaje, uno sin ella (WhatsApp) ignora los parciales y envía sólo el final. **Una sola lógica en el núcleo, comportamiento correcto en ambos.**

4. **Estado y control.** `POST /v1/channels/:name/ack` (entregado/fallido, para reintentos) y evento `typing` hacia el adaptador.

Añadir WhatsApp en fase 2 es, entonces: un proceso que traduce el webhook de Meta a `InboundMessage`, consume `OutboundMessage` y declara sus capabilities. Cero cambios en `apps/api`, en el tablero o en los agentes. El mismo contrato sirve para Slack, Telegram o un widget embebido en la web del cliente.

---

## 3. Plan MVP (2-3 días de trabajo agéntico intensivo)

Orden estricto: cada bloque desbloquea el siguiente. Los marcados **[par]** se pueden repartir entre subagentes en paralelo.

**Bloque 0 — Cimientos (≈ 1 h)**
1. Monorepo pnpm + Turborepo, TypeScript estricto, Biome, Vitest, `.env.example`.
2. `packages/shared`: uuidv7, tipos de error, schemas Zod base, helpers de tiempo.

**Bloque 1 — Datos (≈ 3 h)**
3. `packages/db`: esquema Drizzle con las 16 tablas de día 1 e índices clave: `tasks(project_id,status,order_key)`, `runs(root_run_id)`, `events(topic,seq)`, `tasks(status,lease_until)`.
4. Migraciones y FTS5 (`messages_fts`, `knowledge_fts`) aislados en `search.ts`.
5. Repositorios por agregado: `projects`, `tasks`, `agents`, `runs`, `events`, `approvals`, `audit`.
6. Semilla: org Sixteam, 5 personas, 7 agentes desde `agents/*.md`, 6 `provider_profiles`, y un proyecto demo *Assessment ACME* con 12 tareas.

**Bloque 2 — Núcleo de ejecución (≈ 5 h)**
7. `packages/events`: tipos AG-UI, bus por topics, ring buffer con `seq`, persistencia en `events`.
8. `packages/providers`: registry (Anthropic, OpenAI y `createOpenAICompatible` para Kimi, MiniMax y GLM), cálculo de coste, reintentos con backoff.
9. `packages/runners`: interfaz `AgentRunner` y **`AiSdkRunner`** (loop con `stopWhen`, emisión de eventos AG-UI, escritura de `runs` y `spans`).
10. **`ClaudeCodeRunner`**: `query()` del Agent SDK, proyección de sus mensajes a eventos AG-UI, workspace por proyecto, cancelación limpia.
11. `RunnerPool`: semáforos por runtime, timeouts, presupuesto por run, cola visible, kill switch.

**Bloque 3 — Tablero y tools (≈ 4 h)**
12. `packages/core/board`: máquina de estados, `claim` atómico con lease, latido, reaper, política de `requires_approval`, gates 1 y 2, regla de artefacto obligatorio.
13. **Pruebas de esta parte, sin excepción**: transiciones legales e ilegales por rol, carrera de doble `claim`, expiración de lease, `attempts >= 3`, gate bloqueando CONSTRUIR, aprobación que reanuda un run. *Es el único código donde un fallo corrompe datos en silencio.*
14. `packages/tools`: registro Zod y los dos adaptadores. Tools de día 1: `tasks.{create,claim,move,comment,attach_artifact,list,get}`, `board.get`, `projects.{get,update}`, `knowledge.search`, `artifacts.write`, `delegate` (que es `tasks.create` con padre), `ask_human` (crea `approval`) y un stub `email.send` marcado con efecto externo para ejercitar el gate 2.

**Bloque 4 — API (≈ 3 h) [par]**
15. Fastify: REST de tablero, proyectos, agentes, runs y aprobaciones; login por contraseña compartida más selección de persona del equipo.
16. WebSocket multiplexado por topics con resume por `since_seq`.
17. Contrato de canal implementado para `web` (`/v1/channels/web/events`), con dedup por `(channel, message_id)`.
18. Despachador determinista: cola de `READY`, arranque de runs, reanudación por aprobación, recuperación al arrancar (`running` pasa a `interrupted` y su tarea vuelve a `READY`).

**Bloque 5 — UI (≈ 6 h) [par]**
19. Shell Next.js, store Zustand alimentado por WS y un único reductor de eventos AG-UI.
20. Chat con streaming, tool calls visibles y enlaces a las tarjetas creadas.
21. Kanban dnd-kit: carriles por `stage`, columnas por `status`, actualización optimista, reconciliación por evento del servidor, avatar del actor en cada tarjeta.
22. Panel de tarea: timeline, artefactos renderizados, botones Aprobar y Rechazar, bandeja "Esperando por ti".
23. Enjambre: React Flow de sólo lectura, estado por nodo y aristas animadas de delegación.
24. Vista de run: árbol de spans, tokens, coste y botón de reproducir.

**Bloque 6 — MCP de administración (≈ 2 h)**
25. `apps/mcp-admin` con perfiles `ro` y `rw`, las ~35 tools de la sección 2.7 llamando a `packages/core`, auditoría en cada mutación.
26. Registrarlo en el Claude Code de Ernesto y validar US-8 de punta a punta.

**Bloque 7 — Agentes y demostración (≈ 4 h)**
27. Prompts en 3 capas de los 7 agentes, con la constitución Sixteam (Entender-Construir-Operar, ISO 9001, anti-alucinación con fuente citada) en la capa estable.
28. Quinn: run automático de crítica al entrar una tarea en `REVIEW` más auditoría de tablero bajo demanda.
29. **Guion de aceptación end-to-end, que ES el criterio de terminado del MVP:** Ernesto pide por chat un assessment para ACME; Alex crea el proyecto y 8 tareas; Sam toma 3, las mueve y produce el informe; la tarea entra en `REVIEW`; Quinn la critica; Ernesto aprueba; se abre el gate 1; Debbie toma la primera tarea de CONSTRUIR; un `email.send` queda esperando aprobación. Todo visible en vivo en tablero y enjambre.
30. Pulido: estados vacíos, errores legibles, README de arranque en Windows.

### Qué se corta sin piedad

Autenticación real y roles. Docker, CI/CD y cualquier deploy. Integraciones externas reales: todo stub. RAG y embeddings. WhatsApp y cualquier canal que no sea `web`. Schedules y cron. Streaming de borradores. Compactación automática de contexto (basta truncar y avisar). Editor visual de agentes (formulario mínimo; el poder está en el MCP). Multi-idioma, dark mode y responsive móvil. Cobertura amplia de pruebas: **sólo se prueban la máquina de estados, el claim/lease y los gates**, porque es donde un fallo es silencioso y destructivo. Exportación a PDF (markdown basta). Métricas más allá de coste por run, tarea y proyecto.

**Si el tiempo aprieta, el orden de sacrificio es:** primero el mapa del enjambre (vistoso, no crítico), luego la vista de run detallada (basta el log), luego el `ClaudeCodeRunner` (arrancar sólo con `ai_sdk`). **Nunca se sacrifican** el claim con lease, los gates ni la regla de artefacto obligatorio: sin ellos la plataforma miente.

---

## 4. Riesgos top 5

| # | Riesgo | Mitigación |
|---|---|---|
| **R1** | **Coste y términos de la suscripción Claude Code**: es individual, el uso de equipo la viola, y varios procesos hijos agotan los límites en horas | Runtime y proveedor son un dato por agente (`agents.runtime` + `provider_profiles`): se cambia a API key de Console o a Kimi/GLM sin tocar código, con presupuesto duro por run y por día |
| **R2** | **Teatro agéntico**: los agentes mueven tarjetas a DONE sin producir nada real y el tablero se vuelve decorativo | Ninguna tarea llega a `REVIEW` ni a `DONE` sin fila en `artifacts`, los entregables pasan por gate humano, y Quinn audita cierres sin evidencia |
| **R3** | **Saturación de la máquina**: N procesos hijos de Claude Code agotan CPU y RAM en el Windows de desarrollo y la UI se congela | `RunnerPool` con semáforo por runtime (3 procesos hijos por defecto), timeouts duros por run y cola de espera visible como estado legítimo en la UI |
| **R4** | **Corrupción por concurrencia**: dos agentes toman la misma tarea, o un run muere y deja la tarjeta zombi para siempre | `claim` atómico condicional con lease renovado por latido, reaper cada 30 s, `attempts >= 3` a `BLOCKED`, y pruebas de carrera obligatorias en el bloque 3 |
| **R5** | **El MCP de administración como superficie de auto-modificación**: un agente reescribe su prompt o el de otro, o una inyección desde contenido del cliente escala privilegios | A los agentes sólo se les expone el perfil `ro`; el `rw` es humano; todo prompt se versiona en `prompt_versions` con rollback en un clic y toda mutación queda en `audit_log` con `before`/`after` |

---

## Apéndice: las cinco decisiones en una línea

1. **Runtime híbrido** detrás de `AgentRunner`: Claude Agent SDK para los agentes que necesitan computadora (Debbie, Vinnie, Quinn), loop propio sobre Vercel AI SDK para los conversacionales (Alex, Sam, Sally, Clara), con **un solo catálogo de tools y dos adaptadores**.
2. **UI propia con vocabulario AG-UI sobre un WebSocket multiplexado**, sin el runtime de CopilotKit.
3. **SQLite con Drizzle en un único proceso escritor**, con seis reglas de portabilidad que hacen barata la migración a Postgres el día que se dispare uno de los cinco criterios definidos.
4. **Kanban de 7 estados con claim atómico por lease, artefacto obligatorio y dos gates humanos**; delegar es crear una tarea hija, no un protocolo entre agentes.
5. **El chat web es el canal `web` del contrato de gateway** desde el día 1, para que WhatsApp sea una implementación más y no un refactor.
