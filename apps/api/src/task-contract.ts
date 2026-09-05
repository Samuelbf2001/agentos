/**
 * Adaptador de presentación para el contrato de tareas de la Oleada 2.
 *
 * La fuente de verdad de responsables y la actualización atómica viven en
 * `@agentos/db`. REST/MCP comparten esta normalización (incluyendo el objeto
 * `person`) sin ejecutar SQL ni duplicar repositorios. El contrato funciona
 * con el repositorio SQLite y con su espejo Postgres.
 */
import {
  getPerson,
  getProject,
  getTask,
  getTaskWithAssignees as dbGetTaskWithAssignees,
  listTaskAssignees as dbListTaskAssignees,
  listTasksWithAssignees as dbListTasksWithAssignees,
  listLabelsForTasks,
  listTaskLabels,
  replaceTaskAssignees as dbReplaceTaskAssignees,
  type AgentosDb,
  type Person,
  type Project,
  type Task,
  type TaskAssignee,
} from "@agentos/db";
import { errors } from "@agentos/shared";

export interface TaskAssigneeView extends TaskAssignee {
  person?: Pick<Person, "id" | "fullName" | "email" | "role">;
}

export interface TaskWithAssignees extends Task {
  assignees: TaskAssigneeView[];
  /** Etiquetas normalizadas de la tarjeta (tabla puente `task_labels`). */
  labels: string[];
}

export interface ReplaceTaskAssigneesInput {
  taskId: string;
  personIds: readonly string[];
  primaryPersonId?: string | null;
  assignedBy: string;
  expectedVersion: number;
}

export interface ReplaceTaskAssigneesResult {
  task: Task;
  assignees: TaskAssigneeView[];
  before: TaskAssigneeView[];
  changed: boolean;
}

async function withPerson(db: AgentosDb, row: TaskAssignee): Promise<TaskAssigneeView> {
  const person = await getPerson(db, row.personId);
  return {
    ...row,
    ...(person
      ? {
          person: {
            id: person.id,
            fullName: person.fullName,
            email: person.email,
            role: person.role,
          },
        }
      : {}),
  };
}

/** Responsables canónicos, enriquecidos con los campos actuales de people. */
export async function listTaskAssignees(db: AgentosDb, taskId: string): Promise<TaskAssigneeView[]> {
  const rows = await dbListTaskAssignees(db, taskId);
  return await Promise.all(rows.map((row) => withPerson(db, row)));
}

function primaryId(rows: readonly TaskAssigneeView[]): string | null {
  return rows.find((row) => row.isPrimary)?.personId ?? null;
}

function sortedIds(rows: readonly TaskAssigneeView[]): string[] {
  return rows.map((row) => row.personId).sort();
}

export function normalizePersonIds(
  personIds: readonly string[] | undefined,
  primaryPersonId?: string | null,
): { personIds: string[]; primaryPersonId: string | null } {
  const raw = personIds ?? [];
  const normalized = raw.map((id) => id.trim()).filter(Boolean);
  const unique = [...new Set(normalized)];
  if (unique.length !== normalized.length) {
    throw errors.validation("Una tarea no puede tener el mismo responsable dos veces", { personIds: normalized });
  }
  const primary = primaryPersonId?.trim() || null;
  if (primary && !unique.includes(primary)) {
    throw errors.validation("primary_assignee_person_id debe pertenecer a assignee_person_ids", {
      primary_assignee_person_id: primary,
    });
  }
  return { personIds: unique, primaryPersonId: primary };
}

/**
 * Valida existencia y pertenencia organizacional antes de mutar. Personal
 * interno (`is_internal`) es asignable a cualquier proyecto sin importar su
 * organización (I3).
 */
