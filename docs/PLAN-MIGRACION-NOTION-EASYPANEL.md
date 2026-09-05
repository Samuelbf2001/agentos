# Plan de migración: Notion → AgentOS

**Estado:** plan de ejecución posterior al staging de AgentOS. No modifica páginas, bases, vistas ni permisos de Notion.

## 1. Alcance y principio de preservación

Se migran exclusivamente las bases **Tasks** y **Projects** de `Projects & Tasks (1)`. Notion continúa como archivo histórico de consulta; no se borra, archiva masivamente ni se reemplaza hasta completar conciliación y una ventana de reversión.

La API pública de Notion no entrega un historial completo de versiones. Por ello la preservación se basa en un snapshot inmutable de la página actual, sus propiedades, bloques, relaciones, comentarios accesibles, adjuntos/metadatos y URL original. No se prometerá reconstruir revisiones o comentarios resueltos que la API no exponga.

## 2. Diseño de ejecución en EasyPanel

La migración será un job aislado, no una ruta de la UI ni una tarea de WhatsAppHub:

```text
Notion (solo lectura)
        │
        ▼
agentos-notion-migrator ──► agentos-notion-archive (volumen privado e inmutable)
        │                                      │
        ├──► manifiesto, hashes, cuarentena    └──► adjuntos autorizados
        ▼
agentos-db (solo tras aprobación de importación)
        │
        ▼
AgentOS web: ficha "Historial de Notion" de solo lectura
```

`@agentos/notion-migration` se ejecuta primero en modo snapshot. Sus credenciales serán una integración exclusiva para esta migración, de capacidad de lectura y limitada a las dos fuentes incluidas. No se copiará la configuración secreta de WhatsAppHub ni se utilizará en el proceso el token que fue compartido por chat; ese secreto debe rotarse antes de ejecutar.

## 3. Fases y gates

### Fase N0 — Seguridad e inventario de fuentes

1. Rotar la credencial de Notion expuesta y crear una credencial de migración independiente.
2. Compartir esa integración solo con Tasks y Projects; comprobar acceso sin cambiar nada.
3. Guardar en el gestor de secretos de EasyPanel únicamente `NOTION_SNAPSHOT_TOKEN` y referencias no secretas a las fuentes.
4. Registrar versión de API, esquema de cada fuente, paginación, conteos sin filtros, fecha y hash del manifiesto.

**Gate N0:** acceso probado, cero escrituras, inventario completo y ningún secreto en Git, logs, snapshots de pantalla o documentos.

### Fase N1 — Snapshot inmutable

Por cada página, el job capturará:

- página y propiedades completas, incluidos campos paginados;
- árbol recursivo de bloques sin descartar tipos desconocidos;
- relaciones, personas, icono, portada y metadatos de adjuntos;
- comentarios que la API permita recuperar, con causa explícita cuando no sea posible;
- referencia/descarga autorizada de adjuntos, SHA-256 y estado de cada archivo;
- URL de origen, fecha de captura, hash individual y hash global del manifiesto.

Los archivos se escriben como solo anexado en el volumen `agentos-notion-archive`, con una carpeta por `migration_run_id`. El job no escribe todavía en `projects` ni `tasks`.

**Gate N1:** manifiesto conciliable, páginas con errores separadas, bloques desconocidos preservados crudos y ninguna página descartada silenciosamente.

### Fase N2 — Normalización y revisión humana

1. Construir el mapa `notion_person_id → agentos_person_id` solo mediante correo confirmado o decisión explícita del administrador; nunca por nombre parecido.
2. Registrar ambigüedades en cuarentena sin asignar ni relacionar objetos incorrectamente.
3. Validar el esquema real del snapshot antes de traducir: estados, prioridad, fechas/rangos, relaciones Tasks–Projects, dependencias, bloqueos, etiquetas, horas y reuniones relacionadas.
4. Definir mapeos de estado: `Sin empezar → BACKLOG`, `Realizando → IN_PROGRESS`, `StandBy/Sin Información → BLOCKED`, `En validación → REVIEW`, `Completada → DONE`. El texto y valor originales quedan archivados.
5. Mantener `FASE` de Projects como metadato de negocio. No se convierte automáticamente en `ENTENDER`, `CONSTRUIR` u `OPERAR`.

