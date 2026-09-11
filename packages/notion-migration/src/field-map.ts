/**
 * Mapa de campos Notion → AgentOS. Módulo ÚNICO, tipado y puro: no toca disco,
 * ni red, ni base de datos. Todo lo que el importador decide sobre un valor de
 * origen se decide aquí, y solo aquí.
 *
 * Tres reglas que este módulo no rompe nunca:
 *
 * 1. **Nada se adivina.** Un valor de origen que no encaje en el modelo nativo
 *    devuelve una excepción tipada (`FieldExceptions`) que el importador manda a
 *    `notion_import_quarantine`; jamás se rellena una columna con una suposición.
 * 2. **Nada se pierde.** Los campos sin columna nativa se listan explícitamente
 *    en `TASK_FIELDS_WITHOUT_TARGET` / `PROJECT_FIELDS_WITHOUT_TARGET` y viajan
 *    íntegros al archivo histórico (`notion_page_archives`).
 * 3. **Ninguna identidad se resuelve por nombre.** Solo correo confirmado o
 *    decisión explícita del administrador (ver `resolveAssignees`).
 */
import type {
  BlockedReason,
  ProjectType,
  Stage,
  TaskPriority,
  TaskStatus,
} from "@agentos/shared";
import type { JsonObject } from "./notion-client.js";

// Los enums de dominio vienen de @agentos/shared, que es su fuente única
// (packages/shared/src/schemas.ts). Si alguien añade un estado al tablero, este
// módulo deja de compilar hasta decidir a qué valor de Notion corresponde.
export type { BlockedReason, ProjectType, Stage, TaskPriority, TaskStatus };

// ── Constantes de decisión ──────────────────────────────────────────────────

/**
 * `Estado` (status de Notion) → estado canónico del tablero.
 * Acordado en docs/MIGRACION-NOTION-TASKS-PROJECTS.md §5. Un valor fuera de
 * esta tabla NO se traduce: va a cuarentena y la tarea entra en BACKLOG.
 */
export const NOTION_STATUS_TO_TASK_STATUS: Readonly<Record<string, TaskStatus>> = {
  "Sin empezar": "BACKLOG",
  Realizando: "IN_PROGRESS",
  "StandBy/Sin Información": "BLOCKED",
  "En validación": "REVIEW",
  Completada: "DONE",
};

/**
 * `Priority` (select de Notion) → prioridad canónica.
 * DECISIÓN de esta rama (no estaba en el plan): `URGENTE!!! → urgent`,
 * `ALTO → high`, `MEDIO → normal`, `BAJO → low`. Sin valor → `normal`, que es
 * el default del esquema, y NO se registra excepción: la ausencia de prioridad
 * en Notion es un dato válido, no un error.
 */
export const NOTION_PRIORITY_TO_TASK_PRIORITY: Readonly<Record<string, TaskPriority>> = {
  "URGENTE!!!": "urgent",
  ALTO: "high",
  MEDIO: "normal",
  BAJO: "low",
};

/**
 * Relaciones de la propia base Tasks cuya semántica es "esta tarea depende de".
 * Las inversas (`Bloqueando`, `PreRequisito de`) NO se importan: son el otro
 * lado del mismo par dual y duplicarían la arista.
 */
export const DEPENDENCY_RELATION_NAMES: readonly string[] = ["Bloqueado por", "Bloqueada por"];
export const INVERSE_DEPENDENCY_RELATION_NAMES: readonly string[] = [
  "Bloqueando",
  "PreRequisito de",
];

/**
 * Defaults para las columnas obligatorias que Notion no tiene.
 *
 * `stage` y `type` son NOT NULL en AgentOS y no existen en Notion. Se importan
 * con un valor UNIFORME, nunca inferido de `FASE` (el plan lo prohíbe
 * explícitamente). `OPERAR` porque lo migrado es la operación corriente del
 * negocio, no trabajo de descubrimiento, y porque `assertGate1` exige que la
 * etapa de la tarea no sea posterior a la del proyecto: con proyecto y tarea en
 * la misma etapa, ninguna tarea importada queda atrapada en BACKLOG por un gate
 * que nadie pidió.
 */
