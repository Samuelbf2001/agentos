# 1. PRD (estilo Spec Kit)

## Visión y porqué

AgentOS Sixteam será el sistema operativo interno desde el que personas y agentes de IA ejecutan, dejan evidencia y supervisan el trabajo de consultoría de Sixteam. Su norte de producto es reproducir el ciclo **Entender → Construir → Operar**: diagnosticar y mapear procesos, diseñar mejoras y preparación para ISO 9001, convertir el diseño en software, plataformas o agentes, y operar las soluciones en continuidad. Esta definición, las ofertas comerciales y el roster inicial provienen del `research-brief.md` (§§1–2). ISO 9001 se trata como una capacidad nueva: el producto no afirmará que ya forma parte de la oferta pública ni que puede otorgar una certificación.

El problema que resuelve no es solamente “tener varios chats”. El trabajo agéntico necesita una memoria operativa compartida: compromisos visibles, responsables, dependencias, revisiones, aprobaciones y evidencia. Por eso, el tablero central —no la conversación ni el contexto efímero de un LLM— será la fuente de verdad del trabajo. El chat será el punto de entrada; cada encargo relevante generará trabajo trazable en el tablero.

El MVP debe demostrar de punta a punta este recorrido:

1. Una persona solicita un resultado en el chat web dentro de un engagement.
2. Alex, en función de orquestador/concierge, aclara o descompone el encargo y crea tareas.
3. Los especialistas reclaman tareas compatibles y mueven las tarjetas mediante tools tipadas.
4. La UI muestra en vivo quién trabaja, qué handoffs ocurren y qué tools se ejecutan.
5. Un agente QA independiente revisa la evidencia; las acciones de riesgo se detienen en gates humanos.
6. La persona recibe el resultado y puede reconstruir qué ocurrió desde la solicitud hasta la entrega.

Los principios de producto son:

- **Trabajo durable, no teatro de agentes.** Una interacción visual siempre corresponde a un evento persistido; no se animan relaciones inferidas.
- **Autonomía acotada.** Los agentes pueden crear, reclamar y mover tareas, pero no saltarse permisos, gates, límites de concurrencia ni el kill switch.
- **Calidad con evidencia.** Una tarea no llega a `DONE` por una afirmación del mismo agente que la ejecutó; requiere evidencia y revisión según su riesgo.
- **Portabilidad de proveedor.** La identidad del agente, el prompt, sus tools y el workflow no quedan acoplados al proveedor LLM.
- **Escala honesta.** Se optimiza para Sixteam y sus primeros engagements, no para una plataforma SaaS de mil empresas.

### Supuestos explícitos

Estos supuestos son **criterio de diseño propio** porque el brief no los define completamente:

- El MVP es single-workspace y está operado por personal autorizado de Sixteam. Se conserva `workspace_id` en el modelo para no cerrar la evolución, pero no se implementa aislamiento multi-tenant completo.
- El chat web del MVP requiere autenticación simple y puede ser usado por un miembro interno o por un participante invitado a un engagement. No habrá portal de autoservicio público. Si el runtime activo usa una suscripción personal de Claude Code, solo su titular puede disparar runs; para que otros usuarios los disparen se debe configurar Anthropic API o seats Team.
- Alex es el orquestador funcional porque el roster lo define como Estratega & Concierge IA. Su proveedor por defecto será Claude, pero esa asignación será configuración, no una regla del dominio.
- Se añade `qa-inspector`, un rol técnico nuevo y dedicado a pruebas/encontrar bugs, para cumplir el requisito explícito del brief. No se presenta como miembro del roster público existente y su nombre comercial queda por definir.
- “Preparar para ISO 9001” significa asistir en diagnóstico, trazabilidad y preparación documental; las conclusiones y la certificación final requieren profesionales y organismos competentes.
- Las credenciales disponibles determinan qué smoke tests reales pueden ejecutarse. La compatibilidad sin credenciales se verifica contra adaptadores y servidores simulados; no se declara validado en vivo un proveedor que no haya sido probado con su servicio real.

## Usuarios

| Usuario | Necesidad principal | Permisos del MVP |
|---|---|---|
| Solicitante | Pedir un resultado, aportar contexto y seguir su avance | Chat y lectura del engagement al que pertenece |
| Operador Sixteam | Crear engagements, priorizar trabajo, intervenir y resolver bloqueos | Chat, tablero, ejecución, cancelación y reintento |
| Consultor/aprobador humano | Validar diagnóstico, plan, cambios de riesgo y entregables | Lectura completa, comentarios y decisiones de gate |
| Administrador | Configurar agentes, prompts, proveedores, tools, límites y tablero | UI administrativa mínima y MCP con scopes explícitos |
| Agente orquestador | Convertir solicitudes en planes y handoffs durables | Crear/asignar tareas y operar dentro de su allowlist |
| Agente especialista | Ejecutar una capacidad de Consultoría, Implementación u Operación | Reclamar/mover sus tareas y usar solamente tools permitidas |
| Agente QA | Probar resultados, encontrar defectos y devolver trabajo con evidencia | Revisar tareas ajenas; no aprobar su propio trabajo ni gates humanos |

El roster inicial configurable es el canónico del brief: Alex y Sam en Consultoría; Debbie y Vinnie en Implementación; Sally y Clara en Operación; más `qa-inspector` como rol técnico nuevo. Samuel, Sebastián, Jorge, Jefferson y Ernesto pueden figurar como asignables humanos. Esto no implica que todos deban tener una cuenta activa en el primer demo.

## User stories del MVP

