# Migración preservando historial: Notion → AgentOS

**Estado (2026-09-05, rama `feat/notion-import`):** capturador **e importador**
construidos y probados. El capturador descarga adjuntos con SHA-256 e intenta las
páginas archivadas. El importador es idempotente, escribe linaje completo y se ha
ejercitado contra el snapshot real **sobre copias temporales de la base**. La base
viva `data/agentos.db` **no ha sido tocada**: la importación a producción es el paso
manual descrito en §11 y requiere la aprobación de Ernesto.

Lo que ya existe en código:

| Pieza | Dónde |
| --- | --- |
| Capturador (solo lectura, adjuntos, archivadas) | `packages/notion-migration/src/{cli,notion-client,snapshot}.ts` |
| Mapa de campos tipado y probado | `packages/notion-migration/src/field-map.ts` |
| Lector de snapshot | `packages/notion-migration/src/snapshot-reader.ts` |
| Importador idempotente + CLI | `packages/notion-migration/src/{importer,import-cli}.ts` |
| 5 tablas de linaje (SQLite `0007`, Postgres `0003`) | `packages/db/drizzle/0007_notion_linaje.sql`, `packages/db/drizzle-pg/0003_notion_linaje.sql` |
| Repos duales del linaje | `packages/db/src/repositories/notion-migration.ts`, `packages/db/src/pg/repositories/notion-migration.ts` |
| Ficha "Historial de Notion" (REST, solo lectura) | `apps/api/src/routes/notion-origin.ts` |

**Alcance cerrado:** las dos fuentes canónicas `Tasks` y `Projects` de `Projects & Tasks (1)`.

**Fuera de alcance:** `Tareas Desarrollo`, `Tareas Clientes`, `Clips redes`, Quick Capture, automatizaciones, vistas y cualquier otra página o base de Notion.

## 1. Garantía de preservación

Esta migración no reemplaza, limpia, archiva ni modifica Notion. Primero crea un snapshot inmutable y verificable; después importa a AgentOS. Notion permanece como archivo de consulta hasta que Samuel acepte por escrito el corte.

Cada página de origen tendrá siempre:

- su `notion_page_id`, URL original, fecha de captura y hash de integridad;
- el objeto de página y todas las propiedades tal como las devolvió Notion;
- el árbol recursivo completo de bloques, incluyendo tipos no soportados por la UI nativa;
- las relaciones, personas, adjuntos, icono y portada disponibles en el origen;
- los comentarios accesibles para la conexión, con su resultado de captura explícito;
- un enlace de importación idempotente al objeto nativo o una entrada de cuarentena con causa.

No se intentará reconstruir como eventos nativos el historial de revisiones interno de Notion: la API pública no entrega ese historial completo. La página original queda conservada como evidencia histórica. Tampoco se afirmará que un comentario resuelto fue copiado si la API no lo devuelve.

Los adjuntos se tratan en dos capas: metadatos y referencia originales en el snapshot, y una copia binaria con hash en el archivo protegido cuando pueda descargarse con autorización. Las URLs temporales de archivos de Notion no son una garantía de conservación por sí mismas.

## 2. Inventario visible validado el 2026-09-02

La comprobación fue en la interfaz actual de Notion, sin editar datos. Las cifras de tablero son indicadores de vista, no el conteo definitivo de migración: `99+` es un límite inferior y las vistas pueden filtrar o cargar por partes. El conteo de aceptación saldrá únicamente del snapshot paginado por API.

### Tasks

Estados visibles: `Sin empezar` (99+), `StandBy/Sin Información` (38), `Realizando` (33), `En validación` (31) y `Completada` (99+).

Propiedades observadas:

```text
Name
Asignado
Bloqueada por
Bloqueado por
Bloqueando
Created time
Due Date
Estado
HH estimadas
Horas H reales
PreRequisito de
Priority
Project
Related to Reuniones (Tareas)
Tags
```

### Projects

Fases visibles: `Sin empezar`, `OnBoarding`, `Implementacion`, `En espera`, `Finalizado` y `Soporte Recurrente`. La vista mostraba 20, 2, 6, 1, 0 y 0 respectivamente; no se toma esa suma como inventario definitivo.

Propiedades observadas:

```text
Name
Priority
Due Date
Owner
Completed Tasks
Attachments
Created time
FASE
Tags
Tasks
Archive?
F. Fin Real
F. Inicio
Bloqueado por
PreRequisito de
```

