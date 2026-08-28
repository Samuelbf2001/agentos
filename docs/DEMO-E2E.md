# DEMO-E2E — Guion de aceptación real (B7b)

> Ejecutado el 2026-08-27/28 contra la plataforma real: API en 4300, web en 4301, runs REALES
> por `ClaudeCodeRunner` con la suscripción del CLI (perfil `claude_subscription`).
> Evidencia visual en `docs/evidence/`. Nada de este guion tocó la DB por SQL salvo verificación
> de lectura y la preparación de presupuesto en `app_config` (autorizada por el guion).

## Resumen ejecutivo

**El criterio de éxito del PRD §1 se cumplió**: por chat se pidió el assessment de ACME, el
tablero se pobló y movió solo (con actores y runs navegables), Sam produjo artefactos reales con
provenance verificable, Quinn criticó automáticamente el informe en REVIEW y encontró un defecto
real, los dos gates humanos frenaron y reanudaron el trabajo exactamente donde debían, y el kill
switch paró todo al final. **13 runs reales, $6.48 USD equivalentes** (ver tabla). Se encontraron
**7 bugs/hallazgos** (2 altos), documentados abajo para el ciclo B8 — más 1 fix trivial de 1 línea
aplicado y documentado.

## 0. Preparación (presupuesto y seguridad)

- `app_config` (script sobre la DB, antes de arrancar): `budget_max_cost_per_day_usd=5`,
  `budget_max_cost_per_run_usd=2`, `runner_limit_claude_code=2`, `kill_switch=true` (arranque en
  pausa), y `quinn_review_activity_types += "report"` — necesario porque la lista sembrada solo
  cubre tipos técnicos (`code/build/...`) y el entregable de un assessment que entra a REVIEW es un
  `report`: sin esto US-10 no se puede demostrar en el engagement demo (hallazgo H6).
- Reset de demo por interfaces reales (como Ernesto): 2 tareas READY del seed (Kickoff → Alex,
  Inventario → Clara) se desasignaron de agente (quedaron en manos de Sebastián) para controlar
  qué corría; intento previo de moverlas READY→BACKLOG rechazado por la máquina de estados (H7).
- Insumo humano: 2 notas de entrevista (Gerencia General y Jefe de Producción de ACME) cargadas
  al Context Hub como `interview` vía `PUT /api/knowledge` (los agentes no entrevistan solos;
  las entrevistas llegan como insumo — sam.md).
- Fix de configuración vía API (bug B7a, no de código): los 7 agentes estaban en runtime
  `claude_code` pero Sam/Sally/Clara conservaban modelos no-Anthropic (`gpt-5`,
  `kimi-k2-0905-preview`, `MiniMax-M2`) que el CLI no puede correr → `PATCH /api/agents/{sam,sally}`
  a `sonnet` y clara a `haiku` (H5).

## 1. Guion ejecutado, paso a paso

### Paso 1-3 — Arranque, login y encargo por chat (US-1)

Login UI como **Ernesto** (contraseña compartida + persona). Con el kill switch aún activo la UI
muestra el banner "⛔ agentes pausados"; se reanudó desde la UI y se envió por el chat web:

> "Arranca un assessment para ACME S.A., 40 empleados, manufactura, quieren prepararse para ISO 9001"

- Run de Alex `01a046b5-c54c-7afb-9aef-f7579fdd8f95` ($0.4577, 56 in / 8.384 out).
- **Falla encontrada (H1, ALTA)**: Alex no recibió el `project_id` real en su contexto e inventó
  el slug `assessment-acme` en TODAS sus tool calls. `board.get` con ese id inexistente devolvió
  tablero vacío **sin error** (H2), 13× `tasks.create` fallaron con `not_found` y Alex concluyó
  "el proyecto no existe" y pidió ayuda al humano (comportamiento honesto: no inventó éxito).
  Evidencia: audit_log del run (110 `tool.execute` / 15 `tool.error` en total en la demo).
- Segundo turno de chat (humano da el UUID real): run `01a046bc-...f82df7a4` ($0.3415). Alex leyó
  el tablero real (12 tareas del seed), lo comparó con la metodología `assessment-14d` v2 y creó
  las **2 tareas que faltaban** (Recopilación de evidencia → Clara; Gate 1: presentación y
  decisión), con DoD verificable, actor `agent:alex` y `run_id` navegable (CA-1.3 ✓). Sintetizó
  el backlog completo por fases en el chat.
