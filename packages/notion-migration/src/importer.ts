/**
 * Importador idempotente Notion → AgentOS.
 *
 * Contrato:
 *
 * - **Clave de idempotencia**: `(source_kind, notion_page_id)` en
 *   `notion_import_links`. Reejecutar sobre la misma base actualiza el objeto
 *   enlazado; nunca crea un segundo proyecto, tarea, asignación ni arista.
 * - **Dos pasadas**: primero entidades (proyectos, luego tareas), después
 *   relaciones (`depends_on`, `parent_task_id`, tarea↔proyecto). Una relación a
 *   una página que no está en el lote no se inventa: va a cuarentena.
 * - **Nada se pierde**: cada página importada deja su archivo íntegro
 *   (propiedades, bloques, comentarios y manifiesto de adjuntos) en
 *   `notion_page_archives`.
 * - **Cero escrituras en Notion**: este módulo no tiene cliente HTTP.
 *
 * Las tareas sin `Project` NO van a cuarentena silenciosa: van a un proyecto
 * contenedor "Bandeja de Notion" por organización, marcado como tal con un
 * enlace de linaje `source_kind='inbox'`.
 */
import {
  addTaskLabels,
  appendTaskEvent,
  attachArtifact,
  createNotionMigrationRun,
  createNotionPageArchive,
  boardTasks,
  createOrganization,
  createProject,
  createTask,
  finishNotionMigrationRun,
  getLatestNotionPageArchive,
  getOrganizationByName,
  getProjectByOrgAndName,
  getProject,
  getTask,
  listPeople,
  listNotionImportLinks,
  findNotionImportLink,
  recordNotionQuarantine,
  replaceTaskAssignees,
  updateProject,
  updateTask,
  upsertNotionIdentityMapping,
  upsertNotionImportLink,
  withTransaction,
  type AgentosDb,
  type NotionMigrationRun,
  type NotionPageArchive,
} from "@agentos/db";
import { blocksToMarkdown } from "./blocks-to-markdown.js";
import {
  bindProjectSchema,
  bindTaskSchema,
  INBOX_PROJECT_NAME,
  IMPORT_DEFAULTS,
  mapProjectPage,
  mapTaskPage,
  nextOrderKey,
  normalizeNotionId,
  resolveIdentity,
  type FieldException,
  type MappedTask,
  type NotionPerson,
} from "./field-map.js";
import {
  readPilotCandidates,
  selectPilot,
  type PilotFeature,
  type PilotSelection,
} from "./pilot-selection.js";
import {
  sha256,
  sourceSchemaVersion,
  type SnapshotPage,
  type SnapshotReader,
} from "./snapshot-reader.js";
import type { JsonObject } from "./notion-client.js";

export interface PilotLimits {
  tasks: number;
  projects: number;
}

export interface ImportOptions {
  db: AgentosDb;
  reader: SnapshotReader;
  /** `dry_run` no escribe absolutamente nada: solo concilia y reporta. */
  dryRun?: boolean;
  /**
   * Ignora el salto "Notion no cambió desde la última importación" y vuelve a
   * escribir cada tarea/proyecto ya enlazado (rellena descripción y etiquetas
   * de una importación anterior que no las traía). NO relaja la cuarentena
   * `editado_en_agentos_tras_importar`: una edición humana posterior sigue
   * mandando. Nunca toca `created_at` de una tarea existente.
   */
  force?: boolean;
  pilot?: PilotLimits;
  /** Organización destino; por defecto la interna de Sixteam. */
  organizationName?: string;
  /**
   * Decisiones explícitas del administrador `notion_person_id|correo → people.id`.
   * Es la ÚNICA vía además del correo confirmado. No hay emparejado por nombre.
   */
  adminDecisions?: ReadonlyMap<string, string>;
  actor?: string;
}

export interface ImportReport {
  mode: "dry_run" | "pilot" | "full";
  snapshot_run_id: string;
  manifest_hash: string;
  source_schema_version: string;
  captured_at: string;
  source_counts: { projects: number; tasks: number };
  selected_counts: { projects: number; tasks: number };
  imported: {
    projects_created: number;
    projects_updated: number;
    tasks_created: number;
    tasks_updated: number;
    inbox_projects: number;
  };
  relations: {
    task_project_links: number;
    inbox_tasks: number;
    depends_on_edges: number;
    parent_task_links: number;
  };
  identities: {
    confirmed_email: number;
    admin_decision: number;
    unresolved: number;
    assignments_written: number;
  };
  quarantine: { total: number; by_reason: Record<string, number> };
  destination_counts: { projects: number; tasks: number };
  /** Solo en modo piloto: qué rasgos ejercita el lote y cuáles se quedaron fuera. */
  pilot_coverage?: { covered: PilotFeature[]; missing: PilotFeature[]; absent: PilotFeature[] };
}

