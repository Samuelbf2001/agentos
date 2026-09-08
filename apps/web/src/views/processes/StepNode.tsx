/**
 * Tarjeta de un paso del proceso en el flujograma: número de orden, texto y
 * un resumen de responsable/sistema para no depender de abrir el panel.
 */
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { Chip } from "../../components/system";

export interface StepNodeData extends Record<string, unknown> {
  index: number;
  text: string;
  responsible: string | null;
  system: string | null;
}

export function StepNode({ data, selected }: NodeProps<Node<StepNodeData>>) {
  const { index, text, responsible, system } = data;
  return (
    <div
      data-testid={`step-node-${index}`}
      className={`w-[240px] rounded-soft bg-surface p-3 shadow-raise ${selected ? "ring-2 ring-link" : ""}`}
    >
      <Handle type="target" position={Position.Left} className="!bg-line" />
      <p className="text-label text-faint">Paso {index + 1}</p>
      <p className="mt-1 text-body text-ink">{text || "(sin texto)"}</p>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Chip tone="quiet">{responsible ?? "Sin responsable"}</Chip>
        {system ? <Chip tone="link">{system}</Chip> : null}
      </div>
      <Handle type="source" position={Position.Right} className="!bg-line" />
    </div>
  );
}