export async function validatePeopleForProject(
  db: AgentosDb,
  project: Project,
  personIds: readonly string[],
  primaryPersonId?: string | null,
): Promise<{ personIds: string[]; primaryPersonId: string | null; people: Person[] }> {
  const normalized = normalizePersonIds(personIds, primaryPersonId);
  const people: Person[] = [];
  for (const personId of normalized.personIds) {
    const person = await getPerson(db, personId);
    if (!person) throw errors.notFound("person", personId);
    if (!person.isInternal && person.orgId !== project.orgId) {
      throw errors.validation(
        "La persona responsable debe pertenecer a la organización del proyecto o al equipo interno",
        {
          personId,
          projectId: project.id,
          projectOrgId: project.orgId,
          personOrgId: person.orgId,
        },
      );
    }
    people.push(person);
  }
  return { ...normalized, people };
}

/** Reemplaza la lista a través del repositorio transaccional de @agentos/db. */
export async function replaceTaskAssignees(
  db: AgentosDb,
  input: ReplaceTaskAssigneesInput,
): Promise<ReplaceTaskAssigneesResult> {
  const before = await listTaskAssignees(db, input.taskId);
  const normalized = normalizePersonIds(input.personIds, input.primaryPersonId);
  const task = await getTask(db, input.taskId);
  if (!task) throw errors.notFound("task", input.taskId);
  const project = await getProject(db, task.projectId);
  if (!project) throw errors.notFound("project", task.projectId);
  await validatePeopleForProject(db, project, normalized.personIds, normalized.primaryPersonId);

  const updated = await dbReplaceTaskAssignees(
    db,
    input.taskId,
    {
      personIds: normalized.personIds,
      primaryPersonId: normalized.primaryPersonId,
      assignedBy: input.assignedBy,
    },
    input.expectedVersion,
  );
  const updatedTask = updated as Task & { assignees?: TaskAssignee[] };
  const afterRows = updatedTask.assignees ?? (await dbListTaskAssignees(db, input.taskId));
  const after = await Promise.all(afterRows.map((row) => withPerson(db, row)));
  const changed =
    JSON.stringify(sortedIds(before)) !== JSON.stringify(sortedIds(after)) || primaryId(before) !== primaryId(after);
  return { task: updatedTask, assignees: after, before, changed };
}

export async function taskWithAssignees(db: AgentosDb, task: Task): Promise<TaskWithAssignees> {
  const fromRepo = await dbGetTaskWithAssignees(db, task.id);
  const source = fromRepo ?? task;
  const rawAssignees =
    "assignees" in source && Array.isArray(source.assignees)
      ? source.assignees
      : await dbListTaskAssignees(db, task.id);
  const assignees = await Promise.all(rawAssignees.map((row) => withPerson(db, row)));
  return { ...source, assignees, labels: await listTaskLabels(db, task.id) } as TaskWithAssignees;
}

export async function listTasksWithAssignees(
  db: AgentosDb,
  filter: {
    projectId?: string;
    status?: Task["status"];
    assigneeAgentId?: string;
    assigneePersonId?: string;
    /** Etiqueta exacta (ya normalizada) por la que filtrar el listado. */
    label?: string;
  } = {},
): Promise<TaskWithAssignees[]> {
  const rows = await dbListTasksWithAssignees(db, {
    ...(filter.projectId ? { projectId: filter.projectId } : {}),
    ...(filter.status ? { status: filter.status } : {}),
    ...(filter.assigneeAgentId ? { assigneeAgentId: filter.assigneeAgentId } : {}),
    ...(filter.assigneePersonId ? { personId: filter.assigneePersonId } : {}),
  });
  const labels = await listLabelsForTasks(
    db,
    rows.map((row) => row.id),
  );
  const withLabels = await Promise.all(
    rows.map(async (row) => ({
      ...row,
      assignees: await Promise.all(row.assignees.map((assignee) => withPerson(db, assignee))),
      labels: labels.get(row.id) ?? [],
    })),
  );
  // Una sola consulta de etiquetas sirve para pintar la tarjeta y para filtrar.
  return filter.label ? withLabels.filter((row) => row.labels.includes(filter.label!)) : withLabels;
}
