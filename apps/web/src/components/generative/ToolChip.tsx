/**
 * Chip genérico de tool call (spec B5 §3): nombre + estado, expandible para ver
 * argumentos y resultado crudos. Es el fallback del registro de generative UI.
 */
import { useState } from "react";
import type { ToolCallChip } from "../../state/reducer";

export function ToolChip({ chip }: { chip: ToolCallChip }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="my-1 rounded-tight border border-line bg-surface-2 text-small" data-tool-chip={chip.name}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-2 py-1.5 text-left focus:outline-none focus:ring-2 focus:ring-link"
      >
        <span
          className={`inline-block h-2 w-2 rounded-full ${
            !chip.done ? "animate-pulse bg-work" : chip.isError ? "bg-broken" : "bg-done"
          }`}
        />
        <span className="font-mono font-medium">{chip.name}</span>
        <span className="text-faint">{chip.done ? (chip.isError ? "error" : "ok") : "ejecutando…"}</span>
        <span className="ml-auto text-faint">{open ? "▾" : "▸"}</span>
      </button>
      {open ? (
        <div className="space-y-1 border-t border-line p-2">
          <p className="font-semibold text-muted">Argumentos</p>
          <pre className="max-h-40 overflow-auto rounded bg-surface p-2">{chip.args || "(vacío)"}</pre>
          <p className="font-semibold text-muted">Resultado{chip.synthetic ? " (sintético)" : ""}</p>
          <pre className="max-h-40 overflow-auto rounded bg-surface p-2">
            {chip.result ?? "(pendiente)"}
          </pre>
        </div>
      ) : null}
    </div>
  );
}