| ID | User story | Criterios de aceptación verificables |
|---|---|---|
| MVP-01 | Como operador, quiero crear un engagement y conversar dentro de él para que cada solicitud tenga contexto y propiedad claros. | Dado un usuario autenticado, puede crear un engagement con nombre, cliente, tipo (`ASSESSMENT`, `TRANSFORM` u `OPS`) y objetivo; al enviar un mensaje, este queda persistido una sola vez aunque se repita el request con la misma clave de idempotencia; al recargar, la conversación conserva orden y autor; un usuario sin acceso al engagement recibe `403`. |
| MVP-02 | Como solicitante, quiero que Alex convierta un encargo en trabajo visible, para no depender de una respuesta opaca de chat. | Ante una solicitud ejecutable, se crea una tarea padre enlazada al mensaje y al `root_run_id`; Alex puede crear subtareas con resultado esperado, responsable/capacidad requerida y dependencias; la respuesta del chat enlaza las tarjetas creadas; si falta información imprescindible, Alex crea una solicitud de aclaración y no inventa la respuesta. |
| MVP-03 | Como agente especialista, quiero reclamar y mover tareas compatibles para trabajar con autonomía controlada. | Solo una transacción puede reclamar una tarjeta `READY`; el agente debe estar activo, tener la capacidad requerida, cupo de concurrencia y dependencias resueltas; cada movimiento válido genera un `task_event` con actor, estado anterior/nuevo y `run_id`; una transición inválida retorna un error de dominio y no modifica la tarjeta. |
| MVP-04 | Como operador, quiero ver el kanban cambiar en vivo para entender qué está pasando sin refrescar la página. | Una transición confirmada en base de datos aparece en otro cliente conectado en ≤1 s p95 en entorno local; la tarjeta muestra responsable, estado, prioridad, engagement, último evento y gate/bloqueo; una desconexión y reconexión con cursor recupera los eventos faltantes sin duplicarlos. |
| MVP-05 | Como observador, quiero ver agentes y handoffs en vivo para distinguir actividad real de animación decorativa. | El mapa muestra los agentes por capa y sus estados `IDLE`, `RUNNING`, `WAITING_HUMAN`, `BLOCKED` u `OFFLINE`; una arista temporal solo aparece cuando existe un evento de handoff o tool call persistido; al seleccionarla se abre el `run_id`, tarea y timestamp que la sustentan; terminada la actividad, queda en el historial aunque cese la animación. |
| MVP-06 | Como aprobador, quiero detener acciones de riesgo y aceptar o rechazar con contexto para conservar control humano. | Una tarea con gate pendiente no puede ejecutar la tool protegida ni llegar a `DONE`; la solicitud muestra acción propuesta, argumentos redactados, riesgo, evidencia y solicitante; solo un miembro con scope `human:approve` puede aprobar/rechazar; la decisión queda en auditoría y el rechazo devuelve la tarea a `BLOCKED` o `READY` con motivo explícito. |
| MVP-07 | Como administrador, quiero asignar distintos proveedores/modelos a los agentes para evitar lock-in. | La Agent Card permite elegir `claude_subscription`, `anthropic_api`, `openai` u `openai_compatible` y un modelo; Kimi, MiniMax y GLM existen como presets de `openai_compatible`; cambiar la asignación no requiere modificar UI, schema de tools ni lógica del kanban; pasan los mismos contract tests con el proveedor simulado y al menos un smoke test real con las credenciales que estén disponibles. |
| MVP-08 | Como administrador externo a la UI, quiero editar casi toda la operación mediante MCP para automatizarla de forma segura. | Un cliente MCP autenticado puede consultar y mutar engagements, Agent Cards, prompts versionados, tareas, asignaciones, estados, proveedores, servidores MCP y límites según sus scopes; toda mutación exige `idempotency_key`, registra actor y motivo, y las escrituras con versión incorrecta fallan con conflicto; no existe tool para leer secretos en claro, borrar auditoría/historial o desactivar gates sin scope humano de seguridad. |
| MVP-09 | Como responsable de calidad, quiero que un agente distinto pruebe el trabajo para encontrar fallas antes de cerrarlo. | Toda tarea marcada `requires_qa=true` pasa de `IN_PROGRESS` a `REVIEW`; el revisor no puede ser el mismo `agent_id` ejecutor; QA adjunta checklist/evidencia y decide `PASS` o `CHANGES_REQUESTED`; `CHANGES_REQUESTED` retorna a `READY` con defecto reproducible; `PASS` conduce a `DONE` o al gate humano aplicable. |
| MVP-10 | Como operador, quiero reconstruir y detener una ejecución para diagnosticar fallas y limitar daño/coste. | El detalle de una ejecución muestra `run_id`, `root_run_id`, `parent_run_id`, agente, proveedor/modelo, timestamps, tokens si el proveedor los entrega, tool calls redactadas, cambios de tarea y error; activar el kill switch impide iniciar nuevos runs y solicita cancelación de los activos en ≤2 s local; reintentar crea un nuevo `run_id` enlazado al anterior y no sobrescribe el historial. |

## User stories de fase 2

| ID | User story | Resultado esperado |
|---|---|---|
| F2-01 | Como participante de un cliente, quiero realizar entrevistas guiadas para alimentar un Assessment. | Flujos de kickoff, entrevistas, mapa de procesos, análisis de fugas y roadmap de 14 días, conservando fuente y aprobación humana. |
| F2-02 | Como consultor, quiero gestionar controles y evidencias de preparación ISO 9001. | Matrices, hallazgos, responsables y trazabilidad documental, con disclaimers y firma profesional; no se automatiza la certificación. |
| F2-03 | Como solicitante, quiero conversar por WhatsApp sin crear un workflow separado. | Adaptador WhatsApp que usa el mismo servicio de conversaciones, identidad, tareas, gates y auditoría que la web. |
| F2-04 | Como operador, quiero sugerencias de automatizaciones recurrentes. | Cron consent-first inspirado en Hermes: sugerir, deduplicar y mantener máximo cinco pendientes; nunca crear la automatización sin confirmación. Puede soportar después la cadencia publicada de sprint semanal y reporte de lunes 9 a. m. |
| F2-05 | Como administrador, quiero migrar a Supabase cuando aumenten usuarios o despliegues. | PostgreSQL con migración verificable, backups y RLS multi-tenant antes de habilitar más de un workspace. |
| F2-06 | Como administrador, quiero que el sistema proponga mejoras a prompts/skills. | Review post-turno y curación periódica con tools restringidas, diff revisable, archivo en lugar de borrado y publicación humana. |
| F2-07 | Como equipo, quiero una biblioteca amplia de capacidades Sixteam. | Incorporación gradual y versionada de la taxonomía de ~50 actividades de Marketing, Sales, Service y Reporting Ops mencionada en el brief. |
| F2-08 | Como usuario, quiero interfaces generativas para artefactos complejos. | Evaluar un adaptador AG-UI/CopilotKit después de estabilizar eventos, permisos y estados; no reemplazar el dominio por estado de frontend. |
| F2-09 | Como operador, quiero integraciones reales con CRM, documentos, repositorios y despliegue. | Servidores MCP aislados por dominio, credenciales por vault, scopes mínimos, sandbox y gates según riesgo. |

