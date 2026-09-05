# Plan de despliegue: AgentOS en EasyPanel

**Estado:** plan de ejecución. No crea, reinicia ni modifica servicios hasta superar los gates de cada fase.

## 1. Decisión de arquitectura

AgentOS se desplegará como un sistema nuevo y aislado dentro de EasyPanel. No se instalará dentro de `2brain-backend`, no reutilizará su base de datos, ni sustituirá los servicios activos de WhatsAppHub.

| Componente | Servicio propuesto | Exposición | Dueño de datos |
| --- | --- | --- | --- |
| API de AgentOS | `agentos-api` | Dominio privado al inicio; API pública solo detrás de autenticación | Proyectos, tareas, ejecuciones, gates y auditoría |
| Interfaz web | `agentos-web` | Dominio de equipo | Ninguno: consume la API |
| Base de datos | `agentos-db` | Solo red interna de EasyPanel | PostgreSQL exclusivo de AgentOS |
| Worker | `agentos-worker` | Solo red interna | Ejecuta colas/outbox; se activa cuando exista carga real |
| MCP administrativo | `agentos-mcp` | Solo red interna inicialmente | No es fuente de datos; usa API/DB con rol acotado |
| Archivo de Notion | `agentos-notion-archive` | No público | Snapshots inmutables y adjuntos autorizados |

WhatsAppHub, su PostgreSQL, Redis, CRM, conversaciones y reuniones siguen siendo servicios independientes. AgentOS los consume mediante conectores con permisos mínimos y referencias externas; nunca mediante acceso directo a sus tablas.

## 2. Estado comprobado en el VPS

- El proyecto `whatsfull` ya tiene en funcionamiento `2brain-backend`, varias interfaces, PostgreSQL y Redis.
- `2brain-backend` procede del repositorio de WhatsAppHub, ruta `/backend`, y no tiene despliegue automático activado.
- **El motor de producción es PostgreSQL.** La rama `feat/postgres-async` ya corre la aplicación end-to-end con `AGENTOS_DB_DRIVER=postgres` + `AGENTOS_PG_URL`: la fachada asíncrona está portada y el esquema y las migraciones PG viven en el paquete de datos. SQLite sigue siendo el default local de cero fricción, no el runtime de producción.
- Esto **deja sin efecto** la recomendación de `docs/EVALUACION.md` §6 («el plan es sensato: SQLite en volumen primero», «Postgres end-to-end solo cuando se dispare uno de los criterios de ARCHITECTURE §5»), escrita antes de que esa rama existiera. Para EasyPanel el motor es Postgres desde el primer arranque; la evaluación se corrige cuando `feat/postgres-async` entre a `master`.
- La copia local de AgentOS todavía no tiene un remoto Git configurado: falta definir el origen de despliegue (repositorio privado o acceso SSH dedicado).
- La licencia actual de EasyPanel alcanzó el máximo de tres proyectos. Por ello AgentOS convivirá como servicios con prefijo `agentos-` dentro del proyecto técnico `whatsfull`, pero con contenedores, volúmenes, usuarios de base de datos, variables y dominios propios. No significa que comparta el dominio de datos de WhatsAppHub.
- El 2026-09-04 se generó y validó un dump previo de la base operativa histórica `whatsfull/db` (`db`, aproximadamente 144 MB). El archivo de restauración está fuera de los volúmenes de aplicación, tiene SHA-256 registrado en el VPS y `pg_restore` de PostgreSQL 17 confirmó 228 entradas. No se modificó la base de origen.
- El servicio `whatsfull/agentos-db` fue creado como PostgreSQL 17 + pgvector independiente. Su almacenamiento está en `/etc/easypanel/projects/whatsfull/agentos-db/data`, distinto de `/etc/easypanel/projects/whatsfull/db/data`; la base, el usuario inicial y la extensión `vector` se verificaron sin exponer su contraseña.

