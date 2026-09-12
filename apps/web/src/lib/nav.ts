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
  Network,
  PenLine,
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

/**
 * Los seis módulos de 2brain (Conversaciones, Notas de voz, Grabadora, Videos,
 * Grafo, Agente 2brain) ya son rutas internas de AgentOS. `BRAIN_URL` solo
 * queda para los enlaces de cortesía "Abrir en 2brain" (p. ej. en Reuniones),
 * que apuntan al hub original mientras conviene conservarlos.
 */
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
          id: "notas-lienzo",
          label: "Notas a mano",
          to: paths.notas(),
          icon: PenLine,
          cap: "nav:2brain",
          match: (p) => p.startsWith("/notas"),
        },
        {
          id: "conversaciones",
          label: "Conversaciones",
          to: paths.brainConversaciones(),
          icon: MessageSquare,
          cap: "nav:2brain",
        },
        {
          id: "notas",
          label: "Notas de voz",
          to: paths.brainNotasVoz(),
          icon: Mic,
          cap: "nav:2brain",
          match: (p) => p.startsWith("/2brain/notas-voz"),
        },
        {
          id: "grabadora",
          label: "Grabadora",
          to: paths.brainGrabadora(),
          icon: AudioLines,
          cap: "nav:2brain",
        },
        {
          id: "videos",
          label: "Videos",
          to: paths.brainVideos(),
          icon: Clapperboard,
          cap: "nav:2brain",
          match: (p) => p.startsWith("/2brain/videos"),
        },
        {
          id: "grafo",
          label: "Grafo",
          to: paths.brainGrafo(),
          icon: Waypoints,
          cap: "nav:2brain",
        },
        {
          id: "agente",
          label: "Agente 2brain",
          to: paths.brainAgente(),
          icon: Bot,
          cap: "nav:2brain",
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
          id: "organigrama",
          label: "Organigrama",
          to: paths.proyecto(projectId, "organigrama"),
          icon: Network,
          cap: "proyecto:organigrama",
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
 * (`/proyectos/<id>/...`) es "cliente"; `/hoy?proyecto=<id>` (Decisiones de un
 * cliente concreto) también lo es, para no perder la perspectiva al navegar
 * ahí desde el lateral de cliente; `/proyectos` a secas y `/nuevo-proyecto`
 * (y todo lo demás) son "agencia".
 */
export function perspectiveFor(pathname: string, search = ""): Perspective {
  const match = /^\/proyectos\/([^/]+)\/.+/.exec(pathname);
  if (match?.[1]) return { kind: "client", projectId: match[1] };
  if (pathname.startsWith("/hoy")) {
    const projectId = new URLSearchParams(search).get("proyecto");
    if (projectId) return { kind: "client", projectId };
  }
  return { kind: "agency" };
}
