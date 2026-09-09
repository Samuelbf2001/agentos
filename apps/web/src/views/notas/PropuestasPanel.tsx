/**
 * Tareas propuestas desde la transcripción (fase 3 de Notas).
 *
 * Regla permanente: proponer NO crea nada. El modelo deja candidatas en la
 * nota; el humano incluye/excluye, corrige título, proyecto, responsable, fecha
 * y prioridad (se guarda con PATCH amortiguado y `expected_version`), y SOLO
 * al pulsar «Crear N tareas» se crean, por el mismo camino que el alta normal.
 *
 * Decisiones:
 * - Cada propuesta exige proyecto: el pie se deshabilita nombrando cuáles lo
 *   necesitan. Una propuesta con `project_guess` sin `project_id` se marca
 *   («Proyecto no encontrado») para que el humano lo elija.
 * - El selector de proyecto reutiliza la lógica del `ProjectPicker` de la
 *   ficha (agrupado por cliente con `clienteLabel`/`clientesDe`); el de
 *   responsable, el roster (`useProjectRoster`) del proyecto de la NOTA, una
 *   sola vez para todo el panel: el roster de proyecto es un cache de una
 *   plaza en el store y pedirlo por fila (proyectos distintos) lo haría
 *   oscilar entre filas sin parar. El servidor valida igualmente al crear.
 * - Tras crear, cada propuesta enseña «Creada» con enlace a su ficha (`openTask`).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ListChecks, Sparkles } from "lucide-react";
import { useStore } from "../../state/store";
import { displayPersonName, useProjectRoster } from "../../lib/roster";
import { clienteLabel, clientesDe } from "../../lib/tareas";
import type { CanvasNote, NoteTaskProposal, Person, Project, TaskPriority } from "../../lib/types";
import { PRIORITY_OPTIONS } from "../CreateTaskDialog";

/** Espera antes de guardar la revisión: corta para no perder nada, larga para no martillear. */
export const PROPOSALS_SAVE_MS = 600;

const CONFIDENCE_LABEL: Record<NoteTaskProposal["confidence"], string> = {
  alta: "confianza alta",
  media: "confianza media",
  baja: "confianza baja",
};

const fieldClass =
  "min-h-10 w-full rounded-tight border border-line bg-canvas px-2 text-small text-ink-2 focus:border-link focus:outline-none focus:ring-2 focus:ring-link disabled:opacity-60";

/** Grupos cliente → proyectos, mismo criterio que el ProjectPicker de la ficha. */
function useProjectGroups(projects: Project[]) {
  return useMemo(() => {
    const ctx = { projects };
    return clientesDe(ctx)
      .map((client) => ({
        ...client,
        projects: projects
          .filter((candidate) => candidate.orgId === client.id)
          .sort((a, b) => a.name.localeCompare(b.name, "es")),
      }))
      .filter((client) => client.projects.length > 0);
  }, [projects]);
}