El plan anterior contiene un baseline de 2026-09-01, pero no se reutilizará como verdad actual: las tareas cambian. El nuevo run registrará sus propios conteos, esquema y checksum antes de importar una sola página.

## 3. Contrato de captura

La conexión de migración será independiente de la integración operativa actual y tendrá únicamente capacidades de lectura de contenido y, si se necesitan comentarios, de lectura de comentarios. Sus identificadores y secreto viven solo en el gestor de secretos/entorno de ejecución; nunca en Git, archivos `.env`, logs, reportes ni respuestas de API.

Por cada fuente, el capturador realizará lo siguiente:

1. Recuperar el esquema de la fuente de datos y guardarlo como `schema.json`.
2. Paginar todos los registros, incluidos archivados/trash cuando la conexión los exponga, sin filtros de vista.
3. Recuperar cada página completa y cada propiedad que exceda los límites de referencias de la respuesta de página.
4. Recorrer los bloques hijos de forma recursiva y paginada. Un bloque desconocido se guarda crudo y se reporta; nunca se descarta silenciosamente.
5. Recuperar comentarios accesibles y registrar de forma explícita si Notion no permite obtenerlos.
6. Descargar los adjuntos autorizados a un archivo seguro externo al repositorio; si no se puede, conservar metadatos, motivo y URL de origen, marcados como pendientes de revisión.
7. Generar un manifiesto con conteos, hashes SHA-256, versión de API, hora, errores por página y una huella global del run.

El archivo de snapshot será de solo anexado, en `data/notion-snapshots/` (ignorado por Git), y fuera de cualquier sistema de sincronización o repositorio remoto. Su acceso será restringido al servicio de migración. Los reportes de revisión exponen IDs técnicos, conteos y causas; no incorporan títulos, correos ni contenido de tareas.

## 4. Modelo de destino sin pérdida

AgentOS conserva `projects`, `tasks`, `people`, `task_assignees`, artefactos y documentos de conocimiento como verdad operativa. La información de origen que no corresponda a una columna nativa no se convierte en una nota libre ni se omite: queda en un archivo histórico inmutable ligado a la tarea/proyecto.

La siguiente migración de esquema, en SQLite y PostgreSQL, incorporará estas entidades de linaje:

```text
notion_migration_runs
  id, source_schema_version, captured_at, manifest_hash, status, immutable

notion_page_archives
  id, migration_run_id, source_kind, notion_page_id, original_url,
  raw_page_uri, raw_blocks_uri, raw_comments_uri, raw_files_uri,
  payload_hash, captured_at

notion_import_links
  id, migration_run_id, source_kind, notion_page_id,
  agentos_object_kind, agentos_object_id, archive_id, import_status,
  source_last_edited_at, imported_at

notion_identity_mappings
  id, migration_run_id, notion_person_id, agentos_person_id,
  match_method, validation_state, reviewed_by, reviewed_at

notion_import_quarantine
  id, migration_run_id, source_kind, notion_page_id, field_name,
  reason, raw_reference, resolution_state, resolved_by, resolved_at
```

`notion_page_archives` y el manifiesto son de solo inserción. No se actualizarán para esconder ni corregir el origen; una corrección crea una nueva corrida y deja rastro de la anterior.

## 5. Mapa de campos IMPLEMENTADO

Fuente única en código: `packages/notion-migration/src/field-map.ts`. Probado en
`test/field-map.test.ts`. Ninguna decisión de traducción vive fuera de ahí.

### 5.1 Tasks