## Requisitos no funcionales (NFRs)

| ID | Requisito | Verificación del MVP |
|---|---|---|
| NFR-01 Seguridad | Autenticación obligatoria; RBAC `viewer/operator/approver/admin`; scopes separados para MCP; deny-by-default para tools y servidores MCP. | Tests de autorización por endpoint/tool y prueba negativa de acceso cruzado entre engagements. |
| NFR-02 Secretos | Tokens y API keys se leen desde variables/secret store mediante una referencia; nunca se retornan, persisten en mensajes o incluyen en logs. | Búsqueda automatizada de patrones sensibles en DB/logs de la prueba; respuestas de configuración solo muestran `configured: true/false`. |
| NFR-03 Integridad | Transiciones, reclamos, approvals y outbox son transaccionales, versionados e idempotentes. | Tests concurrentes prueban un único ganador al reclamar y cero tarjetas perdidas/duplicadas. |
| NFR-04 Recuperación | Un run caído no deja una tarjeta tomada indefinidamente; leases vencidos se recuperan de forma segura. | Terminar forzosamente el worker, vencer el lease y comprobar que la tarea vuelve a `READY` o `BLOCKED` con evento de recuperación. |
| NFR-05 Rendimiento local | Eventos de tablero/agente visibles en ≤1 s p95; interacción UI sin bloqueo con 100 tarjetas y 10 ejecuciones históricas por tarjeta. | Prueba automatizada local con timestamps servidor/cliente. La latencia del primer token externo se reporta, pero no se promete porque depende del proveedor. |
| NFR-06 Límites | Máximo configurable por agente y global de ejecuciones, pasos, tokens estimados y duración; defecto MVP: 2 procesos Claude y 4 runs totales. | Tests demuestran que el quinto run queda en cola y que exceder pasos/tiempo termina con estado explícito. |
| NFR-07 Observabilidad | El 100% de runs y tool calls tienen IDs correlacionables y eventos ordenados; payloads sensibles se redactan. | Invariante en DB y prueba de reconstrucción de un flujo chat → orquestador → especialista → QA → aprobación. |
| NFR-08 Auditoría | La historia de configuración y operaciones administrativas es append-only desde la aplicación; no hay hard delete en MCP. | Editar prompt, mover tarea y cambiar proveedor produce revisiones/auditoría con actor, motivo y before/after redactado. |
| NFR-09 Portabilidad | El dominio no importa SDKs de proveedor; los adaptadores cumplen un contrato común de streaming, tools, cancelación y uso. | Regla de dependencias/lint y contract suite común para Claude y OpenAI-compatible. |
| NFR-10 Compatibilidad | Desarrollo y demo reproducibles en Windows 11 con Node LTS y un único comando por proceso. | Setup limpio, migraciones y smoke test documentados en Windows. El despliegue VPS no forma parte del MVP. |
| NFR-11 Privacidad | Los datos quedan acotados al engagement; adjuntos se referencian, no se copian sin necesidad; exportación y retención quedan preparadas. | Tests de filtros por engagement y redacción de eventos/tool results. |
| NFR-12 Accesibilidad | Chat, kanban, gates y detalle de run son operables con teclado y no dependen solo de color. | Smoke manual de navegación por teclado y etiquetas accesibles en acciones críticas. |

## Fuera de alcance

- Certificar organizaciones en ISO 9001, emitir conceptos legales o reemplazar al auditor/certificador humano.
- Multi-tenant SaaS, facturación, marketplace de agentes, SSO empresarial o administración de miles de usuarios.
- WhatsApp, Slack, voz, email y procesamiento avanzado de medios en el MVP; solo se entrega su contrato de gateway.
- Despliegue productivo en el VPS actual, alta disponibilidad, Kubernetes, Redis, colas distribuidas o autoscaling.
- Editor visual de workflows, A2A libre entre agentes o un canvas que permita alterar reglas de dominio arrastrando nodos.
- Ejecución autónoma sin gates sobre producción, compras, borrados, mensajes externos o cambios masivos.
- Conectar de una vez las ~50 actividades/integraciones del catálogo Sixteam; se prueba un flujo vertical con tools controladas.
- Fine-tuning, entrenamiento de modelos, memoria autoeditable sin revisión, cron autónomo y agentes persistentes 24/7 reales.
- Garantizar compatibilidad en vivo con proveedores para los que no se hayan aportado credenciales; sí se entregan presets y contract tests.

# 2. Arquitectura

## Decisión rectora

La arquitectura será un **monolito modular TypeScript con tres procesos desplegables** —web/API, worker y MCP admin—, una base SQLite compartida y paquetes de dominio comunes. No habrá microservicios, broker ni Redis. El sistema se separa por responsabilidades y contratos, no por infraestructura.

Esta es una **decisión propia de diseño** apoyada en dos datos del brief: la escala inicial es una empresa con pocos engagements y el desarrollo ocurre en Windows 11. También preserva los patrones portables señalados en Charlie, Hermes y el plan previo: Agent Cards declarativas, tools tipadas, handoffs como tareas, máquina de estados, gateway por adaptadores y trazabilidad padre/hijo.

