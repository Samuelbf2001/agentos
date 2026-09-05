/**
 * Alta de tarea desde el tablero.
 *
 * El formulario pide justo lo que las invariantes del motor van a exigir más
 * tarde: sin definición de terminado y sin responsable, la tarjeta se queda
 * atascada en BACKLOG porque `BACKLOG→READY` las reclama. Por eso ambos campos
 * se avisan aquí (en línea, mientras se escribe) en vez de dejar que el humano
 * descubra el bloqueo al arrastrar la tarjeta.
 */
import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../state/store";
import { PersonAvatar } from "../components/ui";
import { STAGES, type Person, type Stage, type TaskPriority } from "../lib/types";
import { fromDateTimeLocal } from "./TaskDrawer";

export const STAGE_OPTION_LABEL: Record<Stage, string> = {
  ENTENDER: "Entender",
  CONSTRUIR: "Construir",
  OPERAR: "Operar",
};

const PRIORITY_OPTIONS: { value: TaskPriority; label: string }[] = [
  { value: "low", label: "Baja" },
  { value: "normal", label: "Normal" },
  { value: "high", label: "Alta" },
  { value: "urgent", label: "Urgente" },
];

export interface CreateTaskDraft {
  title: string;
  description: string;
  definitionOfDone: string;
  priority: TaskPriority;
  stage: Stage;
  assigneeIds: string[];
  primaryAssigneeId: string;
  due: string;
  labels: string[];
}

export function emptyDraft(stage: Stage): CreateTaskDraft {
  return {
    title: "",
    description: "",
    definitionOfDone: "",
    priority: "normal",
    stage,
    assigneeIds: [],
    primaryAssigneeId: "",
    due: "",
    labels: [],
  };
}

export interface DraftIssues {
  /** Impide enviar. */
  title?: string;
  due?: string;
  /** No impide enviar: la tarjeta nace en BACKLOG y se puede completar luego. */
  definitionOfDone?: string;
  assignees?: string;
}

/**
 * Validación pura y exportada para poder probarla sin montar el diálogo.
 * `blocking` distingue "no puedo enviar esto" de "puedes, pero la tarjeta no
 * podrá pasar a READY".
 */
export function validateDraft(draft: CreateTaskDraft): { issues: DraftIssues; blocking: boolean } {
  const issues: DraftIssues = {};
  if (!draft.title.trim()) issues.title = "El título es obligatorio.";
  else if (draft.title.trim().length < 3) issues.title = "Usa al menos 3 caracteres.";
  if (draft.due && fromDateTimeLocal(draft.due) === null) issues.due = "Fecha no válida.";
  if (!draft.definitionOfDone.trim()) {
    issues.definitionOfDone = "Sin definición de terminado la tarea no podrá pasar a READY.";
  }
  if (draft.assigneeIds.length === 0) {
    issues.assignees = "Sin responsable la tarea no podrá pasar a READY.";
  }
  return { issues, blocking: Boolean(issues.title || issues.due) };
}

function displayPersonName(person: Person): string {
  return person.full_name || person.fullName || `Persona ${person.id.slice(0, 8)}`;
}

function normalizeLabelInput(raw: string): string {
  return raw.trim().replace(/\s+/g, " ").toLocaleLowerCase("es");
}

