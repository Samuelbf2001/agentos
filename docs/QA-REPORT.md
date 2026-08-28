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

### Q1 — ALTA · Un agente auto-cierra entregables a DONE saltándose REVIEW, Quinn y el humano — **CORREGIDO** (B8 paso 3)

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

**Fix aplicado (B8 paso 3):** se unificaron las dos listas en UNA sola fuente en
core: `QUINN_REVIEWED_ACTIVITY_TYPES` (`packages/core/src/board/policy.ts`).
`computeRequiresApproval` ahora la incluye ⇒ todo entregable que Quinn revisa
tiene `requires_approval=true` y un agente NO puede llevarlo directo a DONE
(`moveTask` lanza `human_approval_required`); llega solo hasta REVIEW, donde Quinn
critica y el humano cierra. El despachador (`DEFAULT_QUINN_ACTIVITY_TYPES` en
`apps/api/src/dispatcher.ts`) ahora deriva su lista de esa MISMA constante, así
política y auto-crítica no pueden volver a desincronizarse (cambio en un solo
lugar). Cubre los cuatro tipos que fallaban (`org_profile`, `process_map`,
`leak_analysis`, `iso_gap`) más `report`/`roadmap`/técnicos. **Tests** en
`packages/core/test/policy.test.ts`: cada tipo sensible IN_PROGRESS→DONE por un
agente → `human_approval_required` (y sí llega a REVIEW); un tipo no sensible
(`research`) sigue pudiendo ir directo a DONE.

---

### Q2 — ALTA · Decidir una aprobación por el MCP admin no reconcilia la tarea (Gate 2 queda huérfano) — **CORREGIDO** (B8 paso 3)

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

**Fix aplicado (B8 paso 3) — dónde quedó la costura:** se extrajo la
reconciliación a UNA función compartida de core,
`engine.reconcileDecidedApproval(approvalId, deps)`
(`packages/core/src/board/engine.ts`), separada de `decideApproval` (que solo fija
el estado). Como ejecutar el efecto externo vive en `apps/api` (gateway de tools +
despachador) y el MCP admin es **otro proceso sin ese runtime**, se eligió la
opción de **encolar la reconciliación como trabajo que el despachador drena**:
  - `decideApproval` (core) SOLO fija el estado. La reconciliación es un paso aparte
    con un flag durable nuevo `approvals.reconciled_at` (migración
    `0001_vengeful_spirit`), reclamado atómicamente (`claimApprovalReconciliation`)
    ⇒ el efecto externo se ejecuta **exactamente una vez**.
  - El **route REST** (`apps/api/src/routes/ops.ts`) decide y llama
    `dispatcher.reconcileApproval(id)` en línea (comportamiento idéntico al previo).
  - El **MCP admin** sigue llamando solo `engine.decideApproval` (capa fina): deja
    `reconciled_at=NULL`, y el **tick del despachador** (`reconcilePendingApprovals`
    en `apps/api/src/dispatcher.ts`, dren en cada `tick()`) recoge esas decisiones,
    ejecuta el efecto del `tool_call` (`toolRuntime.executeApproved`) y encola el
    resume (`enqueueApprovalResume`), o desbloquea la tarjeta de pregunta/entregable.
    **Nada queda huérfano** aunque se apruebe por MCP. Las deps de ejecución se
    inyectan (core no depende de `@agentos/tools`, sin ciclo).
  - Se levanta la condición operativa previa: **el Gate 2 ya se puede aprobar por
    MCP admin** (el despachador de apps/api debe estar corriendo, que es lo normal).
**Test** en `apps/api/test/approvals.test.ts`: se decide por la vía del MCP
(`engine.decideApproval` directo); antes del tick el efecto NO se ejecutó y la
tarea sigue BLOCKED; un `dispatcher.tick()` ejecuta `email.send` (stub `simulated`),
saca la tarea de BLOCKED y crea el run de reanudación con `resume_of_run_id`.

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

### Q4 — BAJA · `verifyToken` no revalida que la persona exista / siga interna — **CORREGIDO** (B8 paso 3)

**Vector:** auth. `apps/api/src/auth.ts` `verifyToken` valida firma + expiración pero
**no** consulta `people`. Un token firmado de una persona luego eliminada o desactivada
sigue válido hasta `exp` (7 días). No es escalada externa (forjar exige el secreto de
firma, derivado de la contraseña compartida), pero un interno deprovisionado conserva
acceso. **Fix:** en el hook `onRequest` (`server.ts`), tras `verifyToken`, exigir
`getPerson(personId)?.isInternal`.

**Fix aplicado (B8 paso 3):** el hook `onRequest` de `apps/api/src/server.ts` ahora,
tras `verifyToken`, consulta `getPerson(ctx.db, session.personId)` y solo fija
`req.session` si `person?.isInternal`; si no, cae al 401 (fail-closed). **Test** en
`apps/api/test/rest.test.ts`: token de una persona interna vale; tras
`updatePerson(..., { isInternal:false })` el MISMO token deja de valer (401).

