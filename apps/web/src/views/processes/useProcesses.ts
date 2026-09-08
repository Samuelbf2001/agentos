/**
 * Carga los procesos del cliente y expone mutaciones optimistas (mismo
 * patrón que useOrgGraph): se pintan antes de confirmar; si la API rechaza,
 * se revierte y se avisa con un toast.
 */
import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../../lib/api";
import type { ProcessEntity, ProcessStep } from "../../lib/types";
import { useStore } from "../../state/store";

export interface UpdateProcessInput {
  name?: string;
  variant?: "as_is" | "to_be";
  owner_person?: string | null;
  steps?: ProcessStep[];
  systems?: string[];
  pain_points?: string[];
  iso_refs?: string[];
  status?: "draft" | "validated";
}

function errMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

/** Aplica un PATCH parcial (snake_case del wire) sobre un proceso en memoria. */
function applyProcessBody(process: ProcessEntity, body: UpdateProcessInput): ProcessEntity {
  return {
    ...process,
    ...(body.name !== undefined ? { name: body.name } : {}),
    ...(body.variant !== undefined ? { variant: body.variant } : {}),
    ...(body.owner_person !== undefined ? { ownerPerson: body.owner_person } : {}),
    ...(body.steps !== undefined ? { steps: body.steps } : {}),
    ...(body.systems !== undefined ? { systems: body.systems } : {}),
    ...(body.pain_points !== undefined ? { painPoints: body.pain_points } : {}),
    ...(body.iso_refs !== undefined ? { isoRefs: body.iso_refs } : {}),
    ...(body.status !== undefined ? { status: body.status } : {}),
  };
}

export interface UseProcessesResult {
  processes: ProcessEntity[] | null;
  loading: boolean;
  error: string | null;
  reload(): Promise<void>;
  createProcess(): Promise<ProcessEntity | null>;
  updateProcess(id: string, body: UpdateProcessInput): Promise<boolean>;
  deleteProcess(id: string): Promise<void>;
}

export function useProcesses(orgId: string): UseProcessesResult {
  const [processes, setProcesses] = useState<ProcessEntity[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const pushToast = useStore((s) => s.pushToast);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { processes: fetched } = await api.processes(orgId);
      setProcesses(fetched);
    } catch (err) {
      setError(errMessage(err, "No se pudieron cargar los procesos"));
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    setProcesses(null);
    void load();
  }, [load]);

  return {
    processes,
    loading,
    error,
    reload: load,

    async createProcess() {
      try {
        const { process } = await api.createProcess(orgId, {
          name: "Nuevo proceso",
          steps: [{ step: "" }],
        });
        setProcesses((ps) => (ps ? [...ps, process] : [process]));
        return process;
      } catch (err) {
        pushToast("error", errMessage(err, "No se pudo crear el proceso"));
        return null;
      }
    },

    async updateProcess(id, body) {
      const current = processes?.find((p) => p.id === id) ?? null;
      if (current) {
        const optimistic = applyProcessBody(current, body);
        setProcesses((ps) => (ps ? ps.map((p) => (p.id === id ? optimistic : p)) : ps));
      }
      try {
        const { process } = await api.updateProcess(id, body);
        setProcesses((ps) => (ps ? ps.map((p) => (p.id === id ? process : p)) : ps));
        return true;
      } catch (err) {
        if (current) setProcesses((ps) => (ps ? ps.map((p) => (p.id === id ? current : p)) : ps));
        pushToast("error", errMessage(err, "No se pudo actualizar el proceso"));
        return false;
      }
    },

    async deleteProcess(id) {
      const previous = processes;
      setProcesses((ps) => (ps ? ps.filter((p) => p.id !== id) : ps));
      try {
        await api.deleteProcess(id);
      } catch (err) {
        setProcesses(previous ?? null);
        pushToast("error", errMessage(err, "No se pudo eliminar el proceso"));
      }
    },
  };
}
