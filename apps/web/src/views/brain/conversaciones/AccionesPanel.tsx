/**
 * Pestaña "Acciones": tabla del registro de acciones del agente (auditoría).
 * Filtro por estado pega al servidor (nueva consulta); filtro por teléfono es
 * client-side sobre `payload.to`/`payload.phone` (el hub no guarda un
 * teléfono aparte para cada acción).
 */
import { Fragment, useState } from "react";
import { ActionButton, Chip, type Tone } from "../../../components/system";
import { EmptyState, ErrorBox, Spinner } from "../../../components/ui";
import type { ConversacionAccion } from "../../../lib/brain/conversaciones";
import { formatDate, jsonText } from "./format";

export interface AccionesPanelProps {
  acciones: ConversacionAccion[];
  loading: boolean;
  error: string | null;
  statusFilter: string;
  onStatusFilterChange: (value: string) => void;
  phoneFilter: string;
  onPhoneFilterChange: (value: string) => void;
  onRefresh: () => void;
}

const STATUS_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "", label: "Todos" },
  { value: "failed", label: "Fallidos" },
  { value: "done", label: "Completados" },
  { value: "skipped", label: "Omitidos" },
];

const STATUS_TONES: Record<string, Tone> = { done: "done", failed: "broken", skipped: "work" };
const STATUS_LABELS: Record<string, string> = { done: "completado", failed: "fallido", skipped: "omitido" };

function statusTone(status: string): Tone {
  return STATUS_TONES[status] ?? "quiet";
}

function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? (status || "sin estado");
}

/** El hub no tiene columna de teléfono en `agent_actions`: casi siempre viaja dentro del payload. */
function phoneOf(accion: ConversacionAccion): string {
  const payload = accion.payload;
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;
    if (typeof record.to === "string") return record.to;
    if (typeof record.phone === "string") return record.phone;
  }
  return "";
}

function failureText(accion: ConversacionAccion): string {
  if (accion.status !== "failed") return "";
  const result = accion.result;
  if (!result) return "Error no especificado";
  if (typeof result === "string") return result;
  if (typeof result === "object" && !Array.isArray(result)) {
    const record = result as Record<string, unknown>;
    const message = [record.error, record.message, record.details].find((v) => typeof v === "string");
    if (typeof message === "string" && message) return message;
  }
  return "Error no especificado";
}

export function AccionesPanel({
  acciones,
  loading,
  error,
  statusFilter,
  onStatusFilterChange,
  phoneFilter,
  onPhoneFilterChange,
  onRefresh,
}: AccionesPanelProps) {
  const [expandedIds, setExpandedIds] = useState<Set<number>>(() => new Set());

  const filtered = phoneFilter.trim()
    ? acciones.filter((accion) => phoneOf(accion).toLowerCase().includes(phoneFilter.trim().toLowerCase()))
    : acciones;

  function toggleExpanded(id: number) {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <select
            value={statusFilter}
            onChange={(event) => onStatusFilterChange(event.target.value)}
            aria-label="Filtrar por estado"
            className="rounded-tight border border-line bg-surface px-2.5 py-1.5 text-small text-ink outline-none focus:border-link"
          >
            {STATUS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <input
            type="text"
            value={phoneFilter}
            onChange={(event) => onPhoneFilterChange(event.target.value)}
            placeholder="Filtrar por teléfono…"
            aria-label="Filtrar por teléfono"
            className="rounded-tight border border-line bg-surface px-2.5 py-1.5 text-small text-ink outline-none focus:border-link"
          />
        </div>
        <ActionButton onClick={onRefresh} disabled={loading}>
          {loading ? "Actualizando…" : "Actualizar acciones"}
        </ActionButton>
      </div>

      {error ? (
        <div className="mt-3">
          <ErrorBox message={error} onRetry={onRefresh} />
        </div>
      ) : null}

      <div className="mt-4 overflow-hidden rounded-panel bg-surface shadow-rest">
        <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
          <h2 className="text-body font-semibold text-ink">Registro de acciones</h2>
          <span className="text-label text-muted">{filtered.length} filas</span>
        </div>

        {loading && acciones.length === 0 ? (
          <Spinner label="Cargando acciones…" />
        ) : !loading && !error && filtered.length === 0 ? (
          <div className="p-4">
            <EmptyState title="No hay acciones" hint="Ninguna acción coincide con el filtro seleccionado." />
          </div>
        ) : filtered.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-small">
              <thead className="bg-canvas-deep text-label text-muted">
                <tr>
                  <th className="px-4 py-2.5 text-left font-semibold">ID</th>
                  <th className="px-4 py-2.5 text-left font-semibold">Estado</th>
                  <th className="px-4 py-2.5 text-left font-semibold">Tipo</th>
                  <th className="px-4 py-2.5 text-left font-semibold">Fecha</th>
                  <th className="px-4 py-2.5 text-left font-semibold">Error</th>
                  <th className="px-4 py-2.5 text-right font-semibold">Detalle</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((accion) => {
                  const expanded = expandedIds.has(accion.id);
                  const failure = failureText(accion);
                  return (
                    <Fragment key={accion.id}>
                      <tr className="border-t border-line-soft align-top">
                        <td className="px-4 py-2.5 tabular-nums text-muted">{accion.id}</td>
                        <td className="px-4 py-2.5">
                          <Chip tone={statusTone(accion.status)}>{statusLabel(accion.status)}</Chip>
                        </td>
                        <td className="px-4 py-2.5 font-semibold text-ink">{accion.action_type}</td>
                        <td className="px-4 py-2.5 whitespace-nowrap text-muted">{formatDate(accion.created_at)}</td>
                        <td className="min-w-60 px-4 py-2.5 text-broken">{failure || <span className="text-faint">—</span>}</td>
                        <td className="px-4 py-2.5 text-right">
                          <button
                            type="button"
                            onClick={() => toggleExpanded(accion.id)}
                            className="press rounded-tight border border-line bg-canvas px-2.5 py-1 text-label font-semibold text-ink-2 hover:bg-surface-2"
                          >
                            {expanded ? "Ocultar" : "Ver"}
                          </button>
                        </td>
                      </tr>
                      {expanded ? (
                        <tr className="border-t border-line-soft bg-canvas">
                          <td className="px-4 pb-4 pt-0" colSpan={6}>
                            <div className="grid grid-cols-1 gap-3 pt-3 lg:grid-cols-2">
                              <div className="rounded-tight border border-line bg-surface p-3">
                                <p className="mb-2 text-label font-semibold uppercase text-muted">Payload</p>
                                <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words text-label leading-relaxed text-ink-2">
                                  {jsonText(accion.payload)}
                                </pre>
                              </div>
                              <div className="rounded-tight border border-line bg-surface p-3">
                                <p className="mb-2 text-label font-semibold uppercase text-muted">Resultado</p>
                                <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words text-label leading-relaxed text-ink-2">
                                  {jsonText(accion.result)}
                                </pre>
                              </div>
                            </div>
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    </div>
  );
}
