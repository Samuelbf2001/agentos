/**
 * Cuerpo del chat (mensajes, streaming de tokens, tarjetas generativas del
 * registro y formulario). Lo comparten la vista Conversación y el panel
 * Copiloto del tablero: lee la única slice `chat` del store y delega el envío
 * al contenedor, que decide hilo y proyecto.
 */
import { useEffect, useRef, useState } from "react";
import { useStore } from "../../state/store";
import { Markdown } from "../Markdown";
import { EmptyState, Spinner } from "../ui";
import { renderToolCall, tasksShownByRegistry } from "../generative/registry";
import type { ToolCallChip } from "../../state/reducer";

export interface ChatBodyProps {
  onSend(text: string): Promise<void>;
  placeholder?: string;
  /** Vacío inicial: se muestra sin hilo abierto y sin mensajes. */
  empty?: { title: string; hint?: string };
  /** Burbujas más anchas para columnas estrechas (panel lateral). */
  compact?: boolean;
  inputTestId?: string;
}

export default function ChatBody({
  onSend,
  placeholder = "Escribe un mensaje…",
  empty,
  compact = false,
  inputTestId,
}: ChatBodyProps) {
  const chat = useStore((s) => s.chat);
  const toolCalls = useStore((s) => s.toolCalls);
  const createdTasks = useStore((s) => s.createdTasks);
  const boardTasks = useStore((s) => s.board.tasks);
  const chatSending = useStore((s) => s.chatSending);
  const openTask = useStore((s) => s.openTask);
  const [draft, setDraft] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

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

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    await onSend(text);
  }

  const bubble = compact ? "max-w-[92%]" : "max-w-[75%]";

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className={`flex-1 space-y-3 overflow-auto ${compact ? "p-3" : "p-4"}`}>
        {empty && chat.threadId === null && chat.messages.length === 0 ? (
          <EmptyState title={empty.title} hint={empty.hint} />
        ) : null}
        {chat.messages.map((m) => (
          <div key={m.id} className={m.role === "user" ? "flex justify-end" : "flex justify-start"}>
            <div
              className={`${bubble} rounded-panel px-3 py-2 text-body ${
                m.role === "user"
                  ? "bg-ink text-surface"
                  : m.meta?.error
                    ? "border border-broken-line bg-broken-bg"
                    : "bg-surface shadow-rest"
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
            <div className={`${bubble} rounded-panel bg-surface shadow-rest px-3 py-2 text-body`}>
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

      <form onSubmit={submit} className="flex gap-2 border-t border-line bg-surface p-3">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={placeholder}
          aria-label="Mensaje"
          data-testid={inputTestId}
          className="min-h-10 min-w-0 flex-1 rounded-tight border border-line px-3 py-2 text-body focus:outline-none focus:ring-2 focus:ring-link"
        />
        <button
          type="submit"
          disabled={chatSending || !draft.trim()}
          className="min-h-10 rounded-tight bg-ink px-4 py-2 text-body font-medium text-surface hover:bg-ink-2 focus:outline-none focus:ring-2 focus:ring-link focus:ring-offset-1 disabled:opacity-40"
        >
          Enviar
        </button>
      </form>
    </div>
  );
}
