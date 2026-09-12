/**
 * Pestaña "Chats": lista de hilos (teléfonos) a la izquierda, mensajes del
 * hilo seleccionado a la derecha. En móvil la lista y los mensajes se apilan
 * (el grid pasa a una sola columna).
 */
import type { RefObject } from "react";
import { ActionButton } from "../../../components/system";
import { EmptyState, ErrorBox, Spinner } from "../../../components/ui";
import type { ConversacionMessage, ConversacionThread } from "../../../lib/brain/conversaciones";
import { compactDate, formatDate, formatPhone } from "./format";

export interface ChatsPanelProps {
  threads: ConversacionThread[];
  threadsLoading: boolean;
  threadsError: string | null;
  search: string;
  onSearchChange: (value: string) => void;
  selectedPhone: string;
  onSelectPhone: (phone: string) => void;
  messages: ConversacionMessage[];
  messagesLoading: boolean;
  messagesError: string | null;
  autoRefresh: boolean;
  onToggleAutoRefresh: (value: boolean) => void;
  onRefresh: () => void;
  /** Contenedor real que hace scroll (no un centinela): el autoscroll mueve su scrollTop. */
  messagesContainerRef: RefObject<HTMLDivElement | null>;
}

function filterThreads(threads: ConversacionThread[], search: string): ConversacionThread[] {
  const needle = search.trim().toLowerCase();
  if (!needle) return threads;
  return threads.filter((thread) =>
    [thread.phone, thread.name ?? "", thread.lastBody ?? ""].some((value) =>
      value.toLowerCase().includes(needle),
    ),
  );
}

export function ChatsPanel({
  threads,
  threadsLoading,
  threadsError,
  search,
  onSearchChange,
  selectedPhone,
  onSelectPhone,
  messages,
  messagesLoading,
  messagesError,
  autoRefresh,
  onToggleAutoRefresh,
  onRefresh,
  messagesContainerRef,
}: ChatsPanelProps) {
  const filteredThreads = filterThreads(threads, search);
  const selectedThread = threads.find((thread) => thread.phone === selectedPhone) ?? null;
  const busy = threadsLoading || messagesLoading;

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="inline-flex items-center gap-2 text-small text-muted">
          <input
            type="checkbox"
            checked={autoRefresh}
            onChange={(event) => onToggleAutoRefresh(event.target.checked)}
            className="h-4 w-4 accent-ink"
          />
          Auto-actualizar (30 s)
        </label>
        <ActionButton onClick={onRefresh} disabled={busy}>
          {busy ? "Actualizando…" : "Actualizar"}
        </ActionButton>
      </div>

      {threadsError ? (
        <div className="mt-3">
          <ErrorBox message={threadsError} onRetry={onRefresh} />
        </div>
      ) : null}

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-[320px_1fr]">
        <aside className="flex max-h-[calc(100vh-260px)] min-h-[420px] flex-col overflow-hidden rounded-panel bg-surface shadow-rest">
          <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2.5">
            <span className="text-small font-semibold text-ink">Teléfonos</span>
            <span className="text-label text-muted">{filteredThreads.length}</span>
          </div>
          <div className="border-b border-line px-3 py-2">
            <input
              type="text"
              value={search}
              onChange={(event) => onSearchChange(event.target.value)}
              placeholder="Buscar por teléfono o nombre…"
              aria-label="Buscar hilo"
              className="w-full rounded-tight border border-line bg-canvas px-2.5 py-1.5 text-small text-ink outline-none focus:border-link"
            />
          </div>
          <div className="flex-1 overflow-y-auto">
            {threadsLoading && threads.length === 0 ? <Spinner label="Cargando conversaciones…" /> : null}
            {!threadsLoading && filteredThreads.length === 0 ? (
              <div className="p-3">
                <EmptyState
                  title="No hay conversaciones"
                  hint="Todavía no hay chats del agente 2brain, o ninguno coincide con la búsqueda."
                />
              </div>
            ) : null}
            {filteredThreads.map((thread) => (
              <button
                key={thread.phone}
                type="button"
                onClick={() => onSelectPhone(thread.phone)}
                aria-current={thread.phone === selectedPhone ? "true" : undefined}
                className={`press block w-full border-b border-line-soft px-3 py-2.5 text-left last:border-b-0 hover:bg-surface-2 ${
                  thread.phone === selectedPhone ? "bg-link-bg" : ""
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-small font-semibold text-ink">
                    {thread.name || formatPhone(thread.phone)}
                  </span>
                  <span className="shrink-0 text-label text-faint">{thread.count ?? 0} msjs</span>
                </div>
                {thread.name ? <p className="mt-0.5 text-label text-muted">{formatPhone(thread.phone)}</p> : null}
                <p className="mt-1 truncate text-small text-muted">{thread.lastBody || "Sin contenido"}</p>
                <p className="mt-1 text-label text-faint">{formatDate(thread.lastAt)}</p>
              </button>
            ))}
          </div>
        </aside>

        <section className="flex max-h-[calc(100vh-260px)] min-h-[420px] flex-col overflow-hidden rounded-panel bg-surface shadow-rest">
          <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-2.5">
            <div>
              <h2 className="text-body font-semibold text-ink">
                {selectedPhone ? formatPhone(selectedPhone) : "Selecciona un teléfono"}
              </h2>
              {selectedThread ? (
                <p className="text-label text-muted">Última actividad: {formatDate(selectedThread.lastAt)}</p>
              ) : null}
            </div>
            {messagesLoading ? <span className="text-label text-muted">Cargando…</span> : null}
          </div>
          <div ref={messagesContainerRef} className="flex-1 overflow-y-auto bg-canvas p-4">
            {messagesError ? <ErrorBox message={messagesError} onRetry={onRefresh} /> : null}
            {!selectedPhone && !messagesError ? (
              <EmptyState title="Selecciona una conversación" hint="Elige un teléfono de la lista para ver sus mensajes." />
            ) : null}
            {selectedPhone && !messagesLoading && !messagesError && messages.length === 0 ? (
              <EmptyState title="Sin mensajes" hint="No hay mensajes guardados para este teléfono." />
            ) : null}
            <div className="flex flex-col gap-3">
              {messages.map((message) => {
                const outgoing = message.direction === "out";
                return (
                  <div key={message.id} className={`flex ${outgoing ? "justify-end" : "justify-start"}`}>
                    <div
                      className={`max-w-[min(680px,85%)] rounded-soft px-3.5 py-2.5 ${
                        outgoing ? "bg-link text-surface" : "bg-surface-2 text-ink"
                      }`}
                    >
                      <p className="whitespace-pre-wrap break-words text-small leading-relaxed">
                        {message.body || ""}
                      </p>
                      <p className={`mt-1.5 text-right text-label ${outgoing ? "text-surface/80" : "text-muted"}`}>
                        {compactDate(message.created_at)}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
