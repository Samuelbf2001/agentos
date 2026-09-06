# Diseño — Ficha de tarea al estilo Notion (side peek redimensionable, edición inline, proyecto/cliente)

**Fecha:** 2026-09-05 · **Estado:** spec verificada contra el código, decisiones tomadas, pendiente de implementar.
**Queja del usuario:** (1) la ficha se abre "en medio" y no se puede ensanchar/estrechar; (2) hay que pulsar "Editar" para modificar; (3) asociar la tarea a un proyecto o cliente es engorroso. Objetivo: replicar la página de tarea de Notion.

## 0. Datos reales de Notion (snapshot 2026-09-04, 1232 tareas)

Llenado: Name/Estado 100%, Due Date 86%, Project 85%, Asignado 55%, Priority 49%, Reuniones 19%, Tags 4%, HH estimadas 3%, Horas reales 3%, dependencias 0%.
**Núcleo visible de la ficha: Estado, Vencimiento, Proyecto, Asignado, Prioridad.** El resto va plegado tras "N más propiedades" y oculto si está vacío, como hace Notion.

## 1. Patrón Notion a replicar

- **Modos:** side peek (panel derecho, ~50%, **borde izquierdo arrastrable**, ancho persistido), center peek (modal ~70%×80%) y full page. Conmutador en la cabecera. La URL refleja la página abierta: Atrás cierra, recargar reabre.
- **Cabecera:** título como H1 contenteditable. Sin botón "Editar": clic → cursor; guarda en blur y Enter; Esc revierte.
- **Bloque de propiedades** bajo el título: tabla de 2 columnas (icono+nombre | valor). Toda fila es click-to-edit con popover anclado al valor: status/select → lista con búsqueda; date → calendario + "quitar"; people → buscador con avatares, multi; relation → buscador por título, chips; number/text → input en sitio; multi_select → chips con búsqueda. **Guardado optimista al cerrar el popover; nunca hay "Guardar".**
- Propiedades vacías plegadas tras "N más propiedades".
- Debajo: actividad, comentarios y contenido.

## 2. Estado actual (verificado, archivo:línea)

- **Contenedor:** `apps/web/src/views/TaskDrawer.tsx:969-972` — Radix `Dialog` modal con overlay opaco; `fixed inset-0` en móvil, `sm:right-0 sm:w-[480px]` en escritorio. Ya está a la derecha, pero **ancho fijo, no redimensionable, y el overlay bloquea el tablero**. Se monta una vez en `apps/web/src/App.tsx:280`, fuera de `<Routes>`.
- **URL:** no refleja la tarea. Se abre con `openTask(id)` (`store.ts:805-833`) desde Board, Tareas, Hoy, Runs, Ruta, Swarm, Chat y `SearchOverlay`; `closeTask` en `store.ts:840-843`. `lib/paths.ts` no tiene entrada de tarea.
- **"Modo edición":** cinco estados locales con botón de guardar — título (`:363`, botón `data-testid="edit-title"` `:391`), descripción (`:77`), definición de terminado (`:476`), etiquetas (`:650`), responsables (`assignmentDirty`, `:1084`), vencimiento (`dueDirty`, `:1096`). Solo prioridad es inline (`<select>` `:450-463`). Todos usan `updateTask` (`store.ts:845-865`) con `expected_version`; el conflicto deja `taskMutationError` y el banner `data-testid="task-conflict"` (`:996`) con "Recargar tarea" manual.
- **Estado (`status`) no se cambia desde la ficha:** solo drag & drop (`moveTaskOptimistic`, `store.ts:589-646`, `POST /api/tasks/:id/move`) o aprobar/rechazar en REVIEW (`:1031-1046`).
- **Proyecto no es editable en ninguna parte.** `UpdateTaskBody` (`apps/api/src/routes/board.ts:128-136`) solo acepta title/description/definition_of_done/activity_type/priority/due_at. Se muestra como texto en `ContextStrip` (`:296-302`).
- **Cliente existe:** `organizations` (`packages/db/src/schema.ts:58-67`) vía `projects.orgId` (`:86-103`). Es atributo del proyecto, no de la tarea. `TareasView` ya filtra por cliente (`:284,525`).
- **Tipos:** `Task` en `apps/web/src/lib/types.ts:114-144`; `tasks` en `schema.ts:174-214`. El tipo web no expone `dependsOn`. No existen horas estimadas/reales en el modelo.
- **Endpoints:** `PATCH /api/tasks/:id` (`board.ts:559`), `POST /:id/move` (`:589`), `POST /:id/assign` (`:622`), `PUT /:id/labels` (`:536`, sin `expected_version` a propósito), comment/approve/reject/artifacts. **Faltan:** cambiar proyecto, cambiar stage, dependencias, horas.
- **Bug latente:** `PATCH /api/tasks/:id` audita pero **no publica en `board:<projectId>`** (`:559-587`), a diferencia de labels (`:552`) y comment (`:614`).
- **UI reutilizable:** `components/ui.tsx` solo tiene avatares, pills, dots, EmptyState, ErrorBox, Spinner, Toasts. **No hay Popover/Select/Combobox/DatePicker.** Única dependencia Radix: `react-dialog`. `CreateTaskDialog.tsx` usa `<select>` nativos y duplica la lógica de roster (`TaskDrawer.tsx:915-921` vs `CreateTaskDialog.tsx:144-157`).
- **Tests que se romperán a propósito:** `project-tasks.test.tsx:70,127,155`, `task-close.test.tsx:43,81,229,254,265,286,314`, `task-labels-search.test.tsx:76`.

