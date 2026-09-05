# PRD — Módulo operativo de Proyectos y Tareas

**Estado:** aprobado para construcción · **Fecha:** 2026-09-01  
**Producto:** AgentOS / 2brain · **Owner funcional:** Samuel  
**Decisión de producto:** construir un módulo nativo y acotado. No es un clon de Notion ni depende de AppFlowy como sistema operativo.

## 1. Problema y resultado esperado

2brain ya conserva proyectos, personas, tareas, artefactos, documentos de conocimiento, fuentes de proyecto y rutas de workspace. El tablero actual está orientado a la operación de agentes: una sola persona asignada, siete estados técnicos y una matriz por fase. Falta una superficie sencilla para que el equipo humano pueda ver qué está pendiente, quién responde, qué proyecto lo contiene y qué evidencia/archivos lo respaldan.

El resultado será un único módulo de trabajo dentro de AgentOS que permita gestionar proyectos y tareas conectados con los datos que 2brain ya tiene. La base de datos y el motor de AgentOS serán la fuente de verdad. Notion podrá importarse una sola vez en una fase posterior, pero no interviene en la operación diaria.

## 2. Alcance del MVP

1. **Proyectos.** Usar la entidad `projects` existente: nombre, organización, fase, gate y ruta de workspace. El módulo puede navegar del proyecto a su tablero y sus fuentes ya vinculadas.
2. **Tareas.** Crear, editar y mover tareas por la máquina de estados existente sin cambiar sus gates, pruebas de evidencia, lease ni control `expected_version`.
3. **Responsables humanos.** Una tarea podrá tener cero o varios responsables de `people`. Se mostrará una persona principal cuando exista; la columna histórica `tasks.assignee_person_id` permanece como proyección compatible, no como lista autoritativa.
4. **Conexión con el brain.** La ficha de tarea mostrará sus artefactos/rutas; la vista de proyecto mostrará fuentes y documentos de conocimiento que el proyecto ya tiene. No se copian ni se indexan archivos de nuevo en este módulo.
5. **Dos avisos de correo, sin ruido.** Solo se generan: (a) asignación/cambio de responsable, y (b) recordatorio una vez a 24 horas del vencimiento. Nunca para tareas DONE/CANCELLED, nunca más de una vez por destinatario y tipo. La entrega queda apagada sin una configuración explícita del proveedor; los tests usarán un proveedor falso. No se enviará correo real durante el desarrollo.
6. **Vistas de trabajo.** Tablero de proyecto, "Mis tareas" por persona, tareas sin responsable y vencidas/próximas. El tablero conserva las fases y estados canónicos para no falsear la operación de los agentes, pero ofrece filtros humanos y tarjetas legibles.

## 3. Fuera de alcance

- Editor de documentos, bloques, páginas anidadas, bases configurables, fórmulas, calendario, automatizaciones generales, chat nuevo o clon visual/funcional de Notion.
- Permitir que una tarea eluda Gate 1/Gate 2, el control de versiones, REVIEW/DONE con evidencia o las reglas del BoardEngine.
- Copiar archivos fuera de sus workspaces, inventar identidades a partir de nombres similares, o convertir Notion/AppFlowy en una segunda fuente de verdad.
- Migración masiva desde Notion en esta entrega. Se hará después, con mapeo, dry-run, idempotencia y revisión humana.

## 4. Decisiones de diseño

### 4.1 Fuente de verdad y compatibilidad

`projects`, `tasks`, `people`, `artifacts`, `knowledge_docs` y `project_sources` de AgentOS son canónicos. El estado de una tarea continúa siendo `BACKLOG | READY | IN_PROGRESS | REVIEW | BLOCKED | DONE | CANCELLED`; la interfaz traduce etiquetas, no crea un segundo estado de negocio.

La lista de responsables vive en `task_assignees`. Si hay principal, `tasks.assignee_person_id` se actualiza en la misma transacción como proyección de compatibilidad para los consumidores actuales. La asignación de agente (`assignee_agent_id`) sigue siendo independiente de los responsables humanos.

### 4.2 Modelo de datos

Se añade, en SQLite y en el espejo PostgreSQL:

| Entidad | Campos esenciales | Regla |
| --- | --- | --- |
| `task_assignees` | `task_id`, `person_id`, `is_primary`, `assigned_by`, `created_at` | Un par tarea-persona es único; como máximo una primaria. Las personas deben pertenecer a la organización del proyecto. |
| `task_notification_log` | `task_id`, `person_id`, `kind`, `scheduled_at`, `delivered_at`, `status`, `dedupe_key`, `last_error` | `dedupe_key` único. `kind`: `assignment` o `due_24h`; registro durable para reintentos y auditoría. |

`tasks.due_at` ya existe; se expone por REST, MCP y UI en vez de duplicarse. La migración inicial transforma todo `assignee_person_id` existente a una asignación primaria. Las nuevas escrituras actualizan la proyección y la tabla puente atómicamente.

### 4.3 Correo seguro y deliberadamente pequeño

Un adaptador de correo con proveedor falso por defecto recibirá un `EmailMessage`. El adaptador real solo se habilita con configuración explícita de servidor y remitente; si no existe, los eventos quedan `suppressed`/`pending` con causa legible y no se hace ninguna llamada de red. La tarea de recordatorios será idempotente, procesará solo la ventana 24h y podrá ejecutarse desde un job del servidor. No se incluye una campaña ni una UI de plantillas.