Por tanto, **no se reutilizará `whatsfull/db`** para AgentOS. Compartir instancia o credenciales mezclaría el dominio operativo con mensajes, CRM y PII de WhatsAppHub.

## 3. Requisitos previos — Gate D0

No se crea un servicio hasta tener todos los puntos siguientes:

1. Un origen versionado para AgentOS: repositorio privado y rama de despliegue, o acceso SSH con usuario explícito para instalar desde una ruta dedicada. Nunca se copia código a mano a un contenedor efímero.
2. Runtime PostgreSQL funcional en `apps/api`, `apps/mcp-admin` y worker, con SQLite aún como default local. **Cumplido en `feat/postgres-async`** (la app arranca y opera con `AGENTOS_DB_DRIVER=postgres`); lo pendiente es integrar esa rama en la rama de despliegue antes de construir el artefacto.
3. `Dockerfile` reproducible, lockfile respetado, usuario no root en runtime, healthcheck y versión/commit visibles sin exponer configuración. **Cumplido**: `Dockerfile.api` y `Dockerfile.web` son multi-stage con pnpm 11.24.0 (la versión del lockfile), usuario `agentos` uid 10001, `HEALTHCHECK` a `/api/health` y `GIT_SHA` en `org.opencontainers.image.revision`. Operativa en `deploy/README.md`.
4. Variables de secreto creadas en EasyPanel, no en Git ni en imágenes: URL de PostgreSQL, claves de sesiones/proveedores y credenciales de los conectores necesarios. Los NOMBRES y su significado están en `deploy/.env.production.example`; los valores nunca salen del gestor de secretos.
5. Política de acceso: usuarios/equipo autenticados en la web; MCP y DB no expuestos al Internet público; HTTPS antes de una URL de equipo.
6. Backups del volumen de PostgreSQL (`pg_dump` contra `agentos-db`), retención y una prueba de restauración en un destino aislado. Procedimiento y el caso SQLite (`deploy/backup-sqlite.sh`) en `deploy/README.md` §6.

## 4. Secuencia de despliegue

### Fase D1 — Preparar código y artefacto

1. Completar la adaptación a PostgreSQL y las pruebas de API/MCP/worker.
2. Añadir imagen de producción multi-stage para API, web y worker. La imagen recibe configuración solo en runtime. **Hecho para API y web** (`Dockerfile.api`, `Dockerfile.web`); el worker aún no tiene imagen propia porque no se levanta en el primer despliegue.
3. Ejecutar `typecheck`, tests completos, build de web/API e integración real contra un PostgreSQL temporal con las mismas extensiones permitidas por producción.
4. Etiquetar el commit y producir una imagen o referencia Git inmutable. Ningún despliegue usa una rama sin SHA registrado.

**Aceptación D1:** las suites de SQLite y PostgreSQL pasan; el arranque con una URL PG válida no abre ni crea `agentos.db`; errores de conexión fallan cerrados y sin imprimir DSN.

### Fase D2 — Crear infraestructura aislada

1. `agentos-db` **ya existe** en el proyecto `whatsfull` (`pgvector/pgvector:pg17`, usuario `agentos`, base y volumen propios en `/etc/easypanel/projects/whatsfull/agentos-db/data`, sin puerto público, extensión `vector` verificada). En esta fase solo se comprueba su estado y se emite el DSN interno para `AGENTOS_PG_URL`; no se recrea.
2. Crear `agentos-api` con acceso interno únicamente a `agentos-db` y sin dominio público inicial.
3. Crear `agentos-web` apuntando a la API interna o al mismo dominio mediante proxy `/api`; el navegador nunca conoce credenciales de base de datos.
4. Crear `agentos-notion-archive` como volumen privado montado únicamente en el job de migración. No se monta en la web, el MCP ni WhatsAppHub.
5. Mantener worker y MCP apagados hasta que la API y el control de acceso estén validados.

