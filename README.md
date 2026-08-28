# AgentOS Sixteam

Plataforma de agentes trabajadores de IA que replica la operación de consultoría de Sixteam (**Entender → Construir → Operar**): diagnóstico y mapeo de procesos, preparación ISO 9001, transformación digital, implementación y operación — con un **tablero de tareas central que los agentes mueven solos**, chat web, visual en vivo del enjambre, y un MCP de administración potente.

> Estado: **MVP funcional en local** (2026-08-28). Escala pequeña, un workspace, SQLite. No es para producción/multi-tenant todavía — ver `docs/PRD.md` §6.

## Qué hay dentro

- **7 agentes** (los 6 canónicos de la web V2 + Quinn, el QA adversario): Alex (orquestador/chat), Sam (diagnóstico), Debbie (constructora), Vinnie (integraciones), Sally (revenue ops), Clara (analista), Quinn (QA).
- **Runtime híbrido**: agentes que necesitan computadora corren con el **Claude Agent SDK** (tu suscripción de Claude Code); los conversacionales, con **Vercel AI SDK** (listos para OpenAI/Kimi/MiniMax/GLM — todos OpenAI-compatibles). El proveedor es un dato editable, no código.
- **Tablero kanban** de 7 estados movido por agentes con claim atómico por lease, **regla anti-teatro** (ninguna tarea se cierra sin artefacto) y **2 gates humanos** (aprobación de plan y de efectos externos).
- **Context Hub**: el activo de la plataforma — contexto de cada empresa (perfil, procesos como entidades, entrevistas, hallazgos, decisiones) tipado y con fuente, más la metodología Sixteam codificada y versionada.
- **MCP de administración** (`agentos-admin`): 55 tools para editar casi todo (agentes, prompts, tablero, config) desde tu Claude Code.

Arquitectura completa en `docs/ARCHITECTURE.md`; spec y criterios en `docs/PRD.md`; demo ejecutada en `docs/DEMO-E2E.md`; auditoría de seguridad en `docs/QA-REPORT.md`.

## Requisitos

- Node ≥ 22 (probado en 24.14), pnpm (via `npm i -g pnpm` si corepack falla), Windows 11 / macOS / Linux.
- Para runtime con suscripción: `claude` CLI instalado y con sesión iniciada (`claude` una vez).
- Opcional: API keys en `.env` (copia de `.env.example`) para OpenAI/Kimi/MiniMax/GLM. Sin ninguna, los agentes conversacionales caen a la suscripción de Claude Code.

## Arranque

```bash
pnpm install
pnpm --filter @agentos/db migrate   # crea el esquema
pnpm --filter @agentos/db seed       # carga org Sixteam, 7 agentes, proyecto demo ACME
pnpm --filter @agentos/api dev       # API en http://localhost:4300
pnpm --filter @agentos/web dev       # UI en http://localhost:4301
```

**Seguro por defecto**: un seed nuevo arranca **PAUSADO** (kill switch activo) para no gastar suscripción sin querer. Cuando quieras ver a los agentes trabajar, entra a la UI como Ernesto (contraseña de `AGENTOS_SHARED_PASSWORD`) y pulsa **Reanudar agentes** (o `system.resume_all` por MCP). Presupuesto por defecto: $2/run, $10/día (editables en Admin o config).

## Conectar el MCP de administración a tu Claude Code

Ver `apps/mcp-admin/README.md`. En corto (perfil de escritura para ti):

```bash
claude mcp add agentos-admin-rw -- pnpm --silent --filter @agentos/mcp-admin start:stdio
```

Los agentes internos solo ven el perfil de solo-lectura (`ro`); el de escritura es humano.

## Notas de operación

- **Aprobar el Gate 2 solo por la UI/API** hasta cerrar el pendiente Q2 de fase 2 (aprobar por MCP ya reconcilia vía despachador, pero la UI es el camino probado).
- Deploy en VPS: fuera de alcance del MVP (el VPS actual sufre CPU steal ~92%). Corre local.
- Tests: `pnpm -r test` (259 tests). Typecheck: `pnpm -r typecheck`.

## Pendientes de fase 2

Jerarquía de agentes con salud de cadena (patrón Paperclip), WhatsApp (el contrato de gateway ya está listo), entrevistas IA masivas, ISO 9001 profundo, Supabase/pgvector, auto-mejora de prompts, catálogo completo de ~50 actividades. Ver `docs/PRD.md` §4 y `docs/QA-REPORT.md`.
