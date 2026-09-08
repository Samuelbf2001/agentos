/**
 * 2brain como módulo propio (PLAN-v1.5 §2brain). Panorama de los módulos del
 * segundo cerebro de Sixteam: Reuniones ya vive dentro de AgentOS (lectura
 * operativa de WhatsAppHub); el resto sigue abriéndose en 2brain mientras se
 * integra, con su estado de conexión a la vista.
 */
import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  AudioLines,
  Bot,
  BookOpen,
  Clapperboard,
  Database,
  ExternalLink,
  MessageSquare,
  Mic,
  Video,
  Waypoints,
  type LucideIcon,
} from "lucide-react";
import { api } from "../lib/api";
import { paths } from "../lib/paths";
import { BRAIN_URL } from "../lib/nav";
import { useBrainOverview } from "../state/useBrainOverview";
import { Card, Chip, SectionHead, type Tone } from "../components/system";
import type { BrainSource, BrainSourceStatus } from "../lib/types";

/** Conectada, sin configurar o sin respuesta: los tres estados que puede tener una fuente remota. */
function connectionChip(status: BrainSourceStatus): { tone: Tone; label: string } {
  if (status === "connected") return { tone: "done", label: "Conectado" };
  if (status === "not_configured") return { tone: "work", label: "Sin configurar" };
  return { tone: "broken", label: "Sin respuesta" };
}

/** Total de páginas inventariadas entre el wiki local y los agregados de WhatsAppHub. */
function wikiPagesLabel(sources: BrainSource[]): string {
  const wiki = sources.find((s) => s.id === "llm_wiki");
  const hub = sources.find((s) => s.id === "whatsapphub");
  const counts = { ...(hub?.counts ?? {}), ...(wiki?.counts ?? {}) };
  const values = Object.values(counts);
  if (values.length === 0) return "Sin datos de páginas";
  const total = values.reduce((sum, v) => sum + v, 0);
  return total === 1 ? "1 página" : `${total} páginas`;
}

function ExternalAction({ href }: { href: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="press inline-flex items-center gap-1 text-small font-semibold text-link hover:underline"
    >
      Abrir en 2brain
      <ExternalLink size={12} aria-hidden="true" />
    </a>
  );
}

function ModuleCard({
  icon: Icon,
  name,
  description,
  status,
  action,
}: {
  icon: LucideIcon;
  name: string;
  description: string;
  status?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <Card className="p-5">
      <div className="flex items-center gap-2">
        <Icon size={20} className="text-ink-2" aria-hidden="true" />
        <h3 className="text-title text-ink">{name}</h3>
      </div>
      <p className="mt-1 text-small text-muted">{description}</p>
      {status || action ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {status}
          {action ? <span className="ml-auto">{action}</span> : null}
        </div>
      ) : null}
    </Card>
  );
}

/** Cuenta de reuniones pendientes de revisión; ninguna carga bloquea la página. */
function useMeetingsPending(): number | null {
  const [pending, setPending] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api.meetingProcessing("pending", 1);
        if (!cancelled) setPending(data.queue.pending ?? data.total ?? 0);
      } catch {
        if (!cancelled) setPending(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return pending;
}

export default function BrainView() {
  const { overview, error } = useBrainOverview();
  const pending = useMeetingsPending();

  const hub = overview?.sources.find((s) => s.id === "whatsapphub");
  const notion = overview?.sources.find((s) => s.id === "notion");
  const hubChip = hub ? connectionChip(hub.status) : null;
  const notionChip = notion ? connectionChip(notion.status) : null;

  return (
    <div className="mx-auto max-w-[1180px] px-4 pb-20 pt-6 sm:px-5">
      <h1 className="text-display text-ink">2brain</h1>
      <p className="mt-1.5 max-w-[60ch] text-body text-muted">
        El segundo cerebro de Sixteam: reuniones, conversaciones, notas de voz y conocimiento. Las reuniones ya
        viven aquí; el resto se abre en 2brain mientras se integra.
      </p>

      {error ? <p className="mt-4 text-small text-muted">No se pudo leer el estado de 2brain</p> : null}

      <SectionHead label="Módulos" />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <ModuleCard
          icon={Video}
          name="Reuniones"
          description="Grabadas por Fathom, extraídas y revisadas antes de convertirse en evidencia."
          status={
            pending === null ? null : pending > 0 ? (
              <Chip tone="work">{pending === 1 ? "1 pendiente de revisión" : `${pending} pendientes de revisión`}</Chip>
            ) : (
              <Chip tone="done">Al día</Chip>
            )
          }
          action={
            <Link to={paths.brainReuniones()} className="press text-small font-semibold text-link hover:underline">
              Abrir
            </Link>
          }
        />
        <ModuleCard
          icon={MessageSquare}
          name="Conversaciones"
          description="Chats de WhatsApp del agente 2brain y sus acciones."
          status={hubChip ? <Chip tone={hubChip.tone}>{hubChip.label}</Chip> : null}
          action={<ExternalAction href={`${BRAIN_URL}/conversaciones`} />}
        />
        <ModuleCard
          icon={Mic}
          name="Notas de voz"
          description="Notas transcritas y sincronizadas a Notion."
          status={hubChip ? <Chip tone={hubChip.tone}>{hubChip.label}</Chip> : null}
          action={<ExternalAction href={`${BRAIN_URL}/notas`} />}
        />
        <ModuleCard
          icon={AudioLines}
          name="Grabadora"
          description="Graba una nota de voz desde el móvil."
          status={hubChip ? <Chip tone={hubChip.tone}>{hubChip.label}</Chip> : null}
          action={<ExternalAction href={`${BRAIN_URL}/recorder`} />}
        />
        <ModuleCard
          icon={Clapperboard}
          name="Videos"
          description="Transcripción de videos por URL."
          status={hubChip ? <Chip tone={hubChip.tone}>{hubChip.label}</Chip> : null}
          action={<ExternalAction href={`${BRAIN_URL}/video-ingest`} />}
        />
        <ModuleCard
          icon={Waypoints}
          name="Grafo"
          description="Contactos, empresas, reuniones y temas conectados."
          status={hubChip ? <Chip tone={hubChip.tone}>{hubChip.label}</Chip> : null}
          action={<ExternalAction href={`${BRAIN_URL}/grafo`} />}
        />
        <ModuleCard
          icon={Bot}
          name="Agente 2brain"
          description="Estado, prompt y herramientas del agente conversacional."
          status={hubChip ? <Chip tone={hubChip.tone}>{hubChip.label}</Chip> : null}
          action={<ExternalAction href={`${BRAIN_URL}/agente`} />}
        />
        <ModuleCard
          icon={BookOpen}
          name="Wiki"
          description="Páginas curadas del conocimiento de Sixteam."
          status={overview ? <p className="text-small text-muted">{wikiPagesLabel(overview.sources)}</p> : null}
        />
        <ModuleCard
          icon={Database}
          name="Notion"
          description="Snapshot de tareas y proyectos de la migración."
          status={notionChip ? <Chip tone={notionChip.tone}>{notionChip.label}</Chip> : null}
        />
      </div>
    </div>
  );
}