El flujo principal es:

```text
Web propia ──HTTP/SSE──> API de aplicación ──comandos──> Dominio ──transacción──> SQLite WAL
      ^                         ^                                  |
      |                         |                                  v
      └──── eventos con cursor ─┘                            outbox/eventos
                                                                   |
MCP admin ──tools tipadas──────> mismos servicios de dominio <── Worker
                                                                   |
                                      AgentRuntime común ──────────┼── Claude Agent SDK
                                                                   └── Vercel AI SDK
```

## Componentes del sistema

| Componente | Responsabilidad | Decisión concreta |
|---|---|---|
| Web/API | Chat, kanban, mapa de agentes, gates, detalle de runs y endpoints de comandos/consulta | Next.js + React; Server-Sent Events (SSE) con cursor para streaming y actualizaciones, no WebSockets en MVP |
| Dominio | Engagements, tareas, máquina de estados, asignación, gates, Agent Cards y políticas | TypeScript puro + schemas Zod; es la única vía autorizada para mutar estado operativo |
| Worker | Consume outbox/cola, reclama tareas, inicia/cancela runs, aplica límites y recupera leases | Proceso Node único en MVP; polling transaccional corto, sin broker externo |
| Runtime de agentes | Contrato común de mensajes, tools, streaming, uso, cancelación y errores | Híbrido: adaptador Claude Agent SDK + adaptadores Vercel AI SDK |
| Tool broker | Publica a cada run solo las tools permitidas y traduce llamadas a servicios/MCP externos | Allowlist por Agent Card, clasificación de riesgo, redacción centralizada y namespace `mcp__servidor__tool` para evitar colisiones |
| MCP admin | Control externo potente sobre configuración y operación | Servidor MCP separado; stdio para desarrollo y Streamable HTTP autenticado, ligado a localhost por defecto |
| Persistencia | Estado durable, auditoría, cola y eventos | SQLite con WAL, foreign keys, migraciones y transacciones; Drizzle ORM + `better-sqlite3` |
| Event stream | Alimenta UI en vivo y reconstruye actividad | `run_events` y `task_events` append-only; SSE lee por secuencia/cursor |
| Gateway | Normaliza canales sin contaminar el dominio | Adaptador web inicial y contrato estable para WhatsApp posterior |

## Decisiones de arquitectura obligatorias

### (a) Runtime de agentes: híbrido con orquestación durable propia

**Elección: híbrido.** Claude Agent SDK se usa como ejecutor para `claude_subscription` y `anthropic_api`; un loop acotado sobre Vercel AI SDK se usa para OpenAI, Kimi, MiniMax, GLM y otros endpoints OpenAI-compatible. La cola, los handoffs, los gates, los límites y la máquina de estados pertenecen a AgentOS, no a ninguno de los dos SDKs.

Justificación:

- El brief confirma que Claude Agent SDK soporta subagentes, tools, MCP y autenticación de Claude Code, pero cada `query()` lanza un proceso hijo. Aprovecharlo permite usar la suscripción disponible sin reimplementar ese transporte; el semáforo de concurrencia evita saturar Windows.
- El brief recomienda Vercel AI SDK para proveedores OpenAI-compatible. Un runner propio sobre `streamText`/tool-calling normaliza esos proveedores sin introducir OpenRouter ni sus costes/latencia.
- Hacer de Claude Agent SDK el runtime único impediría cumplir de manera limpia la portabilidad solicitada. Hacer solo un loop Vercel perdería el camino soportado para la suscripción de Claude Code. El híbrido resuelve ambas condiciones con una frontera común.
- Los subagentes operativos no serán conversaciones ocultas dentro de un run: el handoff canónico crea una tarea hija y, al ejecutarse, un nuevo `run_id` con `parent_run_id`. Se podrá usar capacidad interna del SDK únicamente como implementación local y sin sustituir esa evidencia durable.

Contrato mínimo:

```ts
interface AgentRuntime {
  execute(input: RunInput, signal: AbortSignal): AsyncIterable<RuntimeEvent>;
  validate(config: ProviderConfig): Promise<CapabilityReport>;
}
```

`RunInput` contiene Agent Card versionada, mensajes, tool schemas ya filtradas, presupuesto y contexto de trazabilidad. `RuntimeEvent` normaliza deltas, uso, tool calls, resultados y terminación. El loop Vercel tiene máximo de pasos, duración y presupuesto; ninguna finalización textual puede mutar una tarea sin invocar una tool de dominio.

El prompt efectivo se compila con el patrón de tres capas descrito en Hermes: **stable** (identidad, principios y guías de tools), **context** (engagement, políticas y rol) y **volatile** (tarea, memoria recuperada, usuario y timestamp). Ese orden preserva oportunidades de prefix cache. El run registra la revisión de Agent Card y los hashes de cada capa para reproducibilidad; el contenido sensible sigue las reglas de redacción y acceso del engagement.

El token de suscripción Claude se admite solo para el usuario/seat al que pertenece. Según el caveat del brief, un único seat personal no se comparte como backend multiusuario: el gateway comprueba `triggered_by_member_id` y rechaza el arranque si no es el titular configurado. Al abrir el servicio al equipo se cambia esa configuración a Anthropic Console o seats Team, sin cambiar el dominio.

### (b) CopilotKit completo vs. UI propia ligera

**Elección: UI propia ligera.** El MVP implementará chat, kanban, mapa de agentes y panel de ejecución directamente en React, consumiendo un stream de eventos AgentOS por SSE. No se instalará el runtime completo de CopilotKit.

Esta es una **decisión propia de diseño**. El brief acredita que CopilotKit/AG-UI ofrecen chat, state streaming, generative UI y human-in-the-loop, pero el MVP necesita cuatro superficies muy específicas y una máquina de estados que vive en backend. Adoptar el runtime completo añadiría otro centro de estado antes de estabilizar el contrato del dominio. Se conservará una taxonomía de eventos cercana a AG-UI y se podrá construir un adaptador posterior; no se afirmará compatibilidad AG-UI hasta pasar sus contract tests.