- **Idempotencia (CA-1.5 ✓)**: re-POST del mismo `message_id` al canal web →
  `{"deduped":true, "run_id":null}`, sin segundo run (probado con `demo-e2e-gate2-1`).

### Paso 4-5 — Sam produce artefactos reales (US-3, US-12)

- **Perfil de organización ACME** (`org_profile`): 1er run `01a046b5-...05ac6964` ($0.8126) terminó
  **BLOCKED con razón correcta**: `knowledge.search` solo devuelve metadata (sin `body_md`) y Sam
  no tenía tool de lectura (H3, ALTA) — además `ask_human` le estaba denegada (H4 → fix 1 línea).
  Tras añadir `knowledge.get/list` a su allowlist por API y desbloquear la tarjeta: run
  `01a046bb-...257d4d2b` ($0.4236) → doc tipado `org_profile` `01a046bc-7990-...a520c3af` con
  `source_refs` a las 2 entrevistas y **13 citas `[doc:id]` con quotes textuales**, artefacto
  adjunto y tarjeta a REVIEW (CA-3.3, CA-12.2, CA-12.3 ✓).
- **Mapa de proceso as-is: Producción** (`process_map`): run `01a046be-...58420abb` ($0.5958) →
  entidad `processes` `01a046bf-0cce-...35fadce7` (variant `as_is`, 7 pasos SIPOC con
  responsable/sistema/entrada/salida, 4 sistemas, 5 pain_points cuantificados citando `[doc:id]`)
  + artefacto; tarjeta a REVIEW. **Gap**: no rellenó `source_doc_ids` ni usó
  `processes.link_source` (CA-12.5 parcial, H8).
- **Entrevista Ventas** (movida por error del operador, sin insumo en el Hub): Sam verificó el Hub,
  **se negó a inventar** y preguntó vía `ask_human` (aprobación tipo pregunta en la bandeja).
  El primer run no movió la tarjeta y el despachador la re-despachó → pregunta duplicada y un run
  extra ($0.43+$0.34) (H9). El humano respondió, reasignó a Jorge y la tarjeta quedó en manos
  humanas.
- **Informe de assessment (borrador)** (`report`, `requires_approval`): run
  `01a046c2-...59fac306` ($0.7552, 24.061 tokens out) → informe consolidado con provenance
  completo, huecos declarados explícitamente, artefacto en el workspace y tarjeta a REVIEW.

### Paso 6 — Quinn, auto-crítica en REVIEW (US-10)

Al entrar el informe a REVIEW, el despachador arrancó **solo** el run de Quinn
`01a046c5-...185de410` (trigger `system`, $0.9051). Veredicto: verificó cada cifra contra las
entrevistas fuente (citando `[doc:id]`), validó el cálculo de $12.000/mes, y **encontró un defecto
real**: el informe creó una entidad `processes` **duplicada** para Producción en vez de reusar la
ya mapeada 111 s antes. Abrió **tarea hija tipo `bug`** `01a046c8-...9c27a41c` (severidad alta,
con repro) colgando del informe (CA-10.1/10.2-bug ✓; no movió la original a IN_PROGRESS — no tiene
`tasks.move` y no está claro que deba: CA-10.2 parcial). Declaró lo que NO pudo verificar. No
aprobó ni cerró nada (CA-10.4 ✓).

### Paso 7 — Bandeja y Gate 1 (US-4, CA-1.4)

- **Bug de UI (H10, ALTA para US-4)**: la vista "Esperando por ti" mostró **(0)** con 3 tarjetas
  en REVIEW (una con `requires_approval`) — solo lista aprobaciones de tools/preguntas, no los
  entregables en REVIEW (CA-4.2 ✗). El flujo sí existe en la tarjeta del tablero: diálogo con
  artefactos renderizados, timeline con enlaces a runs y botones "✓ Aprobar / ✕ Rechazar".
- Ernesto aprobó el informe desde la tarjeta → DONE con decisora registrada y auditoría
  before/after (`task.review_approve`, CA-4.3/4.4 ✓).
- **Gate 1 antes/después (CA-1.4 ✓)**: tarea de CONSTRUIR creada por REST; moverla a READY con el
  gate pendiente devolvió `gate_not_passed` (literal, con detalle `gate_state=pending`); tras
  `POST /api/projects/:id/gate {approve}` (auditado) el mismo movimiento pasó → READY.

