/**
 * Rectángulo de fondo de un área: se pinta detrás de los roles que contiene
 * (caja envolvente calculada por OrgChartView a partir de las posiciones
 * absolutas de sus roles). Nunca es interactivo — draggable/selectable/
 * connectable en false y `pointerEvents: none` en el nodo — así que un clic
 * o un arrastre siempre atraviesa hasta el rol.
 */
import type { Node, NodeProps } from "@xyflow/react";

export interface AreaNodeData extends Record<string, unknown> {
  unitId: string;
  name: string;
  roleCount: number;
  /** Token de fondo translúcido, p. ej. "bg-link/10". */
  bgClass: string;
  /** Token de texto a juego con el tono del área, p. ej. "text-link". */
  textClass: string;
  /** true si la leyenda resalta otra área y esta debe apagarse. */
  dimmed: boolean;
}

export function AreaNode({ data }: NodeProps<Node<AreaNodeData>>) {
  const { unitId, name, roleCount, bgClass, textClass, dimmed } = data;
  return (
    <div
      data-testid={`area-node-${unitId}`}
      className={`relative h-full w-full rounded-panel transition-opacity ${bgClass} ${dimmed ? "opacity-40" : ""}`}
    >
      <div className="absolute left-3 top-2 flex flex-col gap-0.5">
        <span className={`text-label font-semibold ${textClass}`}>{name}</span>
        <span className={`text-label font-semibold ${textClass}`}>{roleCount} roles</span>
      </div>
    </div>
  );
}
