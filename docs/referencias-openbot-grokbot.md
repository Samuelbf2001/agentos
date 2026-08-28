# Referencias técnicas: "Open bot" de CopilotKit y GrokBot — revisión a nivel de código

> Investigación 2026-08-28 para AgentOS Sixteam. Clones shallow en
> `C:\Users\samue\AppData\Local\Temp\claude\C--Users-samue-2brain\45b52b5d-3315-476d-84f6-e1db11bfbc11\scratchpad\refs\`
> (`openbot/`, `open-mcp-client/`, `open-multi-agent-canvas/`, `openmausbot/`). Todas las rutas de archivo citadas son relativas a esos clones.

## Resumen ejecutivo

1. **El "Open bot" de CopilotKit existe y se llama `CopilotKit/OpenBot`** (3.2k★, MIT, alpha, push diario). No es un demo: es una **plataforma completa de coworkers IA self-hosted** — Hono + Bun + PostgreSQL + React/Vite + AG-UI — con computadora por bot, gateway de política CEL, auditoría, handoffs bot→bot, rutinas y MCP gobernado. Es la referencia arquitectónica más cercana a lo que queremos construir con AgentOS.
2. `open-multi-agent-canvas` y `open-mcp-client` siguen vivos pero son de la **era CopilotKit v1 + LangGraph Python + Copilot Cloud**: útiles como patrón de UX (canvas por estado de agente, formulario de config MCP), no como base de código.
3. **"GrokBot" sí corresponde a un producto grande de 2026**: **Grok Bot**, lanzado en beta el **2026-08-11 por xAI/SpaceXAI + Cursor** — "AI teammates" siempre encendidos, cada uno con computadora cloud persistente. Es **propietario, sin repo canónico**. Los gigantes open-source del nicho son OpenClaw (~387k★) y Hermes Agent de Nous (~235k★).
4. La alternativa open-source directa con sustancia es **`milind-soni/OpenMausBot`** (1.8k★, TypeScript estricto, ~489 archivos): app de chat estilo Telegram donde cada contacto es un agente real corriendo sobre los **CLIs `claude`/`codex` ya instalados** (suscripción propia, sin proxy). Su capa `server/` es oro puro para nuestro caso: contracts de driver multi-proveedor, eventos runtime normalizados, delegación entre bots con tope de profundidad, y aprobaciones humanas vía MCP.
5. Los demás candidatos "GrokBot" son juguetes o irrelevantes (evidencia abajo).

---

## Parte 1 — CopilotKit

### Censo de la organización (GitHub API, 2026-08-28)

Repos "open-*" y afines relevantes: **OpenBot** (3 201★, activo), **open-mcp-client** (1 647★), **OpenGenerativeUI** (1 523★), **OpenTag** (1 135★, bot de triage para Slack), **channels-sdk** (873★, SDK para meter agentes en Slack/Teams/etc.), **open-research-ANA** (400★), **open-multi-agent-canvas** (526★). Ninguno de los tres objetivo está archivado; no hizo falta ir al monorepo.

### 1.1 `CopilotKit/OpenBot` — la referencia principal

**Qué es**: plataforma de "AI coworkers" self-hosted. Servicios: `app` (React/Vite, puerto 3010), `server` (Hono/Bun, 3001 — runtime CopilotKit v2, auth Better Auth, política, audit, plugins, canales), `agent-computer` (Chromium + `/workspace` por bot, 4100), `agent-bot` (bot AG-UI de referencia, ~200 líneas), `agent-langgraph`, `supervisor` (crea un contenedor Docker por bot, opcional gVisor), PostgreSQL+pgvector. Un bot es **cualquier endpoint AG-UI** (LangGraph, Mastra, CrewAI, o servidor a mano) — la gobernanza viaja en el protocolo, no en el framework.

**Hallazgos por archivo:**

- **Frontend multi-agente**
  - `app/src/lib/copilot/provider.tsx` — un solo `CopilotKitProvider` (runtime `/api/copilotkit`, `credentials: "include"`, cero API keys en el navegador) que monta una vez las herramientas frontend: ComputerTools, HandoffTool, EscalationTool, GalleryTools, SandboxedTools.
  - `app/src/lib/copilot/active-bot.tsx` — patrón **"bot activo"**: las tools se registran una sola vez para toda la app, y un contexto con ref+state declara a qué bot apunta la superficie montada (los handlers leen la ref porque sobreviven al render; los componentes leen el state para re-renderizar). Restaura el bot anterior al desmontar. Directamente copiable.
  - `app/src/components/channels/channel-chat.tsx` — un canal = una conversación con un coworker; usa `useAgent({ agentId: "channel:<id>", runtimeAgentId, threadId })` de `@copilotkit/react-core/v2`, con reparación de tool-calls sin respuesta (`repair-history.ts`) y semilla del primer mensaje.
  - `app/src/components/computer/` (`live-screen.tsx`, `activity-log.tsx`, `take-the-wheel.ts`, `needs-you.ts`) — **pantalla en vivo del bot + tab de actividad + "tomar el volante"**: el humano toma control del navegador del bot (login/2FA), las acciones del bot se rechazan mientras tanto, todo auditado (`computer.help_requested/control_taken/control_released`).
  - `app/src/components/gallery/` + `app/src/lib/copilot/gallery-tools.tsx` — **generative UI gobernada**: componentes React compilados que el bot invoca como tools en vez de responder solo en prosa; cada llamada consulta al server si el componente está publicado y no vetado para ese bot.
- **Backend / AG-UI**
  - `server/src/copilot.ts` (1 214 líneas) — el corazón. `buildAgents()` construye por request el mapa id→`AbstractAgent`: bots built-in como `BuiltInAgent` (config declarativa con prompt+tools) y bots remotos como `HttpAgent` AG-UI con headers de auth resueltos del vault en cada carga. `standingRoleMessage()` inyecta la identidad del coworker como **mensaje system AG-UI ordinario** (lo único que todo framework entiende), con id determinista para deduplicar.
  - `server/src/agents/runtime-agents.ts` — carga de agentes **filtrada en la query SQL** por visibilidad/dueño (nunca "fetch y ocultar"), con "tombstones": un coworker borrado sigue registrado como `unavailable` para que sus conversaciones se puedan leer.
  - `server/src/channels/events.ts` — actividad de canal en vivo vía **Postgres LISTEN/NOTIFY + hub de WebSockets**, explícitamente como optimización y nunca fuente de verdad (el cliente refetchea al reconectar).
  - `server/src/channels/stall-guard.ts` + `turn-watchdog.ts` — vigilancia de streams colgados de agentes remotos.
- **Gateway de acciones + política (el patrón estrella)**
  - `server/src/computer/gateway.ts` (1 193 líneas) — TODO lo que un bot hace (navegador, archivos, shell, MCP, componentes) pasa por un solo gateway: resuelve target → evalúa política → **escribe la fila de audit ANTES de actuar** → llama al computer; segunda fila si la acción falla.
  - `server/src/computer/policy.ts` — reglas **CEL** sobre `tool.name/intent/bot.id/actor.id/page.*/file.*/mcp.*`; deny antes que allow, **fail-closed** (política ausente no permite nada, regla rota rechaza).
- **Cola de trabajo durable (una tabla, tres features)**
  - `server/src/db/schema/work.ts` + `server/src/work/queue.ts` — tabla `work_items` en Postgres con `SELECT … FOR UPDATE SKIP LOCKED`, lease con reloj de la BD, contador de intentos, y **idempotencia en la clave** (rutina+minuto programado: re-disparar = colisión de insert, no segunda ejecución; la fila terminada SE CONSERVA como colisión). Suspensión de computers, rutinas y handoffs usan el mismo mecanismo. Los comentarios del schema son una clase magistral.
- **Handoff bot→bot**
  - `server/src/agents/handoff.ts` / `handoff-runner.ts` / `handoff-tool.ts` + `docs/architecture.md` §"One Bot handing work to another" — `message_bot` con **payload tipado** (tarea, límites, forma de una buena respuesta; nunca texto libre), destinatario resuelto contra el roster visible del usuario, origen firmado (run assertion), **profundidad y fan-out con tope** (`BOT_HANDOFF_MAX_DEPTH/MAX_PER_RUN`, rechazan en vez de truncar), respuesta que aterriza en el canal del bot respondedor, y fallo terminal **dicho en voz alta** en la conversación. `ask_person` se ofrece siempre junto a `message_bot` para que el modelo tenga salida barata antes que delegar.
- **Narrowing de tools por skill**
  - `docs/architecture.md` §"Which tools a run is offered" + `server/src/plugins/selection.ts` — con >~12 tools, un modelo barato elige por mensaje qué skills aplican y el run solo ve las tools de esas skills ∩ lo otorgado. Es UX del modelo, no frontera de seguridad; cualquier fallo deja el catálogo completo. `mcp.tools_discovered` audita qué se ofreció.
- **MCP gobernado**
  - `server/src/plugins/` (`mcp.ts`, `transport.ts`, `tools.ts`, `catalogue.ts`) — catálogo curado (Drive, Notion) con credencial **del usuario que pregunta** (OAuth por persona), servers custom con validación de URL, tools desconocidas tratadas como writes, resultado MCP capado a 20k chars; grant → política → audit en cada llamada.
- **Prompt compartido**
  - `shared/bot-prompt.ts` — `COMPUTER_GUIDANCE` (uso snapshot-first del navegador, "llamar a `computer_request_help` ES pedir ayuda, una frase no lo es") y `PROVENANCE_GUIDANCE` (**anti-alucinación: decir de dónde salió cada respuesta, sin mandar al modelo a cazar fuentes**) inyectados a TODOS los bots — la regla vive en la plataforma, no en el YAML de un agente. Encaja 1:1 con nuestro guardrail "frame fijo + slots con fuente" del blueprint Charlie.
  - `NO_ANSWER_CAME` — texto sintético que cierra tool-calls huérfanos para que el proveedor no rechace el siguiente turno.
- **Rutinas**
  - `server/src/db/schema/coworker.ts` (`routines`, `routine_runs`) + `server/src/routines/` — creadas pidiéndoselo al bot en el canal (no formulario), cron 5 campos + zona IANA, piso de 15 min, máx 20 activas, **10 fallos seguidos la apagan**; corren como el dueño vía la work queue.
- **Config declarativa de tenant** — `examples/fintech/` (`agents.yaml`, `channels.yaml`, `model.yaml`, `skills.yaml`, `knowledge.yaml`): los 3 coworkers de ejemplo son configuración, no código. Validado al boot.

**Qué NO nos sirve de OpenBot**: la dependencia dura de **CopilotKit Intelligence** (servicio de hilos/memoria con licencia — `config.ts` rehúsa arrancar sin `INTELLIGENCE_API_KEY` + `COPILOTKIT_LICENSE_TOKEN`; hay plan gratuito y self-host, pero es un acople fuerte que nosotros resolvemos con nuestra propia persistencia), Better Auth/SSO corporativo completo, SPIRE, el runtime Bun (nosotros Node), y el supervisor Docker-por-bot como requisito de MVP (nuestro VPS no aguanta; queda como camino).

### 1.2 `CopilotKit/open-multi-agent-canvas` (526★)

Frontend Next.js + agentes LangGraph Python en Copilot Cloud. Lo valioso es el **patrón de canvas por estado**:

- `frontend/src/lib/available-agents.ts` — enum de agentes disponibles.
- `frontend/src/components/canvas.tsx` — layout 4/12 chat + 8/12 canvas; `useCoAgent({name})` por agente expone `running` y `nodeName`, y un banner muestra "agente X ejecutando nodo Y"; el canvas renderiza el componente del agente activo.
- `frontend/src/components/coagents-provider.tsx` — un provider agrega el estado tipado de todos los agentes (`TravelAgentState`, `ResearchAgentState`, `MCPAgentState`) en un contexto.
- `frontend/src/components/agents/mcp-agent.tsx` — `useCoAgentStateRender` para render en vivo de logs de progreso `{message, done}` dentro del chat.

**Veredicto**: adoptar el patrón (estado del agente streamed → panel dedicado por agente + indicador de quién corre), descartar el código (CopilotKit v1, `useCoAgent` CoAgents/LangGraph, requiere Copilot Cloud).

### 1.3 `CopilotKit/open-mcp-client` (1 647★)

Next.js + agente LangGraph Python (`agent/sample_agent/agent.py`) que recibe `mcp_config` **dentro del estado del agente** y monta `MultiServerMCPClient` + `create_react_agent` por turno.

- `app/components/MCPConfigForm.tsx` + tipos en `app/types.ts` / (canvas: `frontend/src/lib/mcp-config-types.ts`) — UI de alta de servers MCP: `Record<nombre, {command,args,transport:"stdio"} | {url,transport:"sse"}>`, persistido en localStorage y pasado como estado inicial del agente.
- `app/components/ToolCallRenderer.tsx` — render genérico de tool calls MCP en el chat.

**Veredicto**: la **forma del config** (mapa nombre→server stdio/sse) y el formulario son copiables para nuestra pantalla de admin MCP; el enfoque "config MCP viaja en el estado del agente y el cliente MCP se monta por turno" es la versión simple de lo que OpenBot hace con gobernanza. El stack (LangGraph Python, Copilot Cloud) se descarta. OJO: en nuestra plataforma el config MCP NO debe vivir en localStorage del navegador — va en la BD del server (como `plugin` de OpenBot o `agents` table de nuestro plan 2brain).

---

## Parte 2 — GrokBot

### 2.1 Qué es "Grok Bot" realmente (verificado)

- **Grok Bot** = producto conjunto **xAI/SpaceXAI + Cursor**, beta **2026-08-11**: "AI teammates you can give real work to", cada usuario con **una computadora cloud persistente compartida** (browser+FS+terminal que sigue corriendo con el laptop cerrado; aislamiento por usuario, cada bot con su pantalla). **Propietario, sin código**; se vende dentro de SuperGrok Heavy ($300/mes), Cursor Ultra ($200/mes) y Cursor Premium Teams ($120/seat). Se extiende vía el marketplace de plugins/MCP de Cursor (formato `.grok-plugin/plugin.json`), computer use, "learned routines" y Skills (formato SKILL.md). Fuente: `refs/awesome-grok-bot.md` (lista `ZeroPointRepo/awesome-grok-bot`, verificada contra docs.x.ai).
- Los proyectos virales open-source del nicho "agente personal autónomo multi-canal" son **OpenClaw** (~387k★, multi-canal WhatsApp/Telegram/Slack/Discord, BYO-model) y **Hermes Agent** (NousResearch, ~235k★) — confirma y amplía la nota del brief §5. No son "GrokBot", pero son el contexto competitivo del que Grok Bot es la versión comercial.
- Conclusión del brief §5 ("no hay repo canónico maduro de GrokBot") **confirmada y matizada**: no hay repo del producto, pero SÍ hay una alternativa open-source seria (abajo).

### 2.2 `milind-soni/OpenMausBot` (1 796★, TS, push 2026-08-28) — el clon con sustancia

"Open Source Alternative to Grok Bot": app Electron estilo Telegram donde **cada chat del roster es un agente real** con su personalidad, modelo, computadora y apps. ~489 archivos TS/TSX. Lo reutilizable para AgentOS no es el Electron sino su **harness server** (`server/`, HTTP local en 127.0.0.1 + SSE `/api/events`), que es exactamente "backend Node/TS que orquesta CLIs de agentes".

**Arquitectura del agente (por archivo):**

- `server/contracts.ts` (364 líneas) — **el archivo más valioso del repo**. Contrato de proveedor completo: `ProviderDriver` (SPI: `decodeConfig`/`defaultConfig`/`models`/`create`) → `ProviderInstance` → `ProviderAdapter` (`sendTurn`/`interruptTurn`/`respondToRequest`/`steer?`/`onEvent`). Unión normalizada `RuntimeEvent` de ~14 tipos (`session.started`, `turn.started/retrying/completed` con usage y coste, `item.*`, `content.delta`, `request.opened/resolved` para permisos/preguntas, `runtime.error` con flag `setup`), con `raw` para ver el mensaje nativo detrás de la normalización. **Flags de capacidad por driver** (`agentsMcp`, `computerMcp`, `composioMcp`, `images`, `effortLevels`, `queueing` = steering a mitad de turno) con la regla de diseño "nunca mostrar un control que el driver no puede honrar". Es la versión TS madura de la abstracción de transports de Hermes (brief §4.1).
- `server/drivers/claude.ts` (1 111 líneas) — **cómo usar la suscripción de Claude Code como motor**: proceso CLI por turno, stream-json en ambas direcciones, prompt por stdin, continuidad con `--resume <sessionId>` (el `resumeCursor`), persona del bot vía `--append-system-prompt`, `--model`/`--effort`, `--tools`/`--disallowedTools`/`--allowedTools`. Higiene de entorno: borra `CLAUDECODE`/`ANTHROPIC_API_KEY` heredados para no facturar API por accidente, y verifica login con `claude auth status --json`. Retries clasificados (`drivers/retry.ts`).
- **Aprobación humana vía MCP (patrón brillante)** — `claude.ts` líneas 647-649: `--permission-prompt-tool mcp__ogb__approve` + un server MCP local (`ogb`) sobre socket Unix que reenvía cada petición de permiso del CLI al harness → tarjeta en el chat (`OptionCardData` en `server/store.ts`: tool pedida, "always allow" con `allowKey` granular tipo `Bash:git`, `approvalScope: "local-computer"` separado). `respondToRequest` devuelve el resultado real (`allowed-once`/`rejected`/`unavailable` = fail-closed).
- **Integraciones como MCP servers por turno** — `claude.ts` 591-661: escribe un `mcp.json` temporal (modo 0600) con composio (500+ apps), computer (proxy REST→MCP a la caja cloud, con endpoint de control "quién conduce" para pausar al bot si el humano toma el volante), `agents` (proxy peer-comms), phone. Con allowlist explícita `mcp__composio`, `mcp__computer`, etc.
- **Multi-agente / sesiones concurrentes / canales**:
  - `server/store.ts` — persistencia **local-first en JSON atómico** (`bots.json` con binding thread→instancia + resume cursors por instancia; `messages-<threadId>.json`), redacción de secretos al persistir.
  - `server/index.ts` (5 290 líneas) — el harness: tools `list_bots`/`ask_bot` (síncrono, techo 4 min) y **`MAX_COMMS_DEPTH = 1`**: un peer invocado corre a depth 1 y NO recibe la tool de agentes → recursión estructuralmente imposible. Grupos/secciones con menciones `@bot` que sugieren traer a un peer con `ask_bot`.
  - `server/delegations.ts` — **`delegate_bot` asíncrono**: cola por thread persistida a `delegations.json` (sobrevive reinicios), drenada cuando el turno origen termina (`turn.completed`), máx 4 por turno, gate de aprobación evaluado al drenar (no al encolar), y visibilidad en UI ("Delegated to @B: reason" + Team Map con `pendingDelegationSnapshot()`).
  - `src/state/store.tsx` + `EventSource("/api/events")` — un solo stream SSE alimenta toda la UI.
- **Scheduling** — `server/routines.ts` + `server/webhooks.ts`: rutinas `once`/`daily` con `runOn: "maus" | "cloud"` (correr en el harness o dentro de la VM del bot), duración máxima, **runs como recibos inmutables** (snapshot del prompt para que editar la definición no reescriba la historia), estados `queued/running/waiting/completed/failed/cancelled/missed`, disparo por schedule/manual/**webhook**.
- **Sandboxing** — `server/container-computer.ts` (Docker local), `server/vps-computer.ts`, `server/computer-proxy.ts` (REST→MCP), `server/local-computer.ts` con `approvalScope` separado para el host. Espectro completo: cloud box / VM local / host con opt-in.
- **Skills con seguridad** — `server/skills.ts`: formato SKILL.md abierto, pero **solo markdown en v1** (cita auditoría Snyk "ToxicSkills": 2-13% de skills públicos con exfiltración en scripts), imports llegan **deshabilitados** hasta que un humano los lee, provenance con URL+hash. Índice en system prompt con presupuesto duro (15 skills / 4KB), archivos completos en el workspace para lectura on-demand.
- **Team manifest** — `server/team-manifest.ts`: formato `openmaus.team` v2 con Zod — equipos de bots empaquetados/compartibles (miembros con key/nombre/título/persona, responder `member|everyone|mentions`). Análogo directo a nuestro roster Alex/Sam/Debbie/….
- **Multi-proveedor real** — `server/drivers/`: claude, codex, ACP (`acp/core.ts` + kimi, hermes, cursor, opencode), openai-compat, minimax, antigravity, pi. Kimi y MiniMax ya presentes — los mismos proveedores del requisito de Ernesto.

**Qué NO nos sirve de OpenMausBot**: el shell Electron/desktop y toda la UI de mascotas (`CursorAvatar.tsx` 1 689 líneas), companion iOS/mDNS, teléfono Android, TTS/llamadas, dweb. La persistencia JSON-por-archivo es correcta para una app de escritorio mono-usuario pero para AgentOS multi-usuario usamos SQLite/Postgres (nuestro plan ya lo dice). `MAX_COMMS_DEPTH=1` es más restrictivo que lo que queremos para orquestador+subagentes (nuestro patrón es cola `agent_tasks`, como OpenBot).

### 2.3 Candidatos descartados (con evidencia)

| Repo | Evidencia | Veredicto |
|---|---|---|
| `ishandutta2007/open-grokbot` (4★, Python) | 59 archivos, ~100KB de código; FastAPI+Next scaffold (CRUD bots/conversations/messages/tasks, `orchestrator.py` 16.8KB, `tools/browser.py` 12KB); directorio `tests/` vacío | **Esqueleto de fin de semana, sin sustancia.** Nada que no esté mejor en OpenMausBot |
| `Franzferdinan51/GrokBot` (0★, TS, ~78MB) | README: "Grok Build Desktop" — app Electron sobre el CLI Grok Build de xAI; CHANGELOG de 3.3MB, monorepo enorme de un solo autor | Sustancial pero es un **wrapper desktop de un CLI de coding**, no una plataforma de agentes trabajadores; 0★, bus factor 1. Solo interesante su idea de memoria híbrida (SOUL.md/USER.md/AGENTS.md + RAG episódico), que ya tenemos vía Hermes |
| `pftq/GrokBot` (26★, C#, nov-2025) | "Grok living on your desktop with control of the mouse/keyboard" | Demo de computer-use de escritorio; irrelevante |
| `milind-soni/OpenMausBot` | — | **EL elegido** (ver 2.2) |
| `ZeroPointRepo/awesome-grok-bot` (6★) | 19 entradas verificadas, comparativa Grok Bot vs OpenClaw vs Hermes | No es código; útil como mapa del ecosistema (usado en 2.1) |
| Ecosistema `grokbot-*` (shims, bridges Telegram, sdk) | repos de 1-33★, creados 2026-08-11..27 | Comunidad de 2 semanas alrededor del producto propietario; nada maduro |

---

## Tabla final: Adoptamos / Adaptamos / Descartamos

| Decisión | Qué | Fuente (archivo) | Por qué |
|---|---|---|---|
| **ADOPTAMOS** | Gateway único de acciones: resolver → política → **audit antes de actuar** → ejecutar; fail-closed | `openbot/server/src/computer/gateway.ts`, `policy.ts` | Es la diferencia entre "agente que puede usar tools" y "agente al que puedes acercar tus tools"; base del MCP de administración y de los 2 gates humanos de Charlie |
| **ADOPTAMOS** | Cola de trabajo durable en la BD (`FOR UPDATE SKIP LOCKED`, lease, attempts, idempotencia en la clave, fila terminada = colisión) | `openbot/server/src/db/schema/work.ts`, `work/queue.ts` | Un mecanismo para rutinas + handoffs + mantenimiento; exactamente nuestra `agent_tasks` del plan 2brain, ya resuelta con los edge cases documentados |
| **ADOPTAMOS** | Handoff tipado bot→bot: payload estructurado, destino resuelto por la plataforma, depth/fan-out con tope, fallo terminal anunciado, todo auditado | `openbot/server/src/agents/handoff*.ts`, `docs/architecture.md` | Coincide con nuestro `delegar_a_agente` (handoff = tarea con payload, no A2A) y le añade las 4 decisiones que nunca toma el modelo |
| **ADOPTAMOS** | Contrato de proveedor: `ProviderDriver`/`ProviderAdapter` + unión `RuntimeEvent` normalizada + flags de capacidad | `openmausbot/server/contracts.ts` | Versión TS madura del patrón transports de Hermes; da de una vez el evento común para UI, audit y coste multi-proveedor (Claude CLI, OpenAI, Kimi, MiniMax, GLM) |
| **ADOPTAMOS** | Driver Claude CLI: proceso por turno, stream-json, `--resume`, `--append-system-prompt` (persona), `--mcp-config` temporal, higiene de env (sin API key heredada) | `openmausbot/server/drivers/claude.ts` | Es literalmente "usar la suscripción de Claude Code como fuente LLM" resuelto y endurecido en producción |
| **ADOPTAMOS** | Aprobación humana vía `--permission-prompt-tool` + MCP proxy → tarjeta en chat con "always allow" granular y resultado fail-closed | `openmausbot/server/drivers/claude.ts` (647-649), `server/store.ts` (`OptionCardData`) | Human-in-the-loop sin tocar el runtime del agente; sirve para los gates de Charlie |
| **ADAPTAMOS** | Patrón "bot activo" + tools frontend registradas una vez | `openbot/app/src/lib/copilot/active-bot.tsx`, `provider.tsx` | Copiable casi literal para nuestro web chat multi-agente |
| **ADAPTAMOS** | Canvas por estado de agente + indicador "quién corre qué nodo" + logs `{message,done}` | `open-multi-agent-canvas/frontend/src/components/{canvas,coagents-provider,agents/mcp-agent}.tsx` | El patrón visual que pidió Ernesto ("ver cómo trabajan"); reimplementar sobre AG-UI/estado propio, no sobre CoAgents v1 |
| **ADAPTAMOS** | Forma del config MCP (`Record<nombre, stdio\|sse/http>`) + formulario de admin | `open-mcp-client/app/components/MCPConfigForm.tsx`, `lib/mcp-config-types.ts` | Pantalla de admin MCP; pero el config vive en nuestra BD (allowlist por agente), no en localStorage |
| **ADAPTAMOS** | Rutinas: creadas conversando, piso de frecuencia, cap, apagado por fatiga (10 fallos), runs como recibos inmutables, trigger por webhook | `openbot/server/src/routines/*` + `openmausbot/server/routines.ts` | Encaja con nuestro cron consent-first de Hermes (brief §4.6); tomar el "fatiga apaga" y el snapshot del prompt |
| **ADAPTAMOS** | Guías de prompt de plataforma: `PROVENANCE_GUIDANCE` (citar o marcar como no verificado, sin cazar fuentes) y cierre de tool-calls huérfanos (`NO_ANSWER_CAME`) | `openbot/shared/bot-prompt.ts` | Nuestro guardrail anti-alucinación de Charlie, generalizado a capa de plataforma |
| **ADAPTAMOS** | Narrowing de tools por skill (elegir skills por mensaje; fallo = catálogo completo; nunca es frontera de seguridad) | `openbot/server/src/plugins/selection.ts` + `docs/architecture.md` | Con ~50 actividades/tools del catálogo Sixteam lo vamos a necesitar pronto |
| **ADAPTAMOS** | Skills markdown-only con imports deshabilitados + provenance hash | `openmausbot/server/skills.ts` | Política de seguridad barata para cuando aceptemos skills de terceros |
| **ADAPTAMOS** | Delegación asíncrona post-turno con cola persistida y drenaje al `turn.completed` | `openmausbot/server/delegations.ts` | Complemento del handoff síncrono; el detalle "gate evaluado al drenar" es fino |
| **DESCARTAMOS** | CopilotKit Intelligence como dependencia de hilos/memoria | `openbot/server/src/config.ts`, `intelligence-client.ts` | Acople a servicio licenciado; nuestra persistencia es propia (SQLite→Postgres) |
| **DESCARTAMOS** | LangGraph/CoAgents/Copilot Cloud (v1) | `open-multi-agent-canvas/agent/`, `open-mcp-client/agent/` | El brief ya lo decidió: backend Node propio emitiendo AG-UI, sin LangGraph |
| **DESCARTAMOS** | Contenedor-por-bot como requisito de MVP (supervisor Docker/gVisor) | `openbot/supervisor/`, `openmausbot/server/container-computer.ts` | Sobre-ingeniería a nuestra escala y el VPS no aguanta; queda como camino de crecimiento |
| **DESCARTAMOS** | Persistencia JSON-por-archivo de OpenMausBot; Electron/companion/teléfono/TTS | `openmausbot/server/store.ts`, `electron/`, `companion/` | Correcto para desktop mono-usuario; nuestro caso es servidor multi-usuario |
| **DESCARTAMOS** | Todos los demás repos "GrokBot" | ver tabla §2.3 | Juguetes, wrappers o comunidad de 2 semanas |

---

## Impacto en la arquitectura de AgentOS (máx 10 bullets)

1. **Confirmación fuerte del stack del brief**: backend Node/TS propio + AG-UI como protocolo agente↔UI es exactamente cómo OpenBot logra "cualquier framework es un bot"; nuestros agentes internos emiten AG-UI y los externos se registran por endpoint.
2. **El "MCP súper potente" de administración debe ser un gateway con política+audit, no un CRUD**: cada acción (editar agente, mover tarjeta del kanban, ejecutar tool) pasa por resolver→policy→audit→actuar, fail-closed. Empezar con reglas JSON simples (CEL después).
3. **Una sola tabla `work_items` (SQLite al inicio) soporta kanban-motor, rutinas y handoffs**: claim con lease + idempotencia en la clave. En SQLite mono-proceso el claim es trivial; el schema de OpenBot nos da la semántica correcta para migrar a Postgres sin repensar.
4. **Handoffs = trabajo tipado en cola, nunca texto libre ni A2A**: payload {tarea, límites, forma de buena respuesta}, depth/fan-out con tope decidido por la plataforma, fallo terminal visible en el chat. Valida y mejora nuestro `delegar_a_agente`.
5. **Capa de proveedores**: adoptar `ProviderDriver/ProviderAdapter/RuntimeEvent` de OpenMausBot como interfaz; driver 1 = Claude CLI (suscripción, `--resume`+stream-json), driver 2 = OpenAI-compatible (Vercel AI SDK) para Kimi/MiniMax/GLM. Los flags de capacidad alimentan la UI ("nunca mostrar un knob que el driver no puede girar").
6. **El visual que pidió Ernesto ya tiene receta**: roster/canvas con estado streamed por agente (canvas repo), badge "X ejecutando Y", panel de actividad por agente (Activity de OpenBot: comandos+salida+archivos), y Team Map de delegaciones pendientes (OpenMausBot). El kanban es nuestra pieza original — ninguna referencia lo tiene como centro; lo movemos con eventos de la work queue.
7. **Human-in-the-loop en dos sabores**: `ask_person` siempre ofrecido junto a la delegación (salida barata), y aprobaciones como tarjetas en el chat con "always allow" granular vía `--permission-prompt-tool`/MCP (gates de Charlie sin tocar el loop del agente).
8. **Prompt de plataforma compartido**: identidad del agente como mensaje system AG-UI (`standingRoleMessage`) + guía de computer/tools + `PROVENANCE_GUIDANCE` anti-alucinación viven en la plataforma y se inyectan a todo agente; el YAML del agente solo aporta el rol (encaja con las 3 capas de Hermes).
9. **Agentes y equipo como configuración declarativa**: `agents.yaml`/`channels.yaml` (OpenBot) + manifiesto de equipo validado con Zod (OpenMausBot) confirman nuestra tabla `agents`/"Agent Card"; añadir export/import de "equipo" empaquetado (roster Sixteam como manifiesto).
10. **Seguridad mínima viable desde el día 1**: tools desconocidas = writes, resultados MCP capados, secretos jamás al transcript (solo longitud), credenciales write-only cifradas, y skills de terceros markdown-only deshabilitados hasta lectura humana.
