/**
 * Panel lateral del nodo seleccionado: tipo, grado, los mismos metadatos que
 * enseñaba `grafo.jsx` (por tipo) y el enlace a la sección real de AgentOS
 * cuando existe una.
 */
import { Link } from "react-router-dom";
import { paths } from "../../../lib/paths";
import { EmptyState } from "../../../components/ui";
import type { GraphNode } from "../../../lib/brain/grafo";
import { styleForType } from "./palette";

export interface NodePanelProps {
  node: GraphNode | null;
  degree: number;
  onClose: () => void;
  onFocus: () => void;
}

function readableDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("es-CO", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function metaLines(node: GraphNode): string[] {
  const m = node.meta;
  const lines: Array<string | null> = (() => {
    switch (node.type) {
      case "contacto":
        return [
          m.phone ? `Teléfono: ${m.phone}` : null,
          m.email ? `Email: ${m.email}` : null,
          m.leadStatus ? `Estado: ${m.leadStatus}` : null,
          m.msgInCount != null ? `Mensajes entrantes: ${m.msgInCount}` : null,
          m.lastMessageAt ? `Último mensaje: ${readableDate(m.lastMessageAt) ?? m.lastMessageAt}` : null,
        ];
      case "empresa":
        return [m.domain ? `Dominio: ${m.domain}` : null, m.industry ? `Industria: ${m.industry}` : null];
      case "equipo":
        return [m.email ? `Email: ${m.email}` : null, m.role ? `Rol: ${m.role}` : null];
      case "reunion":
        return [
          m.source ? `Fuente: ${m.source}` : null,
          m.meetingDate ? `Fecha: ${readableDate(m.meetingDate) ?? m.meetingDate}` : null,
          m.participantsCount != null ? `Participantes: ${m.participantsCount}` : null,
          m.isInternal ? "Interna" : null,
        ];
      case "nota":
        return [
          m.kind ? `Tipo: ${m.kind}` : null,
          m.tags && m.tags.length ? `Tags: ${m.tags.join(", ")}` : null,
          m.createdAt ? `Creada: ${readableDate(m.createdAt) ?? m.createdAt}` : null,
        ];
      case "nota_voz":
        return [
          m.category ? `Categoría: ${m.category}` : null,
          m.createdBy ? `Autor: ${m.createdBy}` : null,
          m.createdAt ? `Creada: ${readableDate(m.createdAt) ?? m.createdAt}` : null,
        ];
      case "pagina":
        return [m.pageType ? `Tipo: ${m.pageType}` : null, m.tags && m.tags.length ? `Tags: ${m.tags.join(", ")}` : null];
      default:
        return [];
    }
  })();
  return lines.filter((line): line is string => Boolean(line));
}

/** Enlace a la sección real de AgentOS, si el tipo de nodo tiene una. */
function sectionLink(node: GraphNode): { to: string; label: string } | null {
  switch (node.type) {
    case "contacto": {
      const tel = node.meta.phone;
      return { to: tel ? `${paths.brainConversaciones()}?tel=${encodeURIComponent(tel)}` : paths.brainConversaciones(), label: "Ver en Conversaciones" };
    }
    case "reunion":
      return { to: paths.brainReuniones(), label: "Ver en Reuniones" };
    case "nota":
    case "nota_voz": {
      const rawId = node.refId != null ? String(node.refId) : node.id.split(":").slice(1).join(":");
      return { to: paths.brainNotasVoz(rawId || undefined), label: "Ver en Notas de voz" };
    }
    default:
      return null;
  }
}

export function NodePanel({ node, degree, onClose, onFocus }: NodePanelProps) {
  if (!node) {
    return <EmptyState title="Sin nodo seleccionado" hint="Elige un nodo del lienzo para ver su detalle." />;
  }

  const style = styleForType(node.type);
  const link = sectionLink(node);
  const lines = metaLines(node);

  return (
    <div className="flex flex-col gap-3" data-testid="grafo-panel-nodo">
      <div className="flex items-start justify-between gap-2">
        <h2 className="min-w-0 break-words text-title font-semibold text-ink">{node.label}</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Cerrar panel del nodo"
          className="press shrink-0 text-muted hover:text-ink"
        >
          ✕
        </button>
      </div>

      <span
        className="inline-flex w-fit items-center rounded-full px-2 py-0.5 text-label font-semibold uppercase tracking-wide"
        style={{ color: style.color, background: `${style.color}1a` }}
      >
        {style.label}
      </span>

      <p className="text-small text-muted">{degree === 1 ? "1 conexión" : `${degree} conexiones`}</p>

      {lines.length > 0 ? (
        <ul className="flex flex-col gap-1 text-small text-ink-2">
          {lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}

      <div className="flex flex-col gap-2 border-t border-line pt-3">
        {link ? (
          <Link
            to={link.to}
            className="press inline-flex min-h-9 items-center justify-center rounded-tight bg-link-bg px-3 text-small font-semibold text-link hover:brightness-95"
          >
            {link.label} →
          </Link>
        ) : null}
        <button
          type="button"
          onClick={onFocus}
          className="press inline-flex min-h-9 items-center justify-center rounded-tight border border-line px-3 text-small font-semibold text-ink-2 hover:bg-surface-2"
        >
          Enfocar aquí
        </button>
      </div>
    </div>
  );
}

export default NodePanel;
