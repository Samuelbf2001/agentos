/**
 * Carril de fondo por responsable en el flujograma de un proceso: mismo
 * patrón que las áreas del organigrama — un rectángulo no interactivo (nunca
 * captura clics ni arrastres) con la etiqueta del responsable arriba a la
 * izquierda.
 */
import type { Node, NodeProps } from "@xyflow/react";

export interface LaneNodeData extends Record<string, unknown> {
  laneIndex: number;
  label: string;
}

export function LaneNode({ data }: NodeProps<Node<LaneNodeData>>) {
  return (
    <div data-testid={`lane-node-${data.laneIndex}`} className="relative h-full w-full rounded-panel bg-canvas-deep/60">
      <span className="absolute left-3 top-2 text-label font-semibold text-muted">{data.label}</span>
    </div>
  );
}