### Paso 8 — Gate 2: efecto externo email.send (US-5)

- Por chat: "envía el informe por email a la gerente de ACME…". Alex ($0.3600) **no delegó en
  Sally**: redactó el email y pidió aprobación del contenido por `ask_human` (H11 — razonable,
  pero se esperaba la tarea hija vía `delegate`; CA-6.2 quedó sin ejercitar). El humano aprobó el
  contenido y creó la tarjeta para Sally con el borrador (external_effect).
- Run de Sally `01a046cd-...8cb04524` ($0.4779): leyó tarea+informe, invocó `email.send` → la tool
  **NO ejecutó**: aprobación `01a046ce-1a69-...3b883a79125` `pending` con **payload literal** y
  `action_digest` sha256 `55fdee0f...598e66` (CA-5.1 ✓); Sally adjuntó evidencia, comentó el
  resultado literal `pending_approval` y movió la tarjeta a **BLOCKED(approval)** cerrando el
  turno limpio (CA-5.2 ✓). La bandeja mostró la aprobación con el payload y el aviso "al aprobar,
  la plataforma EJECUTA el efecto".
- **Reinicio del servidor con la aprobación pendiente** → tras el boot: `approvals_pending: 1`,
  misma aprobación (CA-5.4 ✓, NFR-4 ✓).
- Aprobación de Ernesto → la plataforma ejecutó el stub (`{"simulated":true,...}`: ningún email
  salió) y encoló el **run de reanudación** `01a046cf-...c397081e` con
  `resume_of_run_id=8cb04524` ($0.3417). Sally retomó, adjuntó la evidencia post-aprobación y
  cerró a REVIEW (CA-5.3 ✓).

### Paso 9 — Verificación en vivo de la UI (US-2, US-6, US-7)

- Tablero moviéndose solo con WS "en vivo", tarjetas con actor+timestamp y timeline con enlaces a
  runs (CA-2.1/2.2 ✓ observado; latencia p95 no medida instrumentalmente).
- Enjambre: 7 nodos con estado (Alex y Sam "pensando" simultáneos al inicio) y
  tokens/coste acumulados por nodo (CA-6.1/6.3 ✓; CA-6.4 solo-lectura ✓). Arista de delegación
  no observada (no hubo `delegate` real — ver H11): CA-6.2 **no verificada**.
- Vista de run: árbol de 12 spans con duración/estado, tokens in/out y cache read/write, coste
  USD, modelo/runtime, navegación tarea↔run↔hijo (CA-7.1/7.2/7.4 ✓). **Replay**: 55/55 eventos
  repintados sin llamar al LLM (CA-7.3 ✓).

### Paso 10 — Freno de mano (US-11)

"⏸ Pausar agentes" desde la UI → `kill-switch {active:true}` inmediato; un mensaje de chat
posterior quedó persistido pero **sin run** (`warning: kill_switch_active`) (CA-11.1 ✓ en su parte
de no-arranque; no había runs activos que cancelar en ese momento — cancelación en caliente no
re-verificada aquí, cubierta por tests de B2/B4). Servers detenidos al final.

### NFR-11 (secretos)

Barrido de patrones (`sk-ant`, `ANTHROPIC_API_KEY=`, `Bearer eyJ`) sobre events/messages/audit/
docs/artifacts/runs: **0 hits**.

## 2. Coste real (13 runs, todos `claude_code` con suscripción)

| Run | Agente/trigger | Tarea | USD |
|---|---|---|---|
| a3be9a7b | Alex/chat (smoke B4 previo) | — | 0.2384 |
| 9fdd8f95 | Alex/chat (US-1, id inventado) | — | 0.4577 |
| 05ac6964 | Sam/dispatcher (bloqueo honesto) | org_profile | 0.8126 |
| f82df7a4 | Alex/chat (reconcilia backlog) | — | 0.3415 |
| 257d4d2b | Sam/dispatcher | org_profile | 0.4236 |
| 3d1dad1b + 126a98bd | Sam/dispatcher (ask_human ×2, H9) | entrevista ventas | 0.7741 |
| 58420abb | Sam/dispatcher | mapa producción | 0.5958 |
| 59fac306 | Sam/dispatcher | informe | 0.7552 |
| 185de410 | Quinn/system (auto-crítica) | informe | 0.9051 |
| 945e978b | Alex/chat (Gate 2) | — | 0.3600 |
| 8cb04524 | Sally/dispatcher (email.send→pending) | envío email | 0.4779 |
| c397081e | Sally/approval_resume | envío email | 0.3417 |
| **Total** | | | **6.4835** |

