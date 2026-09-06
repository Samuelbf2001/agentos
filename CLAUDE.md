# AgentOS Sixteam — instrucciones para sesiones de Claude

Plataforma de agentes trabajadores de IA que ejecuta la operación de consultoría de Sixteam (Entender → Construir → Operar). Monorepo pnpm: `apps/api` (Fastify, dueño único de la DB, despachador, WS), `apps/web` (Vite+React), `apps/mcp-admin` (MCP rw/ro), `packages/{shared,db,core,runners,tools,events,providers}`.

**Lee antes de tocar código**: `docs/PRD.md` (qué/porqué), `docs/ARCHITECTURE.md` (cómo; §13 = Módulos de Fase), `docs/TASKS.md` (estado), `docs/EVALUACION.md` (última evaluación). Postgres: `docs/POSTGRES.md`. Metodología de trabajo: skill `desarrollo-con-ia` en `2brain/.claude/skills/`.

## Comandos

```bash
pnpm install
pnpm --filter @agentos/db migrate && pnpm --filter @agentos/db seed   # seed = launch del módulo Consultoría (demo ACME)
pnpm --filter @agentos/api dev     # :4300   (login: contraseña AGENTOS_SHARED_PASSWORD + persona del equipo)
pnpm --filter @agentos/web dev     # :4301
pnpm -r typecheck && pnpm -r test  # la suite debe quedar verde antes de cualquier merge
```

Un seed nuevo arranca **pausado** (kill switch activo) para no gastar suscripción: se activa con "Reanudar agentes" en la UI o `agentos.system.resume_all` por MCP. Presupuesto por defecto $2/run y $10/día.

Modo pruebas (copia de datos, puertos propios, entrada sin contraseña): `docs/SANDBOX.md`.

## Reglas duras (no negociables)

1. **`data/agentos.db` es la demo viva. Nunca la toques desde tests ni scripts.** Los tests usan DB temporal (`:memory:` o archivo en tmp). Si necesitas migrar la DB viva, para la API primero, haz backup (`cp data/agentos.db data/agentos.db.bak-<motivo>`), migra, re-seed (idempotente), reinicia.
2. **El worktree principal corre servidores vivos. No cambies de rama ahí.** Toda feature va en rama propia dentro de un `git worktree add ../agentos-wt-<nombre> -b feat/<nombre>`; el dueño de master mergea tras verificar la suite él mismo.
3. **Coordinación multi-sesión** (hay más de una sesión de Claude trabajando en este repo): reparte por adelantado los índices de migración (mira `packages/db/drizzle/meta/_journal.json`, toma el siguiente libre y dilo), no toques áreas de otra rama sin avisar, avisa por `SendMessage` antes de mergear o de tocar `packages/core/board`, y **commitea solo tus archivos**. Trabajo sin commitear en el worktree principal es una deuda: el siguiente en llegar no sabe si está verde.
4. **Nada de LLM real en tests.** Runners y conector WhatsAppHub se mockean. Un smoke real es deliberado, con presupuesto, y se documenta con coste.
5. **Secretos jamás en código, tests, commits, logs ni DB.** `provider_profiles.api_key_env` guarda el NOMBRE de la variable. `AGENTOS_WHATSAPPHUB_KEY` vive solo en `.env` (gitignored).
6. **Las invariantes del tablero no se relajan por prompt ni por UI**: claim atómico por lease, `expected_version`, ningún REVIEW/DONE sin artefacto, Gate 1 (plan) y Gate 2 (efecto externo con digest), REVIEW→DONE y CANCELLED solo humano, perfil `ro` del MCP para agentes. Si una feature necesita cambiar la máquina de estados, va por `packages/core/board` con tests de transiciones ilegales.
7. **Verifica en vivo con datos reales antes de dar algo por hecho.** Los tests con fixtures sintéticos no vieron que un nombre de cliente con punto final rompía el spawn del runner en Windows (`sanitizeWorkspacePath`). Un test puede codificar el bug (`launch.test.ts` fijaba la ruta sin sanear).
8. **Provenance**: todo lo que un agente afirma sobre un cliente cita `[doc:id]` del Context Hub o se marca "no verificado". La metodología y los prompts viven como datos versionados (`agents/*.md`, `methodologies/*.md`, `modules/*.md` → DB con `seed_hash`); editar por MCP crea versión, nunca sobrescribe.

## Estado conocido (mantenlo al día en `docs/TASKS.md`)

Master `cf9d822` (2026-08-28): MVP + fase 2 (jerarquía, ISO 9001 profundo, Fuentes del proyecto, Módulos de Fase, Postgres/pgvector como capa de datos). Postgres corre la app end-to-end desde `feat/postgres-async`: `@agentos/db` expone una sola superficie ASÍNCRONA con dos implementaciones (ver `docs/POSTGRES.md` §5). Fuera de `packages/db` no queda ningún `db.$client`. Commits en español; terminar con `Co-Authored-By: Claude <modelo> <noreply@anthropic.com>`.
