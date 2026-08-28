# PRD — AgentOS Sixteam

> **Spec canónica** (el *qué* y el *porqué*; el *cómo* vive en `ARCHITECTURE.md`).
> Síntesis del orquestador (2026-08-27) sobre dos propuestas independientes: `proposal-opus.md` y `proposal-codex.md`. Metodología: skill `desarrollo-con-ia` (Spec Kit adaptado).

## 0. Constitución (principios no negociables)

1. **Trabajo durable, no teatro de agentes.** El producto es un tablero que se mueve solo y sirve de evidencia; toda animación corresponde a un evento persistido. Ninguna tarea se cierra sin artefacto.
2. **Autonomía acotada.** Los agentes crean, reclaman y mueven tareas, pero no se saltan permisos, gates humanos, límites de concurrencia ni el kill switch. Nada sale hacia afuera sin aprobación humana.
3. **Portabilidad de proveedor.** Identidad, prompt, tools y workflow de un agente no se acoplan a ningún proveedor LLM. El proveedor es un dato, no código.
4. **Escala honesta.** Se optimiza para Sixteam y sus primeros engagements. SQLite local, un solo workspace, sin multi-tenant. Nada de infra para 1000 empresas.
5. **Calidad con evidencia.** Un agente no aprueba su propio trabajo. QA independiente (Quinn) + gates humanos según riesgo.
6. **ISO 9001 = preparación asistida**, nunca certificación. Certifica un organismo acreditado; la plataforma documenta, trazabiliza y detecta huecos.
7. **Spec ≠ plan.** Este documento no fija stack; eso es de `ARCHITECTURE.md`.
8. **El activo es el contexto y la metodología.** El valor de la plataforma no está en el chat ni en los agentes sueltos: está en (a) el **contexto organizado y útil de cada empresa cliente** — perfil, procesos mapeados, entrevistas, hallazgos, decisiones, evidencia, todo tipado y con fuente — y (b) la **metodología Sixteam codificada** — playbooks versionados de consultoría (assessment, ISO 9001, transformación) que los agentes siguen. Todo trabajo de agente alimenta ese contexto estructurado; nada valioso se queda solo en una conversación.

## 1. Visión y porqué

Sixteam vende el ciclo **Entender → Construir → Operar** (Assessment → Transform → Ops). Hoy lo ejecutan personas y escala linealmente con horas humanas. **AgentOS es la fábrica que ejecuta ese ciclo con agentes trabajadores de IA, con humanos en los puntos de decisión y no en los puntos de esfuerzo.**

El producto no es "un chat con IA": el chat es la puerta de entrada, el **tablero central es la fuente de verdad y la evidencia**, y el visual en vivo es la confianza (y la demo comercial: *"esto que ves moverse es lo que te vamos a montar"*).

**Criterio de éxito del MVP (una frase):** Ernesto abre el chat, pide un assessment para una empresa, y en la misma sesión ve el tablero poblarse, agentes tomar tarjetas, moverlas, producir un informe real y detenerse a pedirle aprobación — sin que él toque el tablero.

## 2. Usuarios

| Usuario | Quién | Qué necesita |
|---|---|---|
| Operador interno (primario) | Ernesto | Lanzar trabajo por chat, aprobar/rechazar, ver dónde está todo, corregir agentes en caliente |
| Estratega | Samuel | Estado de engagements y costes sin pedir reportes |
| Equipo ejecutor | Sebastián, Jorge, Jefferson | Tarjetas asignadas con contexto e insumos preparados |
| Administrador | Ernesto vía Claude Code + MCP | Editar agentes, prompts, tareas y config desde fuera de la UI |
| Cliente final (fase 2) | Contacto del cliente | Ver avance, responder entrevistas |
| Agentes (usuarios de primera clase) | Roster abajo | Tools tipadas, tablero como memoria compartida, forma de pedir ayuda humana |

**Roster del MVP** (7 — los 6 canónicos de la web V2 + 1 nuevo):