export const IMPORT_DEFAULTS = {
  taskStage: "OPERAR" as Stage,
  projectStage: "OPERAR" as Stage,
  projectType: "ops" as ProjectType,
  taskPriority: "normal" as TaskPriority,
  /** `StandBy/Sin Información` es un bloqueo humano, no de dependencia ni de gate. */
  blockedReason: "manual" as BlockedReason,
} as const;

/** Proyecto contenedor de las tareas de Notion sin `Project`. Uno por organización. */
export const INBOX_PROJECT_NAME = "Bandeja de Notion";

/**
 * Campos de Notion SIN columna nativa en AgentOS. No se pierden: el importador
 * los guarda íntegros en `notion_page_archives.payload` y se leen por
 * `GET /api/tasks/:id/notion-origin`.
 *
 * `Tags` y `Created time` SÍ tienen destino desde esta rama: `Tags` →
 * `task_labels` (una fila por etiqueta) y `Created time` → `tasks.created_at`
 * (solo al crear; una tarea ya existente conserva el suyo). El cuerpo de la
 * página (bloques) → `tasks.description` en Markdown (`blocks-to-markdown.ts`).
 */
export const TASK_FIELDS_WITHOUT_TARGET: readonly string[] = [
  "HH estimadas",
  "Horas H reales",
  "Related to Reuniones (Tareas)",
  "Bloqueando",
  "PreRequisito de",
];

export const PROJECT_FIELDS_WITHOUT_TARGET: readonly string[] = [
  "Owner",
  "Due Date",
  "Priority",
  "FASE",
  "Tags",
  "F. Inicio",
  "F. Fin Real",
  "Archive?",
  "Attachments",
  "Completed Tasks",
  "Created time",
  "Bloqueado por",
  "PreRequisito de",
];

// ── Utilidades de lectura del JSON de Notion ────────────────────────────────

