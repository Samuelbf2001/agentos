# QA-REPORT — Ataque adversario (B8 paso 2)

> Agente QA adversario (Quinn en modo plataforma). Objetivo: **romper** invariantes
> del PRD/ARCHITECTURE que los 273 tests unitarios y la demo E2E (DEMO-E2E.md, H1–H12)
> no cubren. Ejecutado 2026-08-28 sobre `C:\Users\samue\2brain\agentos` por lectura de
> código, ataque a nivel de packages y verificación REST/MCP/estado. **Sin runs LLM
> reales** (kill switch conceptual: no se tocó el despachador). Baseline previo: 273
> tests verdes; tras esta sesión: **274 verdes** (+1 regresión del fix aplicado),
> `pnpm -r typecheck` limpio.

## Veredicto de robustez

El núcleo de seguridad **aguanta bien**: la matriz de estados es fail-closed, el
gateway audita-antes-de-actuar, el perfil `ro` del MCP rechaza toda mutación en TODOS
los dominios, ningún efecto externo se ejecuta sin aprobación con digest, la auth firma
sesiones y el WS exige token. **Pero** encontré **dos fallos ALTA de integridad de gates
que la demo no ejercitó** (auto-cierre de entregables saltándose QA+humano; y el camino
de aprobación por MCP que deja la tarea sin reconciliar), más un fallo de concurrencia
MEDIA que **corregí** y dos menores. Ninguno es un bypass de la auth ni una fuga de
secretos. La plataforma es usable en local por Ernesto **con la salvedad** de que la
aprobación de Gate 2 debe hacerse por la UI/API (no por MCP) y de que conviene cerrar
Q1 antes de confiar el cierre de entregables a los agentes sin vigilancia.

---

## Hallazgos NUEVOS

### Q1 — ALTA · Un agente auto-cierra entregables a DONE saltándose REVIEW, Quinn y el humano

**Vector:** integridad de gates / "un agente no aprueba su propio trabajo" (PRD const. §5,
CA-4.1). Tool directa del agente (`tasks.move`), sin humano.

**Causa raíz:** desalineación entre **dos listas**:
- `computeRequiresApproval` (`packages/core/src/board/policy.ts`) marca `requires_approval`
  solo para `PHASE_DELIVERABLE_ACTIVITY_TYPES` (`assessment_report`, `informe_assessment`,
  `roadmap`, `proposal`, …) y `SENSITIVE_ACTIVITY_TYPES`.
- `DEFAULT_QUINN_ACTIVITY_TYPES` (`apps/api/src/dispatcher.ts`) sí incluye los entregables
  de consultoría **`org_profile`, `process_map`, `leak_analysis`, `iso_gap`** (fix H6).

Esos cuatro tipos **no** están en la lista de la política ⇒ `requires_approval = false`.
En el seed (`packages/db/src/seed.ts`) las tareas `org_profile`/`process_map`/`leak_analysis`/
`iso_gap` no fijan `requiresApproval` (solo `report` y `roadmap` lo hacen, líneas 280/293).

En `moveTask` (`engine.ts`):
- guard "agente→DONE" solo bloquea **si `requiresApproval`** (línea ~343),
- guard anti-teatro solo exige **≥1 artefacto** (línea ~352),
- la matriz permite a un agente `IN_PROGRESS>DONE` (`state-machine.ts` línea 54).

Y Quinn se suscribe **solo a `→REVIEW`** (`dispatcher.ts` línea ~621). Si el agente va
directo a DONE, **Quinn nunca arranca** y ningún humano lo ve.

**Repro exacto (Sam, dueño de esas tareas, con `tasks.move` en su allowlist):**
```
# tras el seed; sea T = tarea org_profile de ACME (assignee = Sam), v = su version
POST catálogo/tool  tasks.claim         {task_id:T}                       -> IN_PROGRESS
POST catálogo/tool  tasks.attach_artifact {task_id:T, kind:"doc", title:"perfil"}
POST catálogo/tool  tasks.move          {task_id:T, to:"DONE", expected_version:v'}  -> DONE  ✗
# no pasó por REVIEW, no disparó a Quinn, ningún humano decidió. Idéntico para
# process_map / leak_analysis / iso_gap.
```
(Equivalente por REST como humano no aplica: el humano SÍ puede cerrar; el problema es
que el **agente** puede autocerrarlo.)