Presupuesto duro configurado y activo ($5/día, $2/run, semáforo claude_code=2). El acumulado de la
sesión cruzó $5 tras la crítica de Quinn; se decidió completar el Gate 2 (3 runs, ~$1.2, dentro del
tope del día 28 que quedó en $3.97) por ser el criterio central del PRD, y se activó el kill switch
al terminar. Nota: el guion cruzó la medianoche, así que el tope diario nunca cortó.

## 3. CAs verificados / fallados

| CA | Resultado |
|---|---|
| CA-1.1 proyecto+org en ≤60 s | ✓* (proyecto del seed reutilizado; Alex no tiene `projects.create` — con tablero virgen NO podría, ver H12) |
| CA-1.2 ≥6 tareas con DoD y asignado | ✓ (12 seed + 2 de Alex, todas con DoD y asignado) |
| CA-1.3 actor agent:alex + run navegable | ✓ |
| CA-1.4 CONSTRUIR bloqueado sin Gate 1 | ✓ (`gate_not_passed` literal antes; pasa después) |
| CA-1.5 pregunta si falta info / idempotencia | ✓ (Alex y Sam preguntaron; dedup verificado) |
| CA-2.1/2.2 tablero en vivo, actor+timeline | ✓ observado (p95 no instrumentado) |
| CA-2.3 resync por cursor | no verificado |
| CA-2.4 drag humano | ✓ vía REST move (drag UI no probado); READY→BACKLOG denegado (H7) |
| CA-3.1/3.3 dispatch ≤5 s, artefacto obligatorio | ✓ |
| CA-3.2 doble claim / CA-3.4 reaper | no re-verificado aquí (tests B3 en verde) |
| CA-4.1 REVIEW por agente, DONE solo humano | ✓ |
| CA-4.2 bandeja con artefacto | ✗ para entregables REVIEW (H10); ✓ para aprobaciones de tool |
| CA-4.3/4.4 decisión registrada y auditada | ✓ (aprobación; rechazo con nota no ejercitado) |
| CA-5.1–5.4 Gate 2 completo + reinicio | ✓ (digest, BLOCKED(approval), stub+resume, sobrevive restart) |
| CA-6.1/6.3/6.4 enjambre estados+costes | ✓ |
| CA-6.2 arista de delegación | no verificada (no hubo `delegate`; H11) |
| CA-7.1–7.4 run view + replay + navegación | ✓ |
| CA-10.1–10.4 Quinn | ✓ (10.2 parcial: bug hijo sí, la original no vuelve a IN_PROGRESS) |
| CA-11.1/11.3 kill switch | ✓ parcial (no-arranque probado; cancelación en caliente no) |
| CA-12.1–12.3 Context Hub tipado + provenance | ✓ |
| CA-12.5 proceso como entidad | ✓ parcial (sin `source_doc_ids`, H8) |
| US-8/US-9 (MCP admin, multi-proveedor) | fuera de este guion (B6 probado aparte; proveedores API sin credenciales) |

## 4. Bugs y hallazgos (NO corregidos aquí salvo H4; ciclo de corrección = B8)

