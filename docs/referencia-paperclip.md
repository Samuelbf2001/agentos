# Referencia: Paperclip (paperclipai/paperclip) — síntesis

> Síntesis del orquestador (2026-08-28) sobre tres exploraciones a nivel de código (clon en scratchpad/refs/paperclip). Paperclip es un **plano de control** que orquesta agentes ya construidos como una "empresa": la referencia más cercana a AgentOS en gobernanza organizacional.

## Hallazgos clave

**1. Modelo de empresa.** `companies` (tenant raíz con presupuesto mensual) → `agents` con `role`, `reports_to` (self-FK = organigrama) y presupuesto propio. Lo load-bearing: **la salud de la cadena jerárquica gobierna la asignabilidad** — un agente con ancestro terminado/faltante/ciclo no puede recibir trabajo aunque esté activo (`agent-eligibility.ts`, `agent-assignability.ts`); terminar un manager invalida todo su subárbol. La jerarquía también es autorización (un manager actúa sobre su subárbol). `goals` jerárquicas (company→team→agent→task) con **fallback en cascada**: ningún issue queda sin meta (`issue-goal-fallback.ts`).

**2. Issues.** Estados planos (7), `status_version` (optimistic locking), asignación única XOR agente/humano, locks de ejecución (`checkout_run_id` ≠ `execution_run_id`), `origin_fingerprint` con únicos parciales anti-duplicado, `request_depth` con tope, dependencias `blocks`, **descomposición formal plan→hijos** (`issue_plan_decompositions`) y **holds de árbol** (pausar/cancelar subárboles completos cancelando runs vivos).

**3. Ejecución.** Adapter contract mínimo (2 métodos: `execute`, `testEnvironment` + capacidades opcionales); `claude-local` lanza el CLI con `--print --output-format stream-json --resume --append-system-prompt-file` y **`--mcp-config --strict-mcp-config`** (config MCP gobernada forzada). **Heartbeat = un turno de trabajo**: wakeups en cola idempotente con coalescing (`agent_wakeup_requests`), invocados por asignación/dependencia-resuelta/decisión/cron. Liveness semántica (`plan_only`/`empty_response` → continuaciones acotadas), watchdogs de subárboles detenidos, ledger cerrado de recursos con orden fijo de liberación.

**4. Gobernanza de tools.** Application→Connection→Catalog(riesgo)→Profile→Policy: *el profile dice si el agente VE la tool; la policy si ESTA llamada pasa AHORA*. Deny gana; tool write/destructive nueva → **quarantine automática**; aprobación ligada a hash de argumentos+schema (`signed_arguments_mismatch` si cambian), promovible a trust_rule; `change-consent-gate`: un agente no cambia su propio perfil sin confirmación humana consumida una sola vez.

**5. Contexto/memoria (lo prioritario para Ernesto).** **No hay RAG**: la memoria de la empresa ES el plano de control estructurado — documentos vivos por issue con revisiones, `continuation-summary` (memoria entre turnos), work products tipados, decisiones con snapshots anti-staleness, búsqueda facetada SQL. Ensamblado de contexto por turno con **topes duros de caracteres y redacción por nivel de confianza de fuente** (anti prompt-injection). **Metodología = skills por empresa con políticas por rol** (`company-skills.ts` + `company-skill-policy.ts`). Equipos como **plantillas markdown validadas** (`teams-catalog`: TEAM.md + agents/AGENTS.md con reports_to + PROJECT.md + TASK.md + .paperclip.yaml), compiladas y seedeadas al onboarding.

**6. Dashboard.** WS por compañía (EventEmitter en proceso, **sin persistencia del bus → sin resume**; nuestro diseño es superior ahí). Cliente: snapshot REST + delta optimista + invalidación coalescida al reconectar. Vistas: dashboard resumen (agents/tasks/costs/pendingApprovals + actividad por día), kanban, org chart SVG, **"What needs me"** (feed de atención con sourceKind/severity/decideBy), timeline Gantt, costes por agente/proveedor/proyecto con políticas de presupuesto e incidentes que pausan agentes, run-log NDJSON por run con `afterSeq`.

## Adoptamos / Adaptamos / Descartamos

| Decisión | Qué | Estado en AgentOS |
|---|---|---|
| ADOPTAMOS | Contexto por turno con topes duros + redacción por confianza de fuente | Ensamblado en core/prompt (capa volatile) — pendiente afinar en B7b |
| ADOPTAMOS | Metodología como datos versionados por empresa con política por rol | Ya: tabla `methodologies` + allowlists por agente |
| ADOPTAMOS | Aprobación ligada a digest de argumentos | Ya: `approvals.action_digest` |
| ADAPTAMOS | Salud de cadena → asignabilidad y "goal fallback" (nada huérfano) | Fase 2 (cuando haya jerarquía real de agentes; hoy roster plano con Alex orquestador) |
| ADAPTAMOS | Holds de árbol (pausar/cancelar subárbol de tareas con sus runs) | Fase 2; hoy: kill switch global + pausa por agente |
| ADAPTAMOS | "What needs me" con severidad/decideBy + badges | B5 lo implementa como "Esperando por ti"; severidad en fase 2 |
| ADAPTAMOS | Plantillas de equipo markdown (roster Sixteam como manifiesto instalable) | Ya cerca: agents/*.md; empaquetado TEAM.md en fase 2 |
| ADAPTAMOS | Presupuestos con incidentes que pausan agentes | Hoy corte duro por run/día; incidentes visibles en fase 2 |
| DESCARTAMOS | Bus WS sin persistencia | Nuestro bus persiste + since_seq (superior) |
| DESCARTAMOS | Better Auth/SSO, multi-company, quarantine/CEL completos | Sobredimensionados para MVP; el gateway fail-closed cubre lo esencial |

## Impacto en AgentOS (resumen)

1. Valida el rumbo: plano de control + tablero como fuente de verdad + metodología como datos.
2. Roadmap fase 2 claro: jerarquía `reports_to` con salud de cadena, goals con fallback, holds de árbol, severidad en atención, presupuestos con incidentes, empaquetado de equipo.
3. Refuerzo inmediato aplicable en B7b: topes duros de caracteres en la capa volatile del prompt y redacción por confianza de fuente al inyectar contexto del cliente.
