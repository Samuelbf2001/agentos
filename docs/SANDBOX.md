# Modo pruebas (sandbox)

Copia local de `data/agentos.db`, puertos propios (API `:4310`, web `:4311`),
entrada sin contraseña. Sirve para probar contra datos reales sin arriesgar la
demo viva ni el equipo compartido de Sixteam.

## Arrancar

```bash
pnpm sandbox:reset    # copia data/agentos.db → data/sandbox.db (nunca al revés)
pnpm sandbox:api      # apps/api en :4310, AGENTOS_SANDBOX=1
pnpm sandbox:web      # apps/web en :4311, apuntando a :4310
```

`sandbox:api` ejecuta `reset` solo si `data/sandbox.db` todavía no existe — no
pisa una copia que ya estés usando. `pnpm sandbox:status` muestra tamaño y
fecha de ambas bases y si la API/web ya responden.

Desde Claude Code: las configuraciones `sandbox-api` y `sandbox-web` de
`.claude/launch.json` lanzan lo mismo sin tocar la terminal.

## Qué garantiza

- **Nunca arranca con `NODE_ENV=production`**: si el entorno lo trae, el
  script lo sobreescribe a `development` y avisa; y `AGENTOS_SANDBOX=1` con
  `NODE_ENV=production` hace que `apps/api` se niegue a arrancar
  (`resolveSandbox`, fail-closed, igual que la contraseña compartida o el
  secreto de sesión).
- **Jamás escribe en `data/agentos.db`**: `sandbox:reset` solo lee el origen;
  si ya existe una `data/sandbox.db`, la renombra a `.bak-<timestamp>` antes de
  sobrescribirla.
- **Sin notificaciones**: `AGENTOS_NOTIFICATIONS_INTERVAL_MS=0`.
- **Agentes apagados por defecto** (`AGENTOS_DISPATCHER_DISABLED=1`): el
  tablero no despacha runs solo. Con `pnpm sandbox:api -- --agentes` el
  despachador queda activo y **sí gasta presupuesto real** (LLM de verdad) —
  úsalo con intención, no como default.

## Antes de pasar a productivo

**Probar una rama entera** sin tocar el worktree principal:

```bash
git worktree add ../agentos-wt-<nombre> -b feat/<nombre>
cd ../agentos-wt-<nombre>
pnpm install && pnpm sandbox:reset
pnpm sandbox:api   # en otra terminal: pnpm sandbox:web
```

**Contra un Postgres de staging** (sin copiar SQLite): define
`AGENTOS_DB_DRIVER=postgres` y `AGENTOS_PG_URL=postgres://...` (la variable
exacta que usa `packages/db`, ver `packages/db/src/pg/client-pg.ts` y
`docs/POSTGRES.md` §2) en el entorno antes de `pnpm sandbox:api`, y sáltate
`pnpm sandbox:reset` — no hay SQLite que copiar, el aislamiento lo da la base
de staging en sí.
