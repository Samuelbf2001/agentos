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
- La copia local de AgentOS no tiene un remoto Git configurado y el runtime principal sigue siendo SQLite. El paquete de datos ya contiene el esquema y migraciones PostgreSQL, pero API, MCP y workflow deben completar el cambio síncrono a asíncrono antes de que PostgreSQL sea una opción de producción.
- La licencia actual de EasyPanel alcanzó el máximo de tres proyectos. Por ello AgentOS convivirá como servicios con prefijo `agentos-` dentro del proyecto técnico `whatsfull`, pero con contenedores, volúmenes, usuarios de base de datos, variables y dominios propios. No significa que comparta el dominio de datos de WhatsAppHub.
- El 2026-09-04 se generó y validó un dump previo de la base operativa histórica `whatsfull/db` (`db`, aproximadamente 144 MB). El archivo de restauración está fuera de los volúmenes de aplicación, tiene SHA-256 registrado en el VPS y `pg_restore` de PostgreSQL 17 confirmó 228 entradas. No se modificó la base de origen.
- El servicio `whatsfull/agentos-db` fue creado como PostgreSQL 17 + pgvector independiente. Su almacenamiento está en `/etc/easypanel/projects/whatsfull/agentos-db/data`, distinto de `/etc/easypanel/projects/whatsfull/db/data`; la base, el usuario inicial y la extensión `vector` se verificaron sin exponer su contraseña.

Por tanto, **no se reutilizará `whatsfull/db`** para AgentOS. Compartir instancia o credenciales mezclaría el dominio operativo con mensajes, CRM y PII de WhatsAppHub.

## 3. Requisitos previos — Gate D0

No se crea un servicio hasta tener todos los puntos siguientes:

1. Un origen versionado para AgentOS: repositorio privado y rama de despliegue, o acceso SSH con usuario explícito para instalar desde una ruta dedicada. Nunca se copia código a mano a un contenedor efímero.
2. Runtime PostgreSQL funcional en `apps/api`, `apps/mcp-admin` y worker, con SQLite aún como default local. El simple esquema PG no es suficiente.
3. `Dockerfile` reproducible, lockfile respetado, usuario no root en runtime, healthcheck y versión/commit visibles sin exponer configuración.
4. Variables de secreto creadas en EasyPanel, no en Git ni en imágenes: URL de PostgreSQL, claves de sesiones/proveedores y credenciales de los conectores necesarios.
5. Política de acceso: usuarios/equipo autenticados en la web; MCP y DB no expuestos al Internet público; HTTPS antes de una URL de equipo.
6. Backups del volumen de PostgreSQL, retención y una prueba de restauración en un destino aislado.

## 4. Secuencia de despliegue

### Fase D1 — Preparar código y artefacto

1. Completar la adaptación a PostgreSQL y las pruebas de API/MCP/worker.
2. Añadir imagen de producción multi-stage para API, web y worker. La imagen recibe configuración solo en runtime.
3. Ejecutar `typecheck`, tests completos, build de web/API e integración real contra un PostgreSQL temporal con las mismas extensiones permitidas por producción.
4. Etiquetar el commit y producir una imagen o referencia Git inmutable. Ningún despliegue usa una rama sin SHA registrado.

**Aceptación D1:** las suites de SQLite y PostgreSQL pasan; el arranque con una URL PG válida no abre ni crea `agentos.db`; errores de conexión fallan cerrados y sin imprimir DSN.

### Fase D2 — Crear infraestructura aislada

1. Crear `agentos-db` con una base y rol exclusivos, volumen persistente, sin puerto público. Usar PostgreSQL 16 o 17. `pgvector` se activa solo si la imagen gestionada lo soporta; la búsqueda debe degradar a texto si no está disponible.
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

El bloqueo actual para D0 es operativo, no de EasyPanel: falta un origen de despliegue para el checkout local de AgentOS (remoto Git privado o usuario SSH explícito). La API de EasyPanel ya está disponible para crear la infraestructura cuando el artefacto sea reproducible.