const ACTOR_DEFAULT = "system:notion-import";
const DEFAULT_ORGANIZATION = "Sixteam";

interface QuarantineEntry {
  sourceKind: "task" | "project" | "identity";
  notionPageId: string;
  fieldName: string;
  reason: string;
  rawReference?: string;
}

/** Acumulador de excepciones: la cuarentena se escribe en bloque al final. */
class Quarantine {
  readonly entries: QuarantineEntry[] = [];

  add(entry: QuarantineEntry): void {
    this.entries.push(entry);
  }

  addFieldExceptions(
    sourceKind: "task" | "project",
    notionPageId: string,
    exceptions: readonly FieldException[],
  ): void {
    for (const exception of exceptions) {
      this.add({
        sourceKind,
        notionPageId,
        fieldName: exception.field,
        reason: exception.reason,
        ...(exception.rawReference ? { rawReference: exception.rawReference } : {}),
      });
    }
  }

  byReason(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const entry of this.entries) counts[entry.reason] = (counts[entry.reason] ?? 0) + 1;
    return counts;
  }
}

/**
 * Claves de orden por (proyecto, estado). Se siembran UNA vez por proyecto desde
 * el máximo que ya hay en la base: importar sobre un proyecto con tarjetas
 * previas añade al final de cada columna en vez de pisar el orden existente.
 */
class OrderKeys {
  private readonly last = new Map<string, string>();
  private readonly seeded = new Set<string>();

  constructor(private readonly db: AgentosDb) {}

  async next(projectId: string, status: string): Promise<string> {
    if (!this.seeded.has(projectId)) {
      this.seeded.add(projectId);
      for (const task of await boardTasks(this.db, projectId)) {
        const key = `${projectId}|${task.status}`;
        const current = this.last.get(key);
        if (!current || task.orderKey > current) this.last.set(key, task.orderKey);
      }
    }
    const key = `${projectId}|${status}`;
    const value = nextOrderKey(this.last.get(key) ?? null);
    this.last.set(key, value);
    return value;
  }
}

function archivePayload(snapshot: SnapshotPage): Record<string, unknown> {
  return {
    page: snapshot.page,
    properties: snapshot.properties,
    blocks: snapshot.blocks,
    comments: snapshot.comments,
    files: snapshot.files,
  };
}

