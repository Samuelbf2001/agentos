/**
 * Chat (canal web, spec B5 §3): hilo con streaming de tokens, tool calls como
 * chips expandibles, enlaces a tarjetas creadas (task.created del board) y
 * envío idempotente (message_id uuid). Selector de hilo / nuevo hilo.
 */
import { useEffect, useRef, useState } from "react";
import { useStore } from "../state/store";
import { Markdown } from "../components/Markdown";
import { EmptyState, Spinner, timeAgo } from "../components/ui";
import { renderToolCall, tasksShownByRegistry } from "../components/generative/registry";
import type { ToolCallChip } from "../state/reducer";

export default function ChatView() {
  const threads = useStore((s) => s.threads);
  const chat = useStore((s) => s.chat);
  const toolCalls = useStore((s) => s.toolCalls);
  const createdTasks = useStore((s) => s.createdTasks);
  const boardTasks = useStore((s) => s.board.tasks);
  const chatSending = useStore((s) => s.chatSending);
  const loadThreads = useStore((s) => s.loadThreads);
  const openThread = useStore((s) => s.openThread);
  const sendChatMessage = useStore((s) => s.sendChatMessage);
  const openTask = useStore((s) => s.openTask);
  const [draft, setDraft] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void loadThreads();
  }, [loadThreads]);

  const streams = Object.entries(chat.streams);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chat.messages.length, streams.length, streams.map(([, s]) => s.text.length).join(",")]);

  function chipsForRun(runId: string | null): ToolCallChip[] {
    if (!runId) return [];
    return toolCalls[runId] ?? [];
  }

  /** Tarjetas creadas por el run que el registro generativo NO muestra ya. */
  function tasksForRun(runId: string | null) {
    if (!runId) return [];
    const shown = tasksShownByRegistry(chipsForRun(runId));
    return createdTasks.filter((t) => t.runId === runId && !shown.has(t.taskId));
  }

  async function onSend(e: React.FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    await sendChatMessage(text);
  }

  return (
    <div className="flex h-full">
      {/* Selector de hilo */}
      <aside className="w-60 shrink-0 overflow-auto border-r border-line bg-surface p-2">
        <button
          onClick={() => void openThread(null)}
          className={`w-full rounded-tight px-3 py-2 text-left text-body font-medium ${
            chat.threadId === null ? "bg-ink text-surface" : "bg-line-soft hover:bg-line"
          }`}
        >
          ＋ Nuevo hilo
        </button>
        <div className="mt-2 space-y-1">
          {threads.length === 0 ? (
            <p className="px-2 py-4 text-small text-faint">
              Sin hilos todavía. Escribe tu primer mensaje.
            </p>
          ) : null}
          {threads.map((t) => (
            <button
              key={t.id}
              onClick={() => void openThread(t.id)}
              className={`block w-full truncate rounded-tight px-3 py-2 text-left text-small ${
                chat.threadId === t.id ? "bg-line font-medium" : "hover:bg-line-soft"
              }`}
              title={t.sessionKey}
            >
              {t.title ?? `Hilo ${t.id.slice(0, 8)}`}
              <span className="block text-label text-faint">{timeAgo(t.updatedAt)}</span>
            </button>
          ))}
        </div>
      </aside>

      {/* Conversación */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex-1 space-y-3 overflow-auto p-4">
          {chat.threadId === null && chat.messages.length === 0 ? (
            <EmptyState
              title="Habla con Alex"
              hint='Ej.: "Arranca un assessment para ACME S.A., 40 empleados, manufactura, quieren ISO 9001"'
            />
          ) : null}
          {chat.messages.map((m) => (
            <div key={m.id} className={m.role === "user" ? "flex justify-end" : "flex justify-start"}>
              <div
                className={`max-w-[75%] rounded-panel px-3 py-2 text-body ${
                  m.role === "user"
                    ? "bg-ink text-surface"
                    : m.meta?.error
                      ? "border border-broken-line bg-broken-bg"
                      : "border border-line bg-surface"
                }`}
              >
                {m.role === "assistant" ? <Markdown>{m.content}</Markdown> : m.content}
                {m.role === "assistant" ? (
                  <>
                    {chipsForRun(m.runId).map((c) => renderToolCall(c, m.runId ?? ""))}
                    {tasksForRun(m.runId).map((t) => {
                      const task = boardTasks[t.taskId];
                      return (
                        <button
                          key={t.taskId}
                          onClick={() => void openTask(t.taskId)}
                          className="mt-1 mr-1 inline-flex min-h-10 items-center gap-1 rounded-tight border border-link bg-link-bg px-2 py-1 text-small text-link hover:bg-link-bg focus:outline-none focus:ring-2 focus:ring-link"
                        >
                          {task ? task.title : `Tarjeta ${t.taskId.slice(0, 8)}`}
                        </button>
                      );
                    })}
                  </>
                ) : null}
              </div>
            </div>
          ))}

          {/* Streaming en curso */}
          {streams.map(([id, s]) => (
            <div key={id} className="flex justify-start">
              <div className="max-w-[75%] rounded-panel border border-line bg-surface px-3 py-2 text-body">
                <Markdown>{s.text || "…"}</Markdown>
                {!s.done ? (
                  <span className="mt-1 inline-block h-3 w-1.5 animate-pulse bg-faint align-middle" />
                ) : null}
                {chipsForRun(s.runId).map((c) => renderToolCall(c, s.runId ?? ""))}
              </div>
            </div>
          ))}

          {/* Chips de un run activo que aún no emitió texto */}
          {streams.length === 0 && chatSending ? <Spinner label="Enviando…" /> : null}
          <div ref={bottomRef} />
        </div>

        <form onSubmit={onSend} className="flex gap-2 border-t border-line bg-surface p-3">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={
              chat.threadId ? "Escribe un mensaje…" : "Escribe para empezar un hilo nuevo…"
            }
            className="flex-1 rounded-tight border border-line px-3 py-2 text-body"
          />
          <button
            type="submit"
            disabled={chatSending || !draft.trim()}
            className="rounded-tight bg-ink px-4 py-2 text-body font-medium text-surface hover:bg-ink-2 disabled:opacity-40"
          >
            Enviar
          </button>
        </form>
      </div>
    </div>
  );
}