La visualización inicial es deliberadamente un mapa por capas con actividad, no un editor de flujo: Consultoría → Implementación → Operación, con agentes, estado y aristas temporales respaldadas por eventos. El kanban permite drag-and-drop humano, pero esa acción llama al mismo `TaskService.transition` que usan los agentes.

### (c) SQLite vs. Supabase el día 1

**Elección: SQLite el día 1.** Se usará SQLite local con WAL, `foreign_keys=ON`, `busy_timeout`, migraciones y backups consistentes. Las escrituras operativas pasan por transacciones cortas; el worker es el principal escritor asíncrono.

La elección está alineada con la restricción explícita del brief: una empresa, pocos engagements y preferencia inicial por SQLite. También reutiliza el patrón probado en Hermes sin imponer infraestructura remota. Supabase/Postgres se activa cuando ocurra cualquiera de estos disparadores: más de una instancia de worker, necesidad real de RLS multi-tenant, acceso remoto concurrente sostenido, backups administrados o contención medible que incumpla los NFR. Desde el inicio se evitan peculiaridades no migrables, se usan IDs UUIDv7 y se mantienen migraciones SQL/ORM para facilitar el cambio.

## Modelo de datos

Los campos JSON se guardan como `TEXT` validado con Zod. Las credenciales no se guardan en estas tablas: solo referencias a variables o a un secret store.

| Tabla | Columnas clave | Propósito/invariantes |
|---|---|---|
| `workspaces` | `id`, `name`, `status`, `created_at` | Una fila activa en MVP; raíz futura de aislamiento |
| `members` | `id`, `workspace_id`, `email`, `display_name`, `role`, `status` | Roles `viewer/operator/approver/admin`; email único por workspace |
| `engagements` | `id`, `workspace_id`, `client_name`, `name`, `service_type`, `objective`, `status`, `owner_member_id`, `created_at` | Contenedor de conversación, trabajo y acceso |
| `engagement_members` | `engagement_id`, `member_id`, `access_role` | Autoriza el acceso de invitados/miembros al engagement |
| `agents` | `id`, `workspace_id`, `slug`, `display_name`, `layer`, `status`, `provider_config_id`, `model`, `capabilities_json`, `tool_allowlist_json`, `mcp_allowlist_json`, `limits_json`, `current_revision_id`, `version` | Agent Card declarativa; `slug` único; optimistic locking |
| `agent_revisions` | `id`, `agent_id`, `revision`, `system_prompt`, `config_snapshot_json`, `created_by`, `reason`, `created_at` | Historial inmutable y rollback de prompts/configuración |
| `provider_configs` | `id`, `workspace_id`, `kind`, `name`, `base_url`, `credential_ref`, `options_json`, `enabled`, `version` | `kind`: Claude subscription/API, OpenAI o compatible; nunca contiene secreto |
| `mcp_servers` | `id`, `workspace_id`, `name`, `transport`, `endpoint_or_command`, `credential_ref`, `enabled`, `risk_class`, `version` | Catálogo administrable; acceso efectivo depende de allowlist y scopes |
| `conversations` | `id`, `engagement_id`, `channel`, `external_account_id`, `external_thread_id`, `status`, `created_at` | Un hilo canónico independiente del canal |
| `messages` | `id`, `conversation_id`, `run_id`, `external_message_id`, `idempotency_key`, `role`, `actor_type`, `actor_id`, `content_json`, `created_at` | Unicidad por canal/id externo o idempotency key; contenido multimodal normalizado |
| `tasks` | `id`, `engagement_id`, `parent_task_id`, `source_message_id`, `title`, `description`, `state`, `priority`, `required_capabilities_json`, `assigned_agent_id`, `assigned_member_id`, `requires_qa`, `risk_class`, `gate_policy`, `lease_run_id`, `lease_expires_at`, `version`, `created_at`, `updated_at` | Tarjeta canónica; un solo asignado activo; estado solo cambia por servicio de dominio |
| `task_dependencies` | `task_id`, `depends_on_task_id`, `kind` | Impide pasar a `READY` si una dependencia obligatoria no está `DONE` |
| `task_events` | `id`, `task_id`, `sequence`, `run_id`, `actor_type`, `actor_id`, `event_type`, `from_state`, `to_state`, `payload_redacted_json`, `created_at` | Log append-only; secuencia única por tarea |
| `approvals` | `id`, `task_id`, `run_id`, `gate_type`, `stage`, `requested_by_actor`, `action_digest`, `arguments_redacted_json`, `status`, `decided_by_member_id`, `decision_reason`, `created_at`, `decided_at` | Solo un humano con scope decide; conserva exactamente qué se aprobó |
| `runs` | `id`, `root_run_id`, `parent_run_id`, `caused_by_event_id`, `task_id`, `agent_id`, `agent_revision_id`, `provider_config_id`, `model`, `status`, `attempt`, `started_at`, `ended_at`, `input_tokens`, `output_tokens`, `cost_usd`, `error_code` | Unidad de ejecución; nunca se reutiliza un ID en reintentos |
| `run_events` | `id`, `run_id`, `sequence`, `event_type`, `actor_agent_id`, `task_id`, `payload_redacted_json`, `created_at` | Stream append-only y cursor de UI; orden único por run |
| `tool_calls` | `id`, `run_id`, `sequence`, `server_name`, `tool_name`, `arguments_digest`, `arguments_redacted_json`, `result_redacted_json`, `risk_class`, `status`, `duration_ms`, `started_at`, `ended_at` | Auditoría de tools sin secretos; enlaza efectos con ejecución |
| `artifacts` | `id`, `engagement_id`, `task_id`, `run_id`, `kind`, `uri`, `content_digest`, `metadata_json`, `created_at` | Evidencia/deliverables referenciados, no blobs duplicados por defecto |
| `outbox` | `id`, `topic`, `aggregate_type`, `aggregate_id`, `payload_json`, `available_at`, `claimed_by`, `lease_expires_at`, `attempts`, `processed_at` | Cola durable y transaccional para worker/eventos |
| `audit_log` | `id`, `workspace_id`, `actor_type`, `actor_id`, `action`, `target_type`, `target_id`, `reason`, `before_redacted_json`, `after_redacted_json`, `created_at` | Cambios administrativos append-only; no hay tool MCP de borrado |