| Agente | Capa | Rol |
|---|---|---|
| **Alex** | Consultoría | Estratega & Concierge. Orquestador y cara del chat: entiende el encargo, crea proyecto y backlog, asigna, sintetiza |
| **Sam** | Consultoría | Diagnóstico: entrevistas, mapeo de procesos, análisis de fugas, informe de assessment, matriz ISO 9001 |
| **Debbie** | Implementación | Constructora: escribe código, monta plataformas, produce entregables técnicos |
| **Vinnie** | Implementación | Integraciones: sistemas del cliente, APIs, MCPs externos |
| **Sally** | Operación | Operadora de Revenue: secuencias, seguimiento comercial, catálogo Ops |
| **Clara** | Operación | Analista: datos, métricas, reportes, coste por engagement |
| **Quinn** | Meta (nuevo) | **QA y Adversario**: rompe lo que los demás producen, corre pruebas, audita cierres sin evidencia, abre bugs. Nunca aprueba ni cierra |

Humanos asignables: Samuel, Sebastián, Jorge, Jefferson, Ernesto (nombre completo).

## 3. User stories del MVP (criterios de aceptación verificables)

**US-1 — Iniciar un engagement desde el chat.**
- CA-1.1 Al escribir "Arranca un assessment para ACME S.A., 40 empleados, manufactura, quieren ISO 9001", en ≤60 s existe el proyecto (`type='assessment'`, etapa ENTENDER) y la organización ACME.
- CA-1.2 Se crean ≥6 tareas en BACKLOG, cada una con título, definición de terminado no vacía y agente asignado.
- CA-1.3 Toda tarea creada registra actor `agent:alex` y un `run_id` navegable.
- CA-1.4 Ninguna tarea de etapa CONSTRUIR sale de BACKLOG sin el Gate 1 aprobado (forzarlo por MCP devuelve `gate_not_passed`).
- CA-1.5 Si falta información imprescindible, Alex pide aclaración; no inventa. Mensajes repetidos con la misma clave de idempotencia no duplican nada.

**US-2 — Ver el tablero moverse solo.**
- CA-2.1 Un movimiento hecho por un agente aparece en la UI sin recargar en ≤1 s (p95, local).
- CA-2.2 La tarjeta muestra actor y timestamp; su timeline lista cada transición con estado origen/destino, actor y enlace al run.
- CA-2.3 Tras 30 s de desconexión, el cliente se re-sincroniza por cursor sin perder ni duplicar eventos.
- CA-2.4 Un humano puede arrastrar una tarjeta; persiste con actor humano y pasa por la misma máquina de estados que los agentes.

**US-3 — Un agente ejecuta una tarea y produce un artefacto.**
- CA-3.1 Con una tarea READY asignada, el despachador arranca un run en ≤5 s y la tarea pasa a IN_PROGRESS con lease.
- CA-3.2 Dos agentes no pueden reclamar la misma tarea (test de carrera obligatorio: el segundo recibe `{claimed:false}`).
- CA-3.3 Ninguna tarea llega a REVIEW ni DONE sin ≥1 artefacto (`missing_artifact` si se intenta).
- CA-3.4 Si el run muere o expira, el reaper la devuelve a READY en ≤60 s; con 3 intentos pasa a BLOCKED (`stuck`).

**US-4 — Gate humano sobre entregables (Gate 1 + revisión).**
- CA-4.1 Una tarea con `requires_approval` solo llega a REVIEW por el agente; intentar DONE devuelve `human_approval_required`.
- CA-4.2 La UI muestra bandeja "Esperando por ti" con el artefacto renderizado (markdown/diff).
- CA-4.3 Aprobar → DONE con persona decisora registrada; rechazar con nota → vuelve a IN_PROGRESS y el mismo agente recibe la nota como input.
- CA-4.4 La decisión queda en auditoría con before/after.

**US-5 — Gate sobre efectos externos (Gate 2, nivel tool call).**
- CA-5.1 Toda tool marcada de efecto externo NO ejecuta: crea una aprobación con el payload literal y su digest, y devuelve `pending_approval`.
- CA-5.2 El agente mueve la tarea a BLOCKED (motivo `approval`) y cierra el turno limpiamente.
- CA-5.3 Al aprobar, el sistema ejecuta el efecto y encola un run de reanudación (`resume_of_run_id`). Cambiar los argumentos invalida la aprobación (ligada al digest).
- CA-5.4 Una aprobación pendiente sobrevive a un reinicio del servidor y al aprobarla el flujo continúa.

