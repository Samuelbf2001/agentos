/**
 * 2brain › Reuniones: la cola real de captura, extracción y revisión humana
 * (espejo operativo de WhatsAppHub), con la puerta abierta hacia el 2brain
 * original para lo que aún no vive dentro de AgentOS.
 */
import { ExternalLink } from "lucide-react";
import { BRAIN_URL } from "../lib/nav";
import MeetingProcessingView from "./MeetingProcessingView";

export default function BrainMeetingsView() {
  return (
    <div className="mx-auto max-w-[1180px] px-4 pb-20 pt-6 sm:px-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-display text-ink">Reuniones</h1>
          <p className="mt-1.5 max-w-[60ch] text-body text-muted">
            Lo que 2brain capturó, extrajo y revisó. Desde aquí se asocian a un cliente como fuente de contexto.
          </p>
        </div>
        <a
          href={`${BRAIN_URL}/reuniones`}
          target="_blank"
          rel="noreferrer"
          className="press inline-flex items-center gap-1 text-small font-semibold text-link hover:underline"
        >
          Abrir en 2brain
          <ExternalLink size={12} aria-hidden="true" />
        </a>
      </div>

      <div className="mt-6">
        <MeetingProcessingView />
      </div>
    </div>
  );
}