| Campo Notion | Tipo | Destino AgentOS | Regla |
| --- | --- | --- | --- |
| `Name` | title | `tasks.title` | Texto plano. Vacío → `(sin título en Notion)` **+ cuarentena** `titulo_vacio_en_origen`. |
| `Estado` | status | `tasks.status` | `Sin empezar→BACKLOG`, `Realizando→IN_PROGRESS`, `StandBy/Sin Información→BLOCKED` (+`blocked_reason='manual'`), `En validación→REVIEW`, `Completada→DONE`. Valor fuera de tabla → `BACKLOG` **+ cuarentena** `estado_desconocido`. |
| `Priority` | select | `tasks.priority` | `URGENTE!!!→urgent`, `ALTO→high`, `MEDIO→normal`, `BAJO→low`. Vacío → `normal` sin excepción. Desconocido → `normal` **+ cuarentena**. |
| `Due Date` | date | `tasks.due_at` | **Inicio** del rango, epoch ms (fecha suelta = medianoche UTC). `end` y `time_zone` **solo** en el archivo. |
| `Asignado` | people | `task_assignees` (+ `assignee_person_id`) | **Solo** correo confirmado o decisión explícita del administrador. Sin resolver → **cuarentena** `identidad_no_confirmada_por_correo`, tarea sin responsable. Nunca por nombre. |
| `Project` | relation → Projects | `tasks.project_id` | Se resuelve por la base destino de la relación en el esquema, no por el rótulo. Varias → se usa la primera **+ cuarentena** `tarea_con_varios_proyectos`. Ninguna → proyecto **"Bandeja de Notion"**. |
| `Bloqueado por`, `Bloqueada por` | relation → Tasks | `tasks.depends_on` | Segunda pasada. Extremo fuera del lote → **cuarentena** `dependencia_fuera_del_lote`. |
| `Bloqueando`, `PreRequisito de` | relation → Tasks | *(nada)* | Lado inverso del mismo par dual: importarlo duplicaría la arista. Queda en el archivo. |
| `parent.page_id` | — | `tasks.parent_task_id` | Soportado. El esquema actual de Notion no expone subtareas, así que en la práctica es 0. |
| `Tags` | multi_select | *(nada)* | Archivo. |
| `HH estimadas`, `Horas H reales` | number | *(nada)* | Archivo. |
| `Related to Reuniones (Tareas)` | relation → Reuniones | *(nada)* | Fuera de alcance. Archivo. |
| `Created time` | created_time | *(nada)* | `created_at` es la fecha de importación; la de Notion queda en el archivo. |
| Bloques, comentarios, adjuntos | — | `notion_page_archives.payload` | `GET /api/tasks/:id/notion-origin`. |
| *(no existe en Notion)* | — | `tasks.stage` | **`OPERAR`** uniforme — decisión de esta rama, ver §13. |
| *(no existe en Notion)* | — | `tasks.description` | `null`: el cuerpo de la página vive en el archivo, no se aplana. Ver §13. |

### 5.2 Projects

| Campo Notion | Tipo | Destino AgentOS | Regla |
| --- | --- | --- | --- |
| `Name` | title | `projects.name` | Igual que en Tasks. |
| `Tasks` | relation | — | La relación se resuelve desde el lado de la tarea; nunca dos veces. |
| `FASE` | select | *(nada)* | **Nunca** se convierte en `ENTENDER/CONSTRUIR/OPERAR`. Archivo. |
| `Owner` | people | *(nada)* | AgentOS no modela responsable de proyecto. Archivo. Ver §13. |
| `Priority`, `Due Date`, `F. Inicio`, `F. Fin Real`, `Tags`, `Archive?`, `Attachments`, `Completed Tasks`, `Bloqueado por`, `PreRequisito de` | varios | *(nada)* | Archivo. |
| *(no existe en Notion)* | — | `projects.type` | **`ops`** uniforme — decisión de esta rama, ver §13. |
| *(no existe en Notion)* | — | `projects.stage` | **`OPERAR`** uniforme (igual que las tareas: si el proyecto quedara en una etapa anterior, `assertGate1` atraparía todas las tareas importadas en BACKLOG). |
| *(no existe en Notion)* | — | `projects.org_id` | Organización **interna Sixteam**. No se infiere cliente por el nombre del proyecto. Ver §13. |

### 5.3 Bandeja de Notion

Las tareas sin `Project` **no** van a cuarentena silenciosa: entran en un proyecto
contenedor por organización llamado **"Bandeja de Notion"**, marcado como tal con
un enlace de linaje `notion_import_links.source_kind='inbox'` e
`import_status='inbox_container'`. Conservan su archivo, su URL original y su
enlace idempotente como cualquier otra tarea.

## 6. Secuencia de ejecución

