/**
 * Alta de tarea: una ventana centrada, no un cajón.
 *
 * "El crear tareas de añadir no es tan útil, se deja muy poca info" y "no
 * permite elegir proyecto, de cliente; hazlo en ventana central en medio de la
 * pantalla". Así que aquí se elige CLIENTE y PROYECTO (el cliente filtra los
 * proyectos), el texto largo admite imágenes y asistencia de IA, y hay un solo
 * botón para terminar: sin "Cancelar" ni "Guardar" compitiendo con él — se
 * cierra con la × o con Esc, como cualquier ventana.
 *
 * El formulario sigue pidiendo lo que las invariantes del motor exigirán
 * después: sin definición de terminado y sin responsable la tarjeta se queda
 * en BACKLOG porque `BACKLOG→READY` las reclama. Se avisa aquí, en línea, en
 * vez de dejar que el humano descubra el bloqueo al arrastrar.
 *
 * El estado inicial no viaja en el POST (`POST /api/tasks` no lo acepta: mira
 * `apps/api/src/task-create.ts`): toda tarea nace en BACKLOG y, si se pidió
 * otro estado alcanzable en un movimiento humano legal, se mueve justo después
 * con `api.moveTask`. Si ese movimiento falla, la tarea ya existe y sólo se
 * avisa por toast.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import { Modal } from "../components/ui/Modal";
import { useStore } from "../state/store";
import { clienteLabel, clientesDe, guardarProyectoReciente } from "../lib/tareas";
import { HUMAN_TRANSITIONS, STAGES, type Stage, type TaskPriority, type TaskStatus } from "../lib/types";
import { STATUS_LABELS } from "../components/ui";
import { FieldAssist } from "./task/FieldAssist";
import { LabelsEditor } from "./task/LabelsPicker";
import { MarkdownField } from "./task/MarkdownField";
import { PeopleEditor } from "./task/PeopleEditor";
import { fromDateTimeLocal } from "./task/TaskBlocks";

export const STAGE_OPTION_LABEL: Record<Stage, string> = {
  ENTENDER: "Entender",
  CONSTRUIR: "Construir",
  OPERAR: "Operar",
};

export const PRIORITY_OPTIONS: { value: TaskPriority; label: string }[] = [
  { value: "low", label: "Baja" },
  { value: "normal", label: "Normal" },
  { value: "high", label: "Alta" },
  { value: "urgent", label: "Urgente" },
];

/**
 * Estados en los que una tarea puede NACER: BACKLOG y los destinos humanos
 * legales desde BACKLOG. CANCELLED se queda fuera porque nadie crea una tarea
 * para cancelarla. Cualquier otro estado exige varios saltos y sus requisitos
 * (evidencia, responsable), así que no se ofrece: la máquina de estados no se
 * relaja desde la UI.
 */
