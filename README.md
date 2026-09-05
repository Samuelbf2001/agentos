# AgentOS Sixteam

Plataforma de agentes trabajadores de IA que replica la operación de consultoría de Sixteam (**Entender → Construir → Operar**): diagnóstico y mapeo de procesos, preparación ISO 9001, transformación digital, implementación y operación — con un **tablero de tareas central que los agentes mueven solos**, chat web, visual en vivo del enjambre, y un MCP de administración potente.

> Estado: **MVP + fase 2 en local** (2026-09-03). Escala pequeña, un workspace, SQLite por defecto (Postgres+pgvector disponible como backend alternativo). No es para producción/multi-tenant todavía — ver `docs/PRD.md` §6.

## Qué hay dentro

- **7 agentes** (los 6 canónicos de la web V2 + Quinn, el QA adversario): Alex (orquestador/chat), Sam (diagnóstico), Debbie (constructora), Vinnie (integraciones), Sally (revenue ops), Clara (analista), Quinn (QA) — organizados en una **jerarquía** (`agents.reports_to`) con salud de cadena que gobierna la asignabilidad; Quinn es raíz independiente.
- **Runtime híbrido**: agentes que necesitan computadora corren con el **Claude Agent SDK** (tu suscripción de Claude Code); los conversacionales, con **Vercel AI SDK** (listos para OpenAI/Kimi/MiniMax/GLM — todos OpenAI-compatibles). El proveedor es un dato editable, no código.
- **Tablero kanban** de 7 estados movido por agentes con claim atómico por lease, **regla anti-teatro** (ninguna tarea se cierra sin artefacto) y **2 gates humanos** (aprobación de plan y de efectos externos).
- **Módulos de Fase**: 3 módulos (consultoría/implementación/operación) con 5 metodologías codificadas (assessment-14d, iso9001-prep, iso9001-clausulas, transform, ops-continua) y un wizard "Nuevo proyecto" que lanza tareas, dependencias y presupuesto de forma transaccional; encadenado de fases y cadencias consent-first al cerrar una instancia.
- **ISO 9001 profundo**: metodología de cláusulas 4–10 (`iso9001-prep.md`, `iso9001-clausulas.md`) y tool `iso.gap_matrix_template` para la matriz de huecos.
- **Fuentes del proyecto**: conector REST a WhatsAppHub para traer reuniones e hilos de WhatsApp de 2brain al Context Hub como `knowledge_docs` con provenance.
- **Context Hub**: el activo de la plataforma — contexto de cada empresa (perfil, procesos como entidades, entrevistas, hallazgos, decisiones, fuentes) tipado y con fuente, más la metodología Sixteam codificada y versionada.
- **MCP de administración** (`agentos-admin`): 74 tools para editar casi todo (agentes, prompts, tablero, módulos de fase, config) desde tu Claude Code.
- **Postgres + pgvector** como backend alternativo (`@agentos/db/pg`): 23 tablas espejo, búsqueda de texto (tsvector) y semántica (pgvector con EmbeddingProvider OpenAI o mock). Capa de datos probada (suite dedicada); la app todavía no corre end-to-end sobre Postgres — ver `docs/POSTGRES.md` §5.

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

El proyecto demo ACME nace como un **launch real del módulo Consultoría** (no datos sueltos a mano); para un cliente nuevo, dispara el mismo motor desde el botón **"Nuevo proyecto"** de la UI.

**Seguro por defecto**: un seed nuevo arranca **PAUSADO** (kill switch activo) para no gastar suscripción sin querer. Cuando quieras ver a los agentes trabajar, entra a la UI como Ernesto (contraseña de `AGENTOS_SHARED_PASSWORD`) y pulsa **Reanudar agentes** (o `system.resume_all` por MCP). Presupuesto por defecto: $2/run, $10/día (editables en Admin o config).

### Variables de entorno nuevas (fase 2)

- `AGENTOS_WHATSAPPHUB_URL` / `AGENTOS_WHATSAPPHUB_KEY`: conector de Fuentes del proyecto al pipeline de reuniones/WhatsApp de 2brain (WhatsAppHub).
- `AGENTOS_DB_DRIVER=sqlite|postgres`: elige el backend de datos (por defecto `sqlite`).
- `AGENTOS_PG_URL`: cadena de conexión Postgres cuando `AGENTOS_DB_DRIVER=postgres`.
- `AGENTOS_ARTIFACTS_DIR`: dónde se guardan los archivos subidos como artefacto. Por defecto, el
  `artifacts/` del workspace del proyecto o `data/artifacts` (ambos fuera del árbol versionado).
  `AGENTOS_ARTIFACT_MAX_BYTES` ajusta el límite de subida (25 MB por defecto).
- `AGENTOS_NOTIFICATIONS_INTERVAL_MS`: cadencia del reloj de recordatorios de vencimiento (15 min por
  defecto); `0` u `off` lo desactiva.
- `AGENTOS_WEB_ORIGIN`: origen(es) permitidos por CORS, separados por comas (por defecto `http://localhost:4301`).
- `OPENAI_API_KEY`: habilita embeddings reales para búsqueda semántica en Postgres (sin ella, cae a un `EmbeddingProvider` mock).

## Conectar el MCP de administración a tu Claude Code

Ver `apps/mcp-admin/README.md`. En corto (perfil de escritura para ti):

```bash
claude mcp add agentos-admin-rw -- pnpm --silent --filter @agentos/mcp-admin start:stdio
```

Los agentes internos solo ven el perfil de solo-lectura (`ro`); el de escritura es humano.

## Notas de operación

- **Aprobar el Gate 2 solo por la UI/API** hasta cerrar el pendiente Q2 de fase 2 (aprobar por MCP ya reconcilia vía despachador, pero la UI es el camino probado).
- Deploy en VPS: fuera de alcance del MVP (el VPS actual sufre CPU steal ~92%). Corre local.
- Tests: `pnpm -r test` (513 tests verdes + 28 omitidos de la suite Postgres, que se activa con `AGENTOS_PG_URL`, + 1 skip). Typecheck: `pnpm -r typecheck` (10/10 paquetes).

## Pendientes

- **Decisión/config de Ernesto**: `AGENTOS_WHATSAPPHUB_KEY` en `.env`; visto bueno sobre el cambio observable `requiresApproval` 2→7 del demo en DBs frescas (revert de 1 línea); `order_key` unique (Q5) y `projects.create` con approval (H12) diferidos.
- **Fase 2 aún no construida**: WhatsApp (el contrato de gateway ya está listo, falta el adaptador), entrevistas IA masivas, auto-mejora de prompts, portal del cliente, MCPs externos reales (solo hay conector a WhatsAppHub), catálogo completo de ~50 actividades.
- **En curso en otra sesión, sin commitear** (no verificado por esta actualización): módulo operativo de "Proyectos y Tareas" (`docs/PRD-MODULO-PROYECTOS-TAREAS.md`) con responsables humanos múltiples, vencimientos y avisos por correo; y planes (no ejecutados) de despliegue a EasyPanel (`Dockerfile.api`, `docs/PLAN-DESPLIEGUE-EASYPANEL.md`) y de migración desde Notion (`docs/PLAN-MIGRACION-NOTION-EASYPANEL.md`, `docs/MIGRACION-NOTION-TASKS-PROJECTS.md`).

Ver `docs/PRD.md` §4 y `docs/TASKS.md` para el detalle.
