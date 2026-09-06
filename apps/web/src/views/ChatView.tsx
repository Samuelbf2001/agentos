/**
 * Chat (canal web, spec B5 §3): hilo con streaming de tokens, tool calls como
 * chips expandibles, enlaces a tarjetas creadas (task.created del board) y
 * envío idempotente (message_id uuid). Selector de hilo / nuevo hilo.
 * El cuerpo (mensajes + formulario) vive en components/chat/ChatBody y lo
 * comparte con el Copiloto del tablero.
 */
import { useEffect } from "react";
import { useStore } from "../state/store";
import { timeAgo } from "../components/ui";
import ChatBody from "../components/chat/ChatBody";

export default function ChatView() {
  const threads = useStore((s) => s.threads);
  const threadId = useStore((s) => s.chat.threadId);
  const loadThreads = useStore((s) => s.loadThreads);
  const openThread = useStore((s) => s.openThread);
  const sendChatMessage = useStore((s) => s.sendChatMessage);

  useEffect(() => {
    void loadThreads();
  }, [loadThreads]);

  return (
    <div className="flex h-full">
      {/* Selector de hilo */}
      <aside className="w-60 shrink-0 overflow-auto border-r border-line bg-surface p-2">
        <button
          onClick={() => void openThread(null)}
          className={`w-full rounded-tight px-3 py-2 text-left text-body font-medium ${
            threadId === null ? "bg-ink text-surface" : "bg-line-soft hover:bg-line"
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
                threadId === t.id ? "bg-line font-medium" : "hover:bg-line-soft"
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
      <ChatBody
        onSend={(text) => sendChatMessage(text)}
        placeholder={threadId ? "Escribe un mensaje…" : "Escribe para empezar un hilo nuevo…"}
        empty={{
          title: "Habla con Alex",
          hint: 'Ej.: "Arranca un assessment para ACME S.A., 40 empleados, manufactura, quieren ISO 9001"',
        }}
      />
    </div>
  );
}
