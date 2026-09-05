/**
 * Ficha de tarea en drawer: decisión humana, responsables, vencimiento y
 * contexto de proyecto. En móvil ocupa todo el viewport para que ningún
 * control quede cortado accidentalmente.
 */
import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useStore } from "../state/store";
import { CodeBlock, Markdown } from "../components/Markdown";
import {
  actorLabel,
  dueLabel,
  DuePill,
  ErrorBox,
  fmtDate,
  PersonAvatar,
  Spinner,
  StatusPill,
  STATUS_LABELS,
} from "../components/ui";
import { getTaskAssignees, taskAssigneeIsPrimary, taskAssigneePersonId, taskDueTimestamp, taskDueState, type KnowledgeDoc, type Person, type Project, type ProjectSource, type Task } from "../lib/types";
import type { Artifact } from "../lib/types";

type DescriptionInsertKind = "link" | "image";

function cleanMarkdownLabel(value: string, fallback: string): string {
  const clean = value.trim().replace(/[\[\]]/g, "");
  return clean || fallback;
}

/** Solo dejamos insertar recursos web explícitos; evita enlaces javascript: y data: en tareas. */
export function buildDescriptionInsert(kind: DescriptionInsertKind, label: string, url: string): string | null {
  const candidate = url.trim();
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    const safeLabel = cleanMarkdownLabel(label, kind === "image" ? "Imagen" : "Enlace");
    return kind === "image"
      ? `![${safeLabel}](<${parsed.toString()}>)`
      : `[${safeLabel}](<${parsed.toString()}>)`;
  } catch {
    return null;
  }
}

function insertMarkdownAtCursor(
  value: string,
  insertion: string,
  selectionStart: number,
  selectionEnd: number,
): { value: string; cursor: number } {
  const before = value.slice(0, selectionStart);
  const after = value.slice(selectionEnd);
  const prefix = before && !before.endsWith("\n") ? "\n\n" : "";
  const suffix = after && !after.startsWith("\n") ? "\n\n" : "";
  const next = `${before}${prefix}${insertion}${suffix}${after}`;
  return { value: next, cursor: before.length + prefix.length + insertion.length };
}

/**
 * Edición de la descripción en la propia ficha: Markdown sencillo, inserciones
 * guiadas y una previsualización inmediata. No duplica el estado de la tarea;
 * al guardar siempre usa el PATCH con optimistic locking del store.
 */