1. Rotar el token expuesto previamente y crear la conexión exclusiva de lectura, compartida solo con las dos fuentes originales.
2. Ejecutar inventario/snapshot sin escrituras y entregar el manifiesto de conciliación.
3. Revisar la cola de identidades, relaciones, adjuntos y comentarios no capturables. No hay importación mientras exista una ambigüedad no decidida.
4. Ejecutar un piloto de 10 tareas y 3 proyectos que cubra multi-responsable, detalle de página, fecha, dependencia, relación, adjunto y comentario disponible. El piloto no activa correos ni sincronización de vuelta.
5. Mostrar la comparación origen/destino y aprobar el importador idempotente.
6. Importar por lotes de proyecto; reintentar una corrida no puede crear un segundo objeto ni una segunda relación.
7. Hacer snapshot delta y conciliación final; solo entonces decidir el corte.
8. Dejar Notion en consulta histórica. Reemplazar de forma separada las escrituras operativas existentes de WhatsAppHub por AgentOS, sin quitar la confirmación humana `create_confirmed_tasks`.

## 7. Gates de aceptación

No se considera terminada la migración si falta cualquiera de estos puntos:

- Conteos exactos de Tasks, Projects, estados, relaciones, adjuntos y comentarios accesibles iguales entre el manifiesto y la importación.
- Una y solo una `notion_import_link` por página de origen; los reintentos son idempotentes.
- Cada página importada tiene su archivo histórico, URL original y hash verificable.
- Cero identidades resueltas por nombre o silenciadas; toda excepción está en cuarentena.
- Campos no soportados, bloques desconocidos, adjuntos no descargables y comentarios no recuperables aparecen como excepciones, no como datos migrados.
- Cero escrituras en Notion durante inventario, snapshot, piloto o importación.
- La UI de AgentOS muestra el detalle histórico de una muestra aprobada y no altera la máquina de estados, gates ni auditoría actuales.

## 8. Límite conocido y decisión de corte

La migración puede conservar la página, propiedades, bloques, adjuntos accesibles y comentarios que la API permita leer; no puede prometer la reproducción del historial interno de versiones o de comentarios resueltos no expuestos por Notion. Por eso el corte no borra Notion: queda como archivo auténtico y enlazado hasta completar el período de reversa acordado.

## 9. Capturador listo para ejecutar

El paquete `@agentos/notion-migration` implementa un cliente sin endpoints de escritura, paginación, árbol de bloques, propiedades extensas, comentarios y manifiesto con hash. La plantilla sin secretos está en `packages/notion-migration/notion-snapshot.env.example`.

La copia con valores reales debe vivir fuera del checkout. Con una conexión disponible en ese archivo, la ejecución es:

```powershell
pnpm notion:snapshot -- --env-file C:\Users\samue\.agentos\notion-snapshot.env
```

El resultado crea una corrida nueva bajo `data/notion-snapshots/`; no importa registros a AgentOS ni escribe en Notion. Solo se permite usar `NOTION_TOKEN` de una integración operativa si el ejecutor agrega explícitamente `--use-operational-token`; la opción normal exige `NOTION_SNAPSHOT_TOKEN`.

---

## 10. Capturador ampliado (qué hace hoy de más)

Además de página, propiedades paginadas, árbol de bloques y comentarios, el
capturador ahora:

- **Descarga los adjuntos alojados en Notion** (bloques `image`, `file`, `pdf`,
  `video`, `audio` y propiedades de tipo `files`) y los guarda dentro del snapshot
  como `<fuente>/files/<page_id>/<sha256>.<ext>`, con un manifiesto por página en
  `<fuente>/files/<page_id>.json` (SHA-256, bytes, `content_type`, `stored_uri`,
  estado y motivo). Las URLs firmadas de Notion **caducan en una hora**: el binario
  con hash dentro del snapshot es la única conservación real. Los adjuntos
  `external` (alojados por terceros) **no se descargan**: se conserva la referencia
  con estado `external_reference`. Un fallo de descarga queda como `failed` con su
  motivo; nunca se descarta en silencio.
- **Intenta las páginas archivadas / en papelera** con una segunda pasada de
  consulta (`archived`/`in_trash`). La API pública de Notion **no promete** listar
  la papelera: si la rechaza, queda una excepción de categoría `archived` en el
  manifiesto de la fuente. Es un límite registrado, no un "no había nada".
  El manifiesto de cada fuente cuenta `archived_captured`,
  `attachments_downloaded`, `attachments_external` y `attachments_failed`.

Banderas nuevas: `--no-attachments` y `--no-archived` (ambas capturas están
activas por defecto).

## 11. Procedimiento exacto de importación a producción

**Nada de esto se ejecuta sin la aprobación explícita de Ernesto.** El importador
escribe SOLO en la base que se le pasa por `--db`; no tiene valor por defecto a
propósito.

