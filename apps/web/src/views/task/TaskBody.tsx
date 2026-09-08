/**
 * Cuerpo de la ficha (§4.4): título H1 editable, propiedades inline, decisión
 * REVIEW, descripción y definición de terminado siempre editables, fuentes y
 * documentos del proyecto, artefactos, timeline y comentarios. Es el mismo
 * cuerpo en side peek, center peek y página completa.
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { useStore } from "../../state/store";
import { actorLabel, ErrorBox, fmtDate, Spinner } from "../../components/ui";
import { paths } from "../../lib/paths";
import type { KnowledgeDoc, ProjectSource } from "../../lib/types";
import { ArtifactAttacher, ArtifactBlock, BlockedMoveNotice, DefinitionOfDoneEditor, TaskDescriptionEditor } from "./TaskBlocks";
import { TaskProperties } from "./TaskProperties";
import { TaskTitle } from "./TaskTitle";

function ProjectContextSection({ projectId, sources, documents, onNavigate }: {
  projectId: string;
  sources: ProjectSource[];
  documents: KnowledgeDoc[];
  onNavigate: () => void;
}) {
  return (
    <section className="mt-5" aria-labelledby="task-context-title">
      <div className="flex items-center justify-between gap-2">
        <h3 id="task-context-title" className="text-small font-bold text-muted">Fuentes y documentos</h3>
        {/* El contexto es el del proyecto de la tarjeta abierta, nunca el proyecto activo guardado. */}
        <Link to={paths.proyecto(projectId, "contexto")} onClick={onNavigate} className="text-label font-semibold text-link underline underline-offset-2">abrir contexto</Link>
      </div>
      {sources.length > 0 || documents.length > 0 ? (
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <div>
            <p className="text-label font-semibold text-faint">Fuentes vinculadas ({sources.length})</p>
            <ul className="mt-1 space-y-1">
              {sources.slice(0, 3).map((source) => (
                <li key={source.id} className="truncate text-small text-muted" title={source.externalRef.title}>
                  <span className="mr-1 text-faint" aria-hidden="true">↗</span>{source.externalRef.title}
                </li>
              ))}
              {sources.length > 3 ? <li className="text-label text-faint">+{sources.length - 3} más</li> : null}
            </ul>
          </div>
          <div>
            <p className="text-label font-semibold text-faint">Documentos del proyecto ({documents.length})</p>
            <ul className="mt-1 space-y-1">
              {documents.slice(0, 3).map((document) => (
                <li key={document.id} className="truncate text-small text-muted" title={document.title}>
                  <span className="mr-1 text-faint" aria-hidden="true">▤</span>{document.title}
                </li>
              ))}
              {documents.length > 3 ? <li className="text-label text-faint">+{documents.length - 3} más</li> : null}
            </ul>
          </div>
        </div>
      ) : (
        <p className="mt-1 text-label text-faint">No hay fuentes ni documentos vinculados en este proyecto.</p>
      )}
    </section>
  );
}