export function TaskDescriptionEditor({
  value,
  saving,
  onSave,
}: {
  value: string;
  saving: boolean;
  onSave: (value: string | null) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [insertKind, setInsertKind] = useState<DescriptionInsertKind | null>(null);
  const [insertLabel, setInsertLabel] = useState("");
  const [insertUrl, setInsertUrl] = useState("");
  const [insertError, setInsertError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setDraft(value);
    setEditing(false);
    setInsertKind(null);
    setInsertLabel("");
    setInsertUrl("");
    setInsertError(null);
  }, [value]);

  const dirty = draft !== value;

  function openInsert(kind: DescriptionInsertKind) {
    const textarea = textareaRef.current;
    const selected = textarea
      ? draft.slice(textarea.selectionStart, textarea.selectionEnd).trim()
      : "";
    setInsertKind(kind);
    setInsertLabel(selected);
    setInsertUrl("");
    setInsertError(null);
  }

  function addInsert() {
    if (!insertKind) return;
    const markdown = buildDescriptionInsert(insertKind, insertLabel, insertUrl);
    if (!markdown) {
      setInsertError("Usa una URL que empiece por http:// o https://.");
      return;
    }
    const textarea = textareaRef.current;
    const start = textarea?.selectionStart ?? draft.length;
    const end = textarea?.selectionEnd ?? draft.length;
    const result = insertMarkdownAtCursor(draft, markdown, start, end);
    setDraft(result.value);
    setInsertKind(null);
    setInsertLabel("");
    setInsertUrl("");
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(result.cursor, result.cursor);
    });
  }

  async function saveDescription() {
    if (!dirty) {
      setEditing(false);
      return;
    }
    const saved = await onSave(draft.trim() ? draft : null);
    if (saved) setEditing(false);
  }

  function cancelEditing() {
    setDraft(value);
    setInsertKind(null);
    setInsertLabel("");
    setInsertUrl("");
    setInsertError(null);
    setEditing(false);
  }

  return (
    <section className="mt-4 rounded-2xl border border-sky-100 bg-sky-50/50 p-3.5" aria-labelledby="task-description-title">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 id="task-description-title" className="text-xs font-bold uppercase tracking-[0.12em] text-slate-600">Descripción</h3>
          <p className="mt-0.5 text-[11px] text-slate-500">Contexto, enlaces e imágenes de esta tarea.</p>
        </div>
        {!editing ? (
          <button type="button" onClick={() => setEditing(true)} className="min-h-9 rounded-lg border border-sky-200 bg-white px-3 py-1.5 text-xs font-semibold text-sky-800 shadow-sm hover:border-sky-400 hover:bg-sky-50 focus:outline-none focus:ring-2 focus:ring-sky-500">
            Editar
          </button>
        ) : null}
      </div>

      {!editing ? (
        value ? (
          <div className="mt-3 rounded-xl border border-white bg-white px-3 py-2 text-sm shadow-sm"><Markdown>{value}</Markdown></div>
        ) : (
          <button type="button" onClick={() => setEditing(true)} className="mt-3 w-full rounded-xl border border-dashed border-sky-200 bg-white px-3 py-4 text-left text-xs text-slate-400 hover:border-sky-400 hover:text-slate-600 focus:outline-none focus:ring-2 focus:ring-sky-500">
            + Añadir una descripción, enlace o imagen
          </button>
        )
      ) : (
        <div className="mt-3 space-y-3">
          <div className="flex flex-wrap gap-2" aria-label="Insertar contenido en descripción">
            <button type="button" onClick={() => openInsert("link")} className="min-h-9 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:border-sky-300 hover:text-sky-800 focus:outline-none focus:ring-2 focus:ring-sky-500">↗ Enlace</button>
            <button type="button" onClick={() => openInsert("image")} className="min-h-9 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:border-sky-300 hover:text-sky-800 focus:outline-none focus:ring-2 focus:ring-sky-500">▧ Imagen</button>
            <span className="self-center text-[10px] text-slate-400">Markdown sencillo · vista previa en vivo</span>
          </div>

          {insertKind ? (
            <fieldset className="rounded-xl border border-sky-200 bg-white p-3">
              <legend className="px-1 text-xs font-semibold text-sky-900">{insertKind === "image" ? "Añadir imagen por URL" : "Añadir enlace"}</legend>
              <label className="block text-[11px] font-medium text-slate-600" htmlFor="description-insert-label">{insertKind === "image" ? "Texto alternativo" : "Texto visible"}</label>
              <input id="description-insert-label" value={insertLabel} onChange={(event) => setInsertLabel(event.target.value)} placeholder={insertKind === "image" ? "Ej. Boceto de flujo" : "Ej. Documento de referencia"} className="mt-1 min-h-10 w-full rounded-lg border border-slate-300 px-2.5 py-2 text-xs focus:border-sky-500 focus:outline-none focus:ring-2 focus:ring-sky-300" />
              <label className="mt-2 block text-[11px] font-medium text-slate-600" htmlFor="description-insert-url">URL</label>
              <input id="description-insert-url" value={insertUrl} onChange={(event) => { setInsertUrl(event.target.value); setInsertError(null); }} placeholder="https://…" inputMode="url" className="mt-1 min-h-10 w-full rounded-lg border border-slate-300 px-2.5 py-2 text-xs focus:border-sky-500 focus:outline-none focus:ring-2 focus:ring-sky-300" />
              {insertError ? <p className="mt-1 text-[11px] text-rose-700" role="alert">{insertError}</p> : null}
              <div className="mt-3 flex gap-2">
                <button type="button" onClick={addInsert} className="min-h-9 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-700 focus:outline-none focus:ring-2 focus:ring-sky-500">Insertar</button>
                <button type="button" onClick={() => { setInsertKind(null); setInsertError(null); }} className="min-h-9 rounded-lg px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-sky-500">Cancelar</button>
              </div>
            </fieldset>
          ) : null}

          <div className="grid gap-3">
            <div>
              <label htmlFor="task-description-editor" className="text-[11px] font-semibold text-slate-600">Edición rápida</label>
              <textarea
                ref={textareaRef}
                id="task-description-editor"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
                    event.preventDefault();
                    void saveDescription();
                  }
                }}
                placeholder="Explica el objetivo, pega enlaces o añade una imagen…"
                className="mt-1 min-h-32 w-full resize-y rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm leading-relaxed shadow-sm focus:border-sky-500 focus:outline-none focus:ring-2 focus:ring-sky-300"
              />
            </div>
            <div className="rounded-xl border border-white bg-white p-3 shadow-sm" aria-live="polite">
              <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-400">Vista previa</p>
              {draft.trim() ? <div className="mt-1 text-sm"><Markdown>{draft}</Markdown></div> : <p className="mt-2 text-xs text-slate-400">Tu contenido se verá aquí.</p>}
            </div>
          </div>

          <div className="flex flex-wrap justify-end gap-2 border-t border-sky-100 pt-3">
            <button type="button" onClick={cancelEditing} disabled={saving} className="min-h-10 rounded-lg px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-white disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-sky-500">Cancelar</button>
            <button type="button" disabled={!dirty || saving} onClick={() => void saveDescription()} className="min-h-10 rounded-lg bg-sky-700 px-3 py-2 text-xs font-semibold text-white shadow-sm hover:bg-sky-800 disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus:ring-2 focus:ring-sky-500">{saving ? "Guardando…" : "Guardar descripción"}</button>
          </div>
        </div>
      )}
    </section>
  );
}