```bash
# 0) Snapshot fresco (solo lectura hacia Notion)
cd packages/notion-migration
npx tsx src/cli.ts \
  --env-file C:/Users/samue/.agentos/notion-snapshot.env \
  --output-dir C:/Users/samue/2brain/agentos/data/notion-snapshots
# Verificar que la carpeta nueva tiene manifest.json: sin el, la corrida esta
# incompleta y el importador se niega a leerla.

# 1) Ensayo en seco sobre una COPIA (no escribe una sola fila)
cp data/agentos.db /tmp/ensayo.db && cp data/agentos.db-wal /tmp/ensayo.db-wal
npx tsx src/import-cli.ts --snapshot <dir-del-snapshot> --db /tmp/ensayo.db --dry-run

# 2) Piloto sobre la copia
npx tsx src/import-cli.ts --snapshot <dir> --db /tmp/ensayo.db --pilot 10,3
# Revisar a mano 10 tareas y 3 proyectos contra Notion + revisar la cuarentena.

# 3) Importacion completa sobre la copia y conciliacion
npx tsx src/import-cli.ts --snapshot <dir> --db /tmp/completo.db

# 4) SOLO tras aprobacion: produccion
#    a. Parar apps/api (es el dueno unico de la DB).
#    b. cp data/agentos.db data/agentos.db.bak-pre-notion-import
#    c. pnpm --filter @agentos/db migrate      (aplica 0007_notion_linaje)
#    d. npx tsx src/import-cli.ts --snapshot <dir> --db data/agentos.db --confirmo-produccion \
#         [--identity-map C:/Users/samue/.agentos/notion-identidades.json]
#       (sin --confirmo-produccion el CLI se niega a escribir en data/agentos.db)
#    e. Revisar el informe JSON y la tabla notion_import_quarantine.
#    f. Reiniciar apps/api.
```

Reejecutar el paso (d) es seguro: la clave `(source_kind, notion_page_id)` de
`notion_import_links` hace que la segunda corrida **actualice** los mismos objetos
en vez de crear otros. Cada corrida deja su propia fila en
`notion_migration_runs` con el hash del manifiesto importado y el informe completo.

**Aviso honesto sobre reejecutar:** una segunda corrida trata el snapshot como
la verdad de las columnas mapeadas (título, estado, prioridad, fecha, proyecto).
Si alguien editó esos campos **dentro de AgentOS** después de importar, la
reejecución los devuelve al valor de Notion. Lo que NO se pisa: los responsables
resueltos por decisión del administrador se mantienen si la corrida nueva no
resuelve ninguno, y las tareas creadas nativamente en AgentOS no se tocan (no
tienen enlace de linaje). Después del corte, el importador solo debería volver a
correr para un delta explícito y aprobado.

### Cómo se elige el lote del piloto

`--pilot 10,3` **no** toma las 10 primeras tareas. `pilot-selection.ts` hace una
cobertura voraz determinista: en cada paso elige la tarea que aporta más rasgos
todavía no cubiertos —multi-responsable, fecha, rango de fechas, dependencia,
con proyecto, sin proyecto, adjunto, comentario, estado terminado, estado
bloqueado y campo en cuarentena— con desempate por id para que el lote sea
reproducible. Los 3 proyectos salen de las tareas elegidas, no de un prefijo, de
modo que el piloto sea coherente consigo mismo.

El informe trae `pilot_coverage` con tres listas: `covered` (lo que el lote
ejercita), `missing` (rasgos que existen en el snapshot pero no cupieron en el
lote — sube el límite si te importan) y `absent` (rasgos que ninguna tarea del
snapshot tiene; eso es un dato del origen, no un fallo del importador).

### Mapa de identidades (`--identity-map`)

JSON plano `{"<notion_person_id o correo>": "<people.id de AgentOS>"}`. Es la vía
para la **decisión explícita del administrador** cuando la persona existe en
AgentOS pero sin correo registrado. Vive fuera del repositorio. La alternativa
—preferible— es rellenar `people.email` en AgentOS y dejar que el emparejado por
correo confirmado funcione solo.

### Ficha "Historial de Notion" para la UI

`GET /api/tasks/:id/notion-origin` y `GET /api/projects/:id/notion-origin`
(sesión requerida, solo lectura). Devuelven `has_origin`, el `notion_page_id`, la
URL original, el hash del payload, las rutas relativas dentro del snapshot, el
**payload íntegro** (`page`, `properties`, `blocks`, `comments`, `files`), la
corrida que lo importó y la cuarentena de esa página. `has_origin:false` con 200
significa "esto no vino de Notion" — no es un error. `apps/web` **no** se tocó en
esta rama: la ola siguiente monta la pestaña sobre este contrato.

