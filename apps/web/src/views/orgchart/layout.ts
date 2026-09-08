/**
 * Layout por niveles para cuando un rol todavía no tiene canvas_x/y: las
 * raíces (sin reportsToRoleId, o cuyo jefe no está en la lista) quedan
 * arriba, los hijos centrados bajo su padre. Nunca se persiste solo — el
 * usuario tiene que mover el nodo para que la posición se guarde.
 */
import type { OrgRoleFull } from "../../lib/types";

export const COLUMN_GAP = 260;
export const LEVEL_GAP = 170;

export interface RolePosition {
  x: number;
  y: number;
}

export function layoutRoles(roles: OrgRoleFull[]): Map<string, RolePosition> {
  const byId = new Map(roles.map((r) => [r.id, r]));
  const childrenOf = new Map<string, string[]>();
  const roots: string[] = [];

  for (const role of roles) {
    const parentId = role.reportsToRoleId && byId.has(role.reportsToRoleId) ? role.reportsToRoleId : null;
    if (parentId) {
      const list = childrenOf.get(parentId) ?? [];
      list.push(role.id);
      childrenOf.set(parentId, list);
    } else {
      roots.push(role.id);
    }
  }

  const positions = new Map<string, RolePosition>();
  const visiting = new Set<string>();
  let nextColumn = 0;

  // Post-order: cada hoja reclama la siguiente columna libre; el padre queda
  // centrado sobre el rango de columnas de sus hijos.
  function place(id: string, depth: number): number {
    if (visiting.has(id)) {
      // Dato corrupto con ciclo (no debería pasar: la API lo rechaza): se
      // corta aquí para no recursar infinito y se pinta como hoja.
      const column = nextColumn++;
      positions.set(id, { x: column * COLUMN_GAP, y: depth * LEVEL_GAP });
      return column;
    }
    visiting.add(id);
    const children = childrenOf.get(id) ?? [];
    let column: number;
    if (children.length === 0) {
      column = nextColumn++;
    } else {
      const childColumns = children.map((childId) => place(childId, depth + 1));
      column = (Math.min(...childColumns) + Math.max(...childColumns)) / 2;
    }
    positions.set(id, { x: column * COLUMN_GAP, y: depth * LEVEL_GAP });
    visiting.delete(id);
    return column;
  }

  for (const rootId of roots) place(rootId, 0);

  // Cualquier rol no alcanzado (todos con jefe pero formando un ciclo cerrado
  // entre sí, sin raíz) se pinta igual, en columnas nuevas al final.
  for (const role of roles) {
    if (!positions.has(role.id)) {
      const column = nextColumn++;
      positions.set(role.id, { x: column * COLUMN_GAP, y: 0 });
    }
  }

  return positions;
}
