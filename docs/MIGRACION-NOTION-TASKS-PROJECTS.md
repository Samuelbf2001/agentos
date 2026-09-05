# Migración preservando historial: Notion → AgentOS

**Estado:** Fase 1 preparada. Solo lectura; todavía no se ha extraído ni escrito ningún registro.

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

## 5. Mapeo controlado

| Origen | Destino operativo | Regla de preservación |
| --- | --- | --- |
| Task `Name` | `tasks.title` | Mantener también el valor crudo en el archivo. |
| `Estado` | Estado canónico de AgentOS | `Sin empezar → BACKLOG`, `Realizando → IN_PROGRESS`, `StandBy/Sin Información → BLOCKED`, `En validación → REVIEW`, `Completada → DONE`. El estado original siempre queda guardado. |
| `Due Date` | `tasks.due_at` | Conservar zona horaria, inicio y fin originales. |
| `Asignado` | `task_assignees` | Solo coincidencia confirmada por correo; nunca por nombre. Ambiguo o inexistente va a cuarentena. |
| `Project` / `Tasks` | relación tarea-proyecto | Resolver después de crear ambos conjuntos; no crear duplicados. |
| Dependencias y bloqueos | relaciones de dependencia/bloqueo | Importar en una segunda pasada; confirmar semántica de cada propiedad con el esquema, no por el rótulo. |
| Horas, prioridad, tags, reuniones y campos sin columna nativa | atributo tipado futuro + archivo histórico | No falsear el modelo actual ni perder el valor fuente. |
| Bloques, comentarios y adjuntos | ficha `Historial de Notion` de solo lectura | Renderizar desde el archivo histórico, con enlace al original. |
| Project `FASE` | metadato de negocio original | Nunca convertirla automáticamente en las fases técnicas `ENTENDER / CONSTRUIR / OPERAR` de AgentOS. |
| `Owner` | responsables del proyecto | Misma regla de identidad confirmada por correo. |

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