function PropuestaRow({
  proposal,
  groups,
  projects,
  people,
  onChange,
  onOpenTask,
}: {
  proposal: NoteTaskProposal;
  groups: ReturnType<typeof useProjectGroups>;
  projects: Project[];
  people: Person[];
  onChange: (next: NoteTaskProposal) => void;
  onOpenTask: (taskId: string) => void;
}) {
  const created = proposal.created_task_id !== null;
  const project = projects.find((p) => p.id === proposal.project_id) ?? null;
  const patch = (next: Partial<NoteTaskProposal>) => onChange({ ...proposal, ...next });
  const rosterHasAssignee = proposal.assignee_person_id
    ? people.some((p) => p.id === proposal.assignee_person_id)
    : true;
  const guessWithoutProject = !proposal.project_id && !!proposal.project_guess;
  const guessWithoutAssignee = !proposal.assignee_person_id && !!proposal.assignee_guess;

  return (
    <li
      data-testid={`propuesta-${proposal.id}`}
      className={`rounded-tight border p-2.5 ${
        created ? "border-done-line bg-done-bg" : proposal.include ? "border-line bg-surface" : "border-line-soft bg-surface-2 opacity-70"
      }`}
    >
      <div className="flex items-start gap-2">
        {created ? (
          <span className="mt-2 inline-flex h-4 w-4 shrink-0 items-center justify-center text-done" aria-hidden="true">
            <Check size={14} strokeWidth={2.5} />
          </span>
        ) : (
          <input
            type="checkbox"
            aria-label={`Incluir «${proposal.title}»`}
            data-testid={`propuesta-incluir-${proposal.id}`}
            checked={proposal.include}
            onChange={(event) => patch({ include: event.target.checked })}
            className="mt-2.5 h-4 w-4 shrink-0 rounded border-line text-ink focus:ring-link"
          />
        )}
        <div className="min-w-0 flex-1">
          {created ? (
            <div className="flex min-h-10 flex-wrap items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-small font-semibold text-ink">{proposal.title}</span>
              <span className="rounded-full border border-done-line px-2 py-0.5 text-label font-semibold text-done">Creada</span>
              <button
                type="button"
                onClick={() => onOpenTask(proposal.created_task_id!)}
                data-testid={`propuesta-abrir-${proposal.id}`}
                className="press min-h-8 rounded-tight px-2 text-label font-semibold text-link hover:bg-link-bg focus:outline-none focus:ring-2 focus:ring-link"
              >
                Abrir ficha
              </button>
            </div>
          ) : (
            <input
              type="text"
              aria-label="Título de la propuesta"
              data-testid={`propuesta-titulo-${proposal.id}`}
              value={proposal.title}
              onChange={(event) => patch({ title: event.target.value })}
              className={`${fieldClass} font-semibold text-ink`}
            />
          )}
        </div>
      </div>

      {!created ? (
        <div className="mt-2 flex flex-col gap-2 pl-6">
          <div>
            <select
              aria-label="Proyecto de la propuesta"
              data-testid={`propuesta-proyecto-${proposal.id}`}
              value={proposal.project_id ?? ""}
              onChange={(event) => patch({ project_id: event.target.value || null })}
              aria-invalid={proposal.include && !proposal.project_id ? true : undefined}
              className={`${fieldClass} ${proposal.include && !proposal.project_id ? "border-work-line" : ""}`}
            >
              <option value="">— Elegir proyecto —</option>
              {groups.map((client) => (
                <optgroup key={client.id} label={client.label}>
                  {client.projects.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            {guessWithoutProject ? (
              <p className="mt-1 text-label text-work" role="status">
                Proyecto no encontrado: «{proposal.project_guess}». Elige uno.
              </p>
            ) : project ? (
              <p className="mt-1 text-label text-faint">{clienteLabel(project.orgId, { projects })}</p>
            ) : proposal.include ? (
              <p className="mt-1 text-label text-work">Sin proyecto: elige uno para poder crearla.</p>
            ) : null}
          </div>

          <div>
            <select
              aria-label="Responsable de la propuesta"
              data-testid={`propuesta-responsable-${proposal.id}`}
              value={proposal.assignee_person_id ?? ""}
              onChange={(event) => patch({ assignee_person_id: event.target.value || null })}
              className={fieldClass}
            >
              <option value="">— Sin responsable —</option>
              {people.map((person) => (
                <option key={person.id} value={person.id}>
                  {displayPersonName(person)}
                </option>
              ))}
              {!rosterHasAssignee && proposal.assignee_person_id ? (
                <option value={proposal.assignee_person_id}>Persona {proposal.assignee_person_id.slice(0, 8)}</option>
              ) : null}
            </select>
            {guessWithoutAssignee ? (
              <p className="mt-1 text-label text-work" role="status">
                Responsable no encontrado: «{proposal.assignee_guess}».
              </p>
            ) : null}
          </div>

          <div className="grid grid-cols-2 gap-2">
            <input
              type="date"
              aria-label="Fecha límite de la propuesta"
              data-testid={`propuesta-fecha-${proposal.id}`}
              value={proposal.due_at ? proposal.due_at.slice(0, 10) : ""}
              onChange={(event) => patch({ due_at: event.target.value || null })}
              className={fieldClass}
            />
            <select
              aria-label="Prioridad de la propuesta"
              data-testid={`propuesta-prioridad-${proposal.id}`}
              value={proposal.priority}
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
        </div>
      ) : null}

      <p className="mt-2 pl-6 text-label text-faint">
        <span className="italic">«{proposal.source_excerpt}»</span>
        <span aria-hidden="true"> · </span>
        <span>{CONFIDENCE_LABEL[proposal.confidence]}</span>
      </p>
    </li>
  );
}

export function PropuestasPanel({ note }: { note: CanvasNote }) {
  const projects = useStore((s) => s.projects);
  const loadProjects = useStore((s) => s.loadProjects);
  const proposeNoteTasks = useStore((s) => s.proposeNoteTasks);
  const saveNoteProposals = useStore((s) => s.saveNoteProposals);
  const commitNoteTasks = useStore((s) => s.commitNoteTasks);
  const noteProposing = useStore((s) => s.noteProposing);
  const noteProposeError = useStore((s) => s.noteProposeError);
  const noteCommitting = useStore((s) => s.noteCommitting);
  const openTask = useStore((s) => s.openTask);

  const groups = useProjectGroups(projects);
  const roster = useProjectRoster(note.projectId);

  // Borrador local de la revisión: se resincroniza con el servidor sólo cuando
  // no hay edición pendiente (si no, un PATCH que vuelve pisaría lo tecleado).
  const [draft, setDraft] = useState<NoteTaskProposal[]>(note.proposals);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  // Los PATCH van en serie: cada uno lee la versión que dejó el anterior, así
  // dos ediciones seguidas no compiten con `expected_version`.
  const queueRef = useRef<Promise<unknown>>(Promise.resolve());
  const enqueueSave = useCallback(() => {
    const run = queueRef.current.then(() => saveNoteProposals(note.id, draftRef.current));
    queueRef.current = run.catch(() => undefined);
    return run;
  }, [note.id, saveNoteProposals]);

  useEffect(() => {
    if (projects.length === 0) void loadProjects();
  }, [projects.length, loadProjects]);

  useEffect(() => {
    if (timerRef.current) return;
    setDraft(note.proposals);
  }, [note.id, note.version, note.proposals]);

  const flush = useCallback(async () => {
    if (!timerRef.current) return;
    clearTimeout(timerRef.current);
    timerRef.current = null;
    await enqueueSave();
  }, [enqueueSave]);

  const onChange = useCallback(
    (next: NoteTaskProposal) => {
      setDraft((current) => current.map((p) => (p.id === next.id ? next : p)));
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        void enqueueSave();
      }, PROPOSALS_SAVE_MS);
    },
    [enqueueSave],
  );

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const puedeProponer =
    (note.status === "transcribed" || note.status === "converted") && !!note.transcription?.trim();
  const pendientes = draft.filter((p) => p.include && !p.created_task_id);
  const sinProyecto = pendientes.filter((p) => !p.project_id);
  const creadas = draft.filter((p) => p.created_task_id).length;

  const motivo =
    pendientes.length === 0
      ? draft.length === 0
        ? null
        : "No hay propuestas incluidas pendientes de crear."
      : sinProyecto.length > 0
        ? `Elige proyecto en: ${sinProyecto.map((p) => `«${p.title || "sin título"}»`).join(", ")}.`
        : null;
  const puedeCrear = pendientes.length > 0 && sinProyecto.length === 0 && !noteCommitting;

  const crear = useCallback(async () => {
    await flush();
    await commitNoteTasks(note.id);
  }, [commitNoteTasks, flush, note.id]);

  return (
    <section
      data-testid="propuestas-panel"
      className="rounded-panel border border-line bg-surface p-3"
      aria-labelledby="propuestas-titulo"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 id="propuestas-titulo" className="text-label uppercase tracking-wide text-muted">
          Tareas propuestas
        </h2>
        {puedeProponer ? (
          <button
            type="button"
            onClick={() => void proposeNoteTasks(note.id)}
            disabled={noteProposing}
            className="press inline-flex min-h-8 items-center gap-1.5 rounded-tight border border-line px-2.5 text-label font-semibold text-ink-2 hover:bg-surface-2 focus:outline-none focus:ring-2 focus:ring-link disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Sparkles size={14} strokeWidth={1.75} aria-hidden="true" />
            {noteProposing ? "Proponiendo…" : draft.length > 0 ? "Volver a proponer" : "Proponer tareas"}
          </button>
        ) : null}
      </div>

      {noteProposing ? (
        <p className="mt-2 text-small text-muted" role="status">
          Leyendo la transcripción y buscando acciones… no se crea nada todavía.
        </p>
      ) : null}

      {noteProposeError ? (
        <p
          data-testid="error-propuestas"
          className="mt-2 rounded-tight border border-broken-line bg-broken-bg px-2.5 py-2 text-small text-broken"
        >
          {noteProposeError}
        </p>
      ) : null}

      {draft.length === 0 ? (
        <p className="mt-2 text-small text-muted">
          {puedeProponer
            ? "Pulsa «Proponer tareas»: el modelo sugiere una tarea por acción y tú decides cuáles se crean."
            : "Primero transcribe la nota; después se pueden proponer tareas a partir del texto."}
        </p>
      ) : (
        <ul className="mt-2 flex flex-col gap-2" aria-label="Propuestas">
          {draft.map((proposal) => (
            <PropuestaRow
              key={proposal.id}
              proposal={proposal}
              groups={groups}
              projects={projects}
              people={roster.people}
              onChange={onChange}
              onOpenTask={(taskId) => void openTask(taskId)}
            />
          ))}
        </ul>
      )}

      {draft.length > 0 ? (
        <footer className="mt-3 flex flex-col gap-1.5 border-t border-line-soft pt-3">
          <button
            type="button"
            onClick={() => void crear()}
            disabled={!puedeCrear}
            data-testid="crear-tareas"
            className="press inline-flex min-h-10 items-center justify-center gap-1.5 rounded-tight bg-ink px-4 text-small font-semibold text-surface hover:bg-ink-2 focus:outline-none focus:ring-2 focus:ring-link disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ListChecks size={15} strokeWidth={2} aria-hidden="true" />
            {noteCommitting
              ? "Creando…"
              : `Crear ${pendientes.length} ${pendientes.length === 1 ? "tarea" : "tareas"}`}
          </button>
          {motivo ? (
            <p data-testid="motivo-crear" className="text-label text-work">
              {motivo}
            </p>
          ) : (
            <p className="text-label text-faint">
              Sólo se crean las incluidas; nada se crea sin pulsar el botón.
              {creadas > 0 ? ` ${creadas} ya creada(s).` : ""}
            </p>
          )}
        </footer>
      ) : null}
    </section>
  );
}
