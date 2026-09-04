# Evaluación del proyecto — AgentOS Sixteam

> Fecha: 2026-09-03. Autor: sesión orquestadora (2brain-04). Base verificada: master `cf9d822` (47 commits, 2026-08-27/28) + árbol de trabajo con cambios sin commitear de otra sesión (2026-09-01→03). Todo número de este documento se midió en esta evaluación, no se copió de reportes.

## 1. Veredicto en una frase

**La plataforma existe, funciona de verdad y está mejor de lo prometido en el PRD original — pero hoy vive en dos mitades: una commiteada y verificada (master), y otra de ~2.700 líneas sin commitear en el worktree principal que está verde pero que nadie más que su autor puede reclamar.** Lo primero es un activo; lo segundo es una deuda de proceso que hay que cerrar esta semana.

## 2. Qué se prometió y qué hay (contra el pedido original)

| Pedido de Ernesto (2026-08-27) | Estado | Evidencia |
|---|---|---|
| Agentes trabajadores especializados, conectados, con tools | ✅ | 7 agentes, 27 tools de agente por gateway fail-closed, jerarquía `reports_to` |
| Tablero central que los agentes mueven solos, visible en vivo | ✅ | Kanban 7 estados + claim atómico + WS con resume; demo E2E real (docs/DEMO-E2E.md) |
| Chat web primero, WhatsApp después | ✅ / ⏳ | Canal `web` implementado sobre el contrato de gateway; adaptador WhatsApp no construido |
| Usar la suscripción de Claude Code + otros proveedores | ✅ | ClaudeCodeRunner (suscripción Max individual, confirmado) + AiSdkRunner (OpenAI/Kimi/MiniMax/GLM como dato) |
| MCP "súper potente" que edite casi todo | ✅ | 74 tools `agentos.*`, perfiles rw/ro, prompts versionados con rollback, auditoría |
| PRD antes de construir + skill de desarrollo con IA | ✅ | PRD.md, ARCHITECTURE.md, PRD-modulos-fase.md; skill `desarrollo-con-ia` |
| Agente dedicado a pruebas/bugs | ✅ | Quinn (en producto) + QA adversario (docs/QA-REPORT.md) |
| Consultoría de procesos / ISO 9001 / transformación / operación | ✅ | 3 módulos de fase disparables, 5 metodologías (ISO 9001 cláusulas 4–10) |
| Contexto de la empresa organizado como activo (pedido del 08-28) | ✅ | Context Hub (knowledge_docs/processes/methodologies) + provenance `[doc:id]` |
| Unir reuniones y WhatsApp de 2brain a proyectos (pedido del 08-28) | ✅ / ⚠️ | Conector + `project_sources` + UI; falta `AGENTOS_WHATSAPPHUB_KEY` para el smoke real |
| Jerarquía · ISO profundo · Supabase (pedido del 08-28) | ✅ · ✅ · ⚠️ | Postgres+pgvector como capa de datos probada; **la app no corre end-to-end en Postgres** |
| Módulos de fase configurables y disparables (pedido del 08-28) | ✅ | Wizard real: cliente nuevo → 13 tareas en 29 ms, idempotente, 3 runs `succeeded` |

## 3. Métricas medidas hoy

| Métrica | master `cf9d822` | árbol de trabajo (con lo no commiteado) |
|---|---|---|
| Tests | 513 ✅ + 28 skip (PG) + 1 skip | **545 ✅ + 29 skip**, typecheck 0 errores |
| Tablas | 23 (migraciones 0000–0004) | 25 (0005 `task_assignees`, `task_notification_log`) — **ya aplicada a la DB viva** |
| Paquetes | 11 | 12 (+ `packages/notion-migration`) |
| Tools MCP admin / de agente | 74 / 27 | 74 / 27 (+ `tasks.assign_people`, `tasks.set_due_date` según su PRD) |
| Coste real de verificación en vivo | demo E2E $6.48 + reanudación $1.43 + launch Textiles $1.46 | — |

## 4. Calidad: lo que aguanta y lo que no

**Aguanta (verificado con ataque, no con fe):** perfil `ro` del MCP sin fuga de secretos, Gate 2 ligado a digest de argumentos, claim atómico bajo carrera (8 clientes concurrentes en PG), durabilidad ante reinicio (aprobaciones pendientes sobreviven), kill switch en <10 s, límites de delegación y presupuesto.

**Bugs reales que solo aparecieron en vivo** (los tests con fixtures no los vieron): `workspace_path` sin sanear (nombre de cliente con punto final → spawn del runner roto en Windows; un test *fijaba* el bug), `count(*)` bigint como string en Postgres, contexto de chat sin `project_id` real (Alex inventaba ids). Todos corregidos con test de regresión. **Lección institucionalizada** en la skill y en `CLAUDE.md`: verificar con datos con forma real antes de declarar "hecho".

**Deuda técnica conocida:** Postgres sin conectar (repos síncronos vs asíncronos; motor de launch no portado); `order_key` sin `unique` (Q5, diferido con motivo); `projects.create` sin approval (H12); aprobación de Gate 2 por MCP probada solo en tests; ruido de CRLF en `git diff` (falta `.gitattributes` con `eol=lf`).