En fase 2 se pueden añadir FTS5 para mensajes —patrón señalado en Hermes— y tablas específicas de canales/identidades. No se requiere FTS para demostrar el flujo vertical del MVP.

## Kanban movido por agentes

### Estados canónicos

| Estado | Significado | Salidas normales |
|---|---|---|
| `BACKLOG` | Capturado, todavía no ejecutable o no priorizado | `READY`, `CANCELLED` |
| `READY` | Definición suficiente, dependencias y gates previos resueltos | `IN_PROGRESS`, `BLOCKED`, `CANCELLED` |
| `IN_PROGRESS` | Reclamado mediante lease por un agente o humano | `REVIEW`, `WAITING_HUMAN`, `BLOCKED` |
| `REVIEW` | Resultado producido; espera QA independiente | `READY`, `WAITING_HUMAN`, `DONE` |
| `WAITING_HUMAN` | Existe una aprobación/clarificación pendiente | `READY`, `DONE`, `BLOCKED`, `CANCELLED` |
| `BLOCKED` | Tiene impedimento explícito y responsable de desbloqueo | `READY`, `CANCELLED` |
| `DONE` | Resultado aceptado y evidencia requerida completa | `READY` solo por reapertura humana/admin |
| `CANCELLED` | Trabajo cancelado conservando historia | Terminal; clon/reintento crea nueva tarea |

Las columnas visuales pueden renombrarse, ocultarse o reordenarse, pero sus claves semánticas y transiciones no son editables libremente por prompt. Esa separación hace que “editar casi todo” no equivalga a romper invariantes.

### Asignación y movimiento

1. Alex o un operador crea la tarea con resultado esperado, capacidad requerida, riesgo, QA y dependencias. Los especialistas también pueden crear tareas hijas mediante `task.create`, quedando el handoff explícito.
2. El worker selecciona `READY` por prioridad y antigüedad. En una sola transacción verifica dependencias, agente activo, coincidencia de capacidades, allowlists, presupuesto y `max_concurrent_runs`; asigna lease y mueve a `IN_PROGRESS`.
3. El agente solo puede mover una tarea asignada a él y a través de tools de dominio. Alex puede asignar/repriorizar; QA puede devolver o validar; ningún agente decide un gate humano.
4. Para terminar ejecución, el agente adjunta resumen, evidencia o artifact y mueve a `REVIEW`. Si `requires_qa=false` y el riesgo es bajo, una política puede permitir `DONE`, pero el flujo demo usará QA.
5. QA no puede revisar su propio run. `CHANGES_REQUESTED` genera defectos reproducibles y devuelve a `READY`; `PASS` conduce a `DONE` o al gate final.
6. Cada transición usa `expected_version`. Un conflicto obliga a releer; no se aplica last-write-wins.
7. Heartbeat renueva el lease. Al vencer, un recovery job marca el run como `ABANDONED` y devuelve la tarea a `READY` o `BLOCKED` según el número de intentos.

### Gates humanos

- **G1 — `PLAN_APPROVAL`.** Después de diagnóstico/roadmap y antes de iniciar construcción o tocar un entorno del cliente. Aprueba alcance, supuestos, responsable y límites; generaliza el patrón de gates del blueprint Charlie al ciclo Sixteam.
- **G2 — `EXTERNAL_EFFECT_OR_RELEASE`.** Antes de despliegue, compra, borrado, cambio masivo, comunicación externa, modificación de sistema de cliente o liberación de un entregable sensible. La aprobación se liga al digest de la acción: cambiar argumentos invalida la aprobación.

Las tools se clasifican `READ`, `REVERSIBLE_WRITE`, `EXTERNAL_EFFECT` o `DESTRUCTIVE`. Las dos últimas requieren G2. Opt-outs y restricciones legales/comerciales se modelan como políticas irreversibles o solo relajables por administrador humano, en línea con el guardrail citado en Charlie. El kill switch prevalece sobre cualquier aprobación.

## MCP de administración

El MCP usa los mismos servicios de aplicación que la UI; no escribe tablas directamente. Tendrá los siguientes tools tipados:

| Namespace | Tools |
|---|---|
| Workspace/acceso | `workspace.get`, `workspace.update`, `member.list`, `member.invite`, `member.update_role`, `engagement_access.set` |
| Engagements | `engagement.list`, `engagement.get`, `engagement.create`, `engagement.update`, `engagement.archive` |
| Agentes/prompts | `agent.list`, `agent.get`, `agent.create`, `agent.update_card`, `agent.publish_prompt`, `agent.rollback_revision`, `agent.set_status`, `agent.set_limits` |
| Tareas/tablero | `task.list`, `task.get`, `task.create`, `task.update`, `task.assign`, `task.transition`, `task.retry`, `task.cancel`, `board.get`, `board.configure_view` |
| Gates | `approval.list`, `approval.request`, `approval.decide` |
| Conversaciones | `conversation.list`, `conversation.get`, `conversation.post_message` |
| Runs/artefactos | `run.list`, `run.get`, `run.cancel`, `run.retry`, `artifact.list`, `artifact.get`, `artifact.register` |
| Proveedores | `provider.list`, `provider.upsert`, `provider.test`, `provider.set_enabled` |
| MCP/tools | `mcp_server.list`, `mcp_server.upsert`, `mcp_server.test`, `mcp_server.set_enabled`, `tool_catalog.list`, `agent_tool_allowlist.set` |
| Operación/auditoría | `system.status`, `system.kill_switch.set`, `events.tail`, `audit.search` |