## 12. Qué escribe hoy WhatsAppHub en Notion y qué hay que redirigir

Inventario **verificado en el código** de `C:\Users\samue\2brain\WhatsAppHub`
(rutas relativas a `backend/src/`). Esta sección es documentación: **no se ha
implementado ninguna redirección en esta rama**. Es el trabajo de la fase N5.

| Punto | Qué escribe | Base Notion destino |
| --- | --- | --- |
| `app/services/notionService.js:73-74` | `POST /v1/pages` — crea tarea (título + bloques "Asignado/Fuente/notas") | `NOTION_TASKS_DB_ID` |
| `app/services/notionMeetingsService.js:249` | `POST /v1/pages` — crea proyecto. **Detrás del flag `NOTION_CREATE_MISSING_PROJECTS === '1'`** (línea 245): por defecto NO crea proyectos | `NOTION_PROJECTS_DB_ID` |
| `app/services/notionMeetingsService.js:619` | `POST /v1/pages` — crea tarea interna con propiedades y cuerpo (`createTaskForItem`) | `NOTION_TASKS_DB_ID` |
| `app/services/notionMeetingsService.js:716` | `POST /v1/pages` — crea tarea de cliente (`createClientTaskForItem`) | `NOTION_CLIENT_TASKS_DB_ID` |
| `app/services/notionMeetingsService.js:780` | `POST /v1/pages` — crea página de reunión con hasta 100 bloques | `NOTION_MEETINGS_DB_ID` |
| `app/services/notionMeetingsService.js:450` | `PATCH /v1/pages/{id}` — **única** actualización de propiedades de página del repo | tareas |
| `app/services/notionMeetingsService.js:453` | `PATCH /v1/blocks/{id}/children` — añade el bloque de nota al cuerpo de la tarea | tareas |
| `app/services/conversationalAgentService.js:219` | Crea tarea desde chat — **indirecto**: delega en `notionMeetingsService.js:619` | `NOTION_TASKS_DB_ID` |
| `app/services/conversationalAgentService.js:243` | Actualiza tarea desde chat — **indirecto**: `notionMeetingsService.js:450` (+`:453` si hay nota) | `NOTION_TASKS_DB_ID` |
| `app/services/taskFollowupService.js:714` | "Cierra" la tarea: **cambia el estado** a `TASK_FOLLOWUP_DONE_VALUE` (default `Completada`). **No archiva la página** | `NOTION_TASKS_DB_ID` |
| `app/services/taskFollowupService.js:730` | Mueve la fecha límite +1 día (botón "mas1") | `NOTION_TASKS_DB_ID` |
| `app/services/taskFollowupService.js:803` | Mueve la fecha límite N días (respuesta libre) | `NOTION_TASKS_DB_ID` |
| `app/services/notionClipsService.js:139-140` | `POST /v1/pages` — crea página de clip | `NOTION_CLIPS_DB_ID` |

Puntos de entrada que las disparan: `app/controllers/agent.controller.js:56`,
`app/controllers/notes.controller.js:151` y `:268`,
`app/controllers/meetings.controller.js:105` y `:386`,
`app/services/meetingReviewService.js:183`.

**Marca de idempotencia del pipeline de WhatsAppHub** (SQL crudo en
`backend/src/db/migrations.js`, reflejado en `backend/prisma/schema.prisma`):

| Columna | Dónde se define | Dónde se escribe |
| --- | --- | --- |
| `meetings.notion_page_id` | `schema.prisma:229`, `migrations.js:344` | `db/meetingStore.js:240`, `:352-353` |
| `meetings.notion_synced_at` | `schema.prisma:227`, `migrations.js:342` | idem (bloquea la re-sync en `meetingReviewService.js:175`) |
| `meetings.notion_attempts` | `schema.prisma:228`, `migrations.js:343` | idem |
| `social_clips.notion_page_id` | `schema.prisma:376`, `migrations.js:481` | `db/clipStore.js:70` |

**Corrección respecto al inventario previo:** `social_clips.notion_synced_at`
**no existe**. El dedupe de clips se hace por presencia de `notion_page_id`, no
por timestamp. Cualquier redirección tiene que replicar esa marca de
idempotencia en AgentOS o el corte duplicará clips.

