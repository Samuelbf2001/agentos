/**
 * Leyenda + filtros por tipo: un color por tipo de nodo (excepción documentada
 * en `palette.ts`), casilla para ocultar/mostrar y el conteo que ya trae
 * `stats.byType`.
 */
import type { GraphNodeType } from "../../../lib/brain/grafo";
import { NODE_TYPE_ORDER, NODE_TYPE_STYLES } from "./palette";

export interface LegendProps {
  counts: Record<string, number>;
  hidden: Set<GraphNodeType>;
  onToggle: (type: GraphNodeType) => void;
}

export function Legend({ counts, hidden, onToggle }: LegendProps) {
  return (
    <div className="flex flex-wrap items-center gap-3" role="group" aria-label="Filtrar por tipo de nodo">
      {NODE_TYPE_ORDER.map((type) => {
        const style = NODE_TYPE_STYLES[type];
        const active = !hidden.has(type);
        const count = counts[type] ?? 0;
        return (
          <label key={type} className="flex cursor-pointer items-center gap-1.5 text-small select-none">
            <input
              type="checkbox"
              checked={active}
              onChange={() => onToggle(type)}
              aria-label={`Mostrar ${style.label}`}
              style={{ accentColor: style.color }}
            />
            <span aria-hidden="true" className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: style.color }} />
            <span className={active ? "text-ink-2" : "text-faint"}>{style.label}</span>
            <span className="text-faint">({count})</span>
          </label>
        );
      })}
    </div>
  );
}

export default Legend;