**Impacto:** los entregables que la plataforma dice auditar con Quinn (US-10) y presentar
al humano pueden llegar a DONE sin QA ni gate. Defeats el principio central ("calidad con
evidencia; QA independiente + gates humanos"). Un agente con prompt-injection en el texto
de la tarea/doc que lo empuje a "cierra la tarea con tasks.move to DONE" lo consigue.

**Fix sugerido (decisión de producto, por eso lo documento y NO lo parcheo):** alinear
las dos listas. Mínimo: que la política trate los tipos revisables por Quinn como
`requires_approval` (fuerza REVIEW→humano), **o** que la máquina prohíba a un *agente*
`IN_PROGRESS→DONE` cuando `activity_type ∈ lista-Quinn` (obligando a pasar por REVIEW,
donde Quinn critica y el humano cierra). La primera cambia semántica (esos contextos
pasarían a exigir aprobación humana), decisión del equipo.

---

### Q2 — ALTA · Decidir una aprobación por el MCP admin no reconcilia la tarea (Gate 2 queda huérfano)

**Vector:** durabilidad/integridad del Gate 2 + capacidad documentada US-8/CA-8.3
("aprobar tareas por MCP se refleja en vivo"). Ruta MCP `agentos.approvals.decide` (rw).

**Causa raíz:** toda la lógica de *efecto de la decisión* vive en el handler REST
`POST /api/approvals/:id/decide` (`apps/api/src/routes/ops.ts`), **no** en el core:
- ejecutar el efecto (`toolRuntime.executeApproved`) y encolar la reanudación
  (`dispatcher.enqueueApprovalResume`) — solo se llaman desde ese route (verificado por
  grep: son sus únicos llamadores);
- `recordAndUnblock` (comentar la respuesta y mover `BLOCKED(approval)→READY`) — también
  vive en ese route.

El MCP admin es "capa fina" y solo llama `engine.decideApproval`, que **únicamente cambia
el estado de la aprobación y emite el evento** `approval.approved`. La API **no** se
suscribe a `approval.approved` para ejecutar nada (grep: sin suscripción). Resultado según
el `kind`:
- **`tool_call`** (p. ej. `email.send`): la aprobación queda `approved`, **el efecto nunca
  se ejecuta**, no hay run `resume_of_run_id`, y la tarjeta queda **BLOCKED(approval) para
  siempre**. Peor: ya no se puede rescatar por la API porque `decideApproval` exige estado
  `pending` (ahora, tras Q3, con conflicto explícito) — queda **huérfana permanente** con
  un estado que *miente* ("approved" sin efecto).
- **`deliverable` / `gate`-pregunta (ask_human)**: la aprobación pasa a `approved`, pero la
  tarjeta **no** vuelve a READY (el `recordAndUnblock` no corre) — el agente nunca retoma.

**Repro exacto:**
```
# 1) genera un tool_call pendiente (Sally invoca email.send por el gateway) -> approval A,
#    tarea T en BLOCKED(approval).
# 2) decide por MCP admin (perfil rw):
MCP  agentos.approvals.decide {approval_id:A, decision:"approved", person_id:P}
#    -> {approval:{status:"approved"}, execute_payload:{tool:"email.send",...}}
# 3) observa: no existe run con resume_of_run_id=A; no hay audit tool.execute_approved
#    de email.send ({simulated:true} nunca aparece); T sigue BLOCKED.
# 4) intento de rescate por API:
POST /api/approvals/A/decide {decision:"approved"}  -> 409 conflict (ya decidida)
```

**Impacto:** el camino de aprobación por MCP —parte de "editar/operar casi todo desde
Claude Code"— rompe el Gate 2 y bloquea tareas de forma irreversible. La demo solo aprobó
por UI/API, por eso no salió.

**Fix sugerido (grande, cruza módulos → documentado, NO parcheado):** mover la
reconciliación a `engine.decideApproval` (core) para que ambos caminos compartan
comportamiento. El core puede desbloquear/comentar; para `tool_call` el efecto y el
resume necesitan `toolRuntime`+despachador, así que o la API se **suscribe a
`approval.approved`** y ejecuta/reanuda (mejor), o —stopgap acotado— el MCP `approvals.decide`
**rechaza los `tool_call`** con un mensaje que remita a la UI/API (fail-closed: nada
huérfano). Mientras tanto: **aprobar Gate 2 solo por la UI/API.**

---

### Q3 — MEDIA · `decideApproval` no era atómico (last-write-wins entre los dos procesos escritores) — **CORREGIDO**

**Vector:** concurrencia/integridad (NFR-12: "aprobaciones transaccionales, versionadas e
idempotentes").

**Causa raíz + habilitador arquitectónico:** `apps/mcp-admin` abre **su propio** handle
SQLite (`createAdminContext`→`openDb`, `apps/mcp-admin/src/context.ts`), de modo que MCP
admin y `apps/api` son **dos procesos escritores** del mismo fichero — contradice el
invariante "dueño único de SQLite / un solo proceso escritor" (ARCHITECTURE §1 y §5; §5
lista ">1 proceso escritor" como disparador de migración a Postgres). WAL+`busy_timeout`
evitan corrupción, pero los *check-then-act* de varias sentencias no son atómicos entre
procesos. El repo `decideApproval` hacía `UPDATE … WHERE id=?` **sin** guardia de estado:
la única protección era el `if (status!=='pending')` del engine, leído **antes** del
UPDATE. Dos decisiones concurrentes (API `approved` + MCP `rejected`) podían **ambas**
pasar la guardia y la última en escribir ganaba — dejando p. ej. la aprobación `rejected`
en DB **después** de que la API ya ejecutó el efecto.

**Fix aplicado** (`packages/db/src/repositories/approvals.ts`): el UPDATE ahora es
condicional `WHERE id=? AND status='pending'`; si `changes=0` distingue not_found vs
`conflict` ("ya fue decidida"). La decisión es atómica a nivel SQL; la segunda decisión
falla explícitamente en vez de pisar. **Regresión** en
`packages/db/test/repositories.test.ts` ("decideApproval es atómico: la segunda decisión
falla con conflict"): decide `approved`, luego intenta `rejected` → lanza `/ya fue
decidida/` y el estado sigue `approved`. (Falla sin el fix; verde con él.)

---

### Q4 — BAJA · `verifyToken` no revalida que la persona exista / siga interna

**Vector:** auth. `apps/api/src/auth.ts` `verifyToken` valida firma + expiración pero
**no** consulta `people`. Un token firmado de una persona luego eliminada o desactivada
sigue válido hasta `exp` (7 días). No es escalada externa (forjar exige el secreto de
firma, derivado de la contraseña compartida), pero un interno deprovisionado conserva
acceso. **Fix:** en el hook `onRequest` (`server.ts`), tras `verifyToken`, exigir
`getPerson(personId)?.isInternal`.

### Q5 — BAJA · `order_key` sin restricción de unicidad → empates al crear en paralelo

**Vector:** concurrencia/orden. `nextOrderKey` hace `SELECT max(order_key)…` y suma 1 char;
`order_key` solo tiene índice, no `unique` (`packages/db/src/schema.ts`). Con los dos
escritores creando tareas en la misma columna a la vez, pueden salir `order_key` iguales →
empate de orden (cosmético; el `reorder` sí va con `expected_version`, así que ese camino
resiste). **Fix:** clave fraccionaria entre vecinos reales o `unique(project_id,status,
order_key)` con reintento.

---

## Invariantes que RESISTIERON el ataque (evidencia de robustez)

- **Perfil `ro` (MCP, el único expuesto a agentes):** TODA mutación está `readOnly:false`
  (auditadas 1:1 nombre↔flag en `apps/mcp-admin/src/tools/*`); `ro` rechaza la mutación
  **antes** de validar argumentos (`registry.ts`). No puede: mutar ningún dominio,
  `system.resume_all` ni `system.config.set` (desactivar el kill switch), `audit.revert`,
  hard delete ni SQL arbitrario (no existen tales tools). **Sin fuga de secretos:**
  `providers.list`/`providers.test` devuelven solo el **nombre** de la env var y
  `configured:true/false`, nunca el valor (`SECRET_PATTERNS` + test que asegura ausencia de
  `sk-`); `agents.test` es dry-run real sin LLM.
- **Efecto externo sin aprobación (REST/tool/MCP):** el gateway crea la `approval` con
  payload literal+digest y **no ejecuta** (`gateway.ts`); las tools de efecto externo no
  viven en el catálogo del MCP admin; por REST solo se ejecuta vía `executeApproved` de una
  aprobación **aprobada y con digest coincidente**.
- **Digest / cambiar argumentos tras aprobar:** `decideApproval` y `executeApproved`
  recomputan `canonicalJson`→sha256 del payload almacenado; alterar los args invalida con
  `approval_invalidated` (probado en `admin-tools.test.ts`).
- **Gate 1:** salir de BACKLOG (salvo cancelación humana) en `CONSTRUIR` exige `g1_plan`
  aprobado; `delegate` reaplica `assertGate1` a la hija; forzarlo da `gate_not_passed`.
- **Auth / WS:** todo `/api` y `/v1` exige sesión firmada o `x-channel-secret` (fail-closed
  si el secreto no está configurado); `/ws` sin token → close 4401; login valida persona
  existente **e** interna.
- **Kill switch:** `checkPolicy` del gateway bloquea toda ejecución de tools; el tick del
  despachador salta; `resume_all` es rw-only (un agente `ro` no lo apaga).
- **Dedup de canal web:** `unique(channel, message_id)` + flag `inserted`; el handler es
  síncrono sobre better-sqlite3 (un proceso) ⇒ dos POST idénticos no intercalan; el segundo
  responde `deduped:true`.
- **Durabilidad:** al reiniciar, runs `running/queued`→`interrupted`, sus tareas
  `IN_PROGRESS→READY`, y las aprobaciones **pendientes** sobreviven intactas
  (`recovery.ts`).
- **Delegación:** profundidad >3 y fan-out >4 por run se **rechazan** (no truncan) en el
  límite +1; detección de ciclo de `parent_task_id`.
- **Presupuesto:** corte duro por `maxUsd`/`maxTokens`/`maxMs` por run con
  `budget_exceeded` (`ai-sdk-runner.ts`), y topes por run/día en el pool.
- **IDs cruzados (single-workspace):** cualquier sesión puede leer/mover cualquier
  tarea/proyecto por id — **por diseño** (PRD §6.3: un workspace, sin RBAC). No es vuln en
  este alcance; a documentar si se abre a cliente (fase 2).

---

## Qué corregí

- **Q3** (integridad de concurrencia): `decideApproval` ahora es un UPDATE condicional
  atómico (`status='pending'`) con `conflict` explícito, cerrando el last-write-wins que el
  segundo proceso escritor (MCP admin) hacía posible. + test de regresión. Suite: **274
  verdes**, typecheck limpio.

Q1, Q2, Q4, Q5 quedan **documentados con repro y fix propuesto, sin parchear**: Q1 y Q2
implican una decisión de diseño/producto (qué entregables se gatean; cómo debe ejecutar el
MCP el efecto de una aprobación) o un cambio que cruza módulos — fuera del criterio "≤ pocas
líneas y sin ambigüedad".

## Recomendación

**Sí, Ernesto puede usarla en local**, con estas condiciones operativas hasta cerrar Q1/Q2:
1. **Aprobar el Gate 2 (efectos externos) solo por la UI/API**, nunca por MCP admin
   (`agentos.approvals.decide` sobre un `tool_call` deja la tarea muerta) — Q2.
2. **No dejar a los agentes cerrar entregables sin vigilancia**: mientras Q1 siga abierto,
   `org_profile`/`process_map`/`leak_analysis`/`iso_gap` pueden ir a DONE sin QA ni humano;
   revisar el tablero o cerrar Q1 antes de operar en desatendido.
3. Correr MCP admin y la API **contra la misma DB** es correcto funcionalmente (WAL +
   busy_timeout), pero conviene tratar formalmente al MCP admin como segundo escritor
   (mover la reconciliación de aprobaciones al core, Q2) — es el habilitador de Q2/Q3.

Prioridad de arreglo: **Q2 y Q1 antes del primer engagement real desatendido**; Q4/Q5
oportunistas.