function asRecord(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Texto plano de un `rich_text`/`title` de Notion, sin anotaciones. */
export function plainText(richText: unknown): string {
  return asArray(richText)
    .map((item) => str(asRecord(item).plain_text) ?? "")
    .join("")
    .trim();
}

export function propertyOfType(page: JsonObject, name: string): JsonObject | undefined {
  const property = asRecord(asRecord(page.properties)[name]);
  return str(property.type) ? property : undefined;
}

/** Nombre de la propiedad `title` del esquema (no se asume que se llame "Name"). */
export function titlePropertyName(schema: JsonObject): string | undefined {
  for (const [name, definition] of Object.entries(asRecord(schema.properties))) {
    if (str(asRecord(definition).type) === "title") return name;
  }
  return undefined;
}

/** Única propiedad del esquema de un tipo dado; `undefined` si hay 0 o >1. */
export function solePropertyOfType(schema: JsonObject, type: string): string | undefined {
  const matches = Object.entries(asRecord(schema.properties))
    .filter(([, definition]) => str(asRecord(definition).type) === type)
    .map(([name]) => name);
  return matches.length === 1 ? matches[0] : undefined;
}

/** Propiedades `relation` que apuntan a una base concreta (semántica del esquema). */
export function relationPropertiesTo(schema: JsonObject, databaseId: string): string[] {
  const target = normalizeNotionId(databaseId);
  const output: string[] = [];
  for (const [name, definition] of Object.entries(asRecord(schema.properties))) {
    const property = asRecord(definition);
    if (str(property.type) !== "relation") continue;
    const relation = asRecord(property.relation);
    if (normalizeNotionId(str(relation.database_id) ?? "") === target) output.push(name);
  }
  return output;
}

/** Los ids de Notion viajan con y sin guiones; se comparan siempre normalizados. */
export function normalizeNotionId(value: string): string {
  return value.replace(/-/gu, "").toLowerCase();
}

// ── Valores mapeados ────────────────────────────────────────────────────────

export interface FieldException {
  field: string;
  reason: string;
  rawReference?: string;
}

export interface MappedStatus {
  status: TaskStatus;
  blockedReason: BlockedReason | null;
  originalValue: string | null;
  exception?: FieldException;
}

export function mapTaskStatus(page: JsonObject, propertyName: string | undefined): MappedStatus {
  const property = propertyName ? propertyOfType(page, propertyName) : undefined;
  const name = str(asRecord(property?.status).name);
  if (!name) {
    return { status: "BACKLOG", blockedReason: null, originalValue: null };
  }
  const mapped = NOTION_STATUS_TO_TASK_STATUS[name];
  if (!mapped) {
    return {
      status: "BACKLOG",
      blockedReason: null,
      originalValue: name,
      exception: {
        field: propertyName ?? "Estado",
        reason: "estado_desconocido",
        rawReference: name,
      },
    };
  }
  return {
    status: mapped,
    blockedReason: mapped === "BLOCKED" ? IMPORT_DEFAULTS.blockedReason : null,
    originalValue: name,
  };
}

export interface MappedPriority {
  priority: TaskPriority;
  originalValue: string | null;
  exception?: FieldException;
}

export function mapTaskPriority(page: JsonObject, propertyName: string | undefined): MappedPriority {
  const property = propertyName ? propertyOfType(page, propertyName) : undefined;
  const name = str(asRecord(property?.select).name);
  if (!name) return { priority: IMPORT_DEFAULTS.taskPriority, originalValue: null };
  const mapped = NOTION_PRIORITY_TO_TASK_PRIORITY[name];
  if (!mapped) {
    return {
      priority: IMPORT_DEFAULTS.taskPriority,
      originalValue: name,
      exception: {
        field: propertyName ?? "Priority",
        reason: "prioridad_desconocida",
        rawReference: name,
      },
    };
  }
  return { priority: mapped, originalValue: name };
}

export interface MappedDueDate {
  /** Epoch ms del INICIO del rango; `null` sin fecha. */
  dueAt: number | null;
  /** Fin del rango y zona horaria: sin columna nativa, quedan en el archivo. */
  rangeEnd: string | null;
  timeZone: string | null;
  start: string | null;
  exception?: FieldException;
}

/**
 * `Due Date` → `tasks.due_at`. Notion entrega fecha suelta (`2026-09-05`) o
 * fecha-hora ISO. La fecha suelta se ancla a medianoche UTC: determinista y
 * documentado, sin inventar hora local.
 */
export function mapDueDate(page: JsonObject, propertyName: string | undefined): MappedDueDate {
  const property = propertyName ? propertyOfType(page, propertyName) : undefined;
  const date = asRecord(property?.date);
  const start = str(date.start);
  const empty: MappedDueDate = { dueAt: null, rangeEnd: null, timeZone: null, start: null };
  if (!start) return empty;
  const parsed = Date.parse(start);
  if (!Number.isFinite(parsed)) {
    return {
      ...empty,
      start,
      exception: {
        field: propertyName ?? "Due Date",
        reason: "fecha_no_parseable",
        rawReference: start,
      },
    };
  }
  return {
    dueAt: parsed,
    rangeEnd: str(date.end) ?? null,
    timeZone: str(date.time_zone) ?? null,
    start,
  };
}

export interface NotionPerson {
  notionPersonId: string;
  email: string | null;
  /** Solo para el informe humano; NUNCA se usa para emparejar. */
  displayName: string | null;
}

/** Personas de una propiedad `people`, con su correo si Notion lo expone. */
export function readPeople(page: JsonObject, propertyName: string | undefined): NotionPerson[] {
  const property = propertyName ? propertyOfType(page, propertyName) : undefined;
  return asArray(property?.people).map((raw) => {
    const user = asRecord(raw);
    return {
      notionPersonId: str(user.id) ?? "",
      email: str(asRecord(user.person).email)?.toLowerCase() ?? null,
      displayName: str(user.name) ?? null,
    };
  }).filter((person) => person.notionPersonId.length > 0);
}

/**
 * Nombres de un `multi_select` (las etiquetas `Tags`), tal cual vienen de
 * Notion y sin duplicados. La normalización (minúsculas, espacios) la hace el
 * repositorio de etiquetas al escribir: es invariante de `task_labels`, no
 * decisión de este mapa.
 */
export function readMultiSelectNames(page: JsonObject, propertyName: string | undefined): string[] {
  const property = propertyName ? propertyOfType(page, propertyName) : undefined;
  const names = asArray(property?.multi_select)
    .map((item) => str(asRecord(item).name)?.trim())
    .filter((name): name is string => name !== undefined && name.length > 0);
  return [...new Set(names)];
}

/**
 * Fecha de creación original en Notion (epoch ms). Se prefiere
 * `page.created_time` (siempre presente en una página de la API); la
 * propiedad `created_time` del esquema (`Created time`) es el mismo valor y
 * solo se usa de respaldo. `null` si no se puede parsear.
 */
export function readCreatedTime(page: JsonObject, propertyName: string | undefined): number | null {
  const property = propertyName ? propertyOfType(page, propertyName) : undefined;
  const candidate = str(page.created_time) ?? str(property?.created_time);
  if (!candidate) return null;
  const parsed = Date.parse(candidate);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Ids de página referenciados por una propiedad `relation`. */
export function readRelationIds(page: JsonObject, propertyName: string): string[] {
  const property = propertyOfType(page, propertyName);
  if (!property) return [];
  return asArray(property.relation)
    .map((item) => str(asRecord(item).id))
    .filter((id): id is string => id !== undefined);
}

export interface IdentityResolution {
  /** `people.id` cuando el correo coincide (o el administrador lo decidió). */
  agentosPersonId: string | null;
  matchMethod: "confirmed_email" | "admin_decision" | "unresolved";
  reason: string | null;
}

/**
 * Resolución de identidad. Orden: decisión explícita del administrador →
 * correo confirmado → sin resolver. **No hay rama por nombre**: un parecido de
 * nombre nunca asigna una tarea a nadie.
 */
export function resolveIdentity(
  person: NotionPerson,
  directory: {
    /** `people.id` por correo en minúsculas. */
    byEmail: ReadonlyMap<string, string>;
    /** Decisiones del administrador: notion_person_id o correo → `people.id`. */
    adminDecisions?: ReadonlyMap<string, string>;
  },
): IdentityResolution {
  // Las claves del mapa del administrador se comparan en minúsculas: da igual
  // si escribió el id de Notion o el correo, y da igual la caja.
  const decision =
    directory.adminDecisions?.get(person.notionPersonId.toLowerCase()) ??
    (person.email ? directory.adminDecisions?.get(person.email) : undefined);
  if (decision) {
    return { agentosPersonId: decision, matchMethod: "admin_decision", reason: null };
  }
  if (!person.email) {
    return {
      agentosPersonId: null,
      matchMethod: "unresolved",
      reason: "notion_no_expone_correo",
    };
  }
  const match = directory.byEmail.get(person.email);
  if (!match) {
    return {
      agentosPersonId: null,
      matchMethod: "unresolved",
      reason: "correo_sin_persona_en_agentos",
    };
  }
  return { agentosPersonId: match, matchMethod: "confirmed_email", reason: null };
}

// ── Enlace de esquema (semántica por esquema, no por rótulo) ────────────────

export interface TaskSchemaBinding {
  titleProperty: string | undefined;
  statusProperty: string | undefined;
  priorityProperty: string | undefined;
  dueDateProperty: string | undefined;
  peopleProperty: string | undefined;
  /** El único `multi_select` del esquema (`Tags`) → etiquetas de la tarea. */
  tagsProperty: string | undefined;
  /** La única propiedad `created_time` (`Created time`) → `tasks.created_at`. */
  createdTimeProperty: string | undefined;
  /** Relaciones hacia la base Projects (la relación tarea↔proyecto). */
  projectRelations: string[];
  /** Relaciones hacia la propia base Tasks que significan "depende de". */
  dependencyRelations: string[];
  /** Auto-relaciones cuya semántica no está en la tabla acordada: a cuarentena. */
  unknownSelfRelations: string[];
}

/**
 * Resuelve qué propiedad es qué usando el ESQUEMA capturado (tipo y base
 * destino de cada relación), no el rótulo. El rótulo solo se usa donde el
 * esquema no puede distinguir: las dos auto-relaciones duales de Tasks, cuya
 * dirección Notion no expone. Un rótulo desconocido no se adivina: se reporta.
 */
export function bindTaskSchema(
  schema: JsonObject,
  ids: { tasksDatabaseId: string; projectsDatabaseId: string },
): TaskSchemaBinding {
  const selfRelations = relationPropertiesTo(schema, ids.tasksDatabaseId);
  return {
    titleProperty: titlePropertyName(schema),
    statusProperty: solePropertyOfType(schema, "status"),
    priorityProperty: solePropertyOfType(schema, "select"),
    dueDateProperty: solePropertyOfType(schema, "date"),
    peopleProperty: solePropertyOfType(schema, "people"),
    tagsProperty: solePropertyOfType(schema, "multi_select"),
    createdTimeProperty: solePropertyOfType(schema, "created_time"),
    projectRelations: relationPropertiesTo(schema, ids.projectsDatabaseId),
    dependencyRelations: selfRelations.filter((name) => DEPENDENCY_RELATION_NAMES.includes(name)),
    unknownSelfRelations: selfRelations.filter(
      (name) =>
        !DEPENDENCY_RELATION_NAMES.includes(name) &&
        !INVERSE_DEPENDENCY_RELATION_NAMES.includes(name),
    ),
  };
}

export interface ProjectSchemaBinding {
  titleProperty: string | undefined;
  /** Relación hacia Tasks: se resuelve desde el lado de la tarea, no aquí. */
  taskRelations: string[];
}

export function bindProjectSchema(
  schema: JsonObject,
  ids: { tasksDatabaseId: string },
): ProjectSchemaBinding {
  return {
    titleProperty: titlePropertyName(schema),
    taskRelations: relationPropertiesTo(schema, ids.tasksDatabaseId),
  };
}

// ── Mapeo completo de página ────────────────────────────────────────────────

export interface MappedTask {
  notionPageId: string;
  title: string;
  status: TaskStatus;
  blockedReason: BlockedReason | null;
  priority: TaskPriority;
  stage: Stage;
  dueAt: number | null;
  /** Ids de página de Notion de los proyectos referenciados (0, 1 o más). */
  projectPageIds: string[];
  /** Ids de página de Notion de las tareas de las que depende. */
  dependsOnPageIds: string[];
  /**
   * Página madre cuando Notion la expone (`parent.page_id`). En la práctica
   * las filas de una base de datos SIEMPRE llegan con `parent.type ===
   * "database_id"` (ver `fixtures.ts` / captura real): Notion no anida una
   * fila de base bajo otra página. Este campo queda por si algún día una fila
   * SÍ trae `page_id` (p. ej. una base incrustada dentro de otra página en vez
   * de en la barra lateral); hoy siempre resuelve a `null` — ver
   * `field-map.test.ts` ("parentPageId con parent.database_id").
   */
  parentPageId: string | null;
  assignees: NotionPerson[];
  /** Etiquetas (`Tags`) tal cual en Notion; el repositorio las normaliza al escribir. */
  labels: string[];
  /** Fecha de creación original en Notion (epoch ms); `null` si no se pudo leer. */
  createdAt: number | null;
  originalUrl: string | null;
  lastEditedAt: number | null;
  archivedInNotion: boolean;
  /** Valores de origen conservados para el informe y el archivo. */
  original: { status: string | null; priority: string | null; due: MappedDueDate };
  exceptions: FieldException[];
}

export function mapTaskPage(page: JsonObject, binding: TaskSchemaBinding): MappedTask {
  const exceptions: FieldException[] = [];
  const status = mapTaskStatus(page, binding.statusProperty);
  if (status.exception) exceptions.push(status.exception);
  const priority = mapTaskPriority(page, binding.priorityProperty);
  if (priority.exception) exceptions.push(priority.exception);
  const due = mapDueDate(page, binding.dueDateProperty);
  if (due.exception) exceptions.push(due.exception);

  const titleProperty = binding.titleProperty ? propertyOfType(page, binding.titleProperty) : undefined;
  const rawTitle = plainText(titleProperty?.title);
  if (!rawTitle) {
    exceptions.push({ field: binding.titleProperty ?? "Name", reason: "titulo_vacio_en_origen" });
  }

  const projectPageIds = binding.projectRelations.flatMap((name) => readRelationIds(page, name));
  if (projectPageIds.length > 1) {
    exceptions.push({
      field: binding.projectRelations.join("+"),
      reason: "tarea_con_varios_proyectos",
      rawReference: projectPageIds.join(","),
    });
  }
  for (const name of binding.unknownSelfRelations) {
    if (readRelationIds(page, name).length > 0) {
      exceptions.push({ field: name, reason: "semantica_de_relacion_desconocida" });
    }
  }

  const parent = asRecord(page.parent);
  const lastEdited = str(page.last_edited_time);
  return {
    notionPageId: str(page.id) ?? "",
    title: rawTitle || "(sin título en Notion)",
    status: status.status,
    blockedReason: status.blockedReason,
    priority: priority.priority,
    stage: IMPORT_DEFAULTS.taskStage,
    dueAt: due.dueAt,
    projectPageIds,
    dependsOnPageIds: [
      ...new Set(binding.dependencyRelations.flatMap((name) => readRelationIds(page, name))),
    ],
    parentPageId: str(parent.page_id) ?? null,
    assignees: readPeople(page, binding.peopleProperty),
    labels: readMultiSelectNames(page, binding.tagsProperty),
    createdAt: readCreatedTime(page, binding.createdTimeProperty),
    originalUrl: str(page.url) ?? null,
    lastEditedAt: lastEdited ? Date.parse(lastEdited) || null : null,
    archivedInNotion: page.archived === true || page.in_trash === true,
    original: { status: status.originalValue, priority: priority.originalValue, due },
    exceptions,
  };
}

export interface MappedProject {
  notionPageId: string;
  name: string;
  type: ProjectType;
  stage: Stage;
  originalUrl: string | null;
  lastEditedAt: number | null;
  archivedInNotion: boolean;
  exceptions: FieldException[];
}

export function mapProjectPage(page: JsonObject, binding: ProjectSchemaBinding): MappedProject {
  const exceptions: FieldException[] = [];
  const titleProperty = binding.titleProperty ? propertyOfType(page, binding.titleProperty) : undefined;
  const rawName = plainText(titleProperty?.title);
  if (!rawName) {
    exceptions.push({ field: binding.titleProperty ?? "Name", reason: "titulo_vacio_en_origen" });
  }
  const lastEdited = str(page.last_edited_time);
  return {
    notionPageId: str(page.id) ?? "",
    name: rawName || "(sin título en Notion)",
    type: IMPORT_DEFAULTS.projectType,
    stage: IMPORT_DEFAULTS.projectStage,
    originalUrl: str(page.url) ?? null,
    lastEditedAt: lastEdited ? Date.parse(lastEdited) || null : null,
    archivedInNotion: page.archived === true || page.in_trash === true,
    exceptions,
  };
}

/**
 * Clave de orden al final de la columna — misma forma que `nextOrderKey` del
 * motor del tablero (`packages/core/src/board/engine.ts`), replicada aquí
 * porque el importador escribe por repositorio y no por el motor.
 */
export function nextOrderKey(previous: string | null | undefined): string {
  if (!previous) return "m";
  const tail = previous.charCodeAt(previous.length - 1);
  if (tail < "z".charCodeAt(0)) return previous.slice(0, -1) + String.fromCharCode(tail + 1);
  return `${previous}m`;
}