export function TaskBody() {
  const detail = useStore((state) => state.taskDetail);
  const loading = useStore((state) => state.taskDetailLoading);
  const detailError = useStore((state) => state.taskDetailError);
  const taskSaving = useStore((state) => state.taskSaving);
  const closeTask = useStore((state) => state.closeTask);
  const retryTaskDetail = useStore((state) => state.retryTaskDetail);
  const commentOnTask = useStore((state) => state.commentOnTask);
  const approveTaskReview = useStore((state) => state.approveTaskReview);
  const rejectTaskReview = useStore((state) => state.rejectTaskReview);
  const updateTask = useStore((state) => state.updateTask);
  const uploadTaskArtifact = useStore((state) => state.uploadTaskArtifact);
  const attachArtifactLink = useStore((state) => state.attachArtifactLink);
  const blockedMove = useStore((state) => state.blockedMove);
  const retryBlockedMove = useStore((state) => state.retryBlockedMove);
  const clearBlockedMove = useStore((state) => state.clearBlockedMove);
  const projects = useStore((state) => state.projects);
  const agents = useStore((state) => state.agents);
  const [comment, setComment] = useState("");
  const [rejectNote, setRejectNote] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const [retryingMove, setRetryingMove] = useState(false);

  if (loading) return <Spinner label="Cargando tarjeta…" />;
  if (detailError) return <ErrorBox message={detailError} onRetry={() => void retryTaskDetail()} />;
  if (!detail) return null;

  const task = detail.task;
  const project =
    projects.find((candidate) => candidate.id === task.projectId) ??
    detail.projectContext?.project ??
    detail.project ??
    null;
  const sources = detail.projectContext?.sources ?? detail.projectContext?.project_sources ?? [];
  const documents = detail.projectContext?.documents ?? detail.projectContext?.knowledge_docs ?? [];
  const agent = task.assigneeAgentId ? agents.find((candidate) => candidate.id === task.assigneeAgentId) ?? null : null;
  const comments = detail.events.filter((event) => event.kind === "comment");
  const timeline = detail.events.filter((event) => event.kind !== "comment");

  return (
    <>
      {blockedMove && blockedMove.taskId === task.id ? (
        <BlockedMoveNotice
          blocked={blockedMove}
          retrying={retryingMove}
          onRetry={() => {
            setRetryingMove(true);
            void retryBlockedMove().finally(() => setRetryingMove(false));
          }}
          onDismiss={clearBlockedMove}
        />
      ) : null}

      <TaskTitle value={task.title} onSave={(title) => updateTask(task.id, { title })} />

      <TaskProperties task={task} project={project} agent={agent} onNavigate={closeTask} />

      {task.status === "REVIEW" ? (
        <section className="mt-4 rounded-panel border border-decide-line bg-decide-bg p-3" aria-labelledby="review-decision-title">
          <p id="review-decision-title" className="text-small font-semibold text-decide">En revisión: decide tú <span className="font-normal">(REVIEW → DONE solo humano)</span></p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" onClick={() => void approveTaskReview(task.id)} className="min-h-10 rounded-tight bg-done px-3 py-2 text-small font-semibold text-surface hover:bg-done focus:outline-none focus:ring-2 focus:ring-done">✓ Aprobar</button>
            <button type="button" onClick={() => setRejecting((value) => !value)} className="min-h-10 rounded-tight border border-broken bg-surface px-3 py-2 text-small font-semibold text-broken hover:bg-broken-bg focus:outline-none focus:ring-2 focus:ring-broken">✕ Rechazar</button>
          </div>
          {rejecting ? (
            <div className="mt-2">
              <label htmlFor="reject-note" className="sr-only">Nota de rechazo</label>
              <textarea id="reject-note" value={rejectNote} onChange={(event) => setRejectNote(event.target.value)} placeholder="Nota de rechazo (obligatoria): el agente la recibe como input" className="w-full rounded-tight border border-line p-2 text-small focus:border-broken focus:outline-none focus:ring-2 focus:ring-broken" rows={3} />
              <button type="button" disabled={!rejectNote.trim()} onClick={() => { void rejectTaskReview(task.id, rejectNote.trim()); setRejecting(false); setRejectNote(""); }} className="mt-2 min-h-9 rounded-tight bg-broken px-3 py-1.5 text-small font-semibold text-surface disabled:cursor-not-allowed disabled:opacity-40">Confirmar rechazo</button>
            </div>
          ) : null}
        </section>
      ) : null}

      <TaskDescriptionEditor
        value={task.description ?? ""}
        saving={taskSaving}
        onSave={(description) => updateTask(task.id, { description })}
      />

      <DefinitionOfDoneEditor
        value={task.definitionOfDone ?? ""}
        saving={taskSaving}
        onSave={(definition_of_done) => updateTask(task.id, { definition_of_done })}
      />

      <ProjectContextSection projectId={task.projectId} sources={sources} documents={documents} onNavigate={closeTask} />

      <section className="mt-5" aria-labelledby="task-artifacts-title">
        <h3 id="task-artifacts-title" className="text-small font-bold text-muted">Artefactos ({detail.artifacts.length})</h3>
        <div className="mt-1 space-y-2">{detail.artifacts.length === 0 ? <p className="text-small text-faint">Sin artefactos. Nada llega a REVIEW/DONE sin evidencia.</p> : detail.artifacts.map((artifact) => <ArtifactBlock key={artifact.id} artifact={artifact} />)}</div>
        <ArtifactAttacher
          saving={taskSaving}
          onUpload={(file, artifactTitle) => uploadTaskArtifact(task.id, file, artifactTitle)}
          onLink={(input) => attachArtifactLink(task.id, input)}
        />
      </section>

      <section className="mt-5" aria-labelledby="task-timeline-title">
        <h3 id="task-timeline-title" className="text-small font-bold text-muted">Timeline</h3>
        <ol className="mt-2 space-y-2">{timeline.map((event) => <li key={event.id} className="flex items-start gap-2 text-small"><span className="w-24 shrink-0 pt-0.5 text-label text-faint">{fmtDate(event.createdAt)}</span><span className="min-w-0 flex-1"><span className="font-medium">{event.kind}</span>{event.fromStatus || event.toStatus ? <span className="text-muted"> {event.fromStatus ?? "·"} → {event.toStatus ?? "·"}</span> : null}<span className="text-faint"> · {actorLabel(event.actor)}</span>{event.runId ? <><span className="text-faint"> · </span><Link to={paths.run(event.runId)} onClick={closeTask} className="text-link underline">run</Link></> : null}</span></li>)}{timeline.length === 0 ? <li className="text-small text-faint">(sin eventos)</li> : null}</ol>
      </section>

      <section className="mt-5" aria-labelledby="task-comments-title">
        <h3 id="task-comments-title" className="text-small font-bold text-muted">Comentarios ({comments.length})</h3>
        <div className="mt-2 space-y-2">{comments.map((event) => <div key={event.id} className="rounded-tight bg-surface-2 p-2 text-small"><p className="text-label text-faint">{actorLabel(event.actor)} · {fmtDate(event.createdAt)}</p><p className="mt-0.5 break-words">{String((event.payload as { body?: string })?.body ?? "")}</p></div>)}</div>
        <div className="mt-2 flex gap-2"><label htmlFor="task-comment" className="sr-only">Comentario</label><input id="task-comment" value={comment} onChange={(event) => setComment(event.target.value)} placeholder="Comentar…" className="min-h-10 min-w-0 flex-1 rounded-tight border border-line px-2 py-2 text-small focus:border-link focus:outline-none focus:ring-2 focus:ring-link" /><button type="button" disabled={!comment.trim()} onClick={() => { void commentOnTask(task.id, comment.trim()); setComment(""); }} className="min-h-10 rounded-tight bg-ink px-3 py-2 text-small font-semibold text-surface disabled:cursor-not-allowed disabled:opacity-40">Enviar</button></div>
      </section>

      <section className="mt-5 border-t border-line-soft pt-3 text-label text-faint"><p className="break-words">id {task.id} · v{task.version} · intentos {task.attempts}{task.leaseUntil ? ` · lease hasta ${fmtDate(task.leaseUntil)}` : ""}</p>{detail.runs.length > 0 ? <p className="mt-1 text-small text-muted">La trabajaron {detail.runs.map((run, index) => <span key={run.id}>{index > 0 ? ", " : ""}<Link to={paths.run(run.id)} onClick={closeTask} className="text-link underline">una ejecución {run.status}</Link></span>)}. <Link to={`${paths.sistema("actividad")}?de_tarea=${task.id}`} onClick={closeTask} className="text-link underline">Ver todas</Link></p> : null}</section>
    </>
  );
}
