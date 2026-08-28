# Brief de investigación — Plataforma de agentes trabajadores Sixteam ("AgentOS")

> Consolidado 2026-08-27 por el orquestador a partir de 4 investigaciones (web Sixteam, repo Hermes, repo agentesdeventas, estado del arte SDKs). Insumo para el PRD y la arquitectura.

## 1. Visión del negocio (pedido de Ernesto/Samuel, Sixteam)

Construir una plataforma donde **agentes trabajadores de IA especializados**, conectados entre sí y con herramientas, repliquen la operación de Sixteam como un **ecosistema de trabajo agéntico**. El servicio que la plataforma debe soportar (el "trabajo" de los agentes):

1. **Consultoría de procesos**: llegar a una empresa cliente, hacer entrevistas, mapear procesos, proponer mejoras, preparar para certificación **ISO 9001**, y diseñar su transformación digital.
2. **Implementación**: convertir esos procesos en plataformas, software a la medida y/o agentes.
3. **Operación y soporte** continuo de esas soluciones.

Esto calza exactamente con la narrativa pública de la web de Sixteam: **Entender → Construir → Operar** (productos: Sixteam Assessment $2,500 / Sixteam Transform desde $1,500 / Sixteam Ops desde $299/mes). Nota: ISO 9001 NO aparece hoy en la web ni en los docs comerciales — es capacidad nueva a incorporar.

Requisitos explícitos del usuario:
- Canal inicial: **chat web**. WhatsApp y otros canales después (diseñar el gateway para eso).
- Los agentes deben poder usar la **suscripción de Claude Code** como fuente de LLM, pero listos para conectar **OpenAI, Anthropic API, Kimi, MiniMax, GLM**, etc.
- **Visual**: ver cómo los agentes funcionan e interactúan, y cómo mueven tareas en un **tablero de tareas central** (kanban).
- Un **MCP súper potente** que permita "editar casi todo" (agentes, prompts, tareas, tablero, configuración) desde fuera.
- Escala pequeña primero (una empresa, pocos engagements) — stack ágil, no sobre-ingeniería para 1000 empresas.
- Orquestador (Claude) + subagentes para trabajo pesado + **al menos un agente dedicado a pruebas/encontrar bugs**.

## 2. Roster de agentes canónico (de la web V2, `src/pages/v2/Equipo.tsx`)

Por capa: **Consultoría**: Alex (Estratega & Concierge IA), Sam (Diagnóstico IA). **Implementación**: Debbie (Constructora de Sistemas), Vinnie (Integraciones). **Operación**: Sally (Operadora de Revenue), Clara (Analista). Humanos: Samuel (Revenue Strategist), Ernesto (Process Engineer). Equipo real para asignaciones: Samuel, Sebastián, Jorge, Jefferson, Ernesto.

Proceso operativo publicado: "Tú pides (Slack/WhatsApp/Loom) → decidimos si lo hace IA o humano → te llega hecho". Cadencia: reporte lunes 9am, sprint semanal, agentes 24/7. Assessment: kickoff → mapeo agéntico con entrevistas IA a todo el equipo → análisis de fugas → roadmap (14 días).

## 3. Blueprint Charlie (repo `agentesdeventas`, doc `agente-prospeccion-autonomo.md`) — patrón a generalizar

- Arquitectura **Orquestador + subagentes especializados** (Sourcer, Enricher, Analyst, Copywriter, Dispatcher, Monitor).
- **Tools tipadas** estilo function-calling (`apollo.search_people`, `ghl.upsert_contact`, `tasks.create`…).
- **Máquina de estados por entidad** (DESCUBIERTO → ENRIQUECIDO → CALIFICADO → APROBADO → EN_SECUENCIA → HOT/HANDOFF) con **2 gates humanos**.
- Guardrailes: opt-out irreversible, anti-alucinación con fuente citada ("frame fijo + slots generados con fuente verificable"), kill switch.
- Stack ya decidido allí: **Claude Agent SDK + MCP servers + Supabase**.
- Catálogo de ~50 actividades operativas por pilar (Marketing/Sales/Service/Reporting Ops) en `.claude/skills/sixteam-comercial/SKILL.md` — sirve como taxonomía de tareas del tablero.
- Agente de voz **Sofia** en producción (GHL) con prompt de 6 secciones; distingue CASO OPS vs CASO TRANSFORMACIÓN — reutilizable como segmentación de diagnóstico.

## 4. Patrones portables de Hermes (`C:\Users\samue\hermes`, Python)