## 3. Decisiones tomadas (no reabrir)

1. **Copiloto vs peek:** en ≥1280px el peek **empuja** el contenido (`padding-right` en `<main>`) y coexiste con el panel copiloto; por debajo, abrir el peek cierra el copiloto.
2. **Cambio de proyecto con responsables de otro cliente:** el backend **rechaza** con error `validation` que nombra al responsable conflictivo (no limpia en silencio). También rechaza si `parentTaskId`/`dependsOn` apuntan al proyecto viejo.
3. **Horas estimadas/reales y dependencias:** **fuera de alcance** de este rediseño (requieren migración + endpoint + tipo). Trabajo aparte.
4. **Cliente:** fila de solo lectura derivada del proyecto; el picker de proyecto agrupa por cliente. No se mezcla "cambiar cliente" con "cambiar proyecto".
5. **Dependencia nueva permitida:** `@radix-ui/react-popover` (misma familia que el dialog ya instalado).
6. **Stage:** se queda de solo lectura en v1 (falta endpoint).

## 4. Implementación

### 4.1 Contenedor — `apps/web/src/views/task/TaskPeekShell.tsx`
- Radix Dialog con `modal={false}`, sin overlay opaco; `onInteractOutside` no cierra al arrastrar sobre el tablero. `role="complementary"`, `aria-modal={false}`, `<h2>` que titula el panel.
- Modo `side`: `style={{width: peekWidth}}`, `sm:right-0 sm:inset-y-0`. `center`: `w-[min(90vw,860px)] max-h-[85vh]` centrado. `full`: ruta `/tareas/:taskId` que renderiza el mismo cuerpo sin Dialog.
- **Tirador:** `<div role="separator" aria-orientation="vertical" aria-valuenow data-testid="peek-resize">` en el borde izquierdo (`w-1.5 cursor-col-resize`), `pointerdown` + `pointermove` en `window` con `setPointerCapture`; `ancho = clamp(384, innerWidth - clientX, min(920, innerWidth*0.9))`. Teclado: ArrowLeft/Right ±32px.
- Persistencia: `localStorage["agentos_task_peek_width"]` y `["agentos_task_peek_mode"]`, con helpers puros `leerAnchoPeek`/`guardarAnchoPeek` en `apps/web/src/lib/tareas.ts` (mismo patrón que `:493-519`).
- Conmutador side/center/full en la cabecera (3 botones `aria-pressed`, `min-h-10`, foco visible).
- **URL:** query global `?tarea=<id>` (funciona desde las 8 vistas sin reescribir rutas). `paths.conTarea(pathnameYSearch, taskId)` en `lib/paths.ts`. Hook `useTaskDeepLink()` en `App.tsx`: `useSearchParams` → `openTask/closeTask` y viceversa con `replace:false` (Atrás cierra).
- <768px: ocupa todo el ancho, sin tirador.

### 4.2 Propiedades inline — `views/task/TaskProperties.tsx` + `PropertyRow.tsx` + `components/ui/InlinePopover.tsx`

