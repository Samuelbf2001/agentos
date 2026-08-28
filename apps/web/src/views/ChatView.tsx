/**
 * Chat (canal web, spec B5 §3): hilo con streaming de tokens, tool calls como
 * chips expandibles, enlaces a tarjetas creadas (task.created del board) y
 * envío idempotente (message_id uuid). Selector de hilo / nuevo hilo.
 */
import { useEffect, useRef, useState } from "react";
import { useStore } from "../state/store";
import { Markdown } from "../components/Markdown";
import { EmptyState, Spinner, timeAgo } from "../components/ui";
import type { ToolCallChip } from "../state/reducer";

function ToolChip({ chip }: { chip: ToolCallChip }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="my-1 rounded-md border border-slate-200 bg-slate-50 text-xs">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-2 py-1.5 text-left"
      >
        <span
          className={`inline-block h-2 w-2 rounded-full ${
            !chip.done ? "animate-pulse bg-amber-400" : chip.isError ? "bg-rose-500" : "bg-emerald-500"
          }`}
        />
        <span className="font-mono font-medium">{chip.name}</span>
        <span className="text-slate-400">{chip.done ? (chip.isError ? "error" : "ok") : "ejecutando…"}</span>
        <span className="ml-auto text-slate-400">{open ? "▾" : "▸"}</span>
      </button>
      {open ? (
        <div className="space-y-1 border-t border-slate-200 p-2">
          <p className="font-semibold text-slate-500">Argumentos</p>
          <pre className="max-h-40 overflow-auto rounded bg-white p-2">{chip.args || "(vacío)"}</pre>
          <p className="font-semibold text-slate-500">Resultado{chip.synthetic ? " (sintético)" : ""}</p>
          <pre className="max-h-40 overflow-auto rounded bg-white p-2">
            {chip.result ?? "(pendiente)"}
          </pre>
        </div>
      ) : null}
    </div>
  );
}

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

  function tasksForRun(runId: string | null) {
    if (!runId) return [];
    return createdTasks.filter((t) => t.runId === runId);
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
      <aside className="w-60 shrink-0 overflow-auto border-r border-slate-200 bg-white p-2">
        <button
          onClick={() => void openThread(null)}
          className={`w-full rounded-md px-3 py-2 text-left text-sm font-medium ${
            chat.threadId === null ? "bg-slate-900 text-white" : "bg-slate-100 hover:bg-slate-200"
          }`}
        >
          ＋ Nuevo hilo
        </button>
        <div className="mt-2 space-y-1">
          {threads.length === 0 ? (
            <p className="px-2 py-4 text-xs text-slate-400">
              Sin hilos todavía. Escribe tu primer mensaje.
            </p>
          ) : null}
          {threads.map((t) => (
            <button
              key={t.id}
              onClick={() => void openThread(t.id)}
              className={`block w-full truncate rounded-md px-3 py-2 text-left text-xs ${
                chat.threadId === t.id ? "bg-slate-200 font-medium" : "hover:bg-slate-100"
              }`}
              title={t.sessionKey}
            >
              {t.title ?? `Hilo ${t.id.slice(0, 8)}`}
              <span className="block text-[10px] text-slate-400">{timeAgo(t.updatedAt)}</span>
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
                className={`max-w-[75%] rounded-xl px-3 py-2 text-sm ${
                  m.role === "user"
                    ? "bg-slate-900 text-white"
                    : m.meta?.error
                      ? "border border-rose-200 bg-rose-50"
                      : "border border-slate-200 bg-white"
                }`}
              >
                {m.role === "assistant" ? <Markdown>{m.content}</Markdown> : m.content}
                {m.role === "assistant" ? (
                  <>
                    {chipsForRun(m.runId).map((c) => (
                      <ToolChip key={c.id} chip={c} />
                    ))}
                    {tasksForRun(m.runId).map((t) => {
                      const task = boardTasks[t.taskId];
                      return (
                        <button
                          key={t.taskId}
                          onClick={() => void openTask(t.taskId)}
                          className="mt-1 mr-1 inline-flex items-center gap-1 rounded-md border border-sky-200 bg-sky-50 px-2 py-1 text-xs text-sky-800 hover:bg-sky-100"
                        >
                          🗂️ {task ? task.title : `Tarjeta ${t.taskId.slice(0, 8)}`}
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
              <div className="max-w-[75%] rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm">
                <Markdown>{s.text || "…"}</Markdown>
                {!s.done ? (
                  <span className="mt-1 inline-block h-3 w-1.5 animate-pulse bg-slate-400 align-middle" />
                ) : null}
                {chipsForRun(s.runId).map((c) => (
                  <ToolChip key={c.id} chip={c} />
                ))}
              </div>
            </div>
          ))}

          {/* Chips de un run activo que aún no emitió texto */}
          {streams.length === 0 && chatSending ? <Spinner label="Enviando…" /> : null}
          <div ref={bottomRef} />
        </div>

        <form onSubmit={onSend} className="flex gap-2 border-t border-slate-200 bg-white p-3">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={
              chat.threadId ? "Escribe un mensaje…" : "Escribe para empezar un hilo nuevo…"
            }
            className="flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
          <button
            type="submit"
            disabled={chatSending || !draft.trim()}
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-40"
          >
            Enviar
          </button>
        </form>
      </div>
    </div>
  );
}
