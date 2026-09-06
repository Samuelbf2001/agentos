/**
 * Ficha de tarea. Desde el rediseño Notion (docs/DISENO-FICHA-TAREA-NOTION.md)
 * el contenedor es `views/task/TaskPeekShell` (side peek redimensionable,
 * center peek y página completa) y el cuerpo `views/task/TaskBody`. Este
 * módulo conserva el nombre `TaskDrawer` y reexporta los bloques que otras
 * vistas y tests ya importaban desde aquí.
 */
export {
  ArtifactAttacher,
  ArtifactBlock,
  BlockedMoveNotice,
  DefinitionOfDoneEditor,
  TaskDescriptionEditor,
  buildDescriptionInsert,
  fromDateTimeLocal,
  toDateTimeLocal,
} from "./task/TaskBlocks";
export { TaskPeekShell as TaskDrawer } from "./task/TaskPeekShell";
