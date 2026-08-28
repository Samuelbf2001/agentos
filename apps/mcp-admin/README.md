# @agentos/mcp-admin

Servidor MCP de administración de AgentOS ("editar casi todo", ARCHITECTURE §7).
Capa fina sobre `@agentos/core` y los repositorios de `@agentos/db` — ~55 tools
`agentos.<dominio>.<acción>` (agentes, prompts, tablero, proyectos, runs,
approvals, providers, contexto/metodología, config, people, auditoría).

- **Perfiles**: `rw` (humano) y `ro` (el único expuesto a agentes). Misma base de
  código; en `ro` toda mutación responde `read_only_profile`.
- **Reglas duras**: `expected_version` en agents/tasks/projects (conflicto → error
  explícito), `reason` + `idempotency_key` en mutaciones, audit_log before/after en
  todas, editar prompt CREA versión (rollback en una llamada). Sin tools de
  secretos, SQL arbitrario ni hard delete.

## Arrancar

```powershell
# stdio (para registrarlo en Claude Code)
pnpm --filter @agentos/mcp-admin start:stdio

# HTTP streamable en 127.0.0.1:4310 (token Bearer OBLIGATORIO)
$env:AGENTOS_MCP_TOKEN = "un-token-largo"; pnpm --filter @agentos/mcp-admin start:http
```

Variables: `AGENTOS_MCP_PROFILE=rw|ro` (default `ro`, fail-closed),
`AGENTOS_MCP_PERSON_ID=<person_id>` (atribución `person:<id>` en auditoría;
sin ella las mutaciones se firman `system:mcp-admin`), `AGENTOS_DB_PATH`
(default `<repo>/data/agentos.db`), `AGENTOS_MCP_PORT` (default 4310),
`AGENTOS_MCP_TOKEN` (solo HTTP).

## Registrarlo en Claude Code (Ernesto)

Perfil **rw** (administración humana):

```powershell
claude mcp add agentos-admin --scope user `
  --env AGENTOS_MCP_PROFILE=rw `
  --env AGENTOS_MCP_PERSON_ID=<tu person_id de la tabla people> `
  -- pnpm --silent --dir C:\Users\samue\2brain\agentos --filter @agentos/mcp-admin start:stdio
```

Perfil **ro** (solo lectura — el único que se expone a agentes):

```powershell
claude mcp add agentos-admin-ro --scope user `
  --env AGENTOS_MCP_PROFILE=ro `
  -- pnpm --silent --dir C:\Users\samue\2brain\agentos --filter @agentos/mcp-admin start:stdio
```

`--silent` es importante: sin él pnpm escribe su banner por stdout y corrompe el
canal JSON-RPC. Alternativa sin pnpm (vía tsx directo):

```powershell
claude mcp add agentos-admin --scope user `
  --env AGENTOS_MCP_PROFILE=rw `
  -- node --import tsx C:\Users\samue\2brain\agentos\apps\mcp-admin\src\stdio.ts
```

(esta variante exige que `tsx` sea resoluble desde el cwd; la de pnpm no depende
del cwd y es la recomendada).

Tu `person_id`: `agentos.people.list` desde el propio MCP, o
`SELECT id FROM people WHERE full_name='Ernesto'` en `data/agentos.db`.

## Probar rápido

Con el server registrado: `agentos.system.health` → conteos + DB ok;
`agentos.agents.list` → los 7 agentes seed; `agentos.agents.test` con
`{"agent":"alex"}` → prompt de 3 capas ensamblado en DRY-RUN (sin llamar al LLM).