Reglas de seguridad:

- Mutaciones aceptan `idempotency_key`, `reason` y, cuando hay edición, `expected_version`; las de riesgo soportan `dry_run`.
- `approval.decide` requiere identidad humana y scope `human:approve`; una credencial de agente nunca lo recibe.
- No existen `secret.get`, hard delete de runs/eventos/auditoría ni escritura SQL arbitraria.
- Cambiar gates globales, allowlists de alto riesgo, endpoints o kill switch requiere `security:admin` y genera auditoría reforzada.
- En MVP, Streamable HTTP escucha en `127.0.0.1` y exige token con scopes; exposición pública requiere HTTPS, rotación de tokens y revisión aparte. Stdio permite clientes locales.

Así, “editar casi todo” cubre configuración y operación, pero no permite editar evidencia histórica, extraer secretos o evadir la autoridad humana.

## Observabilidad con `run_id`/`parent_run_id`

- Cada ejecución recibe un UUIDv7 `run_id` nuevo. El primer run de una solicitud usa `root_run_id = run_id` y `parent_run_id = null`.
- Un run disparado por una delegación usa el mismo `root_run_id` y `parent_run_id` igual al run que creó/activó la tarea. Un reintento también es un nuevo run y referencia el intento que lo causó.
- `caused_by_event_id`, `task_id`, `agent_id` y `agent_revision_id` fijan causalidad, objeto, ejecutor y prompt exacto.
- Los eventos normalizados mínimos son `run.started`, `llm.delta`, `tool.started`, `tool.succeeded`, `tool.failed`, `task.created`, `task.assigned`, `task.state_changed`, `handoff.created`, `approval.requested`, `approval.resolved`, `run.completed`, `run.failed` y `run.cancelled`.
- `sequence` ordena eventos dentro del run; el `id` global sirve de cursor SSE. La UI reanuda con `Last-Event-ID` y deduplica por ID.
- Tool arguments/results pasan por redacción antes de persistir. El digest no redactado permite verificar que la acción aprobada coincide sin revelar el secreto.
- Se guardan tokens/coste solo si el proveedor los entrega; `null` significa no reportado, nunca cero inferido.
- El esquema es compatible conceptualmente con spans GenAI de OpenTelemetry, pero **no se adopta OTel en el MVP**. Esta decisión propia evita instrumentación prematura sin cerrar una exportación posterior.

## Layout del monorepo

```text
agentos/
  apps/
    web/                 # Next.js: UI, API y SSE
    worker/              # scheduler, leases, recovery y ejecuciones
    mcp-admin/           # servidor MCP stdio + Streamable HTTP
  packages/
    contracts/           # Zod: comandos, eventos, tools y gateway
    core/                # entidades, políticas, máquina de estados, RBAC
    db/                  # Drizzle, SQLite, migraciones, repositorios
    agent-runtime/       # interfaz + adaptadores Claude/Vercel/mock
    tool-broker/         # allowlists, riesgo, MCP clients, redacción
    gateway/             # core de conversaciones + ChannelAdapter web
    observability/       # ids, eventos, correlación, scrubbing
  tests/
    contract/            # providers, MCP y gateway
    integration/         # DB, cola, kanban, gates y recovery
    e2e/                 # chat → agentes → QA → aprobación
  docs/
```

Se usará `pnpm` workspaces sin Turborepo en el MVP. Las dependencias apuntan hacia `contracts/core`; `core` no importa Next.js, SQLite ni SDKs LLM.

## Contrato del gateway para WhatsApp futuro

El core recibe y emite envelopes canónicos; nunca procesa payloads específicos de Meta/WhatsApp. El contrato inicial será:

```ts
type ContentPart =
  | { type: "text"; text: string }
  | { type: "media_ref"; uri: string; mimeType: string; name?: string };

type InboundEnvelope = {
  channel: "web" | "whatsapp" | string;
  externalAccountId: string;
  externalThreadId: string;
  externalMessageId: string;
  sender: { externalId: string; displayName?: string };
  parts: ContentPart[];
  receivedAt: string;
  idempotencyKey: string;
  metadata: Record<string, unknown>;
};

type OutboundEnvelope = {
  conversationId: string;
  replyToMessageId?: string;
  parts: ContentPart[];
  mode: "draft" | "final";
  idempotencyKey: string;
};

interface ChannelAdapter {
  readonly channel: string;
  capabilities(): {
    tokenStreaming: boolean;
    drafts: boolean;
    typing: boolean;
    media: boolean;
  };
  verifyInbound(raw: unknown, headers: Headers): Promise<void>;
  normalizeInbound(raw: unknown): Promise<InboundEnvelope[]>;
  send(message: OutboundEnvelope): Promise<{ externalMessageId: string }>;
  setTyping(externalThreadId: string, active: boolean): Promise<void>;
  acknowledge(externalMessageId: string): Promise<void>;
}
```

La unicidad `(channel, external_account_id, external_message_id)` evita webhooks duplicados. El servicio resuelve el envelope a una conversación/engagement antes de llamar al orquestador. Si un canal no soporta tokens o borradores —como puede ocurrir con WhatsApp— acumula la respuesta y envía `final`; esa limitación no altera runs, tareas ni mensajes canónicos. Autenticación de webhook, consentimiento/opt-out, ventanas de mensajería y plantillas pertenecen al adaptador WhatsApp y a sus políticas, no al prompt del agente.

# 3. Plan MVP

El plan está dimensionado para **aproximadamente 24–28 horas de trabajo agéntico**, ejecutables en 2–3 días con validaciones frecuentes. El objetivo es un único slice demostrable; cada tarea deja tests o evidencia antes de ampliar superficie.

