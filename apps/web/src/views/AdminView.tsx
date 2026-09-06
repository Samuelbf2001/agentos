/**
 * Admin mínimo (spec B5 §9): config (semáforos/kill switch). Los agentes
 * viven en Sistema › Equipo (AgentsSection); esta vista es solo Config.
 */
import { useEffect, useState } from "react";
import { api, ApiError } from "../lib/api";
import type { AppConfigRow } from "../lib/types";
import { useStore } from "../state/store";
import { ErrorBox, fmtDate, Spinner } from "../components/ui";

function ConfigTab() {
  const killSwitch = useStore((s) => s.killSwitch);
  const [rows, setRows] = useState<AppConfigRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setError(null);
    try {
      const res = await api.config();
      setRows(res.config);
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : "Error cargando config");
    }
  }
  useEffect(() => {
    void load();
  }, []);

  return (
    <div className="space-y-3">
      <p className="text-small text-muted">
        {killSwitch
          ? "Agentes pausados: no arrancan runs nuevos y los activos se cancelan en menos de 10 segundos. Se reanudan desde el botón de la cabecera."
          : "Agentes activos. Se pausan desde el botón de la cabecera."}
      </p>

      <div className="rounded-soft border border-line bg-surface p-4">
        <p className="text-small font-bold uppercase text-faint">
          app_config (semáforos y presupuestos)
        </p>
        {error ? <ErrorBox message={error} onRetry={() => void load()} /> : null}
        {rows === null && !error ? <Spinner label="Cargando…" /> : null}
        {rows && rows.length === 0 ? <p className="mt-2 text-small text-faint">(vacío)</p> : null}
        {rows && rows.length > 0 ? (
          <table className="mt-2 w-full text-left text-small">
            <thead className="text-label uppercase text-faint">
              <tr>
                <th className="py-1 pr-4">Clave</th>
                <th className="py-1 pr-4">Valor</th>
                <th className="py-1">Actualizado</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line-soft">
              {rows.map((r) => (
                <tr key={r.key}>
                  <td className="py-1.5 pr-4 font-mono">{r.key}</td>
                  <td className="py-1.5 pr-4 font-mono text-muted">{JSON.stringify(r.value)}</td>
                  <td className="py-1.5 text-faint">{fmtDate(r.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
        <p className="mt-3 text-label text-faint">
          Edición de presupuestos y semáforos: MCP admin (mutaciones con idempotency_key +
          expected_version + reason, todo auditado).
        </p>
      </div>
    </div>
  );
}

export default function AdminView() {
  return (
    <div className="p-4">
      <ConfigTab />
    </div>
  );
}
