/**
 * Carga el grafo del organigrama y expone mutaciones optimistas (se pintan
 * antes de confirmar; si la API rechaza, se revierte y se avisa con un
 * toast — mismo patrón que moveTaskOptimistic en el store).
 */
import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../../lib/api";
import type { OrgGraph, OrgRoleFull } from "../../lib/types";
import { useStore } from "../../state/store";

export interface UpdateOrgRoleInput {
  name?: string;
  unit_id?: string | null;
  purpose?: string | null;
  reports_to_role_id?: string | null;
  canvas_x?: number;
  canvas_y?: number;
  status?: "draft" | "validated";
  expected_version?: number;
}

function errMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

/** Aplica un PATCH parcial (snake_case del wire) sobre un rol en memoria. */
function applyRoleBody(role: OrgRoleFull, body: UpdateOrgRoleInput): OrgRoleFull {
  return {
    ...role,
    ...(body.name !== undefined ? { name: body.name } : {}),
    ...(body.unit_id !== undefined ? { unitId: body.unit_id } : {}),
    ...(body.purpose !== undefined ? { purpose: body.purpose } : {}),
    ...(body.reports_to_role_id !== undefined ? { reportsToRoleId: body.reports_to_role_id } : {}),
    ...(body.canvas_x !== undefined ? { canvasX: body.canvas_x } : {}),
    ...(body.canvas_y !== undefined ? { canvasY: body.canvas_y } : {}),
    ...(body.status !== undefined ? { status: body.status } : {}),
  };
}

export interface UseOrgGraphResult {
  graph: OrgGraph | null;
  loading: boolean;
  error: string | null;
  reload(): Promise<void>;
  createUnit(name: string): Promise<void>;
  createRole(input: { name: string; canvasX?: number; canvasY?: number }): Promise<OrgRoleFull | null>;
  updateRole(id: string, body: UpdateOrgRoleInput): Promise<boolean>;
  deleteRole(id: string): Promise<void>;
  setFunctions(id: string, functions: { id?: string; name: string; description?: string | null }[]): Promise<void>;
  setPeople(id: string, people: { person_id: string; dedication_pct?: number | null }[]): Promise<void>;
  setProcesses(id: string, processes: { process_id: string; relation: "owner" | "participant" }[]): Promise<void>;
}

export function useOrgGraph(orgId: string): UseOrgGraphResult {
  const [graph, setGraph] = useState<OrgGraph | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const pushToast = useStore((s) => s.pushToast);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.orgGraph(orgId);
      setGraph(data);
    } catch (err) {
      setError(errMessage(err, "No se pudo cargar el organigrama"));
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    setGraph(null);
    void load();
  }, [load]);

  /**
   * `PATCH /api/roles/:id` devuelve la fila del rol sin sus listas anidadas:
   * se conservan las que ya teníamos para no perder funciones, personas y
   * procesos al renombrar o mover un rol.
   */
  function mergeRole(role: Partial<OrgRoleFull> & { id: string }) {
    setGraph((g) =>
      g
        ? {
            ...g,
            roles: g.roles.map((r) =>
              r.id === role.id
                ? {
                    ...r,
                    ...role,
                    functions: role.functions ?? r.functions,
                    people: role.people ?? r.people,
                    processes: role.processes ?? r.processes,
                  }
                : r,
            ),
          }
        : g,
    );
  }

  return {
    graph,
    loading,
    error,
    reload: load,

    async createUnit(name) {
      try {
        const { unit } = await api.createOrgUnit(orgId, { name });
        setGraph((g) => (g ? { ...g, units: [...g.units, unit] } : g));
      } catch (err) {
        pushToast("error", errMessage(err, "No se pudo crear el área"));
      }
    },

    async createRole({ name, canvasX, canvasY }) {
      try {
        const { role } = await api.createOrgRole(orgId, {
          name,
          ...(canvasX !== undefined ? { canvas_x: canvasX } : {}),
          ...(canvasY !== undefined ? { canvas_y: canvasY } : {}),
        });
        setGraph((g) => (g ? { ...g, roles: [...g.roles, role] } : g));
        return role;
      } catch (err) {
        pushToast("error", errMessage(err, "No se pudo crear el rol"));
        return null;
      }
    },

    async updateRole(id, body) {
      const current = graph?.roles.find((r) => r.id === id) ?? null;
      if (current) mergeRole(applyRoleBody(current, body));
      try {
        const { role } = await api.updateOrgRole(id, body);
        mergeRole(role);
        return true;
      } catch (err) {
        if (current) mergeRole(current);
        if (err instanceof ApiError && err.status === 400 && body.reports_to_role_id !== undefined) {
          pushToast("error", "Ese reporte crearía un ciclo");
        } else {
          pushToast("error", errMessage(err, "No se pudo actualizar el rol"));
        }
        return false;
      }
    },

    async deleteRole(id) {
      const previous = graph;
      setGraph((g) => (g ? { ...g, roles: g.roles.filter((r) => r.id !== id) } : g));
      try {
        await api.deleteOrgRole(id);
      } catch (err) {
        setGraph(previous ?? null);
        pushToast("error", errMessage(err, "No se pudo eliminar el rol"));
      }
    },

    async setFunctions(id, functions) {
      try {
        const { functions: saved } = await api.replaceRoleFunctions(id, functions);
        setGraph((g) => (g ? { ...g, roles: g.roles.map((r) => (r.id === id ? { ...r, functions: saved } : r)) } : g));
      } catch (err) {
        pushToast("error", errMessage(err, "No se pudieron guardar las funciones"));
      }
    },

    async setPeople(id, people) {
      try {
        const { people: saved } = await api.replaceRolePeople(id, people);
        setGraph((g) => (g ? { ...g, roles: g.roles.map((r) => (r.id === id ? { ...r, people: saved } : r)) } : g));
      } catch (err) {
        pushToast("error", errMessage(err, "No se pudo actualizar la asignación de personas"));
      }
    },

    async setProcesses(id, processes) {
      try {
        const { processes: saved } = await api.replaceRoleProcesses(id, processes);
        setGraph((g) =>
          g ? { ...g, roles: g.roles.map((r) => (r.id === id ? { ...r, processes: saved } : r)) } : g,
        );
      } catch (err) {
        pushToast("error", errMessage(err, "No se pudieron actualizar los procesos del rol"));
      }
    },
  };
}