export function ArtifactBlock({ artifact }: { artifact: Artifact }) {
  const [open, setOpen] = useState(true);
  const isDiff = artifact.kind === "diff" || /\.(diff|patch)$/.test(artifact.title);
  return (
    <div className="rounded-md border border-slate-200">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex min-h-10 w-full items-center gap-2 bg-slate-50 px-3 py-2 text-left text-xs focus:outline-none focus:ring-2 focus:ring-sky-500 focus:ring-inset"
      >
        <span className="rounded bg-slate-200 px-1 py-0.5 font-mono text-[10px]">{artifact.kind}</span>
        <span className="min-w-0 flex-1 truncate font-medium">{artifact.title}</span>
        <span className="text-slate-400" aria-hidden="true">{open ? "▾" : "▸"}</span>
      </button>
      {open ? (
        <div className="p-3 text-sm">
          {artifact.content ? (
            isDiff ? (
              <CodeBlock code={artifact.content} lang="diff" />
            ) : (
              <Markdown>{artifact.content}</Markdown>
            )
          ) : artifact.path ? (
            <p className="break-words text-xs text-slate-500">
              Archivo en workspace: <code className="rounded bg-slate-100 px-1">{artifact.path}</code>
            </p>
          ) : (
            <p className="text-xs text-slate-400">(sin contenido)</p>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function toDateTimeLocal(ts: number | null | undefined): string {
  if (!ts) return "";
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function fromDateTimeLocal(value: string): number | null {
  if (!value.trim()) return null;
  const timestamp = new Date(value).getTime();
  return Number.isNaN(timestamp) ? null : timestamp;
}

function displayPersonName(person: Person): string {
  return person.full_name || person.fullName || `Persona ${person.id.slice(0, 8)}`;
}

function ContextStrip({ task, detailProject, sources, documents, onOpenContext }: {
  task: Task;
  detailProject: Project | null;
  sources: ProjectSource[];
  documents: KnowledgeDoc[];
  onOpenContext: () => void;
}) {
  const contextSources = sources ?? [];
  const contextDocuments = documents ?? [];
  return (
    <section className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-3" aria-labelledby="task-context-title">
      <div className="flex items-center justify-between gap-2">
        <h3 id="task-context-title" className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">Contexto operativo</h3>
        <Link to="/context" onClick={onOpenContext} className="text-[10px] font-semibold text-sky-700 underline underline-offset-2">abrir contexto</Link>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
        {detailProject ? (
          <Link to="/board" onClick={onOpenContext} className="inline-flex max-w-full items-center gap-1 rounded-full border border-slate-200 bg-white px-2 py-1 font-semibold text-slate-700 hover:border-slate-400">
            <span aria-hidden="true">⌂</span>
            <span className="max-w-[14rem] truncate">{detailProject.name}</span>
          </Link>
        ) : (
          <span className="rounded-full border border-slate-200 bg-white px-2 py-1 text-slate-500">Proyecto no disponible</span>
        )}
        <span className="rounded-full border border-slate-200 bg-white px-2 py-1 text-[10px] text-slate-500">{task.stage}</span>
        <span className="rounded-full border border-slate-200 bg-white px-2 py-1 text-[10px] text-slate-500">{contextSources.length} fuentes</span>
        <span className="rounded-full border border-slate-200 bg-white px-2 py-1 text-[10px] text-slate-500">{contextDocuments.length} documentos</span>
      </div>
      {contextSources.length > 0 || contextDocuments.length > 0 ? (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Fuentes vinculadas</p>
            <ul className="mt-1 space-y-1">
              {contextSources.slice(0, 3).map((source) => (
                <li key={source.id} className="truncate text-xs text-slate-600" title={source.externalRef.title}>
                  <span className="mr-1 text-slate-400" aria-hidden="true">↗</span>{source.externalRef.title}
                </li>
              ))}
              {contextSources.length > 3 ? <li className="text-[10px] text-slate-400">+{contextSources.length - 3} más</li> : null}
            </ul>
          </div>
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Documentos del proyecto</p>
            <ul className="mt-1 space-y-1">
              {contextDocuments.slice(0, 3).map((document) => (
                <li key={document.id} className="truncate text-xs text-slate-600" title={document.title}>
                  <span className="mr-1 text-slate-400" aria-hidden="true">▤</span>{document.title}
                </li>
              ))}
              {contextDocuments.length > 3 ? <li className="text-[10px] text-slate-400">+{contextDocuments.length - 3} más</li> : null}
            </ul>
          </div>
        </div>
      ) : (
        <p className="mt-2 text-[11px] text-slate-400">No hay fuentes ni documentos vinculados en este proyecto.</p>
      )}
    </section>
  );
}

export function TaskDrawer() {
  const detail = useStore((state) => state.taskDetail);
  const loading = useStore((state) => state.taskDetailLoading);
  const detailError = useStore((state) => state.taskDetailError);
  const mutationError = useStore((state) => state.taskMutationError);
  const taskSaving = useStore((state) => state.taskSaving);
  const closeTask = useStore((state) => state.closeTask);
  const retryTaskDetail = useStore((state) => state.retryTaskDetail);
  const commentOnTask = useStore((state) => state.commentOnTask);
  const approveTaskReview = useStore((state) => state.approveTaskReview);
  const rejectTaskReview = useStore((state) => state.rejectTaskReview);
  const updateTask = useStore((state) => state.updateTask);
  const assignTaskPeople = useStore((state) => state.assignTaskPeople);
  const people = useStore((state) => state.people);
  const peopleLoading = useStore((state) => state.peopleLoading);
  const peopleError = useStore((state) => state.peopleError);
  const loadPeople = useStore((state) => state.loadPeople);
  const sessionPerson = useStore((state) => state.person);
  const projects = useStore((state) => state.projects);
  const agents = useStore((state) => state.agents);
  const [comment, setComment] = useState("");
  const [rejectNote, setRejectNote] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const [assigneeIds, setAssigneeIds] = useState<string[]>([]);
  const [primaryAssigneeId, setPrimaryAssigneeId] = useState<string>("");
  const [dueInput, setDueInput] = useState("");
  const [assignmentDirty, setAssignmentDirty] = useState(false);
  const [dueDirty, setDueDirty] = useState(false);
  const peopleLoadAttempted = useRef(false);

  const task = detail?.task;
  const open = detail !== null || loading || Boolean(detailError);
  const detailProject = detail?.projectContext?.project ?? detail?.project ?? (task ? projects.find((project) => project.id === task.projectId) ?? null : null);
  const contextSources = detail?.projectContext?.sources ?? detail?.projectContext?.project_sources ?? [];
  const contextDocuments = detail?.projectContext?.documents ?? detail?.projectContext?.knowledge_docs ?? [];
  const embeddedPeople = useMemo(() => {
    if (!task) return [];
    return getTaskAssignees(task).flatMap((assignee) => {
      if (!assignee.person) return [];
      const name = assignee.person.full_name ?? assignee.person.fullName ?? `Persona ${assignee.person.id.slice(0, 8)}`;
      return [{ ...assignee.person, full_name: name, role: assignee.person.role ?? null }];
    });
  }, [task]);
  const peopleOptions = useMemo(() => {
    const map = new Map<string, Person>();
    for (const candidate of [...people, ...embeddedPeople]) map.set(candidate.id, candidate);
    if (sessionPerson) map.set(sessionPerson.id, sessionPerson);
    return [...map.values()].sort((a, b) => displayPersonName(a).localeCompare(displayPersonName(b), "es"));
  }, [embeddedPeople, people, sessionPerson]);
  const agent = task?.assigneeAgentId ? agents.find((candidate) => candidate.id === task.assigneeAgentId) : null;
  const comments = (detail?.events ?? []).filter((event) => event.kind === "comment");
  const timeline = (detail?.events ?? []).filter((event) => event.kind !== "comment");

  useEffect(() => {
    if (!task) return;
    const assignees = getTaskAssignees(task);
    const ids = assignees.map(taskAssigneePersonId).filter((id): id is string => Boolean(id));
    const primary = assignees.find(taskAssigneeIsPrimary);
    setAssigneeIds(ids);
    setPrimaryAssigneeId(primary ? taskAssigneePersonId(primary) ?? ids[0] ?? "" : ids[0] ?? "");
    setDueInput(toDateTimeLocal(taskDueTimestamp(task)));
    setAssignmentDirty(false);
    setDueDirty(false);
    setRejecting(false);
  }, [task?.id, task?.version]);

  useEffect(() => {
    if (!open) {
      peopleLoadAttempted.current = false;
      return;
    }
    if (!peopleLoading && people.length === 0 && !peopleLoadAttempted.current) {
      peopleLoadAttempted.current = true;
      void loadPeople();
    }
  }, [loadPeople, open, people.length, peopleLoading]);

  if (!open) return null;

  async function saveAssignment() {
    if (!task) return;
    const ok = await assignTaskPeople(task.id, assigneeIds, primaryAssigneeId || null);
    if (ok) setAssignmentDirty(false);
  }

  async function saveDueDate() {
    if (!task) return;
    const ok = await updateTask(task.id, { due_at: fromDateTimeLocal(dueInput) });
    if (ok) setDueDirty(false);
  }

  return (
    <Dialog.Root open={open} onOpenChange={(value) => !value && closeTask()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-slate-950/35 backdrop-blur-[1px]" />
        <Dialog.Content className="fixed inset-0 z-50 flex h-[100dvh] w-full flex-col overflow-hidden bg-white shadow-2xl focus:outline-none sm:inset-y-0 sm:left-auto sm:right-0 sm:h-full sm:w-[480px] sm:max-w-[100vw]" aria-describedby="task-drawer-description">
          <div className="flex shrink-0 items-start gap-3 border-b border-slate-200 bg-white px-4 py-3 shadow-sm sm:px-5">
            <div className="min-w-0 flex-1">
              <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-400">Ficha de operación</p>
              <Dialog.Title className="mt-1 truncate text-base font-semibold leading-snug text-slate-900">{task?.title ?? "Detalle de tarea"}</Dialog.Title>
              <Dialog.Description id="task-drawer-description" className="sr-only">Detalle, responsables, vencimiento y evidencia de la tarea.</Dialog.Description>
              {task ? (
                <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
                  <StatusPill status={task.status} />
                  <span>{task.stage}</span>
                  <span className="text-slate-300">·</span>
                  <DuePill task={task} />
                </div>
              ) : null}
            </div>
            <Dialog.Close className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700 focus:outline-none focus:ring-2 focus:ring-sky-500" aria-label="Cerrar ficha">×</Dialog.Close>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-4 sm:px-5">
            {loading ? <Spinner label="Cargando tarjeta…" /> : null}
            {!loading && detailError ? <ErrorBox message={detailError} onRetry={() => void retryTaskDetail()} /> : null}
            {!loading && !detailError && task ? (
              <>
                {mutationError ? (
                  <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900" role="alert" data-testid="task-conflict">
                    <p className="font-semibold">La tarea cambió mientras la editabas.</p>
                    <p className="mt-1 break-words">{mutationError}</p>
                    <button type="button" onClick={() => void retryTaskDetail()} className="mt-2 min-h-9 rounded-md border border-amber-400 bg-white px-3 py-1.5 font-semibold hover:bg-amber-100 focus:outline-none focus:ring-2 focus:ring-amber-500">Recargar tarea</button>
                  </div>
                ) : null}

                <ContextStrip task={task} detailProject={detailProject} sources={contextSources} documents={contextDocuments} onOpenContext={closeTask} />

                {task.status === "REVIEW" ? (
                  <section className="mt-4 rounded-xl border border-violet-200 bg-violet-50 p-3" aria-labelledby="review-decision-title">
                    <p id="review-decision-title" className="text-xs font-semibold text-violet-900">En revisión: decide tú <span className="font-normal">(REVIEW → DONE solo humano)</span></p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <button type="button" onClick={() => void approveTaskReview(task.id)} className="min-h-10 rounded-md bg-emerald-600 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-700 focus:outline-none focus:ring-2 focus:ring-emerald-500">✓ Aprobar</button>
                      <button type="button" onClick={() => setRejecting((value) => !value)} className="min-h-10 rounded-md border border-rose-300 bg-white px-3 py-2 text-xs font-semibold text-rose-700 hover:bg-rose-50 focus:outline-none focus:ring-2 focus:ring-rose-500">✕ Rechazar</button>
                    </div>
                    {rejecting ? (
                      <div className="mt-2">
                        <label htmlFor="reject-note" className="sr-only">Nota de rechazo</label>
                        <textarea id="reject-note" value={rejectNote} onChange={(event) => setRejectNote(event.target.value)} placeholder="Nota de rechazo (obligatoria): el agente la recibe como input" className="w-full rounded-md border border-slate-300 p-2 text-xs focus:border-rose-400 focus:outline-none focus:ring-2 focus:ring-rose-300" rows={3} />
                        <button type="button" disabled={!rejectNote.trim()} onClick={() => { void rejectTaskReview(task.id, rejectNote.trim()); setRejecting(false); setRejectNote(""); }} className="mt-2 min-h-9 rounded-md bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40">Confirmar rechazo</button>
                      </div>
                    ) : null}
                  </section>
                ) : null}

                <section className="mt-4 rounded-xl border border-slate-200 bg-white p-3" aria-labelledby="task-people-title">
                  <div className="flex items-center justify-between gap-2">
                    <h3 id="task-people-title" className="text-xs font-bold uppercase tracking-[0.12em] text-slate-500">Responsables humanos</h3>
                    {taskSaving && assignmentDirty ? <span className="text-[10px] text-slate-400">Guardando…</span> : null}
                  </div>
                  <fieldset className="mt-2">
                    <legend className="text-[11px] text-slate-500">Selecciona una o más personas</legend>
                    {peopleLoading ? <p className="mt-2 text-xs text-slate-400">Cargando equipo…</p> : null}
                    {peopleError ? (
                      <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 p-2 text-[11px] text-amber-800" role="alert">
                        <p>{peopleError}</p>
                        <button type="button" onClick={() => void loadPeople()} className="mt-1 font-semibold underline">Reintentar roster</button>
                      </div>
                    ) : null}
                    {!peopleLoading && peopleOptions.length === 0 ? <p className="mt-2 text-xs text-slate-400">Sin personas disponibles para esta organización.</p> : null}
                    <div className="mt-2 space-y-1">
                      {peopleOptions.map((person) => {
                        const checked = assigneeIds.includes(person.id);
                        return (
                          <label key={person.id} className="flex min-h-10 cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 hover:bg-slate-50 focus-within:bg-slate-50">
                            <input type="checkbox" checked={checked} onChange={(event) => { const next = event.target.checked ? [...assigneeIds, person.id] : assigneeIds.filter((id) => id !== person.id); setAssigneeIds(next); if (!event.target.checked && primaryAssigneeId === person.id) setPrimaryAssigneeId(next[0] ?? ""); setAssignmentDirty(true); }} className="h-4 w-4 rounded border-slate-300 text-slate-800 focus:ring-sky-500" />
                            <PersonAvatar name={displayPersonName(person)} size={5} />
                            <span className="min-w-0 flex-1 truncate text-xs font-medium text-slate-700">{displayPersonName(person)}</span>
                            {primaryAssigneeId === person.id ? <span className="text-[10px] font-semibold text-sky-700">principal</span> : null}
                          </label>
                        );
                      })}
                    </div>
                  </fieldset>
                  <div className="mt-3 border-t border-slate-100 pt-3">
                    <label htmlFor="primary-assignee" className="text-[11px] font-semibold text-slate-600">Persona principal</label>
                    <select id="primary-assignee" value={primaryAssigneeId} disabled={assigneeIds.length === 0 || taskSaving} onChange={(event) => { setPrimaryAssigneeId(event.target.value); setAssignmentDirty(true); }} className="mt-1 min-h-10 w-full rounded-md border border-slate-300 bg-white px-2 py-2 text-xs focus:border-sky-500 focus:outline-none focus:ring-2 focus:ring-sky-300 disabled:bg-slate-50">
                      <option value="">Sin persona principal</option>
                      {peopleOptions.filter((person) => assigneeIds.includes(person.id)).map((person) => <option key={person.id} value={person.id}>{displayPersonName(person)}</option>)}
                    </select>
                  </div>
                  <button type="button" disabled={!assignmentDirty || taskSaving || peopleLoading} onClick={() => void saveAssignment()} className="mt-3 min-h-10 w-full rounded-md bg-slate-900 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus:ring-2 focus:ring-sky-500">{taskSaving && assignmentDirty ? "Guardando responsables…" : "Guardar responsables"}</button>
                </section>

                <section className="mt-4 rounded-xl border border-slate-200 bg-white p-3" aria-labelledby="task-due-title">
                  <div className="flex items-center justify-between gap-2">
                    <h3 id="task-due-title" className="text-xs font-bold uppercase tracking-[0.12em] text-slate-500">Vencimiento</h3>
                    <DuePill task={task} />
                  </div>
                  <label htmlFor="task-due-at" className="mt-2 block text-[11px] text-slate-500">Fecha y hora local</label>
                  <input id="task-due-at" data-testid="task-due-at" type="datetime-local" value={dueInput} onChange={(event) => { setDueInput(event.target.value); setDueDirty(true); }} className="mt-1 min-h-10 w-full rounded-md border border-slate-300 px-2 py-2 text-sm focus:border-sky-500 focus:outline-none focus:ring-2 focus:ring-sky-300" />
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <button type="button" disabled={!dueInput || taskSaving} onClick={() => { setDueInput(""); setDueDirty(true); }} className="min-h-9 rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40">Quitar fecha</button>
                    <button type="button" disabled={!dueDirty || taskSaving} onClick={() => void saveDueDate()} className="min-h-9 rounded-md bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40">{taskSaving && dueDirty ? "Guardando…" : "Guardar fecha"}</button>
                    <span className="text-[10px] text-slate-400">{taskDueState(task) === "none" ? "Sin vencimiento" : dueLabel(task)}</span>
                  </div>
                </section>

                <section className="mt-4 rounded-xl border border-slate-200 bg-white p-3" aria-labelledby="task-agent-title">
                  <h3 id="task-agent-title" className="text-xs font-bold uppercase tracking-[0.12em] text-slate-500">Agente asignado</h3>
                  {agent ? <div className="mt-2 flex items-center gap-2"><span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-slate-800 text-[10px] font-bold text-white">{agent.name.slice(0, 2).toUpperCase()}</span><span className="text-xs font-medium text-slate-700">{agent.name}</span><span className="text-[10px] text-slate-400">proyección de ejecución</span></div> : <p className="mt-2 text-xs text-slate-400">Sin agente asignado.</p>}
                </section>

                <TaskDescriptionEditor
                  value={task.description ?? ""}
                  saving={taskSaving}
                  onSave={(description) => updateTask(task.id, { description })}
                />

                <section className="mt-4" aria-labelledby="task-dod-title">
                  <h3 id="task-dod-title" className="text-xs font-bold uppercase tracking-[0.12em] text-slate-500">Definición de terminado</h3>
                  {task.definitionOfDone ? <div className="mt-1 rounded-md bg-emerald-50 p-2 text-sm"><Markdown>{task.definitionOfDone}</Markdown></div> : <p className="mt-1 text-xs text-slate-400">(sin DoD)</p>}
                </section>

                <section className="mt-4" aria-labelledby="task-artifacts-title">
                  <h3 id="task-artifacts-title" className="text-xs font-bold uppercase tracking-[0.12em] text-slate-500">Artefactos ({detail.artifacts.length})</h3>
                  <div className="mt-1 space-y-2">{detail.artifacts.length === 0 ? <p className="text-xs text-slate-400">Sin artefactos. Nada llega a REVIEW/DONE sin evidencia.</p> : detail.artifacts.map((artifact) => <ArtifactBlock key={artifact.id} artifact={artifact} />)}</div>
                </section>

                <section className="mt-4" aria-labelledby="task-timeline-title">
                  <h3 id="task-timeline-title" className="text-xs font-bold uppercase tracking-[0.12em] text-slate-500">Timeline</h3>
                  <ol className="mt-2 space-y-2">{timeline.map((event) => <li key={event.id} className="flex items-start gap-2 text-xs"><span className="w-24 shrink-0 pt-0.5 text-[10px] text-slate-400">{fmtDate(event.createdAt)}</span><span className="min-w-0 flex-1"><span className="font-medium">{event.kind}</span>{event.fromStatus || event.toStatus ? <span className="text-slate-500"> {event.fromStatus ?? "·"} → {event.toStatus ?? "·"}</span> : null}<span className="text-slate-400"> · {actorLabel(event.actor)}</span>{event.runId ? <><span className="text-slate-400"> · </span><Link to={`/runs/${event.runId}`} onClick={closeTask} className="text-sky-700 underline">run</Link></> : null}</span></li>)}{timeline.length === 0 ? <li className="text-xs text-slate-400">(sin eventos)</li> : null}</ol>
                </section>

                <section className="mt-4" aria-labelledby="task-comments-title">
                  <h3 id="task-comments-title" className="text-xs font-bold uppercase tracking-[0.12em] text-slate-500">Comentarios ({comments.length})</h3>
                  <div className="mt-2 space-y-2">{comments.map((event) => <div key={event.id} className="rounded-md bg-slate-50 p-2 text-xs"><p className="text-[10px] text-slate-400">{actorLabel(event.actor)} · {fmtDate(event.createdAt)}</p><p className="mt-0.5 break-words">{String((event.payload as { body?: string })?.body ?? "")}</p></div>)}</div>
                  <div className="mt-2 flex gap-2"><label htmlFor="task-comment" className="sr-only">Comentario</label><input id="task-comment" value={comment} onChange={(event) => setComment(event.target.value)} placeholder="Comentar…" className="min-h-10 min-w-0 flex-1 rounded-md border border-slate-300 px-2 py-2 text-xs focus:border-sky-500 focus:outline-none focus:ring-2 focus:ring-sky-300" /><button type="button" disabled={!comment.trim()} onClick={() => { void commentOnTask(task.id, comment.trim()); setComment(""); }} className="min-h-10 rounded-md bg-slate-900 px-3 py-2 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40">Enviar</button></div>
                </section>

                <section className="mt-5 border-t border-slate-100 pt-3 text-[10px] text-slate-400"><p className="break-words">id {task.id} · v{task.version} · intentos {task.attempts}{task.leaseUntil ? ` · lease hasta ${fmtDate(task.leaseUntil)}` : ""}</p>{detail.runs.length > 0 ? <p className="mt-1">Runs: {detail.runs.map((run, index) => <span key={run.id}>{index > 0 ? ", " : ""}<Link to={`/runs/${run.id}`} onClick={closeTask} className="text-sky-700 underline">{run.id.slice(0, 8)} ({run.status})</Link></span>)}</p> : null}</section>
              </>
            ) : null}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