## 5. Experiencia de interfaz

**Dirección:** *mesa de control operativa*: sobria, compacta, centrada en decidir y no en decorar. Superficies claras, tipografía de alta jerarquía y acentos de estado conservan el lenguaje visual actual de AgentOS. La estructura mantiene el proyecto visible arriba y reduce el tablero a decisiones accionables.

**Diferenciador:** cada tarjeta lleva un "riel de pulso" lateral que combina estado, vencimiento y responsables (humano + agente) sin obligar a abrirla. En la ficha, una franja de contexto enlaza proyecto, responsables, fuentes y artefactos.

- En escritorio, filtros horizontales y tablero desplazable; en móvil, filtros apilados, tarjetas de ancho completo y drawer a ancho total.
- Estados obligatorios de UI: carga, vacío, error recuperable, sin responsable, vencida/próxima y operación guardada/error de conflicto.
- Todos los selectores de persona tienen etiqueta y no muestran correo salvo en la ficha de administración/autorización.

## 6. Contratos funcionales

### 6.1 REST y eventos

- `GET /api/tasks?assignee_person_id=&project_id=&status=` devuelve la proyección con `assignees`.
- `GET /api/tasks/:id` devuelve tarea, `assignees`, artefactos, fuentes del proyecto/documentos vinculados, eventos y runs.
- `POST /api/tasks` acepta `assignee_person_ids`, `primary_assignee_person_id` y `due_at`; conserva el campo singular solo como compatibilidad de entrada temporal.
- `PATCH /api/tasks/:id` permite `due_at`, con `expected_version`.
- `POST /api/tasks/:id/assign` reemplaza la lista de responsables de forma atómica y conserva `expected_version`; publica `task.assigned` y audita antes/después.
- `POST /api/notifications/process-due` es interno/protegido y solo dispara el procesador idempotente; no permite destinatarios arbitrarios.

Los eventos del tablero seguirán disparando la reconciliación de la UI. Las mutaciones conservan `appendTaskEvent`, `appendAudit` y la comprobación de sesión actual.

### 6.2 MCP

- `tasks.create`, `tasks.list`, `tasks.get` incorporan responsables y fecha de vencimiento.
- Se añade `tasks.assign_people` con `expected_version`; no permite cambiar asignación de agentes ni realizar correo arbitrario.
- `tasks.set_due_date` fija o limpia `due_at` con `expected_version`; conserva estado, responsables, evento y auditoría, y no envía correo por sí misma.
- El MCP reutiliza los mismos servicios de dominio/validación que REST. Una llamada read-only nunca procesa correo ni muta el log.

## 7. Criterios de aceptación verificables

1. Se puede crear una tarea con dos personas, definir una como principal y verla igual en tablero, ficha, REST y MCP.
2. Reasignar la tarea con una versión válida cambia la tabla puente, la proyección histórica, el evento y la auditoría; con una versión vieja devuelve conflicto y no cambia nada.
3. No puede asignarse una persona de otra organización ni una persona inexistente.
4. Las tareas existentes con `assignee_person_id` se preservan como responsables primarios después de migrar.
5. Una ficha muestra artefactos y el contexto de fuentes/documentos ya vinculados al proyecto, sin duplicar contenido ni archivos.
6. El filtro "Mis tareas" y los indicadores sin responsable/vencida devuelven el conjunto correcto; el diseño funciona a 390×844 y escritorio sin corte horizontal involuntario.
7. Asignar a una persona con correo crea como máximo un aviso `assignment` por cambio real; una tarea a 24h crea a lo sumo un `due_24h` por persona. DONE/CANCELLED no reciben avisos.
8. Sin configuración del proveedor no sale red ni correo; con el fake provider, los envíos y fallos quedan verificables e idempotentes.
9. Las reglas existentes del BoardEngine, gates, artefactos, leases, dependencias y asignación de agentes continúan pasando sus pruebas.
10. SQLite y PostgreSQL mantienen el mismo esquema/contrato y las pruebas de portabilidad pasan.

## 8. Riesgos y mitigaciones

| Riesgo | Mitigación |
| --- | --- |
| Dos fuentes de verdad para responsables | Tabla puente canónica, proyección singular transaccional y prueba de backfill. |
| Avisos repetidos | `dedupe_key` única, ventana de recordatorio fija y tests de repetición/concurrencia. |
| Correo real no configurado | Adaptador deshabilitado/falso por defecto; no se considera entrega real sin proveedor y remitente verificados. |
| Romper la operación de agentes | No se toca la máquina de estados; regresiones del BoardEngine y dispatcher son gates de salida. |
| Reutilizar archivos o identidades de forma errónea | Mostrar referencias existentes; nunca inferir o copiar; validar pertenencia organizacional. |

## 9. Migración histórica de Notion (posterior al MVP)

Se ejecutará una sola vez mediante un importador separado: inventario y dry-run, mapeo explícito de personas/proyectos, idempotency key por página, reportes de ambiguos y aprobación humana antes de escribir. Las páginas, bloques, bases y permisos de Notion no se sincronizarán. Ningún token se almacena en código, logs, documentación o base de datos.
