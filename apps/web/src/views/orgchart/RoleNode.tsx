/**
 * Tarjeta de un rol en el canvas. El rol es el centro del grafo: área,
 * personas que lo ocupan y un resumen de cuánto contenido tiene (funciones y
 * procesos), para no tener que abrir el panel solo para saber si hay algo.
 */
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { Chip } from "../../components/system";
import { PersonAvatar } from "../../components/ui";
import type { OrgRoleFull } from "../../lib/types";

export interface RoleNodePerson {
  id: string;
  fullName: string;
}

export interface RoleNodeData extends Record<string, unknown> {
  role: OrgRoleFull;
  areaName: string | null;
  areaColor: string;
  people: RoleNodePerson[];
  /** true si la leyenda tiene otra área resaltada y este rol no pertenece a ella. */
  dimmed: boolean;
}

function shortName(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return parts[0] ?? fullName;
  const last = parts[parts.length - 1] ?? "";
  return `${parts[0]} ${last[0] ?? ""}.`;
}

export function RoleNode({ data, selected }: NodeProps<Node<RoleNodeData>>) {
  const { role, areaName, areaColor, people, dimmed } = data;
  return (
    <div
      data-testid={`role-node-${role.id}`}
      className={`w-[220px] rounded-soft bg-surface p-3 shadow-raise transition-opacity ${
        selected ? "ring-2 ring-link" : ""
      } ${dimmed ? "opacity-40" : ""}`}
    >
      <Handle type="target" position={Position.Top} className="!bg-line" />
      <div className="flex items-center gap-1.5">
        <span className={`h-2 w-2 shrink-0 rounded-full ${areaColor}`} aria-hidden="true" />
        <span className="truncate text-label text-muted">{areaName ?? "Sin área"}</span>
      </div>
      <p className="mt-1 truncate text-body font-semibold text-ink">{role.name}</p>
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
        {people.length > 0 ? (
          people.slice(0, 3).map((p) => (
            <span key={p.id} className="inline-flex items-center gap-1">
              <PersonAvatar name={p.fullName} size={5} />
              <span className="text-label text-muted">{shortName(p.fullName)}</span>
            </span>
          ))
        ) : (
          <Chip tone="work">Vacante</Chip>
        )}
      </div>
      <p className="mt-2 text-label text-faint">
        {role.functions.length} funciones · {role.processes.length} procesos
      </p>
      <Handle type="source" position={Position.Bottom} className="!bg-line" />
    </div>
  );
}