Verificado también: en todo WhatsAppHub **no hay** archivado (`archived:true` /
`in_trash`), ni `databases.create`, ni `comments.create`, ni `DELETE` contra
Notion. `wikiHubsService.js` tiene su propio cliente de Notion pero **solo lee**.

## 13. Decisiones tomadas en esta rama que Ernesto debe confirmar

Ninguna es reversible "gratis" después de importar a producción: cámbialas antes.

1. **`tasks.stage` y `projects.stage` = `OPERAR`** para todo lo importado. Notion no
   tiene el concepto. Se eligió uniforme (nunca derivado de `FASE`) y la misma
   etapa en tarea y proyecto para que `assertGate1` no atrape las tareas
   importadas en BACKLOG. Alternativa: `ENTENDER` en ambos.
2. **`projects.type` = `ops`** para todo lo importado. Alternativa: `transform`
   para los proyectos en `FASE = Implementacion`, pero eso sería derivar de `FASE`,
   que el plan prohíbe.
3. **Organización destino = la interna `Sixteam`.** Emparejar un proyecto de Notion
   con `ACME S.A.` o `Textiles del Norte S.A.` exigiría inferir el cliente por el
   nombre, que es exactamente lo que la regla de identidad prohíbe. Re-asignar
   proyectos a organizaciones cliente es una decisión humana posterior.
4. **`tasks.description` queda `null`.** El cuerpo de la página (bloques) se
   conserva íntegro en el archivo y se lee por `/notion-origin`, siguiendo §5 del
   plan original. Si Ernesto prefiere ver el texto en la tarjeta, hay que aplanar
   los bloques a texto plano en el importador: es un cambio pequeño y aditivo.
5. **Prioridad**: `URGENTE!!! → urgent`, `ALTO → high`, `MEDIO → normal`,
   `BAJO → low`, sin prioridad → `normal`. No estaba en ningún documento previo.
6. **`Owner` de proyecto no tiene destino**: AgentOS no modela responsable de
   proyecto. Queda en el archivo. Si hace falta, es una columna nueva.
7. **Correos de `people` en AgentOS.** Hoy solo Ernesto tiene correo; los demás
   responsables de Notion caerán en cuarentena por diseño. Rellenar
   `people.email` antes de importar a producción es lo que convierte esa
   cuarentena en asignaciones reales.

## 14. Resultado real de la corrida del 2026-09-05

Snapshot `notion-2026-09-05T20-53-47-990Z`, manifiesto
`2c661ac73ac6672874bab296a582132763223dccccd86aab32e1ee8f8317873f`.
Piloto e importación completa ejecutados sobre **copias temporales** de
`data/agentos.db`. La base viva no fue tocada.

### 14.1 Captura

| | Tasks | Projects |
| --- | --- | --- |
| Páginas capturadas | 1232 | 33 |
| Archivadas / en papelera | 0 | 0 |
| Adjuntos descargados (con SHA-256) | 116 | 0 |
| Adjuntos externos (solo referencia) | 2 | 0 |
| Adjuntos fallidos | 0 | 0 |
| Excepciones | 1 | 1 |

Tamaño del snapshot: 45 MB. Las dos únicas excepciones son de categoría
`archived` con estado **HTTP 400**: la API pública de Notion **rechaza** pedir
las páginas archivadas/en papelera en la consulta de base de datos. Queda
registrado como límite explícito, no como "no había nada archivado".

Otro dato del origen: **ninguna** página devolvió comentarios. La conexión pudo
llamar al endpoint sin error (cero excepciones de categoría `comments`), así que
no es un problema de permisos: no hay comentarios que preservar en estas dos
bases.

### 14.2 Conciliación origen ↔ destino (importación completa)

Contado de forma independiente a los dos lados: a la izquierda leyendo los JSON
del snapshot, a la derecha con SQL sobre la copia importada.

