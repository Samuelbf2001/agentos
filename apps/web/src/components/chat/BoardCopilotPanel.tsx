/**
 * Copiloto del tablero: un hilo de chat por proyecto, con thread_hint
 * determinista `board:<projectId>` (session_key `web:<personId>:board:<id>`)
 * para reabrir siempre la misma conversación, y con el proyecto en el scope
 * del run aunque la vista tenga otro activo. El tablero no se toca desde aquí:
 * se actualiza solo por el topic board:<projectId> cuando Alex crea o mueve
 * tareas.
 *
 * Comparte la única slice `chat` del store con la vista Conversación: son
 * pestañas excluyentes del mismo proyecto, así que abrir el hilo del tablero
 * aquí es lo mismo que abrirlo allí (continuidad, sin estado duplicado).
 */
import { useEffect } from "react";
import { useStore } from "../../state/store";
import type { Thread } from "../../lib/types";
import ChatBody from "./ChatBody";

export function boardThreadHint(projectId: string): string {
  return `board:${projectId}`;
}

/** Hilo del canal web cuya session_key termina en `:board:<projectId>`. */
export function findBoardThread(threads: Thread[], projectId: string): Thread | undefined {
  const suffix = `:${boardThreadHint(projectId)}`;
  return threads.find((t) => t.sessionKey.endsWith(suffix));
}

export default function BoardCopilotPanel({
  projectId,
  projectName,
  onClose,
}: {
  projectId: string;
  projectName?: string;
  onClose(): void;
}) {
  const loadThreads = useStore((s) => s.loadThreads);
  const openThread = useStore((s) => s.openThread);
  const sendChatMessage = useStore((s) => s.sendChatMessage);
  const threadHint = boardThreadHint(projectId);

  // Al abrir (o al cambiar de proyecto con el panel abierto) se apunta al hilo
  // de ESE proyecto; si no existe, se deja vacío y el primer envío lo crea.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await loadThreads();
      if (cancelled) return;
      const state = useStore.getState();
      const found = findBoardThread(state.threads, projectId);
      const target = found?.id ?? null;
      if (state.chat.threadId === target) return;
      await openThread(target);
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, loadThreads, openThread]);

  return (
    <aside
      id="board-copilot"
      data-testid="board-copilot"
      aria-label="Copiloto del tablero"
      className="order-first flex h-[55vh] w-full shrink-0 flex-col overflow-hidden rounded-panel border border-line bg-surface shadow-rest lg:sticky lg:top-3 lg:order-none lg:h-[calc(100vh-6rem)] lg:w-[24rem]"
    >
      <header className="flex items-center gap-2 border-b border-line px-3 py-2">
        <div className="min-w-0 flex-1">
          <p className="text-small font-semibold text-ink">Copiloto</p>
          <p className="truncate text-label text-muted">
            Alex · {projectName ? `hilo de ${projectName}` : "hilo del proyecto"}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Cerrar copiloto"
          data-testid="board-copilot-close"
          className="inline-flex min-h-10 min-w-10 items-center justify-center rounded-tight text-muted hover:bg-line-soft hover:text-ink focus:outline-none focus:ring-2 focus:ring-link"
        >
          ×
        </button>
      </header>
      <ChatBody
        compact
        inputTestId="board-copilot-input"
        placeholder="Pídele a Alex que planifique, descomponga o asigne…"
        empty={{
          title: "Planifica con Alex",
          hint: 'Ej.: "Descompón esta iniciativa en tareas y asígnalas al equipo"',
        }}
        onSend={(text) => sendChatMessage(text, { threadHint, projectId })}
      />
    </aside>
  );
}