| Propiedad | Control | Acción |
|---|---|---|
| Título | H1 contenteditable; blur/Enter guarda, Esc revierte | `updateTask({title})` |
| Estado | popover de lista con `StatusPill` | `moveTaskOptimistic` (máquina de estados, no PATCH) |
| Etapa | solo lectura v1 | — |
| Prioridad | popover con `PriorityDot` | `updateTask({priority})` |
| Vencimiento | popover con `<input type="datetime-local">` + "Quitar fecha" | `updateTask({due_at})` |
| Asignado | `PeoplePicker`: buscador + `PersonAvatar`, multi, marcar principal | `assignTaskPeople` |
| Proyecto | `ProjectPicker` (§4.3) | `moveTaskToProject` (nuevo) |
| Cliente | chip solo lectura desde `project.orgId` | — |
| Etiquetas | `LabelsPicker`: chips con búsqueda sobre `labelCatalog` | `setTaskLabels` (sin `expected_version`, a propósito) |
| Definición de terminado | textarea siempre visible, guarda en blur | `updateTask({definition_of_done})` |
| Agente | chip solo lectura | — |

Guardado optimista al cerrar el popover, con reversión si falla (patrón de `moveTaskOptimistic`, `store.ts:602-619`). **409 `version_conflict`:** `updateTask` además llama `retryTaskDetail()`; `PropertyRow` reabre el popover con el valor releído y un aviso de una línea "Otra persona lo cambió a X". Sustituye al banner global manual. "N más propiedades" con estado en `localStorage`.

`PeoplePicker` absorbe la lógica de roster duplicada: extraer `useProjectRoster(projectId)` a `apps/web/src/lib/roster.ts` y consumirlo desde el drawer y `CreateTaskDialog`.

### 4.3 Proyecto — `views/task/ProjectPicker.tsx` + backend mínimo
- Chip del proyecto actual + popover con buscador por nombre agrupado por cliente (`clienteLabel`/`clientesDe` de `lib/tareas.ts`). Enlace "Crear proyecto" a `paths.nuevoProyecto()` (no hay `api.createProject` en el cliente web).
- **Backend:** `POST /api/tasks/:id/project` body `{project_id, expected_version}` en `apps/api/src/routes/board.ts`. Valida destino existente; revalida responsables con `validateTaskAssigneeOrganization` (`packages/db/src/repositories/task-assignees.ts:119-137`) y rechaza nombrando el conflicto; rechaza si `parentTaskId`/`dependsOn` apuntan al proyecto viejo; recalcula `orderKey` en la columna destino. Publica `task.moved_project` en **ambos** topics `board:<old>` y `board:<new>`. Audita.
- Mismo cambio: **`PATCH /api/tasks/:id` publica `task.updated` en `board:<projectId>`** (corrige el bug latente).
- Web: `api.moveTaskProject(id, body)`, acción `moveTaskToProject(taskId, projectId)` optimista con reversión; reducer maneja `task.moved_project` junto a `task.moved` (`reducer.ts:190`): quita la tarjeta del tablero viejo y la añade al nuevo.

### 4.4 Qué se queda como está
`ArtifactBlock`, `ArtifactAttacher`, `BlockedMoveNotice`, aprobación REVIEW, timeline y comentarios: se mueven al cuerpo bajo las propiedades sin reescribir. `TaskDescriptionEditor` pierde el botón "Editar" (textarea siempre visible, guarda en blur). `ContextStrip` se disuelve: proyecto y cliente pasan a propiedades; fuentes/documentos quedan como sección del cuerpo.

## 5. Tests (`apps/web/test/task-peek.test.tsx` + adaptar los citados en §2)
1. Arrastrar el tirador cambia el ancho y lo persiste; al remontar arranca con ese ancho.
2. El ancho respeta min y max aunque el puntero salga de la ventana.
3. Cambiar estado desde la ficha, sin modo edición → `POST /api/tasks/t1/move` con `expected_version` (body exacto).
4. Cambiar prioridad/vencimiento → PATCH con `expected_version`; no existe `data-testid="edit-title"` ni "Guardar fecha".
5. Un 409 relee la tarea y reabre el popover con el valor nuevo.
6. Elegir otro proyecto → `POST /api/tasks/t1/project`; `task.moved_project` quita la tarjeta del tablero viejo (test de reducer).
7. Esc cierra y limpia `?tarea`; abrir con `?tarea=t1` monta la ficha; Atrás cierra sin salir de la vista.
8. En <768px el peek ocupa todo el ancho y no muestra tirador.
Backend (`apps/api/test`): `POST /project` rechaza responsable de otro cliente nombrándolo; publica en ambos topics; PATCH publica `task.updated`.

## 6. Riesgos
- Quitar el overlay cambia la gestión de foco: Esc y clic-fuera deben seguir funcionando sin cerrar al arrastrar sobre el tablero.
- El tirador sin `role="separator"`, `aria-valuenow` y teclado rompe accesibilidad.
- `PUT /labels` no participa en la reconciliación por versión (deliberado).