| Métrica | Origen (snapshot) | Destino (copia) |
| --- | --- | --- |
| Tareas | 1232 | 1232 enlaces `task` |
| Proyectos | 33 | 33 enlaces `project` + 1 `inbox` |
| Archivos históricos | — | 1265 (1232 + 33), todos con payload |
| `Completada` → `DONE` | 1005 | 1005 |
| `Sin empezar` → `BACKLOG` | 124 | 124 |
| `StandBy/Sin Información` → `BLOCKED` | 38 | 38 |
| `Realizando` → `IN_PROGRESS` | 34 | 34 |
| `En validación` → `REVIEW` | 31 | 31 |
| `ALTO` → `high` | 297 | 297 |
| `MEDIO` (243) + sin prioridad (633) → `normal` | 876 | 876 |
| `URGENTE!!!` → `urgent` | 36 | 36 |
| `BAJO` → `low` | 23 | 23 |
| Con fecha | 1058 | 1058 |
| Dependencias (lado "depende de") | 4 | 4 aristas `depends_on` |
| Tareas sin `Project` | 182 | 182 en "Bandeja de Notion" |
| Tareas con Ernesto | 182 | 182 filas en `task_assignees` |
| Pares tarea↔persona que no son Ernesto | 743 | 743 en cuarentena |
| Tareas con más de un proyecto | 5 | 5 en cuarentena |
| Títulos vacíos (1 tarea + 1 proyecto) | 2 | 2 en cuarentena |

Todas las tareas importadas quedaron en `stage=OPERAR`; los 34 proyectos
(33 + la Bandeja) en `type=ops, stage=OPERAR`. La copia pasó de 0,9 MB a 15 MB:
la diferencia es el archivo histórico íntegro.

### 14.3 Cuarentena (750 entradas)

| Motivo | Filas | Qué significa y qué hacer |
| --- | --- | --- |
| `identidad_no_confirmada_por_correo` | 743 | Los 4 responsables de Notion que **no** son Ernesto (`samuel@sixteam.pro`, `sebastian@sixteam.pro`, `jorgesixteampro@gmail.com`, `guillot0777@gmail.com`) no tienen correo en `people`. **Rellenar `people.email` antes de la importación a producción** convierte estas 743 excepciones en asignaciones reales; si no, esas tareas quedan sin responsable. |
| `tarea_con_varios_proyectos` | 5 | Se usó el primer proyecto de la relación. Decisión humana pendiente. |
| `titulo_vacio_en_origen` | 2 | Una tarea y un proyecto sin título en Notion; entraron como `(sin título en Notion)`. |

`notion_identity_mappings` quedó con 5 filas: 1 `confirmed_email` (Ernesto,
`validation_state=confirmed`) y 4 `unresolved` en `pending_review`. **Cero
identidades emparejadas por nombre.**

### 14.4 Piloto (`--pilot 10,3`) y verificación manual

El lote elegido por cobertura ejercitó 11 de los 12 rasgos: responsable,
multi-responsable, fecha, rango de fechas, dependencia, con proyecto, sin
proyecto, adjunto, estado terminado, estado bloqueado y campo en cuarentena. El
único ausente, `con_comentario`, no existe en el snapshot (ver §14.1).

Las 10 tareas se compararon una a una contra el JSON del snapshot —título,
estado, prioridad, fecha, proyecto, responsables, dependencias, hash del
archivo y URL original—: **0 discrepancias**.

**Idempotencia verificada con datos reales:** la segunda corrida del piloto
sobre la misma copia dio `projects_created=0, tasks_created=0,
projects_updated=3, tasks_updated=10` y los mismos conteos de destino
(3 proyectos / 10 tareas). La copia quedó con 6 proyectos y 35 tareas (los 2 y
25 que ya tenía más lo importado), sin un solo duplicado.

Nota sobre las tablas de solo anexado: cada corrida abre su propia fila en
`notion_migration_runs` y escribe su propio archivo y su propia cuarentena. Por
eso tras dos corridas del piloto hay 26 archivos y 20 filas de cuarentena (13 y
10 por corrida). Eso es la traza histórica funcionando, no duplicación: los
objetos nativos y los enlaces siguen siendo 13.

### 14.5 Ficha de origen verificada en vivo

`GET /api/tasks/:id/notion-origin` y `GET /api/projects/:id/notion-origin`
probados contra la copia importada devuelven 200 con el payload íntegro. En una
tarea se leen `Tags`, `HH estimadas`, `Horas H reales`,
`Related to Reuniones (Tareas)`, `Bloqueando` y `PreRequisito de`; en un
proyecto, `FASE`, `Owner`, `Archive?`, `F. Inicio`, `F. Fin Real`, `Priority`,
`Tags` y `Attachments`. Una tarea nativa de AgentOS responde
`{"has_origin": false}` con 200, como se diseñó.