**US-6 — Visual en vivo de agentes interactuando.**
- CA-6.1 Un lienzo muestra un nodo por agente con estado: idle / pensando / usando_tool / bloqueado / pausado / esperando_turno.
- CA-6.2 Cuando Alex delega en Sam aparece una arista animada correspondiente a una tarea hija real; clic abre la tarjeta.
- CA-6.3 Cada nodo muestra tokens y coste acumulados de la sesión.
- CA-6.4 El lienzo es de solo lectura; toda arista corresponde a un evento persistido (nada decorativo).

**US-7 — Inspeccionar y reproducir un run.**
- CA-7.1 La vista de run muestra el árbol de spans (LLM, tools, subruns) con duración y estado.
- CA-7.2 Muestra tokens in/out/cache, coste USD y modelo/proveedor efectivos (`null` = no reportado, nunca cero inferido).
- CA-7.3 "Reproducir" repinta la sesión evento a evento sin volver a llamar al LLM.
- CA-7.4 Desde una tarjeta se navega al run que la movió; desde el run, a su padre e hijos.

**US-8 — Administrar (casi) todo desde MCP.**
- CA-8.1 Con el perfil rw en Claude Code: listar agentes, crear uno, cambiar prompt/modelo/allowlist; surte efecto en el siguiente run sin reiniciar.
- CA-8.2 Editar un prompt crea versión; rollback en una llamada; ambas en auditoría.
- CA-8.3 Crear, mover, comentar y aprobar tareas por MCP se refleja en vivo en el navegador.
- CA-8.4 El perfil ro (el único expuesto a agentes) rechaza toda mutación. No existen tools de leer secretos, borrar auditoría ni SQL arbitrario.
- CA-8.5 Mutaciones aceptan idempotency_key y expected_version; conflicto de versión falla explícitamente (no last-write-wins).

**US-9 — Multi-proveedor LLM por agente.**
- CA-9.1 Perfiles incluyen al menos: suscripción Claude Code, Anthropic API, OpenAI, Kimi, MiniMax, GLM.
- CA-9.2 Cambiar proveedor/modelo de un agente hace que su siguiente run use ese proveedor, con tool calling funcionando (verificado en vivo solo donde haya credenciales; el resto pasa contract tests con mock — no se declara validado lo no probado).
- CA-9.3 Fallo o 429 del proveedor → run `failed` con error legible y la tarea vuelve a READY; no se pierde trabajo.
- CA-9.4 Ninguna clave es legible por tools ni UI: solo referencias a variables de entorno.

**US-10 — Un agente dedicado a encontrar bugs (Quinn).**
- CA-10.1 Cuando una tarea técnica entra a REVIEW, Quinn arranca automáticamente un run de crítica.
- CA-10.2 Si encuentra fallo, crea tarea hija tipo `bug` con repro, y la original vuelve a IN_PROGRESS.
- CA-10.3 Bajo demanda audita el tablero: DONE sin artefacto, leases vencidos, compromisos del chat sin tarjeta.
- CA-10.4 Quinn no puede aprobar ni cerrar tareas (fuera de su allowlist) y nunca revisa su propio trabajo.

**US-12 — Contexto de empresa organizado y metodología codificada (el activo).**
- CA-12.1 Todo engagement tiene un **Context Hub**: perfil de la organización, procesos mapeados, entrevistas, hallazgos, decisiones y evidencia — cada documento **tipado y con fuente**, no blobs sueltos.
- CA-12.2 Los artefactos que producen los agentes se registran como documentos de contexto tipados, consultables por búsqueda (`knowledge.search`) desde cualquier agente.
- CA-12.3 Los entregables citan qué documentos de contexto usaron (provenance); una afirmación sin fuente se marca "no verificado".
- CA-12.4 La **metodología** (playbook de assessment: fases, preguntas de entrevista, plantillas de entregable, criterios ISO 9001) vive como datos versionados que Alex y Sam siguen — editable por MCP sin tocar código, con historial.
- CA-12.5 Un proceso mapeado es una entidad (no un párrafo): nombre, dueño, estado as-is/to-be, pasos, sistemas implicados, y enlaces a sus fuentes (entrevistas/documentos).

**US-11 — Freno de mano.**
- CA-11.1 "Pausar agentes" detiene todo en ≤10 s: no arrancan runs nuevos y los activos reciben cancelación.
- CA-11.2 Un agente concreto se pausa sin afectar a los demás.
- CA-11.3 Cancelar un run deja la tarea en READY (no zombi) y el run en `cancelled`.

## 4. User stories fase 2