| # | Sev | Qué pasa | Repro |
|---|---|---|---|
| H1 | **ALTA** | El contexto de un run de chat no incluye el `project_id` real del thread: Alex inventa slugs (`assessment-acme`) y todo `tasks.create` falla con `not_found`. US-1 no funciona de una con tablero real. | Chat en un thread con `project_id` seteado → pedir crear tareas → audit del run muestra args con slug inventado. Corregir el ensamblado (`assemblePrompt`/volatile) para inyectar ids reales. |
| H2 | **ALTA** | `board.get` con `project_id` inexistente devuelve tablero vacío OK en vez de `not_found` — alimenta la alucinación de H1 ("el tablero está vacío"). | `board.get {project_id:"lo-que-sea"}` → ok con 0 tarjetas. |
| H3 | **ALTA** | `knowledge.search` solo devuelve metadata (sin body) y varios agentes no tenían `knowledge.get` en su allowlist (seed) → no pueden leer las fuentes que deben citar (CA-12.2). | Con la allowlist sembrada de Sam: `knowledge.search` → ids; no hay forma de leer `body_md`. Workaround aplicado por API (allowlist de Sam); falta corregir `agents/*.md`/seed. |
| H4 | **ALTA** (fix 1 línea aplicado) | `delegate` y `ask_human` (tools de catálogo sin punto) no se namespaceaban a `mcp__agentos__*` en `claudeCodeAllowlist` → el CLI las negaba (fail-closed): ni delegar ni preguntar podía ningún agente `claude_code`. | Ver commit: `apps/api/src/domain-tools.ts` (condición del map). Añadir test de la allowlist con nombres sin punto. |
| H5 | MEDIA | B7a dejó los 7 agentes en runtime `claude_code` con modelos no-Anthropic en 3 de ellos (`gpt-5`, `kimi-...`, `MiniMax-M2`): el CLI no puede correrlos. Workaround por `PATCH /api/agents`; corregir seed/md o validar modelo↔runtime al guardar. | `GET /api/agents` sobre DB sembrada. |
| H6 | MEDIA | `quinn_review_activity_types` sembrado solo con tipos técnicos: en un engagement de consultoría (entregables `report`/`process_map`) Quinn jamás arrancaría (US-10 muerto en el caso de uso principal). Config editada en caliente para la demo. | Tarea `report` a REVIEW con la config del seed → no hay run de Quinn. |
| H7 | BAJA | Humano no puede des-priorizar READY→BACKLOG (`invalid_transition`), pero CA-2.4 dice que el humano arrastra por la misma máquina. Decidir: o la UI lo esconde o la máquina lo permite a humanos. | `POST /tasks/:id/move {to:BACKLOG}` desde READY como persona. |
| H8 | MEDIA | Sam pobló `processes` sin `source_doc_ids` (y no usó `processes.link_source`): CA-12.5 parcial. Prompt o validación de la tool ("as_is sin fuentes → warning"). | Ver entidad `...35fadce7`. |
| H9 | MEDIA | `ask_human` sin mover la tarjeta → el despachador re-despacha y el agente repite la pregunta (run y aprobación duplicados). Falta convención/enforcement: pregunta pendiente ⇒ BLOCKED. | Tarea READY sin insumo → 2 runs, 2 aprobaciones iguales (una quedó huérfana). |
| H10 | **ALTA** (US-4) | "Esperando por ti" no lista tarjetas en REVIEW con `requires_approval` (mostró 0 con 3 en REVIEW); solo aprobaciones de tools/preguntas. El botón Aprobar vive solo en el diálogo de la tarjeta. | REVIEW con requires_approval → /waiting vacío. |
| H11 | MEDIA | Alex evita `delegate`: para el envío redactó él y pidió aprobación en vez de crear la tarea hija a Sally (su propio prompt lo manda a delegar). Consecuencia: CA-6.2 (arista) sin ejercitar. Revisar prompt/función delegate (¿la conocía tras H4?). | Chat pidiendo un envío de email. |
| H12 | MEDIA | Alex no tiene `projects.create` en el catálogo/allowlist: con un workspace virgen CA-1.1 es imposible por chat (el humano debe crear el proyecto). Decidir si se le da la tool o si CA-1.1 asume proyecto pre-creado. | Chat pidiendo assessment sin proyecto existente. |
| Obs | — | Los agentes `claude_code` pueden usar tools built-in del CLI no listadas (Sally usó `Read` sobre el workspace). Aceptable para leer su workspace; revisar en B8 qué más queda permitido por defecto. | Spans del run `8cb04524`. |

## 5. Evidencia (docs/evidence/)

- `02-enjambre-runs-activos.png` — Alex y Sam "pensando" en paralelo (semáforo 2).
- `03-kanban-en-movimiento.png` — 14 tarjetas, IN_PROGRESS "hace segundos", Gate 1 pendiente.
- `04-bandeja-esperando-por-ti.png` — bug H10: (0) con 3 tarjetas en REVIEW.
- `05-tarjeta-informe-review-aprobar.png` — diálogo con artefactos, timeline con runs, Aprobar/Rechazar.
- `06-bandeja-gate2-email-pendiente.png` — aprobación email.send con payload literal.
- `07-run-sally-spans-coste.png` — spans, tokens, cache, coste, hijo (resume).
- `08-run-replay.png` — replay 55/55 eventos sin LLM.
- `09-enjambre-final-costes.png` — coste/tokens acumulados por nodo.
- `10-chat-gate2-alex.png` — conversación completa con Alex.
- `11-kill-switch-activo.png` — freno de mano al cierre.
