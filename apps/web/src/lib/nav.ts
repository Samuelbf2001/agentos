/**
 * Navegación del shell (menú lateral GoHighLevel/HubSpot). Única fuente de
 * verdad para agencia y cliente: `Sidebar` sólo pinta lo que aquí se declara,
 * filtrado por capacidad. Nada de rutas ni iconos sueltos en otros ficheros.
 */
import {
  Activity,
  AudioLines,
  Bot,
  BookOpen,
  Brain,
  Building2,
  Clapperboard,
  FileText,
  FolderOpen,
  History,
  Kanban,
  ListChecks,
  Map,
  MessageSquare,
  MessagesSquare,
  Mic,
  Plug,
  Settings,
  ShieldCheck,
  Sun,
  Users,
  Video,
  Waypoints,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import type { Capability } from "./capabilities";
import { paths } from "./paths";

export interface NavItem {
  id: string;
  label: string;
  to: string;
  icon: LucideIcon;
  badge?: "decisions" | "failed";
  external?: boolean;
  cap?: Capability;
  match?: (pathname: string) => boolean;
  children?: NavItem[];
}

export interface NavGroup {
  id: string;
  label?: string;
  items: NavItem[];
}

/** El "2brain" de Sixteam vive hoy en WhatsAppHub, fuera de AgentOS. */
export const BRAIN_URL =
  import.meta.env.VITE_AGENTOS_2BRAIN_URL ?? "https://whatsfull.sixteam.pro";

export function agencyNav(): NavGroup[] {
  return [
    {
      id: "principal",
      items: [
        {
          id: "hoy",
          label: "Hoy",
          to: paths.hoy(),
          icon: Sun,
          badge: "decisions",
          cap: "nav:hoy",
          match: (p) => p === "/" || p.startsWith("/hoy"),
        },
        {
          id: "tareas",
          label: "Tareas",
          to: paths.tareas(),
          icon: ListChecks,
          cap: "nav:tareas",
        },
        {
          id: "clientes",
          label: "Clientes",
          to: paths.proyectos(),
          icon: Building2,
          cap: "nav:proyectos",
          match: (p) => p.startsWith("/proyectos") || p.startsWith("/nuevo-proyecto"),
        },
      ],
    },
    {
      id: "2brain",
      label: "2brain",
      items: [
        {
          id: "panorama",
          label: "Panorama",
          to: paths.brain(),
          icon: Brain,
          cap: "nav:2brain",
          match: (p) => p === "/2brain" || p === "/2brain/",
        },
        {
          id: "reuniones",
          label: "Reuniones",
          to: paths.brainReuniones(),
          icon: Video,
          cap: "nav:2brain",
        },
        {
          id: "conversaciones",
          label: "Conversaciones",
          to: `${BRAIN_URL}/conversaciones`,
          icon: MessageSquare,
          external: true,
        },
        {
          id: "notas",
          label: "Notas de voz",
          to: `${BRAIN_URL}/notas`,
          icon: Mic,
          external: true,
        },
        {
          id: "grabadora",
          label: "Grabadora",
          to: `${BRAIN_URL}/recorder`,
          icon: AudioLines,
          external: true,
        },
        {
          id: "videos",
          label: "Videos",
          to: `${BRAIN_URL}/video-ingest`,
          icon: Clapperboard,
          external: true,
        },
        {
          id: "grafo",
          label: "Grafo",
          to: `${BRAIN_URL}/grafo`,
          icon: Waypoints,
          external: true,
        },
        {
          id: "agente",
          label: "Agente 2brain",
          to: `${BRAIN_URL}/agente`,
          icon: Bot,
          external: true,
        },
      ],
    },
    {
      id: "agencia",
      label: "Agencia",
      items: [
        { id: "metodo", label: "Método", to: paths.activo(), icon: BookOpen, cap: "nav:activo" },
        { id: "equipo", label: "Equipo", to: paths.sistema("equipo"), icon: Users, cap: "sistema:equipo" },
      ],
    },
    {
      id: "sistema",
      label: "Sistema",
      items: [
        {
          id: "ahora",
          label: "Ahora mismo",
          to: paths.sistema("ahora"),
          icon: Activity,
          cap: "sistema:ahora",
        },
        {
          id: "actividad-sistema",
          label: "Actividad",
          to: paths.sistema("actividad"),
          icon: History,
          cap: "sistema:actividad",
          badge: "failed",
        },
        {
          id: "fuentes",
          label: "Fuentes",
          to: paths.sistema("fuentes"),
          icon: Plug,
          cap: "sistema:fuentes",
        },
        {
          id: "configuracion",
          label: "Configuración",
          to: paths.sistema("configuracion"),
          icon: Settings,
          cap: "sistema:configuracion",
        },
      ],
    },
  ];
}

export function clientNav(projectId: string): NavGroup[] {
  return [
    {
      id: "proyecto",
      items: [
        {
          id: "ruta",
          label: "Resumen",
          to: paths.proyecto(projectId, "ruta"),
          icon: Map,
          cap: "proyecto:ruta",
        },
        {
          id: "tablero",
          label: "Tablero",
          to: paths.proyecto(projectId, "tablero"),
          icon: Kanban,
          cap: "proyecto:tablero",
        },
        {
          id: "contexto",
          label: "Contexto",
          to: paths.contexto(projectId),
          icon: FolderOpen,
          cap: "proyecto:contexto",
          match: (p) => p.startsWith(`/proyectos/${projectId}/contexto`),
          children: [
            {
              id: "documentos",
              label: "Documentos",
              to: paths.contexto(projectId, "documentos"),
              icon: FileText,
            },
            {
              id: "procesos",
              label: "Procesos",
              to: paths.contexto(projectId, "procesos"),
              icon: Workflow,
            },
          ],
        },
        {
          id: "conversacion",
          label: "Conversación",
          to: paths.proyecto(projectId, "conversacion"),
          icon: MessagesSquare,
          cap: "proyecto:conversacion",
        },
        {
          id: "actividad-proyecto",
          label: "Actividad",
          to: paths.proyecto(projectId, "actividad"),
          icon: History,
          cap: "proyecto:actividad",
        },
        {
          id: "decisiones",
          label: "Decisiones",
          to: paths.hoy(projectId),
          icon: ShieldCheck,
          cap: "nav:hoy",
        },
      ],
    },
  ];
}

export type Perspective = { kind: "agency" } | { kind: "client"; projectId: string };

/**
 * Perspectiva actual según la URL: dentro de un proyecto
 * (`/proyectos/<id>/...`) es "cliente"; `/proyectos` a secas y
 * `/nuevo-proyecto` (y todo lo demás) son "agencia".
 */
export function perspectiveFor(pathname: string): Perspective {
  const match = /^\/proyectos\/([^/]+)\/.+/.exec(pathname);
  if (match?.[1]) return { kind: "client", projectId: match[1] };
  return { kind: "agency" };
}