1. **Abstracción de proveedor**: `agent/transports/base.py` — 4 métodos (`convert_messages → convert_tools → build_kwargs → normalize_response`) + registry; transports anthropic/chat_completions/bedrock intercambiables.
2. **Prompt en 3 capas** (`agent/system_prompt.py`): stable (identidad/SOUL.md + guías tools/skills) / context (AGENTS.md) / volatile (memoria, USER.md, timestamp) — orden deliberado para prefix cache.
3. **Persistencia**: SQLite WAL, tablas `sessions` (tokens/coste/parent_session_id) y `messages`, FTS5 espejo por triggers para búsqueda de conversaciones a coste-cero de LLM.
4. **Auto-mejora**: `agent/background_review.py` (fork del agente post-turno con tools restringidas a memoria+skills) + `agent/curator.py` (mantenimiento periódico, nunca borra, archiva).
5. **Gateway multi-canal**: `gateway/platforms/base.py` (ABC `BasePlatformAdapter`: MessageEvent, streaming de borradores, typing, media) + registry de adaptadores; incluye servidor OpenAI-compatible.
6. **Cron consent-first**: automatizaciones se sugieren, nunca se auto-crean (máx 5 pendientes, dedup).

## 5. Estado del arte (investigación web, ago-2026)

- **CopilotKit** (MIT, ~37k★): componentes React de chat con streaming, generative UI, state streaming (`useCoAgent`) y human-in-the-loop; runtime Node. Creadores del **protocolo AG-UI** (eventos estándar agente↔UI, agnóstico de framework, SDK TS `@ag-ui/*`). Se integra con backend Node propio SIN LangGraph: el orquestador emite eventos AG-UI. `open-multi-agent-canvas` (ahora en el monorepo) sirve como referencia de UX multi-agente+MCP.
- **GrokBot**: no hay repo canónico maduro; solo inspiración conceptual (agentes persistentes 24/7 con sandbox).
- **Claude Agent SDK TS** (`@anthropic-ai/claude-agent-sdk`): maduro. `agents` (subagentes), `tool()` + `createSdkMcpServer()` (MCP in-process), `mcpServers` externos, `hooks`. Varios `query()` concurrentes por proceso Node (cada uno hace spawn de un proceso hijo de Claude Code — coste CPU/RAM por agente). Autenticación por suscripción: `claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN` (1 año, requiere Pro/Max/Team). **Caveat de términos (feb-2026)**: la suscripción es individual; uso multi-usuario del equipo por un solo seat viola ToS → para equipo: API key de Console o seats Team. Diseñar el proveedor como intercambiable.
- **Multi-proveedor**: Kimi (`api.moonshot.ai/v1`), MiniMax (`api.minimax.io/v1`), GLM/Z.ai (`api.z.ai/api/paas/v4`) son OpenAI-compatibles. Recomendación: **Vercel AI SDK** (`@ai-sdk/openai` + `createOpenAICompatible`) — interfaz única tipada con streaming y tool-calling; sin OpenRouter (fee+latencia innecesarios a esta escala).
- **Metodología**: GitHub **Spec Kit** (spec-driven): constitution → specify (qué/porqué, sin stack) → plan (cómo) → tasks → implement. PRD mínimo: contexto/porqué, user stories con criterios de aceptación verificables, NFRs, spec≠plan.

## 6. Plan previo de 2brain (jul-2026, `2brain/docs/plan-ecosistema-agentes.md`)

Decisiones aún válidas como inspiración: tabla `agents` declarativa ("Agent Card": slug, status, system_prompt, model, tools JSONB, mcp_servers con allowlist, triggers, limits); `McpToolProvider` cliente MCP con namespacing `mcp__server__tool`; cola `agent_tasks` + tool `delegar_a_agente` (handoffs explícitos como tarea con payload, NO A2A); observabilidad `run_id`/`parent_run_id` (spans estilo OTel GenAI sin adoptar OTel); visual = mapa por capas + panel de detalle (no editor de flujo). AQUELLA restricción de "construir dentro de WhatsAppHub" ya NO aplica: esta plataforma es nueva e independiente.

## 7. Restricciones de entorno

- Desarrollo en Windows 11 (esta máquina). Deploy futuro probable: VPS con EasyPanel/Docker (ojo: el VPS actual de Hostinger sufre CPU steal ~92% — no asumir que aguanta; el deploy no es parte del MVP).
- Escala: 1 empresa (Sixteam) + primeros clientes. SQLite es aceptable y preferido al inicio; Supabase/Postgres como camino de crecimiento.
- Presupuesto de tokens: la suscripción de Claude Code de Ernesto (uso personal) + API keys que se añadan después.
