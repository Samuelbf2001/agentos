/**
 * Panel de tarjeta (drawer, spec B5 §4): descripción, DoD, timeline de
 * task_events con actor y enlace al run, artefactos renderizados
 * (markdown/diff), comentarios y Aprobar/Rechazar en REVIEW (rechazo con nota).
 */
import * as Dialog from "@radix-ui/react-dialog";
import { useState } from "react";
import { Link } from "react-router-dom";
import { useStore } from "../state/store";
import { CodeBlock, Markdown } from "../components/Markdown";
import { actorLabel, fmtDate, Spinner, StatusPill } from "../components/ui";
import type { Artifact } from "../lib/types";

export function ArtifactBlock({ artifact }: { artifact: Artifact }) {
  const [open, setOpen] = useState(true);
  const isDiff = artifact.kind === "diff" || /\.(diff|patch)$/.test(artifact.title);
  return (
    <div className="rounded-md border border-slate-200">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 bg-slate-50 px-2 py-1.5 text-left text-xs"
      >
        <span className="rounded bg-slate-200 px-1 py-0.5 font-mono text-[10px]">{artifact.kind}</span>
        <span className="font-medium">{artifact.title}</span>
        <span className="ml-auto text-slate-400">{open ? "▾" : "▸"}</span>
      </button>
      {open ? (
        <div className="p-2 text-sm">
          {artifact.content ? (
            isDiff ? (
              <CodeBlock code={artifact.content} lang="diff" />
            ) : (
              <Markdown>{artifact.content}</Markdown>
            )
          ) : artifact.path ? (
            <p className="text-xs text-slate-500">
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

export function TaskDrawer() {
  const detail = useStore((s) => s.taskDetail);
  const loading = useStore((s) => s.taskDetailLoading);
  const closeTask = useStore((s) => s.closeTask);
  const commentOnTask = useStore((s) => s.commentOnTask);
  const approveTaskReview = useStore((s) => s.approveTaskReview);
  const rejectTaskReview = useStore((s) => s.rejectTaskReview);
  const agents = useStore((s) => s.agents);
  const [comment, setComment] = useState("");
  const [rejectNote, setRejectNote] = useState("");
  const [rejecting, setRejecting] = useState(false);

  const open = detail !== null || loading;
  if (!open) return null;

  const task = detail?.task;
  const agent = task?.assigneeAgentId ? agents.find((a) => a.id === task.assigneeAgentId) : null;
  const comments = (detail?.events ?? []).filter((e) => e.kind === "comment");
  const timeline = (detail?.events ?? []).filter((e) => e.kind !== "comment");

  return (
    <Dialog.Root open={open} onOpenChange={(v) => !v && closeTask()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/30" />
        <Dialog.Content className="fixed inset-y-0 right-0 z-50 w-[480px] overflow-auto bg-white p-4 shadow-2xl focus:outline-none">
          {loading || !task ? (
            <Spinner label="Cargando tarjeta…" />
          ) : (
            <>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <Dialog.Title className="text-sm font-bold leading-snug">{task.title}</Dialog.Title>
                  <div className="mt-1 flex items-center gap-2 text-xs text-slate-500">
                    <StatusPill status={task.status} />
                    <span>carril {task.stage}</span>
                    {agent ? <span>· asignada a {agent.name}</span> : null}
                    {task.blockedReason ? <span className="text-rose-600">· {task.blockedReason}</span> : null}
                  </div>
                </div>
                <Dialog.Close className="rounded p-1 text-slate-400 hover:bg-slate-100">✕</Dialog.Close>
              </div>

              {task.status === "REVIEW" ? (
                <div className="mt-3 rounded-lg border border-violet-200 bg-violet-50 p-3">
                  <p className="text-xs font-semibold text-violet-800">
                    En revisión: decide tú (REVIEW → DONE solo humano)
                  </p>
                  <div className="mt-2 flex gap-2">
                    <button
                      onClick={() => void approveTaskReview(task.id)}
                      className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700"
                    >
                      ✓ Aprobar
                    </button>
                    <button
                      onClick={() => setRejecting((v) => !v)}
                      className="rounded-md border border-rose-300 px-3 py-1.5 text-xs font-medium text-rose-700 hover:bg-rose-50"
                    >
                      ✕ Rechazar
                    </button>
                  </div>
                  {rejecting ? (
                    <div className="mt-2">
                      <textarea
                        value={rejectNote}
                        onChange={(e) => setRejectNote(e.target.value)}
                        placeholder="Nota de rechazo (obligatoria): el agente la recibe como input"
                        className="w-full rounded-md border border-slate-300 p-2 text-xs"
                        rows={3}
                      />
                      <button
                        disabled={!rejectNote.trim()}
                        onClick={() => {
                          void rejectTaskReview(task.id, rejectNote.trim());
                          setRejecting(false);
                          setRejectNote("");
                        }}
                        className="mt-1 rounded-md bg-rose-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
                      >
                        Confirmar rechazo
                      </button>
                    </div>
                  ) : null}
                </div>
              ) : null}

              <section className="mt-4">
                <h3 className="text-xs font-bold uppercase tracking-wide text-slate-400">Descripción</h3>
                {task.description ? (
                  <div className="mt-1 text-sm">
                    <Markdown>{task.description}</Markdown>
                  </div>
                ) : (
                  <p className="mt-1 text-xs text-slate-400">(sin descripción)</p>
                )}
              </section>

              <section className="mt-4">
                <h3 className="text-xs font-bold uppercase tracking-wide text-slate-400">
                  Definición de terminado
                </h3>
                {task.definitionOfDone ? (
                  <div className="mt-1 rounded-md bg-emerald-50 p-2 text-sm">
                    <Markdown>{task.definitionOfDone}</Markdown>
                  </div>
                ) : (
                  <p className="mt-1 text-xs text-slate-400">(sin DoD)</p>
                )}
              </section>

              <section className="mt-4">
                <h3 className="text-xs font-bold uppercase tracking-wide text-slate-400">
                  Artefactos ({detail!.artifacts.length})
                </h3>
                <div className="mt-1 space-y-2">
                  {detail!.artifacts.length === 0 ? (
                    <p className="text-xs text-slate-400">
                      Sin artefactos. Nada llega a REVIEW/DONE sin evidencia.
                    </p>
                  ) : (
                    detail!.artifacts.map((a) => <ArtifactBlock key={a.id} artifact={a} />)
                  )}
                </div>
              </section>

              <section className="mt-4">
                <h3 className="text-xs font-bold uppercase tracking-wide text-slate-400">Timeline</h3>
                <ol className="mt-1 space-y-1.5">
                  {timeline.map((e) => (
                    <li key={e.id} className="flex items-baseline gap-2 text-xs">
                      <span className="w-28 shrink-0 text-[10px] text-slate-400">{fmtDate(e.createdAt)}</span>
                      <span className="min-w-0 flex-1">
                        <span className="font-medium">{e.kind}</span>
                        {e.fromStatus || e.toStatus ? (
                          <span className="text-slate-500">
                            {" "}
                            {e.fromStatus ?? "·"} → {e.toStatus ?? "·"}
                          </span>
                        ) : null}
                        <span className="text-slate-400"> · {actorLabel(e.actor)}</span>
                        {e.runId ? (
                          <>
                            {" · "}
                            <Link
                              to={`/runs/${e.runId}`}
                              onClick={closeTask}
                              className="text-sky-700 underline"
                            >
                              run
                            </Link>
                          </>
                        ) : null}
                      </span>
                    </li>
                  ))}
                  {timeline.length === 0 ? (
                    <p className="text-xs text-slate-400">(sin eventos)</p>
                  ) : null}
                </ol>
              </section>

              <section className="mt-4">
                <h3 className="text-xs font-bold uppercase tracking-wide text-slate-400">
                  Comentarios ({comments.length})
                </h3>
                <div className="mt-1 space-y-2">
                  {comments.map((c) => (
                    <div key={c.id} className="rounded-md bg-slate-50 p-2 text-xs">
                      <p className="text-[10px] text-slate-400">
                        {actorLabel(c.actor)} · {fmtDate(c.createdAt)}
                      </p>
                      <p className="mt-0.5">{String((c.payload as { body?: string })?.body ?? "")}</p>
                    </div>
                  ))}
                </div>
                <div className="mt-2 flex gap-2">
                  <input
                    value={comment}
                    onChange={(e) => setComment(e.target.value)}
                    placeholder="Comentar…"
                    className="flex-1 rounded-md border border-slate-300 px-2 py-1.5 text-xs"
                  />
                  <button
                    disabled={!comment.trim()}
                    onClick={() => {
                      void commentOnTask(task.id, comment.trim());
                      setComment("");
                    }}
                    className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
                  >
                    Enviar
                  </button>
                </div>
              </section>

              <section className="mt-4 border-t border-slate-100 pt-2 text-[10px] text-slate-400">
                <p>
                  id {task.id} · v{task.version} · intentos {task.attempts}
                  {task.leaseUntil ? ` · lease hasta ${fmtDate(task.leaseUntil)}` : ""}
                </p>
                {detail!.runs.length > 0 ? (
                  <p className="mt-0.5">
                    Runs:{" "}
                    {detail!.runs.map((r, i) => (
                      <span key={r.id}>
                        {i > 0 ? ", " : ""}
                        <Link to={`/runs/${r.id}`} onClick={closeTask} className="text-sky-700 underline">
                          {r.id.slice(0, 8)} ({r.status})
                        </Link>
                      </span>
                    ))}
                  </p>
                ) : null}
              </section>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
