# Runbook de despliegue — AgentOS en EasyPanel

Operativa concreta de los artefactos de esta carpeta. La estrategia, los gates y
la política de reversión de datos están en `docs/PLAN-DESPLIEGUE-EASYPANEL.md`;
aquí solo está el "cómo se hace".

> Este runbook **no autoriza** desplegar. Nada de lo que sigue se ejecuta contra
> el VPS sin la orden explícita del responsable del despliegue.

## 1. Qué se despliega

| Servicio EasyPanel | Origen | Expuesto | Estado |
| --- | --- | --- | --- |
| `agentos-api` | `Dockerfile.api` | solo red interna | API Fastify + dispatcher + runners |
| `agentos-web` | `Dockerfile.web` | dominio de equipo (HTTPS) | SPA de Vite servida por nginx; proxy `/api` y `/ws` a la API |
| `agentos-db` | imagen `pgvector/pgvector:pg17` | solo red interna | PostgreSQL 17 + pgvector, usuario `agentos`; **ya existe** en el proyecto `whatsfull` |

Los tres viven en el proyecto técnico `whatsfull` (la licencia de EasyPanel está
en su tope de 3 proyectos), pero con contenedores, volúmenes, usuario de base de
datos, variables y dominio propios. No comparten datos con WhatsAppHub.

En Docker Swarm el nombre de red de un servicio es `<proyecto>_<servicio>`: la
API es `whatsfull_agentos-api` y la DB `whatsfull_agentos-db`.

## 2. Imágenes

```bash
GIT_SHA=$(git rev-parse --short HEAD)
docker build -f Dockerfile.api -t agentos-api:$GIT_SHA --build-arg GIT_SHA=$GIT_SHA .
docker build -f Dockerfile.web -t agentos-web:$GIT_SHA --build-arg GIT_SHA=$GIT_SHA .
```

- Ambas son multi-stage y usan **pnpm 11.24.0**, la misma versión que generó
  `pnpm-lock.yaml`. Con pnpm 10 `--frozen-lockfile` falla.
- `GIT_SHA` queda en `org.opencontainers.image.revision` (y en la API también
  como variable `AGENTOS_GIT_SHA`). Ningún despliegue usa una imagen sin SHA:
  `docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' agentos-api:$GIT_SHA`.
- `agentos-api` corre como usuario **no root** `agentos` (uid/gid 10001) con
  `dumb-init` como PID 1 (el runner `claude_code` lanza procesos hijos).
- La API **no tiene build de TypeScript**: los paquetes del workspace exportan
  `./src/index.ts` directamente, así que producción ejecuta
  `node --import tsx apps/api/src/index.ts`. Por eso `tsx` está en las
  `dependencies` de la raíz, no en `devDependencies`.
- El upstream del proxy de la web se fija en build o en runtime con
  `AGENTOS_API_UPSTREAM` (por defecto `http://whatsfull_agentos-api:4300`).

## 3. Variables de entorno

Los **nombres** están documentados uno a uno en `deploy/.env.production.example`.
Los **valores** se cargan en el gestor de variables de EasyPanel, nunca en Git,
ni en la imagen, ni en un archivo del VPS.

Mínimo para arrancar `agentos-api`:

- `AGENTOS_SHARED_PASSWORD` y `AGENTOS_SESSION_SECRET` (acceso y sesiones).
- `AGENTOS_DB_DRIVER=postgres` + `AGENTOS_PG_URL` (DSN interno de `agentos-db`).
- `AGENTOS_WEB_ORIGIN` con el dominio público de la web.
- `ANTHROPIC_API_KEY` (o la clave del proveedor que se use).
- `AGENTOS_DISPATCHER_DISABLED=1` en el primer arranque (ver §5).

Para `agentos-web` basta `AGENTOS_API_UPSTREAM` si el proyecto o el servicio no
se llaman `whatsfull` / `agentos-api`.

**Riesgo abierto conocido:** sin `AGENTOS_SHARED_PASSWORD` la API arranca con la
contraseña de desarrollo `agentos-dev` y solo escribe una advertencia. Se cierra
en la pasada de aplicación; hasta entonces, verificar la variable antes de
publicar el dominio.

## 4. Volumen y permisos

`agentos-api` guarda todo su estado en `/app/data` (declarado como `VOLUME`):