**No permitido en D2:** modificar variables de `2brain-backend`, reiniciar WhatsAppHub, dar acceso de red a PostgreSQL de WhatsAppHub, copiar tokens entre servicios o publicar una URL sin autenticación.

### Fase D3 — Configurar secretos y contratos

1. Cargar las variables en el gestor de secretos de EasyPanel, usando nombres, nunca valores en archivos de configuración.
2. Crear un rol de AgentOS con privilegios únicamente sobre su propia base.
3. Configurar el conector WhatsAppHub de solo lectura: URL interna, clave dedicada y rutas permitidas de reuniones/contactos/dossiers.
4. Configurar logs estructurados con redacción de `Authorization`, cookies, DSN, contenido de mensajes y payloads de Notion.
5. Registrar la versión del artefacto, fecha, operador y hash de configuración no sensible en la auditoría de despliegue.

**Aceptación D3:** healthcheck de API, conexión de base, usuario de aplicación, endpoint de lectura del conector y UI básica funcionan sin secretos en respuestas o logs.

### Fase D4 — Staging y ensayo de reversión

1. Desplegar una instancia de staging con otra base y volumen, utilizando el mismo artefacto que producción.
2. Ejecutar smoke tests: login, crear/editar tarea de prueba, transición con `expected_version`, evento/audit, enlace de fuente de WhatsAppHub de solo lectura y reinicio controlado de API.
3. Ensayar backup y restauración del volumen de staging; comparar conteos, checksums y una tarea con adjunto/referencia.
4. Verificar que dos instancias no compiten por la misma tarea ni duplican una notificación.

**Aceptación D4:** backup restaurable, sin datos de producción en staging, y pruebas de concurrencia/idempotencia aprobadas.

### Fase D5 — Producción inicial

1. Crear solo los servicios nuevos de AgentOS con una versión inmutable aprobada.
2. Aplicar migraciones de esquema mediante job único y registrado; la API no arranca con migraciones pendientes.
3. Publicar el dominio de equipo con HTTPS y autenticación. Los dominios de WhatsAppHub no se modifican.
4. Mantener la operación inicial limitada a proyectos/tareas de prueba y fuentes de contexto de solo lectura durante la ventana de observación.
5. Monitorear errores, latencia, conexiones PG, espacio de volumen, entregas de outbox y auditoría durante 48 horas.

## 5. Reversión

| Caso | Acción de reversión |
| --- | --- |
| Fallo de API/web | Volver al SHA anterior; la base no se restaura salvo que una migración haya escrito datos incompatibles. |
| Fallo de migración de esquema | Detener API, restaurar snapshot de `agentos-db` y corregir en staging. |
| Conector WhatsAppHub defectuoso | Desactivar el conector por variable/feature flag; no tocar WhatsAppHub. |
| Error de importación Notion | Detener el job, conservar snapshot y cuarentena; no borrar el origen ni los archivos de evidencia. |
| Incidente de seguridad | Revocar secreto afectado, bloquear endpoint/servicio y auditar accesos antes de reactivar. |

No habrá rollback que borre tareas, fuentes o auditoría selectivamente. Una importación se marca como fallida y se corrige mediante una nueva corrida idempotente.

## 6. Orden de ejecución autorizado

1. Cerrar D0 y construir el artefacto PG.
2. Desplegar staging D2–D4.
3. Ejecutar el plan de migración de Notion en staging.
4. Publicar AgentOS en producción inicial D5.
5. Realizar la migración completa y el corte operativo únicamente después de su conciliación.

El bloqueo actual para D0 es operativo, no técnico: (a) falta un origen de despliegue para el checkout local de AgentOS (remoto Git privado o usuario SSH explícito) y (b) falta integrar `feat/postgres-async` en la rama de despliegue. El artefacto ya es reproducible (`Dockerfile.api`, `Dockerfile.web`, `deploy/`) y la API de EasyPanel está disponible para crear la infraestructura restante.