export function CreateTaskDialog({
  open,
  onOpenChange,
  projectId,
  defaultStage,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  defaultStage: Stage;
}) {
  const createTask = useStore((state) => state.createTask);
  const taskCreating = useStore((state) => state.taskCreating);
  const people = useStore((state) => state.people);
  const peopleLoading = useStore((state) => state.peopleLoading);
  const loadPeople = useStore((state) => state.loadPeople);
  const sessionPerson = useStore((state) => state.person);
  const labelCatalog = useStore((state) => state.labelCatalog);
  const projectPeople = useStore((state) => state.projectPeople);
  const projectPeopleId = useStore((state) => state.projectPeopleId);
  const loadProjectPeople = useStore((state) => state.loadProjectPeople);
  const openTask = useStore((state) => state.openTask);

  const [draft, setDraft] = useState<CreateTaskDraft>(() => emptyDraft(defaultStage));
  const [labelInput, setLabelInput] = useState("");
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setDraft(emptyDraft(defaultStage));
    setLabelInput("");
    setTouched({});
    if (people.length === 0 && !peopleLoading) void loadPeople();
    if (projectPeopleId !== projectId) void loadProjectPeople(projectId);
    // El foco al primer campo evita que el humano tenga que buscar dónde escribir.
    requestAnimationFrame(() => titleRef.current?.focus());
  }, [open, defaultStage]);

  // El roster del proyecto manda cuando la API lo dio: la asignación exige
  // que la persona pertenezca a la organización del proyecto, así que ofrecer
  // el equipo entero sólo produciría rechazos al guardar.
  const roster = projectPeopleId === projectId ? projectPeople : null;
  const peopleOptions = useMemo(() => {
    if (roster) {
      return [...roster].sort((a, b) =>
        displayPersonName(a).localeCompare(displayPersonName(b), "es"),
      );
    }
    const map = new Map<string, Person>();
    for (const candidate of people) map.set(candidate.id, candidate);
    if (sessionPerson) map.set(sessionPerson.id, sessionPerson);
    return [...map.values()].sort((a, b) =>
      displayPersonName(a).localeCompare(displayPersonName(b), "es"),
    );
  }, [roster, people, sessionPerson]);

  const { issues, blocking } = validateDraft(draft);

  function patch(next: Partial<CreateTaskDraft>): void {
    setDraft((current) => ({ ...current, ...next }));
  }

  function togglePerson(personId: string, checked: boolean): void {
    setDraft((current) => {
      const assigneeIds = checked
        ? [...current.assigneeIds, personId]
        : current.assigneeIds.filter((id) => id !== personId);
      const primaryAssigneeId = assigneeIds.includes(current.primaryAssigneeId)
        ? current.primaryAssigneeId
        : assigneeIds[0] ?? "";
      return { ...current, assigneeIds, primaryAssigneeId };
    });
  }

  function addLabel(raw: string): void {
    const label = normalizeLabelInput(raw);
    if (!label) return;
    setDraft((current) =>
      current.labels.includes(label) ? current : { ...current, labels: [...current.labels, label] },
    );
    setLabelInput("");
  }

  async function submit(): Promise<void> {
    setTouched({ title: true, due: true });
    if (blocking || taskCreating) return;
    const task = await createTask({
      project_id: projectId,
      title: draft.title.trim(),
      stage: draft.stage,
      ...(draft.description.trim() ? { description: draft.description.trim() } : {}),
      ...(draft.definitionOfDone.trim() ? { definition_of_done: draft.definitionOfDone.trim() } : {}),
      priority: draft.priority,
      ...(draft.assigneeIds.length > 0 ? { assignee_person_ids: draft.assigneeIds } : {}),
      ...(draft.primaryAssigneeId ? { primary_assignee_person_id: draft.primaryAssigneeId } : {}),
      due_at: fromDateTimeLocal(draft.due),
      ...(draft.labels.length > 0 ? { labels: draft.labels } : {}),
    });
    if (task) {
      onOpenChange(false);
      // Abrir la ficha recién creada cierra el bucle: se ve lo que se creó.
      void openTask(task.id);
    }
  }

  const inputClass =
    "mt-1 min-h-10 w-full rounded-soft border border-line px-2.5 py-2 text-body focus:border-link focus:outline-none focus:ring-2 focus:ring-link";
  const hintClass = "mt-1 text-label text-work";

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/35 backdrop-blur-[1px]" />
        <Dialog.Content
          className="fixed inset-0 z-50 flex h-[100dvh] w-full flex-col overflow-hidden bg-surface shadow-float focus:outline-none sm:inset-y-0 sm:left-auto sm:right-0 sm:h-full sm:w-[480px] sm:max-w-[100vw]"
          aria-describedby="create-task-description"
          data-testid="create-task-dialog"
        >
          <div className="flex shrink-0 items-start gap-3 border-b border-line px-4 py-3 sm:px-5">
            <div className="min-w-0 flex-1">
              <p className="text-label font-bold uppercase text-faint">Nueva tarea</p>
              <Dialog.Title className="mt-1 text-title font-semibold leading-snug text-ink">
                Crear tarea en el tablero
              </Dialog.Title>
              <Dialog.Description id="create-task-description" className="mt-0.5 text-label text-muted">
                Nace en BACKLOG. Para pasar a READY necesitará definición de terminado y responsable.
              </Dialog.Description>
            </div>
            <Dialog.Close
              className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-soft text-title text-faint hover:bg-line-soft hover:text-ink-2 focus:outline-none focus:ring-2 focus:ring-link"
              aria-label="Cerrar formulario"
            >
              ×
            </Dialog.Close>
          </div>

          <form
            className="min-h-0 flex-1 overflow-y-auto px-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-4 sm:px-5"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <div>
              <label htmlFor="new-task-title" className="text-label font-semibold text-muted">
                Título <span className="text-broken">*</span>
              </label>
              <input
                ref={titleRef}
                id="new-task-title"
                data-testid="new-task-title"
                value={draft.title}
                onChange={(event) => {
                  patch({ title: event.target.value });
                  setTouched((t) => ({ ...t, title: true }));
                }}
                onBlur={() => setTouched((t) => ({ ...t, title: true }))}
                aria-invalid={Boolean(touched.title && issues.title)}
                placeholder="Ej. Mapear el proceso de cobranza"
                className={inputClass}
              />
              {touched.title && issues.title ? (
                <p className="mt-1 text-label text-broken" role="alert">
                  {issues.title}
                </p>
              ) : null}
            </div>

            <div className="mt-3">
              <label htmlFor="new-task-description" className="text-label font-semibold text-muted">
                Descripción
              </label>
              <textarea
                id="new-task-description"
                data-testid="new-task-description"
                value={draft.description}
                onChange={(event) => patch({ description: event.target.value })}
                rows={3}
                placeholder="Contexto, enlaces, qué se espera…"
                className="mt-1 w-full resize-y rounded-soft border border-line px-2.5 py-2 text-body focus:border-link focus:outline-none focus:ring-2 focus:ring-link"
              />
            </div>

            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <div>
                <label htmlFor="new-task-stage" className="text-label font-semibold text-muted">
                  Etapa
                </label>
                <select
                  id="new-task-stage"
                  data-testid="new-task-stage"
                  value={draft.stage}
                  onChange={(event) => patch({ stage: event.target.value as Stage })}
                  className={inputClass}
                >
                  {STAGES.map((stage) => (
                    <option key={stage} value={stage}>
                      {STAGE_OPTION_LABEL[stage]}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="new-task-priority" className="text-label font-semibold text-muted">
                  Prioridad
                </label>
                <select
                  id="new-task-priority"
                  data-testid="new-task-priority"
                  value={draft.priority}
                  onChange={(event) => patch({ priority: event.target.value as TaskPriority })}
                  className={inputClass}
                >
                  {PRIORITY_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="mt-3">
              <label htmlFor="new-task-dod" className="text-label font-semibold text-muted">
                Definición de terminado
              </label>
              <textarea
                id="new-task-dod"
                data-testid="new-task-dod"
                value={draft.definitionOfDone}
                onChange={(event) => patch({ definitionOfDone: event.target.value })}
                rows={2}
                placeholder="Ej. Mapa SIPOC validado por el cliente"
                className="mt-1 w-full resize-y rounded-soft border border-line px-2.5 py-2 text-body focus:border-link focus:outline-none focus:ring-2 focus:ring-link"
              />
              {issues.definitionOfDone ? (
                <p className={hintClass} data-testid="new-task-dod-hint">
                  ⚠ {issues.definitionOfDone}
                </p>
              ) : null}
            </div>

            <div className="mt-3">
              <label htmlFor="new-task-due" className="text-label font-semibold text-muted">
                Vencimiento
              </label>
              <input
                id="new-task-due"
                data-testid="new-task-due"
                type="datetime-local"
                value={draft.due}
                onChange={(event) => {
                  patch({ due: event.target.value });
                  setTouched((t) => ({ ...t, due: true }));
                }}
                className={inputClass}
              />
              {touched.due && issues.due ? (
                <p className="mt-1 text-label text-broken" role="alert">
                  {issues.due}
                </p>
              ) : null}
            </div>

            <fieldset className="mt-4 rounded-panel border border-line p-3">
              <legend className="px-1 text-label font-semibold text-muted">Responsables</legend>
              {peopleLoading ? <p className="text-small text-faint">Cargando equipo…</p> : null}
              {!peopleLoading && peopleOptions.length === 0 ? (
                <p className="text-small text-work" data-testid="no-project-people">
                  La organización de este proyecto no tiene personas registradas. Una tarea sólo
                  admite responsables de la organización dueña del proyecto.
                </p>
              ) : null}
              <div className="space-y-1">
                {peopleOptions.map((person) => (
                  <label
                    key={person.id}
                    className="flex min-h-9 cursor-pointer items-center gap-2 rounded-tight px-1.5 py-1 hover:bg-surface-2"
                  >
                    <input
                      type="checkbox"
                      checked={draft.assigneeIds.includes(person.id)}
                      onChange={(event) => togglePerson(person.id, event.target.checked)}
                      className="h-4 w-4 rounded border-line text-ink focus:ring-link"
                    />
                    <PersonAvatar name={displayPersonName(person)} size={5} />
                    <span className="min-w-0 flex-1 truncate text-small font-medium text-ink-2">
                      {displayPersonName(person)}
                    </span>
                  </label>
                ))}
              </div>
              {draft.assigneeIds.length > 1 ? (
                <div className="mt-2 border-t border-line-soft pt-2">
                  <label htmlFor="new-task-primary" className="text-label font-semibold text-muted">
                    Persona principal
                  </label>
                  <select
                    id="new-task-primary"
                    value={draft.primaryAssigneeId}
                    onChange={(event) => patch({ primaryAssigneeId: event.target.value })}
                    className={inputClass}
                  >
                    {peopleOptions
                      .filter((person) => draft.assigneeIds.includes(person.id))
                      .map((person) => (
                        <option key={person.id} value={person.id}>
                          {displayPersonName(person)}
                        </option>
                      ))}
                  </select>
                </div>
              ) : null}
              {issues.assignees ? (
                <p className={hintClass} data-testid="new-task-assignee-hint">
                  ⚠ {issues.assignees}
                </p>
              ) : null}
            </fieldset>

            <div className="mt-4">
              <label htmlFor="new-task-label" className="text-label font-semibold text-muted">
                Etiquetas
              </label>
              <div className="mt-1 flex gap-2">
                <input
                  id="new-task-label"
                  data-testid="new-task-label"
                  value={labelInput}
                  list="label-catalog"
                  onChange={(event) => setLabelInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === ",") {
                      event.preventDefault();
                      addLabel(labelInput);
                    }
                  }}
                  placeholder="cliente, urgente…"
                  className="min-h-10 min-w-0 flex-1 rounded-soft border border-line px-2.5 py-2 text-body focus:border-link focus:outline-none focus:ring-2 focus:ring-link"
                />
                <button
                  type="button"
                  onClick={() => addLabel(labelInput)}
                  disabled={!labelInput.trim()}
                  className="min-h-10 rounded-soft border border-line px-3 text-small font-semibold text-ink-2 hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Añadir
                </button>
              </div>
              <datalist id="label-catalog">
                {labelCatalog.map((usage) => (
                  <option key={usage.label} value={usage.label} />
                ))}
              </datalist>
              {draft.labels.length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {draft.labels.map((label) => (
                    <span
                      key={label}
                      className="inline-flex items-center gap-1 rounded-full bg-line-soft px-2 py-0.5 text-label font-medium text-ink-2"
                    >
                      {label}
                      <button
                        type="button"
                        aria-label={`Quitar etiqueta ${label}`}
                        onClick={() => patch({ labels: draft.labels.filter((item) => item !== label) })}
                        className="text-faint hover:text-broken"
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              ) : null}
            </div>

            <div className="mt-5 flex flex-wrap justify-end gap-2 border-t border-line-soft pt-3">
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                className="min-h-10 rounded-soft px-3 py-2 text-small font-semibold text-muted hover:bg-line-soft"
              >
                Cancelar
              </button>
              <button
                type="submit"
                data-testid="new-task-submit"
                disabled={blocking || taskCreating}
                className="min-h-10 rounded-soft bg-ink px-4 py-2 text-small font-semibold text-surface hover:bg-ink-2 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {taskCreating ? "Creando…" : "Crear tarea"}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export default CreateTaskDialog;