| Dentro del contenedor | Contenido |
| --- | --- |
| `/app/data/agentos.db` | SQLite, solo si `AGENTOS_DB_DRIVER=sqlite` |
| `/app/data/artifacts` | artefactos generados (o `AGENTOS_ARTIFACTS_DIR`) |
| `/app/data/workspaces` | workspaces de los runners |
| `/app/data/backups` | copias de `backup-sqlite.sh` |

Bind mount en EasyPanel: `/etc/easypanel/projects/whatsfull/agentos-api/data` →
`/app/data`.

El contenedor corre como uid 10001, así que **antes del primer arranque** hay
que dar propiedad del directorio del host, o la API no podrá escribir:

```bash
mkdir -p /etc/easypanel/projects/whatsfull/agentos-api/data
chown -R 10001:10001 /etc/easypanel/projects/whatsfull/agentos-api/data
```

## 5. Secuencia de un despliegue

1. Construir ambas imágenes con `GIT_SHA` y registrar el SHA en la bitácora.
2. Crear/actualizar las variables de los tres servicios (§3).
3. `chown` del directorio del volumen (§4).
4. **Arranque pausado**: levantar `agentos-api` con
   `AGENTOS_DISPATCHER_DISABLED=1`. La API queda viva y responde, pero no
   despacha runs ni corre el reaper, así que un error de configuración no
   arranca trabajo real. Comprobar:
   - `GET /api/health` → 200 (el `HEALTHCHECK` de la imagen ya lo consulta;
     `docker inspect --format '{{.State.Health.Status}}'` debe decir `healthy`).
   - `POST /api/auth/login` con `{"password":…,"person_id":…}` → 200, y con la
     contraseña equivocada → 401.
   - `docker exec <contenedor> id` → `uid=10001(agentos)`.
   - Logs sin DSN, sin tokens y sin contraseñas.
5. Levantar `agentos-web` y comprobar que la SPA carga y que `/api/health` a
   través del proxy responde 200 (misma URL pública, mismo origen).
6. Publicar el dominio con HTTPS y autenticación.
7. Quitar `AGENTOS_DISPATCHER_DISABLED` y reiniciar la API para habilitar los
   bucles. Observar 48 h: errores, latencia, conexiones PG, espacio del volumen.

## 6. Respaldos

- **PostgreSQL (producción):** `pg_dump` contra `agentos-db` con su propio
  usuario, hacia un destino fuera de los volúmenes de aplicación, con SHA-256
  registrado y una prueba de restauración en un destino aislado. Es el respaldo
  que cuenta mientras `AGENTOS_DB_DRIVER=postgres`.
- **SQLite:** `deploy/backup-sqlite.sh` (solo si el servicio corre con
  `AGENTOS_DB_DRIVER=sqlite`). Usa la API de backup online de SQLite —copiar el
  `.db` con `cp` mientras la API escribe en WAL produce un archivo corrupto—,
  verifica `PRAGMA integrity_check`, comprime, anota el SHA-256 y borra copias
  de más de 14 días (`AGENTOS_BACKUP_RETENTION_DAYS`). Funciona con `sqlite3`
  en el host o, si no existe, con el `better-sqlite3` del propio contenedor.

  ```bash
  # cron diario en el VPS
  0 3 * * * AGENTOS_API_CONTAINER=<contenedor> /ruta/deploy/backup-sqlite.sh >> /var/log/agentos-backup.log 2>&1
  ```

  Las copias quedan en el mismo volumen: copiarlas fuera del host para que
  sirvan de respaldo real.

## 7. Reversión

1. Volver a desplegar la imagen del SHA anterior (por eso cada imagen lleva su
   revisión en las labels). La API es el único servicio con estado propio.
2. Si el problema es de configuración, no de código: corregir la variable y
   reiniciar; no hace falta reconstruir.
3. Si una migración escribió datos incompatibles: detener la API, restaurar el
   snapshot de `agentos-db` (o la copia de `backup-sqlite.sh`) y corregir en
   staging. Nunca se borran tareas, fuentes ni auditoría selectivamente.
4. Si el conector WhatsAppHub falla: desactivarlo por variable. **Nunca** se
   tocan los servicios, variables ni la base de WhatsAppHub.
5. Incidente de seguridad: revocar el secreto afectado, bloquear el servicio y
   auditar accesos antes de reactivar.