### Q5 — BAJA · `order_key` sin restricción de unicidad → empates al crear en paralelo — **DIFERIDO** (B8 paso 3)

**Vector:** concurrencia/orden. `nextOrderKey` hace `SELECT max(order_key)…` y suma 1 char;
`order_key` solo tiene índice, no `unique` (`packages/db/src/schema.ts`). Con los dos
escritores creando tareas en la misma columna a la vez, pueden salir `order_key` iguales →
empate de orden (cosmético; el `reorder` sí va con `expected_version`, así que ese camino
resiste). **Fix:** clave fraccionaria entre vecinos reales o `unique(project_id,status,
order_key)` con reintento.

**Decisión (B8 paso 3): DIFERIDO — un `unique` rompería flujos legítimos.** El
`order_key` se asigna UNA vez al crear (según el estado de creación: BACKLOG en
`createTask`, READY en `delegate`) y `moveTask` **no lo reescribe** al cambiar de
columna. Además `nextOrderKey` reinicia a `"m"` cuando la columna queda vacía. Por
tanto dos tareas creadas en momentos distintos pueden acabar con el MISMO
`(project_id, status, order_key)` tras moverse entre columnas de forma
perfectamente normal (p. ej. T1 nace "m" en BACKLOG y pasa a READY; luego T2 nace
"m" en BACKLOG y pasa a READY → colisión en READY). Un
`unique(project_id, status, order_key)` haría **fallar `moveTask`** (SQLITE_CONSTRAINT)
en transiciones legítimas — rompería la máquina de estados. Un `unique(order_key)`
global rompería el reordenamiento fraccionario, que reutiliza deliberadamente el
espacio lexicográfico. El empate real solo aparece con dos escritores creando en la
MISMA columna a la vez, es **cosmético** (orden lexicográfico estable como
desempate secundario por `id` implícito) y el `reorder` ya resiste vía
`expected_version`. Cerrar Q5 bien exige reescribir `order_key` en cada transición
(clave fraccionaria entre vecinos reales del destino) — cambio de mayor alcance,
fuera del criterio "trivial y sin ambigüedad". Se difiere.

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
  segundo proceso escritor (MCP admin) hacía posible. + test de regresión.

### Cierre B8 paso 3 (corrector final de integridad)

- **Q1 (ALTA) — CORREGIDO.** Lista única en core `QUINN_REVIEWED_ACTIVITY_TYPES`
  (`policy.ts`) usada por `computeRequiresApproval` Y por la auto-crítica de Quinn
  del despachador: todo entregable revisable por Quinn exige REVIEW+aprobación; un
  agente ya no puede llevarlo directo a DONE. +3 tests.
- **Q2 (ALTA) — CORREGIDO.** Reconciliación post-decisión extraída a
  `engine.reconcileDecidedApproval` (core, deps inyectadas). REST la ejecuta en
  línea; el MCP admin solo fija el estado y el **despachador de apps/api la drena**
  (`reconcilePendingApprovals` en cada `tick`), con flag durable `reconciled_at`
  (migración 0001) reclamado atómicamente (efecto exactamente-una-vez). Nada queda
  huérfano al aprobar por MCP. +1 test.
- **Q4 (BAJA) — CORREGIDO.** `onRequest` revalida `getPerson(personId)?.isInternal`
  en cada request. +1 test.
- **Q5 (BAJA) — DIFERIDO.** Un `unique(project_id,status,order_key)` rompería
  `moveTask` (el `order_key` se asigna al crear y no se reescribe al cambiar de
  columna, y `nextOrderKey` reinicia a "m" al vaciarse la columna) y un `unique`
  global rompería el reordenamiento fraccionario; el empate es cosmético y el
  `reorder` ya resiste por `expected_version`. Ver detalle en Q5.

Suite completa: **verde** (`pnpm -r test`), `pnpm -r typecheck` exit 0.

## Recomendación

**Sí, Ernesto puede usarla en local.** Las dos condiciones operativas previas
(Q1/Q2) quedan **cerradas**:
1. El **Gate 2 (efectos externos) ya se puede aprobar por MCP admin** además de por
   la UI/API: el despachador de apps/api reconcilia la decisión (ejecuta el efecto y
   reanuda) — requiere que apps/api esté corriendo, que es lo normal. (Q2 cerrado.)
2. Los agentes **ya no pueden cerrar entregables sin gate**:
   `org_profile`/`process_map`/`leak_analysis`/`iso_gap`/`report`/`roadmap` exigen
   REVIEW + aprobación humana; Quinn los critica en REVIEW. (Q1 cerrado.)
3. Correr MCP admin y la API **contra la misma DB** es correcto (WAL + busy_timeout);
   el MCP admin queda formalmente tratado como segundo escritor que **solo decide**,
   delegando la ejecución del efecto al dueño del runtime (apps/api) — habilitador de
   Q2/Q3 resuelto.

Pendiente oportunista: **Q5** (order_key), diferido con motivo documentado.
