/** Runs (US-7, spec B5 §6): lista con filtros (agente, estado, coste). */
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import type { Run } from "../lib/types";
import { useStore } from "../state/store";
import {
  AgentAvatar,
  EmptyState,
  ErrorBox,
  fmtCost,
  fmtTokens,
  RunStatusPill,
  Spinner,
  timeAgo,
} from "../components/ui";

const RUN_STATUSES = ["", "queued", "running", "succeeded", "failed", "cancelled", "interrupted"];

export default function RunsView() {
  const agents = useStore((s) => s.agents);
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [agentId, setAgentId] = useState("");
  const [costFilter, setCostFilter] = useState<"" | "with_cost" | "no_cost">("");

  async function load() {
    setError(null);
    try {
      const res = await api.runs({
        limit: 100,
        ...(status ? { status } : {}),
        ...(agentId ? { agent_id: agentId } : {}),
      });
      setRuns(res.runs);
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : "Error cargando runs");
    }
  }

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 10_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, agentId]);

  const filtered = useMemo(() => {
    if (!runs) return null;
    if (costFilter === "with_cost") return runs.filter((r) => r.costUsd !== null && r.costUsd > 0);
    if (costFilter === "no_cost") return runs.filter((r) => r.costUsd === null);
    return runs;
  }, [runs, costFilter]);

  const agentById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);

  return (
    <div className="p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        <select
          value={agentId}
          onChange={(e) => setAgentId(e.target.value)}
          className="rounded-md border border-slate-300 px-2 py-1 text-xs"
        >
          <option value="">Todos los agentes</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="rounded-md border border-slate-300 px-2 py-1 text-xs"
        >
          {RUN_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s === "" ? "Todos los estados" : s}
            </option>
          ))}
        </select>
        <select
          value={costFilter}
          onChange={(e) => setCostFilter(e.target.value as typeof costFilter)}
          className="rounded-md border border-slate-300 px-2 py-1 text-xs"
        >
          <option value="">Coste: todos</option>
          <option value="with_cost">Con coste reportado</option>
          <option value="no_cost">Coste no reportado</option>
        </select>
        <button onClick={() => void load()} className="text-xs text-slate-500 underline">
          Refrescar
        </button>
      </div>

      {error ? <ErrorBox message={error} onRetry={() => void load()} /> : null}
      {!filtered && !error ? <Spinner label="Cargando runs…" /> : null}
      {filtered && filtered.length === 0 ? (
        <EmptyState title="Sin runs" hint="Cuando los agentes trabajen, aquí verás cada ejecución." />
      ) : null}

      {filtered && filtered.length > 0 ? (
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-400">
              <tr>
                <th className="px-3 py-2">Run</th>
                <th className="px-3 py-2">Agente</th>
                <th className="px-3 py-2">Trigger</th>
                <th className="px-3 py-2">Estado</th>
                <th className="px-3 py-2">Tokens in/out</th>
                <th className="px-3 py-2">Coste</th>
                <th className="px-3 py-2">Cuándo</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.map((r) => {
                const agent = r.agentId ? agentById.get(r.agentId) : null;
                return (
                  <tr key={r.id} className="hover:bg-slate-50">
                    <td className="px-3 py-2 font-mono">
                      <Link to={`/runs/${r.id}`} className="text-sky-700 underline">
                        {r.id.slice(0, 8)}
                      </Link>
                      {r.parentRunId ? <span className="ml-1 text-slate-400">(hijo)</span> : null}
                    </td>
                    <td className="px-3 py-2">
                      {agent ? (
                        <span className="flex items-center gap-1.5">
                          <AgentAvatar name={agent.name} slug={agent.slug} size={5} />
                          {agent.name}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-3 py-2 text-slate-500">{r.trigger}</td>
                    <td className="px-3 py-2">
                      <RunStatusPill status={r.status} />
                    </td>
                    <td className="px-3 py-2 text-slate-500">
                      {fmtTokens(r.tokensIn)} / {fmtTokens(r.tokensOut)}
                    </td>
                    <td className="px-3 py-2 text-slate-500">{fmtCost(r.costUsd)}</td>
                    <td className="px-3 py-2 text-slate-400">{timeAgo(r.createdAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
