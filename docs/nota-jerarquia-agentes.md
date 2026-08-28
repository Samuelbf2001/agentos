# Nota — Jerarquía de agentes (Fase 2)

> Nota del constructor de `feat/jerarquia-agentes` (2026-08-28). Decisiones de diseño
> de la jerarquía de mando `reports_to`, inspirada en Paperclip §modelo de empresa y
> adaptada a la escala del roster Sixteam.

## Qué se implementó

1. **Esquema.** `agents.reports_to` (self-FK nullable) + migración drizzle `0002_jerarquia_reports_to`
   (ADD COLUMN limpio). Semilla: frontmatter `reports_to:` en `agents/*.md` + segunda pasada
   en `seed.ts` que resuelve slug→id (idempotente, no re-escribe si ya es correcto).
2. **`packages/core/org.ts`.** `getChainOfCommand`, `computeOrgChainHealth`
   (healthy | terminated_ancestor | missing_manager | cycle), `wouldCreateCycle`/`assertNoCycle`
   (tope anti-ciclo `MAX_CHAIN_DEPTH=64`), `orgForCompany` (bosque agrupado por manager).
3. **Asignabilidad gobernada.** `assertAgentCanRun` (motor) lanza `agent_not_assignable`
   (nuevo `ErrorCodes.AGENT_NOT_ASSIGNABLE`, con `reason`) si la cadena está rota;
   `isAgentAssignable`/`orgChainHealth` expuestos en `BoardEngine`. El despachador de
   `apps/api` usa `isAgentAssignable` en las tres vías (despacho de tarea, reanudación de
   aprobación, auto-crítica de Quinn): una cadena rota espera igual que un agente pausado.
4. **MCP + API.** `agentos.agents.set_manager` y `agentos.agents.org` en mcp-admin;
   `GET /api/agents/org` (árbol + salud por agente) en apps/api.

## Decisiones (las que el encargo pedía documentar)

### Quinn: raíz meta (reports_to = null)

Quinn es la capa **meta** (crítico adversario / QA). Se decidió que sea **raíz independiente**,
no report de Alex, por **independencia del auditor**: la asignabilidad de Quinn no debe depender
de la salud de la cadena operacional que él mismo audita. Pausar a Alex (raíz operacional) NO
debe desactivar la QA. Refuerzos: Quinn es el único agente con `autonomy: auto` y su capa `meta`
es semánticamente distinta de las capas operativas (consultoría/implementación/operación) que sí
cuelgan de Alex. Resultado: **bosque de dos raíces** — Alex (operacional) y Quinn (meta).

### Cascada: por CÁLCULO, no persistida

Al pausar/archivar un manager, sus reports quedan **no-ejecutables por cálculo**
(`computeOrgChainHealth` los ve `terminated_ancestor`), **sin** mutar el `status` de las filas de
los reports. Ventajas: (a) reversible — reactivar al manager restaura todo el subárbol sin tocar
nada; (b) no se pierde el estado original de cada report; (c) una sola fuente de verdad. Se
verifica en tests que el report sigue `active` en su fila mientras su cadena está rota.

### Metas jerárquicas (`goals`): DIFERIDO (propuesta escrita)

No entró en esta fase para no dejarlo a medias. Propuesta para una fase siguiente:

- Tabla `goals(id, scope['company'|'agent'], agent_id?, parent_id?, title, body, created_at)`.
- **Fallback en cascada** (estilo `issue-goal-fallback` de Paperclip): al crear/mover una tarea sin
  meta explícita, se hereda la meta del agente asignado → la de su manager (subiendo la cadena de
  mando ya existente) → la meta company. Invariante: **ninguna tarea/proyecto sin meta**.
- Reutiliza `getChainOfCommand` de `org.ts` para el ascenso del fallback (ya está listo).
- Exponer en `GET /api/agents/org` (o `/api/goals`) y una tool `agentos.goals.*`.

## Pendiente para el merge

- (Opcional) Aristas tenues de jerarquía en el Enjambre de `apps/web` — no se tocó la UI.
- `goals` según la propuesta de arriba, si se prioriza.
- Nota: en `apps/mcp-admin` hay **2 tests que ya fallaban en master** (`system.pause_all` y
  `system.health` esperan `kill_switch=false` pero el seed arranca con el kill switch activo por
  diseño). No los toca esta rama; conviene actualizarlos aparte.