function capturedAtMs(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

/**
 * Importa un snapshot completo. `dryRun` recorre exactamente el mismo camino de
 * decisión pero no abre corrida ni escribe una sola fila.
 */
export async function importNotionSnapshot(options: ImportOptions): Promise<ImportReport> {
  const { db, reader } = options;
  const actor = options.actor ?? ACTOR_DEFAULT;
  const dryRun = options.dryRun === true;
  const force = options.force === true;
  const mode: ImportReport["mode"] = dryRun ? "dry_run" : options.pilot ? "pilot" : "full";

  const manifest = await reader.manifest();
  const tasksSchema = await reader.schema("tasks");
  const projectsSchema = await reader.schema("projects");
  const schemaVersion = sourceSchemaVersion({ tasks: tasksSchema, projects: projectsSchema });

  const tasksDatabaseId = String((tasksSchema as JsonObject).id ?? "");
  const projectsDatabaseId = String((projectsSchema as JsonObject).id ?? "");
  const taskBinding = bindTaskSchema(tasksSchema, { tasksDatabaseId, projectsDatabaseId });
  const projectBinding = bindProjectSchema(projectsSchema, { tasksDatabaseId });

  const allProjectIds = await reader.pageIds("projects");
  const allTaskIds = await reader.pageIds("tasks");
  const quarantine = new Quarantine();
  const orderKeys = new OrderKeys(db);
  /** B2: cuenta los fallos de escritura de tarea/proyecto — decide el `status` final. */
  let writeErrors = 0;

  // ── Selección del lote ────────────────────────────────────────────────────
  // El piloto NO es un prefijo: se elige por cobertura de rasgos (ver
  // pilot-selection.ts) para que 10 tareas ejerciten de verdad multi-responsable,
  // dependencia, adjunto, comentario, rango de fechas y tarea sin proyecto.
  let pilotSelection: PilotSelection | undefined;
  if (options.pilot) {
    const candidates = await readPilotCandidates(reader, taskBinding, allTaskIds);
    pilotSelection = selectPilot(candidates, allProjectIds, {
      tasks: Math.max(0, options.pilot.tasks),
      projects: Math.max(0, options.pilot.projects),
    });
  }
  const selectedProjectIds = pilotSelection ? pilotSelection.projectIds : allProjectIds;
  const selectedTaskIds = pilotSelection ? pilotSelection.taskIds : allTaskIds;

  const report: ImportReport = {
    mode,
    snapshot_run_id: manifest.run_id,
    manifest_hash: manifest.manifest_hash,
    source_schema_version: schemaVersion,
    captured_at: manifest.captured_at,
    source_counts: { projects: allProjectIds.length, tasks: allTaskIds.length },
    selected_counts: { projects: selectedProjectIds.length, tasks: selectedTaskIds.length },
    imported: {
      projects_created: 0,
      projects_updated: 0,
      tasks_created: 0,
      tasks_updated: 0,
      inbox_projects: 0,
    },
    relations: { task_project_links: 0, inbox_tasks: 0, depends_on_edges: 0, parent_task_links: 0 },
    identities: {
      confirmed_email: 0,
      admin_decision: 0,
      unresolved: 0,
      assignments_written: 0,
    },
    quarantine: { total: 0, by_reason: {} },
    destination_counts: { projects: 0, tasks: 0 },
    ...(pilotSelection
      ? {
          pilot_coverage: {
            covered: pilotSelection.covered,
            missing: pilotSelection.missing,
            absent: pilotSelection.absent,
          },
        }
      : {}),
  };

  const capturedAt = capturedAtMs(manifest.captured_at);

  // ── Organización destino ──────────────────────────────────────────────────
  // Se lee (nunca se crea) también en dry-run: el directorio de identidades de
  // abajo necesita saber cuál es la organización destino para filtrar
  // responsables, aunque el ensayo no vaya a escribir la organización.
  const organizationName = options.organizationName ?? DEFAULT_ORGANIZATION;
  const existingOrganization = await getOrganizationByName(db, organizationName);
  let organizationId = existingOrganization?.id ?? "";
  if (!dryRun) {
    const organization =
      existingOrganization ?? (await createOrganization(db, { name: organizationName, kind: "internal" }));
    organizationId = organization.id;
  }

  // ── Corrida ───────────────────────────────────────────────────────────────
  let run: NotionMigrationRun | undefined;
  if (!dryRun) {
    run = await createNotionMigrationRun(db, {
      sourceSchemaVersion: schemaVersion,
      capturedAt,
      manifestHash: manifest.manifest_hash,
      snapshotRunId: manifest.run_id,
      mode,
      status: "running",
      immutable: true,
    });
  }
  const runId = run?.id ?? "";

  // ── Directorio de identidades (correo → people.id) ────────────────────────
  // Se construye también en dry-run: leer no escribe, y sin él el ensayo daría
  // "todas las identidades sin resolver", que es exactamente lo que se quiere
  // saber ANTES de importar de verdad.
  //
  // Solo cuentan personas de la organización destino o personas internas
  // (isInternal === true) — la misma regla que aplica el resto del sistema al
  // asignar responsables (validateTaskAssigneeOrganization en
  // packages/db/src/repositories/task-assignees.ts). Un correo que solo
  // exista en OTRA organización no interna no resuelve: la cuarentena lo dice
  // explícitamente (persona_de_otra_organizacion) en vez de fallar la
  // escritura de la tarea o, peor, abortar la corrida entera (B2).
  const byEmail = new Map<string, string>();
  const otherOrgEmails = new Set<string>();
  const ambiguousEmails = new Set<string>();
  {
    const candidatesByEmail = new Map<string, { personId: string; orgId: string }[]>();
    for (const person of await listPeople(db)) {
      if (!person.email) continue;
      const email = person.email.toLowerCase();
      if (person.orgId === organizationId || person.isInternal) {
        const candidates = candidatesByEmail.get(email) ?? [];
        candidates.push({ personId: person.id, orgId: person.orgId });
        candidatesByEmail.set(email, candidates);
      } else {
        otherOrgEmails.add(email);
      }
    }
    for (const [email, candidates] of candidatesByEmail) {
      // Dos personas de distintas organizaciones comparten correo: no se
      // decide el orden de filas (last-write-wins de un Map sería arbitrario).
      if (new Set(candidates.map((c) => c.orgId)).size > 1) {
        ambiguousEmails.add(email);
        continue;
      }
      byEmail.set(email, candidates[0]!.personId);
    }
  }

  /** Motivo de cuarentena fino para un responsable que no resolvió. */
  const identityQuarantineReason = (person: NotionPerson): string => {
    const email = person.email?.toLowerCase();
    if (!email) return "identidad_no_confirmada_por_correo";
    if (ambiguousEmails.has(email)) return "correo_ambiguo";
    if (otherOrgEmails.has(email)) return "persona_de_otra_organizacion";
    return "identidad_no_confirmada_por_correo";
  };

  const identityCache = new Map<string, ReturnType<typeof resolveIdentity>>();

  const resolvePerson = async (person: NotionPerson): Promise<string | null> => {
    const cached = identityCache.get(person.notionPersonId);
    const resolution =
      cached ??
      resolveIdentity(person, {
        byEmail,
        ...(options.adminDecisions ? { adminDecisions: options.adminDecisions } : {}),
      });
    if (!cached) {
      identityCache.set(person.notionPersonId, resolution);
      report.identities[resolution.matchMethod] += 1;
      if (!dryRun) {
        await upsertNotionIdentityMapping(db, {
          migrationRunId: runId,
          notionPersonId: person.notionPersonId,
          notionEmail: person.email,
          agentosPersonId: resolution.agentosPersonId,
          matchMethod: resolution.matchMethod,
          validationState: resolution.matchMethod === "unresolved" ? "pending_review" : "confirmed",
        });
      }
    }
    return resolution.agentosPersonId;
  };

  // B2: try/finally alrededor de la corrida completa — la cuarentena
  // acumulada se vuelca y la corrida se cierra pase lo que pase; nunca queda
  // una fila en `running`.
  try {
  // ── Pasada 1a: proyectos ──────────────────────────────────────────────────
  /** `notion_page_id` normalizado → `projects.id`. */
  const projectIdByPage = new Map<string, string>();

  for (const notionPageId of selectedProjectIds) {
    const snapshot = await reader.page("projects", notionPageId);
    const mapped = mapProjectPage(snapshot.page, projectBinding);
    quarantine.addFieldExceptions("project", notionPageId, mapped.exceptions);

    if (dryRun) {
      // El ensayo distingue would_create de would_update mirando el enlace
      // existente (lectura pura, no escribe nada) en vez de contar todo como
      // alta nueva.
      if (await findNotionImportLink(db, "project", notionPageId)) {
        report.imported.projects_updated += 1;
      } else {
        report.imported.projects_created += 1;
      }
      projectIdByPage.set(normalizeNotionId(notionPageId), `dry-run:${notionPageId}`);
      continue;
    }

    // B2: un proyecto que falla al escribir no debe abortar la corrida ni
    // perder la cuarentena acumulada hasta ahora — se anota y se sigue.
    try {
      const existingLink = await findNotionImportLink(db, "project", notionPageId);
      const current = existingLink ? await getProject(db, existingLink.agentosObjectId) : undefined;

      if (existingLink && current) {
        // I1: reejecutar no debe pisar una edición humana posterior a la
        // última importación.
        if (current.updatedAt > existingLink.importedAt) {
          quarantine.add({
            sourceKind: "project",
            notionPageId,
            fieldName: "*",
            reason: "editado_en_agentos_tras_importar",
          });
          projectIdByPage.set(normalizeNotionId(notionPageId), current.id);
          continue;
        }
        // I1: Notion no cambió desde la última importación — no se toca nada
        // (salvo con `force`, que reescribe a propósito).
        if (
          !force &&
          mapped.lastEditedAt !== null &&
          existingLink.sourceLastEditedAt !== null &&
          mapped.lastEditedAt <= existingLink.sourceLastEditedAt
        ) {
          projectIdByPage.set(normalizeNotionId(notionPageId), current.id);
          continue;
        }
      }

      // I2: no duplicar el archivo si el contenido no cambió desde la última
      // corrida que archivó esta misma página.
      const payload = archivePayload(snapshot);
      const payloadHash = sha256(payload);
      const reusableArchive = await getLatestNotionPageArchive(db, "project", notionPageId);
      const archive: NotionPageArchive =
        reusableArchive && reusableArchive.payloadHash === payloadHash
          ? reusableArchive
          : await createNotionPageArchive(db, {
              migrationRunId: runId,
              sourceKind: "project",
              notionPageId,
              originalUrl: mapped.originalUrl,
              rawPageUri: snapshot.uris.page,
              rawBlocksUri: snapshot.uris.blocks,
              rawCommentsUri: snapshot.uris.comments,
              rawFilesUri: snapshot.uris.files,
              payload,
              payloadHash,
              capturedAt,
            });

      let projectId: string;
      if (existingLink && current) {
        await updateProject(db, current.id, { name: mapped.name }, current.version);
        projectId = current.id;
        report.imported.projects_updated += 1;
      } else if (existingLink) {
        // El enlace apunta a un proyecto que ya no existe: se recrea y el enlace
        // se repunta. La corrida anterior queda registrada igualmente.
        const created = await createProject(db, {
          orgId: organizationId,
          name: mapped.name,
          type: mapped.type,
          stage: mapped.stage,
        });
        projectId = created.id;
        report.imported.projects_created += 1;
      } else {
        const created = await createProject(db, {
          orgId: organizationId,
          name: mapped.name,
          type: mapped.type,
          stage: mapped.stage,
        });
        projectId = created.id;
        report.imported.projects_created += 1;
      }

      await upsertNotionImportLink(db, {
        migrationRunId: runId,
        sourceKind: "project",
        notionPageId,
        agentosObjectKind: "project",
        agentosObjectId: projectId,
        archiveId: archive.id,
        importStatus: existingLink ? "updated" : "imported",
        sourceLastEditedAt: mapped.lastEditedAt,
      });
      projectIdByPage.set(normalizeNotionId(notionPageId), projectId);
    } catch (error) {
      quarantine.add({
        sourceKind: "project",
        notionPageId,
        fieldName: "*",
        reason: "error_al_escribir_proyecto",
        rawReference: error instanceof Error ? error.message : String(error),
      });
      writeErrors += 1;
    }
  }

  // ── Bandeja de Notion (contenedor de tareas sin proyecto) ─────────────────
  let inboxProjectId: string | null = null;
  const ensureInboxProject = async (): Promise<string> => {
    if (inboxProjectId) return inboxProjectId;
    const inboxPageKey = `inbox:${organizationId}`;
    const existingLink = await findNotionImportLink(db, "inbox", inboxPageKey);
    const linked = existingLink ? await getProject(db, existingLink.agentosObjectId) : undefined;
    const reused = linked ?? (await getProjectByOrgAndName(db, organizationId, INBOX_PROJECT_NAME));
    const project =
      reused ??
      (await createProject(db, {
        orgId: organizationId,
        name: INBOX_PROJECT_NAME,
        type: IMPORT_DEFAULTS.projectType,
        stage: IMPORT_DEFAULTS.projectStage,
      }));
    if (!reused) report.imported.inbox_projects += 1;
    await upsertNotionImportLink(db, {
      migrationRunId: runId,
      sourceKind: "inbox",
      notionPageId: inboxPageKey,
      agentosObjectKind: "project",
      agentosObjectId: project.id,
      importStatus: "inbox_container",
    });
    inboxProjectId = project.id;
    return project.id;
  };

  // ── Pasada 1b: tareas ─────────────────────────────────────────────────────
  const mappedTasks = new Map<string, MappedTask>();
  /** `notion_page_id` normalizado → `tasks.id`. */
  const taskIdByPage = new Map<string, string>();

  for (const notionPageId of selectedTaskIds) {
    const snapshot = await reader.page("tasks", notionPageId);
    const mapped = mapTaskPage(snapshot.page, taskBinding);
    mappedTasks.set(normalizeNotionId(notionPageId), mapped);
    quarantine.addFieldExceptions("task", notionPageId, mapped.exceptions);

    // Proyecto destino: primera relación resuelta; si no hay, la Bandeja.
    let projectId: string | null = null;
    for (const projectPageId of mapped.projectPageIds) {
      const resolved = projectIdByPage.get(normalizeNotionId(projectPageId));
      if (resolved) {
        projectId = resolved;
        break;
      }
      quarantine.add({
        sourceKind: "task",
        notionPageId,
        fieldName: "Project",
        reason: "proyecto_no_importado_en_este_lote",
        rawReference: projectPageId,
      });
    }
    if (projectId) report.relations.task_project_links += 1;
    else report.relations.inbox_tasks += 1;

    // Responsables: solo identidades resueltas. Cada no resuelta va a cuarentena.
    const personIds: string[] = [];
    for (const person of mapped.assignees) {
      const personId = await resolvePerson(person);
      if (personId) {
        if (!personIds.includes(personId)) personIds.push(personId);
      } else {
        quarantine.add({
          sourceKind: "identity",
          notionPageId,
          fieldName: taskBinding.peopleProperty ?? "Asignado",
          reason: identityQuarantineReason(person),
          rawReference: person.notionPersonId,
        });
      }
    }

    if (dryRun) {
      // El ensayo recorre el MISMO camino de decisión, cuarentena incluida: su
      // informe es la previsión honesta de lo que hará la corrida real —
      // would_create vs would_update según haya o no un enlace existente.
      if (await findNotionImportLink(db, "task", notionPageId)) {
        report.imported.tasks_updated += 1;
      } else {
        report.imported.tasks_created += 1;
      }
      continue;
    }

    // B2: una tarea que falla al escribir no debe abortar la corrida ni
    // perder la cuarentena acumulada hasta ahora — se anota y se sigue.
    try {
      const existingLink = await findNotionImportLink(db, "task", notionPageId);
      const current = existingLink ? await getTask(db, existingLink.agentosObjectId) : undefined;

      if (existingLink && current) {
        // I1: reejecutar no debe pisar una edición humana posterior a la
        // última importación.
        if (current.updatedAt > existingLink.importedAt) {
          quarantine.add({
            sourceKind: "task",
            notionPageId,
            fieldName: "*",
            reason: "editado_en_agentos_tras_importar",
          });
          taskIdByPage.set(normalizeNotionId(notionPageId), current.id);
          continue;
        }
        // I1: Notion no cambió desde la última importación — no se toca nada
        // (salvo con `force`, que reescribe a propósito para rellenar
        // descripción y etiquetas).
        if (
          !force &&
          mapped.lastEditedAt !== null &&
          existingLink.sourceLastEditedAt !== null &&
          mapped.lastEditedAt <= existingLink.sourceLastEditedAt
        ) {
          taskIdByPage.set(normalizeNotionId(notionPageId), current.id);
          continue;
        }
      }

      const targetProjectId = projectId ?? (await ensureInboxProject());

      // Cuerpo de la página → Markdown. Los bloques ya están en memoria (el
      // mismo `snapshot.blocks` que va al archivo): no se vuelve a leer disco.
      // Sin cuerpo (o solo bloques vacíos/no soportados) → `null`, no "".
      const description = blocksToMarkdown(snapshot.blocks) || null;

      // TODO lo que NO es base de datos se resuelve ANTES de abrir la
      // transacción: el snapshot ya se leyó de disco al principio del bucle y
      // el hash es cálculo puro. Dentro del cuerpo transaccional no queda ni
      // red, ni disco, ni temporizadores — que es justo lo que exige la guarda
      // anti-cesión de `withTransaction` en el motor SQLite.
      // I2: no duplicar el archivo si el contenido no cambió desde la última
      // corrida que archivó esta misma página.
      const payload = archivePayload(snapshot);
      const payloadHash = sha256(payload);
      const isUpdate = current !== undefined;
      // La clave de orden se calcula fuera: es una lectura del tablero más
      // aritmética, y así el cuerpo transaccional solo escribe.
      const orderKey = current ? null : await orderKeys.next(targetProjectId, mapped.status);

      // Escritura ATÓMICA de esta tarea: archivo + tarea + responsables +
      // artefacto + evento + enlace de linaje. Si algo falla a mitad, el
      // ROLLBACK evita dejar media tarea importada con un enlace de linaje que
      // mentiría en la siguiente corrida. El catch de abajo sigue registrando
      // la cuarentena y contando el fallo (B2).
      const taskId = await withTransaction(db, async (tx) => {
        const reusableArchive = await getLatestNotionPageArchive(tx, "task", notionPageId);
        const archive: NotionPageArchive =
          reusableArchive && reusableArchive.payloadHash === payloadHash
            ? reusableArchive
            : await createNotionPageArchive(tx, {
                migrationRunId: runId,
                sourceKind: "task",
                notionPageId,
                originalUrl: mapped.originalUrl,
                rawPageUri: snapshot.uris.page,
                rawBlocksUri: snapshot.uris.blocks,
                rawCommentsUri: snapshot.uris.comments,
                rawFilesUri: snapshot.uris.files,
                payload,
                payloadHash,
                capturedAt,
              });

        let writtenId: string;
        if (current) {
          // `created_at` NO va en el parche: una tarea existente conserva el
          // suyo (y `updateTask` ni siquiera lo admite en su tipo).
          await updateTask(
            tx,
            current.id,
            {
              projectId: targetProjectId,
              title: mapped.title,
              description,
              status: mapped.status,
              priority: mapped.priority,
              stage: mapped.stage,
              blockedReason: mapped.blockedReason,
              dueAt: mapped.dueAt,
            },
            current.version,
          );
          writtenId = current.id;
        } else {
          const created = await createTask(tx, {
            projectId: targetProjectId,
            title: mapped.title,
            description,
            status: mapped.status,
            priority: mapped.priority,
            stage: mapped.stage,
            blockedReason: mapped.blockedReason,
            dueAt: mapped.dueAt,
            dependsOn: [],
            orderKey: orderKey!,
            // Fecha de creación ORIGINAL de Notion (`Created time`); sin ella,
            // el repositorio pone la de ahora.
            ...(mapped.createdAt !== null ? { createdAt: mapped.createdAt } : {}),
          });
          writtenId = created.id;
        }

        // `Tags` → `task_labels`. Unión (no reemplazo): una etiqueta puesta a
        // mano en AgentOS no se borra, porque poner etiquetas no toca
        // `tasks.updated_at` y la guarda I1 no la vería. El repositorio
        // normaliza (minúsculas, espacios) y deduplica: es su invariante.
        if (mapped.labels.length > 0) {
          await addTaskLabels(tx, writtenId, mapped.labels, actor);
        }

        if (personIds.length > 0) {
          const beforeAssign = await getTask(tx, writtenId);
          await replaceTaskAssignees(
            tx,
            writtenId,
            { personIds, primaryPersonId: personIds[0]!, assignedBy: actor },
            beforeAssign!.version,
          );
        }

        // B3: el motor del tablero exige un artefacto para REVIEW/DONE (regla
        // anti-teatro) — una tarea importada ya en esos estados debe poder
        // moverse sin tropezar con `missing_artifact`.
        if (mapped.status === "REVIEW" || mapped.status === "DONE") {
          await attachArtifact(tx, {
            taskId: writtenId,
            kind: "notion_archive",
            title: "Página de Notion",
            meta: { archiveId: archive.id, notionPageId, originalUrl: mapped.originalUrl },
          });
        }
        // B3: toda tarea importada deja constancia en su línea de tiempo — no
        // nace vacía.
        await appendTaskEvent(tx, {
          taskId: writtenId,
          kind: "imported",
          actor: "system:notion-import",
          payload: { notionPageId, migrationRunId: runId },
        });

        await upsertNotionImportLink(tx, {
          migrationRunId: runId,
          sourceKind: "task",
          notionPageId,
          agentosObjectKind: "task",
          agentosObjectId: writtenId,
          archiveId: archive.id,
          importStatus: isUpdate ? "updated" : "imported",
          sourceLastEditedAt: mapped.lastEditedAt,
        });
        return writtenId;
      });

      // Los contadores se mueven DESPUÉS del COMMIT: si la transacción
      // revierte, el informe no cuenta una tarea que no quedó escrita.
      if (isUpdate) report.imported.tasks_updated += 1;
      else report.imported.tasks_created += 1;
      if (personIds.length > 0) report.identities.assignments_written += personIds.length;
      taskIdByPage.set(normalizeNotionId(notionPageId), taskId);
    } catch (error) {
      quarantine.add({
        sourceKind: "task",
        notionPageId,
        fieldName: "*",
        reason: "error_al_escribir_tarea",
        rawReference: error instanceof Error ? error.message : String(error),
      });
      writeErrors += 1;
    }
  }

  // ── Pasada 2: relaciones entre tareas ─────────────────────────────────────
  // Se ejecuta cuando ambos extremos existen. Un extremo fuera del lote no se
  // inventa: queda como excepción explícita.
  if (!dryRun) {
    for (const [normalizedPageId, mapped] of mappedTasks) {
      const taskId = taskIdByPage.get(normalizedPageId);
      if (!taskId) continue;

      const dependsOn: string[] = [];
      for (const dependencyPageId of mapped.dependsOnPageIds) {
        const resolved = taskIdByPage.get(normalizeNotionId(dependencyPageId));
        if (resolved && resolved !== taskId) {
          if (!dependsOn.includes(resolved)) dependsOn.push(resolved);
        } else if (!resolved) {
          quarantine.add({
            sourceKind: "task",
            notionPageId: mapped.notionPageId,
            fieldName: "depends_on",
            reason: "dependencia_fuera_del_lote",
            rawReference: dependencyPageId,
          });
        }
      }

      const parentTaskId = mapped.parentPageId
        ? (taskIdByPage.get(normalizeNotionId(mapped.parentPageId)) ?? null)
        : null;
      if (mapped.parentPageId && !parentTaskId) {
        quarantine.add({
          sourceKind: "task",
          notionPageId: mapped.notionPageId,
          fieldName: "parent_task_id",
          reason: "tarea_madre_fuera_del_lote",
          rawReference: mapped.parentPageId,
        });
      }

      if (dependsOn.length === 0 && !parentTaskId) continue;
      const current = await getTask(db, taskId);
      if (!current) continue;
      const patch: { dependsOn?: string[]; parentTaskId?: string } = {};
      // Idempotencia: solo se escribe si el valor cambia realmente.
      const sameDeps =
        current.dependsOn.length === dependsOn.length &&
        dependsOn.every((id) => current.dependsOn.includes(id));
      if (dependsOn.length > 0 && !sameDeps) patch.dependsOn = dependsOn;
      if (parentTaskId && current.parentTaskId !== parentTaskId) patch.parentTaskId = parentTaskId;
      if (Object.keys(patch).length > 0) {
        await updateTask(db, taskId, patch, current.version);
        // I1: esta escritura es del propio importador, no una edición humana.
        // Si no se refresca `importedAt` aquí, la siguiente corrida vería
        // `current.updatedAt > link.importedAt` (el link se selló en la
        // pasada 1, ANTES de esta) y confundiría su propio trabajo con una
        // edición humana posterior.
        await upsertNotionImportLink(db, {
          migrationRunId: runId,
          sourceKind: "task",
          notionPageId: mapped.notionPageId,
          agentosObjectKind: "task",
          agentosObjectId: taskId,
          importStatus: "updated",
          sourceLastEditedAt: mapped.lastEditedAt,
        });
      }
      report.relations.depends_on_edges += dependsOn.length;
      if (parentTaskId) report.relations.parent_task_links += 1;
    }
  }

  } finally {
    // ── Cuarentena y cierre ─────────────────────────────────────────────────
    // SIEMPRE se ejecuta, incluso si algo por encima lanzó sin ser atrapado
    // por un try/catch puntual: la cuarentena acumulada hasta ese punto no se
    // pierde y la corrida nunca queda colgada en `running` (B2).
    report.quarantine = { total: quarantine.entries.length, by_reason: quarantine.byReason() };

    if (!dryRun) {
      for (const entry of quarantine.entries) {
        await recordNotionQuarantine(db, {
          migrationRunId: runId,
          sourceKind: entry.sourceKind,
          notionPageId: entry.notionPageId,
          fieldName: entry.fieldName,
          reason: entry.reason,
          rawReference: entry.rawReference ?? null,
          resolutionState: "open",
        });
      }
      const links = await listNotionImportLinks(db, {});
      report.destination_counts = {
        projects: links.filter((link) => link.sourceKind === "project").length,
        tasks: links.filter((link) => link.sourceKind === "task").length,
      };
      const status: NotionMigrationRun["status"] =
        writeErrors > 0
          ? "failed"
          : quarantine.entries.length > 0
            ? "completed_with_exceptions"
            : "completed";
      await finishNotionMigrationRun(db, runId, {
        status,
        report: report as unknown as Record<string, unknown>,
      });
    } else {
      // Solo esta corrida (would_create + would_update de este lote), no el
      // total histórico de la base — eso solo tiene sentido para una corrida
      // real, que sí escribió algo.
      report.destination_counts = {
        projects: report.imported.projects_created + report.imported.projects_updated,
        tasks: report.imported.tasks_created + report.imported.tasks_updated,
      };
    }
  }

  return report;
}