## 5. Hallazgo de proceso: el trabajo paralelo sin commitear

Otra sesión construyó entre el 01 y el 03 de septiembre, **directamente en el worktree principal y sin commitear**:

- **Módulo operativo de Proyectos y Tareas** (docs/PRD-MODULO-PROYECTOS-TAREAS.md, plan en 5 oleadas): responsables humanos múltiples (`task_assignees`), vencimientos expuestos, dos avisos de correo con proveedor falso por defecto, vista "Brain" y "Mis tareas". Oleadas 1–3 aparentemente hechas; oleada 4 (QA independiente, descriptor en docs/CLAUDE-QA-MODULO-PROYECTOS-TAREAS.md) pendiente.
- **`packages/notion-migration`**: snapshot inmutable de las bases Tasks/Projects de Notion, solo lectura, nada escrito aún; tokens solo por variable de entorno (verificado: sin secretos en el árbol).
- **Despliegue**: `Dockerfile.api`, `Dockerfile.web`, `deploy/`, plan de EasyPanel como sistema aislado (no ejecutado).

**Está verde** (545 tests, typecheck limpio) y respeta las invariantes del tablero según su PRD. Los problemas son de proceso, no de código:

1. Tres días de trabajo sin un solo commit → no hay recibo, no hay rollback, y cualquier otra sesión (esta incluida) no puede saber a ciencia cierta qué es intencional.
2. La migración 0005 **se aplicó a la DB viva** sin que el esquema estuviera commiteado: la DB va por delante del repositorio.
3. Rompe la regla acordada entre sesiones (worktree por rama, DB viva intocable, aviso antes de tocar áreas compartidas). Esa regla ahora está escrita en `CLAUDE.md` del proyecto para que la lea cualquier sesión que entre.

**Acción recomendada (esta semana):** esa sesión (o Ernesto) commitea en una rama `feat/modulo-proyectos-tareas` con su suite verde, corre la QA independiente ya descrita, y el dueño de master mergea tras verificar. Hasta entonces, nadie más debería tocar `apps/api/src/routes/board.ts`, `TaskDrawer.tsx`, `BoardView.tsx` ni los repos de tareas.

## 6. Qué falta respecto a la visión completa

Ordenado por valor/esfuerzo:

1. **Cerrar el módulo de Proyectos/Tareas** (ya construido; falta commit + QA + merge). Esfuerzo bajo, valor alto: es la superficie que el equipo humano va a usar a diario.
2. **Activar la ingesta real de 2brain**: poner `AGENTOS_WHATSAPPHUB_KEY` y hacer un smoke con una reunión real. Esfuerzo mínimo.
3. **Decisión de producto pendiente**: `requiresApproval` 2→7 en bases nuevas (recomiendo mantenerlo: es la política real aplicándose; revert de una línea si se prefiere menos fricción en demos).
4. **Higiene de repo**: `.gitattributes` (`* text=auto eol=lf`) para acabar con el ruido de CRLF, y un script `pnpm verify` (typecheck + test) que sea la definición única de "verde".
5. **Despliegue en EasyPanel**: el plan es sensato (sistema aislado, SQLite en volumen primero). No requiere Postgres para arrancar. Ojo al VPS actual (CPU steal ~92%): conviene otro VPS o aceptar latencia.
6. **Canal WhatsApp**: el contrato de gateway está diseñado para esto; es un proceso adaptador nuevo, cero cambios en núcleo.
7. **Postgres end-to-end**: solo cuando se dispare uno de los cinco criterios de ARCHITECTURE §5 (multi-escritor, remoto concurrente, >5 GB, RLS por cliente, vectorial). Hoy ninguno se ha disparado.
8. **Roadmap de producto**: entrevistas IA masivas, MCPs externos (Notion/GHL/Apollo), catálogo completo de ~50 actividades, auto-mejora de prompts con revisión humana, portal del cliente.

## 7. Cómo se construyó (para repetirlo)

PRD-first con investigación previa (Hermes, agentesdeventas, web, OpenBot/OpenMausBot, Paperclip), **misma tarea de diseño a Opus y a Codex sin verse** y síntesis del orquestador; construcción por bloques con subagentes de perímetro estricto; QA adversario dedicado; verificación en vivo con presupuesto; coordinación entre dos sesiones de Claude por worktrees, índices de migración repartidos y aviso antes de cada merge. Lo que funcionó y lo que no está en la skill `desarrollo-con-ia` y en `CLAUDE.md`.

## 8. Documentación actualizada en esta evaluación

`README.md` (estado, arranque, variables nuevas, pendientes reales), `docs/TASKS.md` (fase 2 con commits, trabajo en curso ajeno, pendientes), `docs/PRD.md` (estado de fase 2 al 03-09, nota de suscripción), `CLAUDE.md` del proyecto (nuevo: reglas duras para cualquier sesión), skill `desarrollo-con-ia` (lecciones), memoria del proyecto. **No se tocaron** `docs/ARCHITECTURE.md` ni `docs/POSTGRES.md` porque tienen ediciones sin commitear de la otra sesión (adenda Postgres, 25 tablas): se consolidan cuando esa sesión commitee.