**Gate N2:** cero identidades inferidas por nombre, relaciones ambiguas en cuarentena y mapa de campos aprobado contra el esquema capturado.

### Fase N3 — Piloto idempotente

Seleccionar 10 tareas y 3 proyectos que cubran multi-asignación, relación, dependencia, bloqueo, fecha/rango, adjunto, comentario accesible y estado terminado.

El importador crea registros de linaje:

```text
notion_migration_runs
notion_page_archives
notion_import_links
notion_identity_mappings
notion_import_quarantine
```

Cada objeto importado tiene una sola llave `(source_kind, notion_page_id)` por corrida. Reintentar no crea otra tarea, proyecto, asignación o relación. Los valores no modelados se almacenan como atributo tipado futuro y/o historia de Notion, nunca se inventan en campos operativos.

**Gate N3:** comparación manual origen/destino aprobada, reejecución sin duplicados, transiciones de AgentOS válidas y cero notificaciones externas.

### Fase N4 — Importación completa y conciliación

1. Importar proyectos y tareas en lotes idempotentes; resolver relaciones y dependencias en una segunda pasada.
2. Generar un delta snapshot de Notion antes de declarar el corte.
3. Conciliar conteos exactos por fuente, estado, asignación, relación, adjunto y excepción; contrastar hashes y links de linaje.
4. Publicar informe de errores sin títulos, contenido, teléfonos, correos o secretos; el detalle queda en el archivo protegido.

**Gate N4:** una y solo una importación enlazada por página; conteos explicados; toda excepción con motivo y responsable; ningún write a Notion.

### Fase N5 — Corte operativo y reversa

1. Mantener Notion como consulta histórica durante el período acordado.
2. Cambiar el flujo confirmado de WhatsAppHub para crear tareas solo en AgentOS. Se conserva revisión humana; no existe dual-write Notion/AgentOS.
3. Activar notificaciones AgentOS → WhatsAppHub solo mediante outbox idempotente y comprobante de entrega.
4. Desactivar las escrituras operativas a Notion después de verificar cero duplicados y evidencia de corte. La conexión de snapshot se puede revocar al finalizar el período de archivo.

**Reversa:** detener creación nueva en AgentOS, restablecer el destino operativo anterior solo si el corte fue autorizado para ello y conservar tanto snapshot como links de importación. No se borran registros importados para “deshacer”; se deja la auditoría y se abre una nueva corrida correctiva.

## 4. Criterios finales de aceptación

- Notion no recibió escrituras durante snapshot, piloto, importación ni conciliación.
- Cada página importada conserva URL, identificador Notion, hash, `migration_run_id` y referencia a su archivo histórico.
- Ninguna identidad fue emparejada por nombre; casos no resueltos siguen visibles en cuarentena.
- Las relaciones, dependencias, bloqueos y adjuntos tienen conteo reconciliado o excepción explícita.
- Los estados importados respetan el motor de gates y auditabilidad de AgentOS; un valor original no compatible no fuerza una transición inválida.
- Reintentar el importador no duplica datos ni genera notificaciones.
- El equipo puede abrir una muestra aprobada en AgentOS, revisar su historial y volver a la página original de Notion.

## 5. Secuencia real de comandos y permisos

En staging, el job se ejecutará primero como snapshot con una copia de entorno fuera del repositorio. Solo después de N1–N3 se habilita la fase de importación. La configuración, identificadores de fuentes, passwords, tokens y URLs firmadas no se guardan en este documento, en commits ni en la salida de jobs.

La ejecución completa requiere una aprobación explícita posterior al manifiesto N1 y otra posterior al piloto N3. Esas aprobaciones son el límite entre captura de historia, importación operativa y corte de la operación diaria.