1. **Congelar contratos y escenarios de aceptación (1 h).** Definir enums, schemas Zod, RBAC, eventos, `AgentRuntime`, tools de dominio y fixture del recorrido demo.
2. **Scaffold del workspace y procesos (1 h).** Crear `pnpm` workspace, apps web/worker/MCP y paquetes con límites de importación; comandos Windows reproducibles.
3. **Persistencia y migraciones SQLite (2.5 h).** Implementar tablas MVP, WAL, repositorios, UUIDv7, idempotencia y seeds del workspace, roster canónico y `qa-inspector`.
4. **Dominio de kanban y gates (2.5 h).** Máquina de estados, dependencies, optimistic locking, asignación atómica, leases, G1/G2, auditoría y tests concurrentes.
5. **Runtime común y proveedor mock (1.5 h).** Normalizar eventos, cancelación, límites, tool calls y contract suite determinista sin consumir tokens.
6. **Adaptadores LLM (3 h).** Claude Agent SDK con semáforo de procesos; Vercel AI SDK con OpenAI y factory OpenAI-compatible; presets Kimi/MiniMax/GLM; smoke real solo con credenciales disponibles.
7. **Worker y orquestación durable (3 h).** Outbox, polling, recovery de leases, Alex → especialista → QA, handoffs por tareas y kill switch.
8. **API, chat y SSE (2 h).** Autenticación mínima, engagement/conversation commands, stream con cursor, reanudación y redacción.
9. **UI operativa (4 h).** Chat con streaming, kanban, mapa por capas basado en eventos, panel de run y bandeja de approvals; teclado y estados de error.
10. **MCP admin (2.5 h).** Tools prioritarias de Agent Cards, prompts, tareas, approvals, providers, runs, status y kill switch; scopes, versionado e idempotencia. Las tools no esenciales del catálogo pueden existir como lectura o devolver `not_implemented` solo si están fuera del contrato publicado del MVP.
11. **E2E y fallas inducidas (2.5 h).** Recorrido completo con mock; conflicto de claim, rechazo de gate, tool denegada, caída/recovery del worker, cancelación y reconexión SSE.
12. **Smoke real y handoff (1 h).** Probar el proveedor disponible, verificar que no haya secretos en DB/logs, capturar evidencia y documentar ejecución local y limitaciones.

### Corte explícito para caber en 2–3 días

- Solo un workspace y autenticación mínima; no RLS multi-tenant, SSO ni gestión completa de invitaciones.
- SQLite local; no Supabase, deploy, Docker productivo, VPS, Redis ni alta disponibilidad.
- Web como único canal; el gateway queda contratado y probado con adaptador fake, sin WhatsApp real.
- UI propia con cuatro superficies; no CopilotKit, AG-UI certificado, generative UI ni editor de workflows.
- Un flujo vertical de ejemplo y un set pequeño de tools de dominio; no catálogo completo de 50 actividades ni integraciones CRM/documentales reales.
- Prompts/Agent Cards iniciales suficientes para orquestar, ejecutar y probar; no biblioteca completa de metodologías Sixteam ni corpus ISO 9001.
- Claude y un endpoint OpenAI-compatible se validan en vivo solo si existen credenciales; los demás presets pasan contract tests simulados.
- Sin cron, auto-mejora, memoria curada automática, FTS, voz, multimedia avanzada, analítica financiera ni agentes 24/7 productivos.
- El mapa representa eventos reales recientes; no hay simulación espacial, avatares complejos ni reproducción cinematográfica.
- El MCP cubre administración prioritaria; no expone SQL, secretos, hard delete ni modificación libre de invariantes/gates.

# 4. Riesgos top 5

| # | Riesgo | Mitigación concreta |
|---|---|---|
| 1 | **El MCP “editar casi todo” o una tool de agente se convierte en vía de escalamiento o daño.** | Una única capa de servicios de dominio, RBAC/scopes, allowlists deny-by-default, clasificación de riesgo, `expected_version`, idempotencia, `dry_run`, G2 ligado al digest exacto, auditoría append-only y kill switch. MCP HTTP escucha en localhost por defecto; no hay secretos legibles, SQL arbitrario ni hard delete. Tests negativos intentan aprobar con identidad de agente y usar tools fuera de allowlist. |
| 2 | **La suscripción personal de Claude se usa fuera de sus términos o los procesos hijos saturan el host.** | `claude_subscription` se restringe al titular/seat durante el MVP y se muestra un warning operativo; para uso multiusuario se exige Anthropic API o seats Team. Semáforo por defecto de dos procesos Claude, límites globales, timeout/cancelación, métricas de RAM/latencia y fallback configurable a otro proveedor. No se presupone que el VPS actual soporte la carga. |
| 3 | **Un agente alucina un diagnóstico, una recomendación ISO o la terminación de trabajo sensible.** | Prompts separan hechos, supuestos y evidencia; artefactos conservan fuente/digest; QA independiente y criterios reproducibles; G1 valida diagnóstico/plan y G2 valida efectos/entrega. La UI identifica ISO 9001 como preparación asistida, no certificación. Tool results y entregables de alto riesgo requieren revisión humana, no autoevaluación del mismo run. |
| 4 | **Carreras, caídas o reintentos dejan tarjetas duplicadas, atascadas o con estado distinto al trabajo real.** | Toda transición/reclamo ocurre en una transacción SQLite con optimistic locking; outbox e idempotency keys evitan pérdida/duplicado; leases y heartbeat permiten recovery; un solo writer worker reduce contención; WAL, backups y pruebas de crash/concurrencia verifican invariantes. Al superar los umbrales definidos se migra a Supabase/Postgres, no antes. |
| 5 | **La matriz de proveedores y la ambición visual/operativa hacen imposible un MVP fiable en 2–3 días.** | Mantener un `AgentRuntime` mínimo y una contract suite común; validar en vivo solo proveedores con credenciales y marcar los demás como presets no verificados; usar UI propia, SSE, un único flujo vertical y mock determinista. Congelar los cortes del Plan MVP y no añadir WhatsApp, CopilotKit, catálogo completo, auto-mejora ni deploy hasta que el E2E chat → especialista → QA → gate pase de forma repetible. |