- **F2-1 WhatsApp**: el cliente habla por WhatsApp con el mismo agente y el mismo hilo; el adaptador se registra por el contrato de canal sin cambios en el núcleo.
- **F2-2 Entrevistas IA masivas**: Sam entrevista en paralelo a todo el equipo del cliente y consolida el mapa de procesos con fuente citada por respuesta.
- **F2-3 ISO 9001 profundo**: matriz cláusula↔proceso↔evidencia, generación de documentación obligatoria, detección de huecos y plan de cierre (con disclaimer y firma profesional).
- **F2-4 Cadencia automática**: reporte de lunes 9am y sprint semanal solos; automatizaciones consent-first (se sugieren, máx 5 pendientes, nunca se auto-crean).
- **F2-5 Auto-mejora**: revisión post-run que propone mejoras de prompt como tarjeta en REVIEW; jamás se aplica sola.
- **F2-6 Supabase/Postgres + RAG vectorial** cuando se dispare un criterio de migración.
- **F2-7 Portal del cliente**: tablero filtrado, subir documentos, responder bloqueos.
- **F2-8 MCPs externos reales**: Notion, GHL, Apollo, Drive con allowlist por agente.
- **F2-9 Catálogo completo**: incorporar gradualmente la taxonomía de ~50 actividades por pilar (Marketing/Sales/Service/Reporting Ops).

## 5. Requisitos no funcionales

| # | NFR | Umbral verificable |
|---|---|---|
| NFR-1 | Latencia chat | Primer token ≤2.5 s p95 (runtime in-process); arranque run con proceso hijo ≤8 s p95 |
| NFR-2 | Latencia tablero | Movimiento visible en UI ≤1 s p95 local |
| NFR-3 | Concurrencia | 3 runs de proceso hijo + 10 in-process simultáneos sin degradar la UI en la máquina de desarrollo; el exceso hace cola visible |
| NFR-4 | Durabilidad | Al reiniciar: runs `running` → `interrupted`, sus tareas vuelven a READY ≤60 s, aprobaciones pendientes sobreviven |
| NFR-5 | Coste | Presupuesto por run y por día; superarlo corta con error explícito |
| NFR-6 | Seguridad de efectos | Cero tools de efecto externo ejecutadas sin aprobación (test automatizado) |
| NFR-7 | Auditabilidad | 100% de mutaciones en audit_log; todo movimiento atribuible a run_id o persona |
| NFR-8 | Reproducibilidad | Cualquier run se reproduce desde eventos sin llamar al LLM |
| NFR-9 | Portabilidad de datos | Migrar a Postgres no toca código fuera de la capa de datos |
| NFR-10 | Windows-first | Un comando levanta todo en Windows 11 sin Docker ni WSL |
| NFR-11 | Secretos | Nunca en DB/logs/respuestas; búsqueda automatizada de patrones sensibles en la prueba E2E |
| NFR-12 | Integridad | Claims, transiciones y aprobaciones transaccionales, versionadas e idempotentes (tests concurrentes) |

## 6. Fuera de alcance (explícito)

1. Multi-tenant real (RLS, cifrado por org) — un workspace.
2. Deploy productivo, Docker, CI/CD, EasyPanel — el MVP corre local (el VPS actual sufre CPU steal ~92%).
3. Autenticación real (SSO/RBAC granular) — contraseña compartida + selección de persona.
4. RAG vectorial/embeddings — FTS local basta; vectores con Postgres en fase 2.
5. Voz/telefonía (Sofia sigue en GHL).
6. Editor visual de flujos — el visual es observación, no IDE.
7. Integraciones externas reales — stubs registrados para ejercitar gates.
8. Facturación, contratos, firma electrónica.
9. Auto-modificación de prompts sin humano — los agentes proponen, un humano aplica.
10. App móvil, offline, multi-idioma, dark mode.
11. Emitir certificaciones ISO.
12. Protocolo A2A en tiempo real — delegar es crear una tarea hija, decisión de diseño.
13. WhatsApp y demás canales (solo queda el contrato de gateway implementado para `web`).

## 7. Nota de términos de uso (suscripción Claude Code)

La suscripción es individual: en el MVP el runtime de proceso hijo corre bajo el token/login de Ernesto para uso propio. En cuanto haya uso de equipo o cliente se cambia el perfil de proveedor a API key de Console o seats Team — cero cambios de código, porque el proveedor es un dato. La UI muestra este aviso en la config de proveedores.