export const ESTADOS_INICIALES: TaskStatus[] = [
  "BACKLOG",
  ...HUMAN_TRANSITIONS.BACKLOG.filter((status) => status !== "CANCELLED"),
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

export function CreateTaskDialog({
  open,
  onOpenChange,
  projectId,
  defaultStage = "ENTENDER",
  initialTitle = "",
  initialStatus,
  allowProjectChange = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Proyecto de partida. Siempre visible; editable sólo con `allowProjectChange`. */
  projectId?: string;
  defaultStage?: Stage;
  /**
   * Título ya escrito fuera del diálogo: al abrir "más campos" no se puede
   * perder lo que la persona ya tecleó.
   */
  initialTitle?: string;
  /** Estado de la columna desde la que se pulsó "+" en el tablero. */
  initialStatus?: TaskStatus;
  /** La base transversal deja elegir cliente y proyecto; el tablero no. */
  allowProjectChange?: boolean;
}) {
  const createTask = useStore((state) => state.createTask);
  const taskCreating = useStore((state) => state.taskCreating);
  const labelCatalog = useStore((state) => state.labelCatalog);
  const openTask = useStore((state) => state.openTask);
  const pushToast = useStore((state) => state.pushToast);
  const projects = useStore((state) => state.projects);
  const loadProjects = useStore((state) => state.loadProjects);

  const [project, setProject] = useState<string>(projectId ?? "");
  const [client, setClient] = useState<string>("");
  const [status, setStatus] = useState<TaskStatus>("BACKLOG");
  const [draft, setDraft] = useState<CreateTaskDraft>(() => ({
    ...emptyDraft(defaultStage),
    title: initialTitle,
  }));
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [moving, setMoving] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;

  const clientes = useMemo(() => clientesDe({ projects }), [projects]);
  const proyectosVisibles = useMemo(
    () => (client ? projects.filter((candidate) => candidate.orgId === client) : projects),
    [projects, client],
  );
  /** Agrupados por cliente, igual que el selector de proyecto de la ficha. */
  const gruposDeProyectos = useMemo(
    () =>
      clientes
        .map((cliente) => ({
          ...cliente,
          projects: proyectosVisibles
            .filter((candidate) => candidate.orgId === cliente.id)
            .sort((a, b) => a.name.localeCompare(b.name, "es")),
        }))
        .filter((cliente) => cliente.projects.length > 0),
    [clientes, proyectosVisibles],
  );
  const proyectoActual = projects.find((candidate) => candidate.id === project) ?? null;

  useEffect(() => {
    if (!open) return;
    if (allowProjectChange && projects.length === 0) void loadProjects();
    const partida = projects.find((candidate) => candidate.id === projectId) ?? null;
    setProject(projectId ?? "");
    setClient(partida?.orgId ?? "");
    setStatus(initialStatus && ESTADOS_INICIALES.includes(initialStatus) ? initialStatus : "BACKLOG");
    setDraft({ ...emptyDraft(partida?.stage ?? defaultStage), title: initialTitle });
    setTouched({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, projectId, defaultStage, initialTitle, initialStatus]);

  const { issues, blocking } = validateDraft(draft);
  const busy = taskCreating || moving;
  /** El "+" de una columna a la que no se llega en un salto legal: se dice. */
  const estadoInalcanzable =
    initialStatus && !ESTADOS_INICIALES.includes(initialStatus) ? initialStatus : null;

  function patch(next: Partial<CreateTaskDraft>): void {
    setDraft((current) => ({ ...current, ...next }));
  }

  function elegirProyecto(nextId: string): void {
    setProject(nextId);
    const next = projects.find((candidate) => candidate.id === nextId);
    if (next) {
      setClient(next.orgId);
      // La etapa acompaña al proyecto mientras nadie la haya tocado a mano.
      if (!touched.stage) patch({ stage: next.stage });
    }
  }

  /** Lo que la IA necesita saber del borrador, exista o no la tarea todavía. */
  function draftParaIA() {
    const current = draftRef.current;
    return {
      title: current.title,
      description: current.description,
      definition_of_done: current.definitionOfDone,
      ...(project ? { project_id: project } : {}),
      priority: current.priority,
      due_at: fromDateTimeLocal(current.due),
      labels: current.labels,
      assignee_person_ids: current.assigneeIds,
    };
  }

  async function submit(): Promise<void> {
    setTouched((t) => ({ ...t, title: true, due: true, project: true }));
    if (blocking || busy) return;
    if (!project) return;
    const task = await createTask({
      project_id: project,
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
    if (!task) return;
    guardarProyectoReciente(project);
    if (status !== "BACKLOG" && HUMAN_TRANSITIONS.BACKLOG.includes(status)) {
      setMoving(true);
      try {
        await api.moveTask(task.id, { to: status, expected_version: task.version });
      } catch (err) {
        // La tarea ya existe: el estado es lo único que no se consiguió.
        pushToast(
          "error",
          err instanceof Error
            ? `Tarea creada, pero sigue en BACKLOG: ${err.message}`
            : `Tarea creada, pero no pudo pasar a ${STATUS_LABELS[status]}`,
        );
      } finally {
        setMoving(false);
      }
    }
    onOpenChange(false);
    // Abrir la ficha recién creada cierra el bucle: se ve lo que se creó.
    void openTask(task.id);
  }

  const fieldClass =
    "mt-1 min-h-10 w-full rounded-soft border border-line bg-surface px-2.5 py-2 text-body focus:border-link focus:outline-none focus:ring-2 focus:ring-link";
  const labelClass = "text-label font-semibold text-muted";
  const hintClass = "mt-1 text-label text-work";

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      testId="create-task-dialog"
      closeLabel="Cerrar el alta de tarea"
      title="Nueva tarea"
      description={
        estadoInalcanzable
          ? `Nace en BACKLOG: a ${STATUS_LABELS[estadoInalcanzable]} se llega moviéndola cuando cumpla sus requisitos.`
          : "Para pasar a READY necesitará definición de terminado y responsable."
      }
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        requestAnimationFrame(() => titleRef.current?.focus());
      }}
      footer={
        <div className="flex items-center gap-3">
          <p className="min-w-0 flex-1 text-label text-faint">
            {proyectoActual
              ? `${clienteLabel(proyectoActual.orgId, { projects })} · ${proyectoActual.name}`
              : "Elige el proyecto al que pertenece"}
          </p>
          <button
            type="button"
            data-testid="new-task-submit"
            disabled={blocking || busy || !project}
            onClick={() => void submit()}
            className="press min-h-10 shrink-0 rounded-soft bg-ink px-4 py-2 text-small font-semibold text-surface hover:bg-ink-2 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? "Creando…" : "Crear tarea"}
          </button>
        </div>
      }
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        onKeyDown={(event) => {
          // Ctrl/Cmd+Enter crea desde cualquier campo, incluidos los textarea.
          if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
            event.preventDefault();
            void submit();
          }
        }}
      >
        {/* ── De quién es el trabajo ───────────────────────────────────── */}
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="new-task-client" className={labelClass}>
              Cliente
            </label>
            <select
              id="new-task-client"
              data-testid="new-task-client"
              value={client}
              disabled={!allowProjectChange}
              onChange={(event) => {
                const next = event.target.value;
                setClient(next);
                // Si el proyecto elegido ya no es de este cliente, se suelta.
                if (next && proyectoActual && proyectoActual.orgId !== next) setProject("");
              }}
              className={`${fieldClass} disabled:opacity-60`}
            >
              <option value="">Todos los clientes</option>
              {clientes.map((cliente) => (
                <option key={cliente.id} value={cliente.id}>
                  {cliente.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="new-task-project" className={labelClass}>
              Proyecto <span className="text-broken">*</span>
            </label>
            <select
              id="new-task-project"
              data-testid="new-task-project"
              value={project}
              disabled={!allowProjectChange}
              aria-invalid={Boolean(touched.project && !project)}
              onChange={(event) => elegirProyecto(event.target.value)}
              className={`${fieldClass} disabled:opacity-60`}
            >
              <option value="">Elige un proyecto…</option>
              {gruposDeProyectos.map((cliente) => (
                <optgroup key={cliente.id} label={cliente.label}>
                  {cliente.projects.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            {touched.project && !project ? (
              <p className="mt-1 text-label text-broken" role="alert">
                Elige el proyecto al que pertenece la tarea.
              </p>
            ) : null}
          </div>
        </div>

        {/* ── El título: lo primero que se escribe ─────────────────────── */}
        <div className="mt-4">
          <div className="flex items-center gap-2">
            <label htmlFor="new-task-title" className={labelClass}>
              Título <span className="text-broken">*</span>
            </label>
            <span className="ml-auto">
              <FieldAssist
                field="title"
                draft={draftParaIA}
                showPrompt={false}
                onApply={(text) => patch({ title: text.trim().replace(/\s+/g, " ") })}
              />
            </span>
          </div>
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
            placeholder="Qué hay que conseguir. Ej. Mapear el proceso de cobranza de ACME"
            className="mt-1 min-h-12 w-full rounded-soft border border-line bg-surface px-3 py-2 text-title font-medium text-ink focus:border-link focus:outline-none focus:ring-2 focus:ring-link"
          />
          {touched.title && issues.title ? (
            <p className="mt-1 text-label text-broken" role="alert">
              {issues.title}
            </p>
          ) : null}
        </div>

        {/* ── Descripción: con imágenes y con IA ───────────────────────── */}
        <div className="mt-4">
          <MarkdownField
            id="new-task-description"
            testId="new-task-description"
            label="Descripción"
            value={draft.description}
            onChange={(value) => patch({ description: value })}
            rows={4}
            preview={false}
            placeholder="Contexto, pasos, enlaces. Pega o suelta una imagen aquí."
            header={
              <span className={labelClass} id="new-task-description-label">
                Descripción
              </span>
            }
            textareaClassName="mt-1 w-full resize-y rounded-soft border border-line bg-surface px-2.5 py-2 text-body focus:border-link focus:outline-none focus:ring-2 focus:ring-link"
            assist={{ field: "description", draft: draftParaIA }}
          />
        </div>

        {/* ── Cuándo, en qué fase y con qué urgencia ───────────────────── */}
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <label htmlFor="new-task-status" className={labelClass}>
              Estado inicial
            </label>
            <select
              id="new-task-status"
              data-testid="new-task-status"
              value={status}
              onChange={(event) => setStatus(event.target.value as TaskStatus)}
              className={fieldClass}
            >
              {ESTADOS_INICIALES.map((value) => (
                <option key={value} value={value}>
                  {STATUS_LABELS[value]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="new-task-stage" className={labelClass}>
              Etapa
            </label>
            <select
              id="new-task-stage"
              data-testid="new-task-stage"
              value={draft.stage}
              onChange={(event) => {
                patch({ stage: event.target.value as Stage });
                setTouched((t) => ({ ...t, stage: true }));
              }}
              className={fieldClass}
            >
              {STAGES.map((stage) => (
                <option key={stage} value={stage}>
                  {STAGE_OPTION_LABEL[stage]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="new-task-priority" className={labelClass}>
              Prioridad
            </label>
            <select
              id="new-task-priority"
              data-testid="new-task-priority"
              value={draft.priority}
              onChange={(event) => patch({ priority: event.target.value as TaskPriority })}
              className={fieldClass}
            >
              {PRIORITY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="new-task-due" className={labelClass}>
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
              className={fieldClass}
            />
            {touched.due && issues.due ? (
              <p className="mt-1 text-label text-broken" role="alert">
                {issues.due}
              </p>
            ) : null}
          </div>
        </div>

        {/* ── Quién responde ───────────────────────────────────────────── */}
        <div className="mt-4">
          <p className={labelClass} id="new-task-people-label">
            Responsables
          </p>
          <div className="mt-1.5" role="group" aria-labelledby="new-task-people-label">
            <PeopleEditor
              variant="chips"
              projectId={open && project ? project : null}
              ids={draft.assigneeIds}
              primary={draft.primaryAssigneeId}
              onChange={(ids, primary) => patch({ assigneeIds: ids, primaryAssigneeId: primary })}
            />
          </div>
          {issues.assignees ? (
            <p className={hintClass} data-testid="new-task-assignee-hint">
              ⚠ {issues.assignees}
            </p>
          ) : null}
        </div>

        {/* ── Etiquetas ────────────────────────────────────────────────── */}
        <div className="mt-4">
          <p className={labelClass}>Etiquetas</p>
          <div className="mt-1.5">
            <LabelsEditor
              value={draft.labels}
              onChange={(labels) => patch({ labels })}
              catalog={labelCatalog}
              autoFocus={false}
            />
          </div>
        </div>

        {/* ── Definición de terminado ──────────────────────────────────── */}
        <div className="mt-4">
          <div className="flex items-center gap-2">
            <label htmlFor="new-task-dod" className={labelClass}>
              Definición de terminado
            </label>
            <span className="ml-auto">
              <FieldAssist
                field="definition_of_done"
                draft={draftParaIA}
                onApply={(text) => patch({ definitionOfDone: text })}
              />
            </span>
          </div>
          <textarea
            id="new-task-dod"
            data-testid="new-task-dod"
            value={draft.definitionOfDone}
            onChange={(event) => patch({ definitionOfDone: event.target.value })}
            rows={2}
            placeholder="Qué tiene que existir para darla por cerrada. Ej. Mapa SIPOC validado por el cliente"
            className="mt-1 w-full resize-y rounded-soft border border-line bg-surface px-2.5 py-2 text-body focus:border-link focus:outline-none focus:ring-2 focus:ring-link"
          />
          {issues.definitionOfDone ? (
            <p className={hintClass} data-testid="new-task-dod-hint">
              ⚠ {issues.definitionOfDone}
            </p>
          ) : null}
        </div>

        {/* Enter dentro de un input no debe crear a medias: el envío real es
            el botón del pie o Ctrl/Cmd+Enter. */}
        <button type="submit" className="sr-only" tabIndex={-1} aria-hidden="true">
          Crear tarea
        </button>
      </form>
    </Modal>
  );
}

export default CreateTaskDialog;
