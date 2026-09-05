/**
 * Inventario unificado que servía al "Cerebro". La vista desapareció; el dato
 * sigue: Sistema › Salud pinta contadores y fuentes, Sistema › Equipo pinta
 * personas y agentes, y Activo Sixteam pinta los módulos.
 */
import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../lib/api";
import type { BrainOverview } from "../lib/types";

export function useBrainOverview(): {
  overview: BrainOverview | null;
  error: string | null;
  reload: () => void;
} {
  const [overview, setOverview] = useState<BrainOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    let cancelled = false;
    setError(null);
    (async () => {
      try {
        const data = await api.brainOverview();
        if (!cancelled) setOverview(data);
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof ApiError ? err.message : "No se pudo leer el inventario del sistema",
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => reload(), [reload]);

  return { overview, error, reload };
}
