/**
 * 2brain › Conversaciones: los chats de WhatsApp del agente 2brain (con
 * autoscroll y auto-actualización opcional) y su registro de acciones
 * (auditoría). Solo lectura — el hub WhatsAppHub sigue siendo el dueño de
 * estos datos; esta vista solo los enseña por la API de AgentOS.
 *
 * Deep link opcional `?tel=<phone>` abre directamente ese hilo en la pestaña
 * de chats.
 */
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ApiError } from "../../lib/api";
import {
  fetchConversacionAcciones,
  fetchConversacionChats,
  fetchConversacionMessages,
  type ConversacionAccion,
  type ConversacionMessage,
  type ConversacionThread,
} from "../../lib/brain/conversaciones";
import { AccionesPanel } from "./conversaciones/AccionesPanel";
import { ChatsPanel } from "./conversaciones/ChatsPanel";

const REFRESH_MS = 30_000;

type Tab = "chats" | "acciones";

/** 502 provider_error del proxy: el hub de 2brain no contestó, no un error nuestro. */
function messageFor(cause: unknown, fallback: string): string {
  if (cause instanceof ApiError) {
    if (cause.status === 502 || cause.code === "provider_error") {
      return "2brain no responde ahora mismo (el hub de WhatsApp no contestó). Intenta de nuevo en un momento.";
    }
    return cause.message;
  }
  return fallback;
}

export default function ConversacionesView() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [tab, setTab] = useState<Tab>("chats");

  // ── Chats ────────────────────────────────────────────────────────────────
  const [threads, setThreads] = useState<ConversacionThread[]>([]);
  const [threadsLoading, setThreadsLoading] = useState(true);
  const [threadsError, setThreadsError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [selectedPhone, setSelectedPhone] = useState(() => searchParams.get("tel") ?? "");
  const [messages, setMessages] = useState<ConversacionMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [messagesError, setMessagesError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(false);
  // Ref al CONTENEDOR de mensajes (no un centinela al final): el autoscroll
  // mueve su scrollTop, nunca el de la página — así el h1 no desaparece.
  const messagesContainerRef = useRef<HTMLDivElement | null>(null);

  // ── Acciones ─────────────────────────────────────────────────────────────
  const [acciones, setAcciones] = useState<ConversacionAccion[]>([]);
  const [accionesLoading, setAccionesLoading] = useState(true);
  const [accionesError, setAccionesError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState("");
  const [phoneFilter, setPhoneFilter] = useState("");

  async function loadThreads() {
    setThreadsLoading(true);
    setThreadsError(null);
    try {
      const data = await fetchConversacionChats();
      const nextThreads = data.threads ?? [];
      setThreads(nextThreads);
      setSelectedPhone((current) => {
        if (current && (nextThreads.some((thread) => thread.phone === current) || current === searchParams.get("tel"))) {
          return current;
        }
        return nextThreads[0]?.phone ?? "";
      });
    } catch (cause) {
      setThreads([]);
      setThreadsError(messageFor(cause, "No se pudieron cargar las conversaciones."));
    } finally {
      setThreadsLoading(false);
    }
  }

  async function loadMessages(phone: string) {
    if (!phone) {
      setMessages([]);
      return;
    }
    setMessagesLoading(true);
    setMessagesError(null);
    try {
      const data = await fetchConversacionMessages(phone);
      setMessages(data.messages ?? []);
    } catch (cause) {
      setMessages([]);
      setMessagesError(messageFor(cause, "No se pudieron cargar los mensajes."));
    } finally {
      setMessagesLoading(false);
    }
  }

  async function loadAcciones() {
    setAccionesLoading(true);
    setAccionesError(null);
    try {
      const data = await fetchConversacionAcciones({ status: statusFilter || undefined });
      setAcciones(data.actions ?? []);
    } catch (cause) {
      setAcciones([]);
      setAccionesError(messageFor(cause, "No se pudo cargar el registro de acciones."));
    } finally {
      setAccionesLoading(false);
    }
  }

  useEffect(() => {
    void loadThreads();
    // Solo al montar: recargas posteriores las dispara el botón/auto-refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void loadAcciones();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter]);

  useEffect(() => {
    void loadMessages(selectedPhone);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPhone]);

  // Auto-actualización cada 30 s (solo hilos + hilo abierto), apagada por defecto.
  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(() => {
      void loadThreads();
      if (selectedPhone) void loadMessages(selectedPhone);
    }, REFRESH_MS);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRefresh, selectedPhone]);

  // Autoscroll al final al recibir mensajes (nunca a media carga). Sobre el
  // contenedor de mensajes, nunca sobre `window` (si no, la página entera se
  // desplaza y la cabecera desaparece).
  useEffect(() => {
    if (!messagesLoading && messages.length > 0) {
      const el = messagesContainerRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
  }, [messages, messagesLoading]);

  function selectPhone(phone: string) {
    setSelectedPhone(phone);
    setSearchParams((params) => {
      const next = new URLSearchParams(params);
      if (phone) next.set("tel", phone);
      else next.delete("tel");
      return next;
    });
  }

  function refreshChats() {
    void loadThreads();
    if (selectedPhone) void loadMessages(selectedPhone);
  }

  return (
    <div className="mx-auto max-w-[1180px] px-4 pb-20 pt-6 sm:px-5">
      <h1 className="text-display text-ink">Conversaciones</h1>
      <p className="mt-1.5 max-w-[60ch] text-body text-muted">
        Chats de WhatsApp del agente 2brain y su registro de acciones. Vista de solo lectura sobre el hub.
      </p>

      <div className="mt-5 inline-flex w-fit rounded-soft bg-canvas-deep p-1" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "chats"}
          onClick={() => setTab("chats")}
          className={`press rounded-tight px-3.5 py-1.5 text-small font-semibold ${
            tab === "chats" ? "bg-ink text-surface" : "text-muted hover:text-ink"
          }`}
        >
          Chats
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "acciones"}
          onClick={() => setTab("acciones")}
          className={`press rounded-tight px-3.5 py-1.5 text-small font-semibold ${
            tab === "acciones" ? "bg-ink text-surface" : "text-muted hover:text-ink"
          }`}
        >
          Acciones del agente
        </button>
      </div>

      <div className="mt-4">
        {tab === "chats" ? (
          <ChatsPanel
            threads={threads}
            threadsLoading={threadsLoading}
            threadsError={threadsError}
            search={search}
            onSearchChange={setSearch}
            selectedPhone={selectedPhone}
            onSelectPhone={selectPhone}
            messages={messages}
            messagesLoading={messagesLoading}
            messagesError={messagesError}
            autoRefresh={autoRefresh}
            onToggleAutoRefresh={setAutoRefresh}
            onRefresh={refreshChats}
            messagesContainerRef={messagesContainerRef}
          />
        ) : (
          <AccionesPanel
            acciones={acciones}
            loading={accionesLoading}
            error={accionesError}
            statusFilter={statusFilter}
            onStatusFilterChange={setStatusFilter}
            phoneFilter={phoneFilter}
            onPhoneFilterChange={setPhoneFilter}
            onRefresh={() => void loadAcciones()}
          />
        )}
      </div>
    </div>
  );
}
