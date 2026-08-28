/**
 * Admin mínimo (spec B5 §9): agentes (tabla con pausar y edición de modelo),
 * config (semáforos/kill switch). Espejo mínimo del MCP: el poder completo
 * (prompts versionados, proveedores, rollback) está en apps/mcp-admin — la
 * API REST no expone prompts ni proveedores, y aquí se dice explícitamente.
 */
import { useEffect, useState } from "react";
import { api, ApiError } from "../lib/api";
import type { AppConfigRow } from "../lib/types";
import { useStore } from "../state/store";
import { AgentAvatar, EmptyState, ErrorBox, fmtDate, Spinner } from "../components/ui";

const LAYER_LABEL: Record<string, string> = {
  consultoria: "Consultoría",
  implementacion: "Implementación",
  operacion: "Operación",
  meta: "Meta",
};

function AgentsTab() {
  const agents = useStore((s) => s.agents);
  const loadAgents = useStore((s) => s.loadAgents);
  const setAgentStatus = useStore((s) => s.setAgentStatus);
  const pushToast = useStore((s) => s.pushToast);
  const [editingModel, setEditingModel] = useState<string | null>(null);
  const [modelDraft, setModelDraft] = useState("");

  useEffect(() => {
    void loadAgents();
  }, [loadAgents]);

  if (agents.length === 0) {
    return <EmptyState title="Sin agentes" hint="¿Seed aplicado en apps/api?" />;
  }

  async function saveModel(agentId: string, version: number) {
    try {
      await api.updateAgent(agentId, { expected_version: version, model: modelDraft.trim() || null });
      await loadAgents();
      pushToast("ok", "Modelo actualizado (surte efecto en el siguiente run)");
    } catch (err) {
      pushToast("error", err instanceof ApiError ? `${err.code}: ${err.message}` : "No se pudo actualizar");
    } finally {
      setEditingModel(null);
    }
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
      <table className="w-full text-left text-xs">
        <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-400">
          <tr>
            <th className="px-3 py-2">Agente</th>
            <th className="px-3 py-2">Capa</th>
            <th className="px-3 py-2">Runtime</th>
            <th className="px-3 py-2">Modelo</th>
            <th className="px-3 py-2">Autonomía</th>
            <th className="px-3 py-2">Estado</th>
            <th className="px-3 py-2">Acciones</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {agents.map((a) => (
            <tr key={a.id} className="hover:bg-slate-50">
              <td className="px-3 py-2">
                <span className="flex items-center gap-1.5 font-medium">
                  <AgentAvatar name={a.name} slug={a.slug} size={5} />
                  {a.name}
                  <span className="font-mono text-[10px] text-slate-400">{a.slug}</span>
                </span>
              </td>
              <td className="px-3 py-2">{LAYER_LABEL[a.layer] ?? a.layer}</td>
              <td className="px-3 py-2 font-mono text-[10px]">{a.runtime}</td>
              <td className="px-3 py-2">
                {editingModel === a.id ? (
                  <span className="flex gap-1">
                    <input
                      value={modelDraft}
                      onChange={(e) => setModelDraft(e.target.value)}
                      className="w-40 rounded border border-slate-300 px-1 py-0.5 font-mono text-[10px]"
                      placeholder="(por defecto del proveedor)"
                    />
                    <button
                      onClick={() => void saveModel(a.id, a.version)}
                      className="rounded bg-slate-900 px-1.5 text-[10px] text-white"
                    >
                      ✓
                    </button>
                    <button onClick={() => setEditingModel(null)} className="text-[10px] text-slate-400">
                      ✕
                    </button>
                  </span>
                ) : (
                  <button
                    onClick={() => {
                      setEditingModel(a.id);
                      setModelDraft(a.model ?? "");
                    }}
                    className="font-mono text-[10px] text-sky-700 underline"
                  >
                    {a.model ?? "(por defecto)"}
                  </button>
                )}
              </td>
              <td className="px-3 py-2">{a.autonomy}</td>
              <td className="px-3 py-2">
                <span
                  className={`rounded px-1.5 py-0.5 text-[9px] font-semibold ${
                    a.status === "active"
                      ? "bg-emerald-100 text-emerald-700"
                      : a.status === "paused"
                        ? "bg-amber-100 text-amber-700"
                        : "bg-slate-200 text-slate-500"
                  }`}
                >
                  {a.status === "active" ? "activo" : a.status === "paused" ? "pausado" : "desactivado"}
                </span>
              </td>
              <td className="px-3 py-2">
                {a.status === "active" ? (
                  <button
                    onClick={() => void setAgentStatus(a.id, "paused", a.version)}
                    className="rounded border border-amber-300 px-2 py-0.5 text-[10px] text-amber-700 hover:bg-amber-50"
                  >
                    ⏸ Pausar
                  </button>
                ) : (
                  <button
                    onClick={() => void setAgentStatus(a.id, "active", a.version)}
                    className="rounded bg-emerald-600 px-2 py-0.5 text-[10px] text-white hover:bg-emerald-700"
                  >
                    ▶ Activar
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="border-t border-slate-100 p-3 text-[11px] text-slate-400">
        Prompts (3 capas, versionados con rollback) y proveedores LLM se administran por el MCP
        <code className="mx-1 rounded bg-slate-100 px-1">agentos-admin</code>
        desde Claude Code — la API no los expone a la UI (las claves jamás salen: solo nombres de
        variables de entorno).
      </p>
    </div>
  );
}

function ConfigTab() {
  const killSwitch = useStore((s) => s.killSwitch);
  const setKillSwitch = useStore((s) => s.setKillSwitch);
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
      <div className="flex items-center gap-3 rounded-lg border border-slate-200 bg-white p-4">
        <div>
          <p className="text-sm font-bold">Kill switch (US-11)</p>
          <p className="text-xs text-slate-500">
            Al activarlo no arrancan runs nuevos y los activos se cancelan en ≤10 s.
          </p>
        </div>
        <button
          onClick={() => void setKillSwitch(!killSwitch)}
          className={`ml-auto rounded-md px-3 py-1.5 text-xs font-medium text-white ${
            killSwitch ? "bg-emerald-600 hover:bg-emerald-700" : "bg-rose-600 hover:bg-rose-700"
          }`}
        >
          {killSwitch ? "▶ Reanudar agentes" : "⏸ Pausar agentes"}
        </button>
      </div>

      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <p className="text-xs font-bold uppercase tracking-wide text-slate-400">
          app_config (semáforos y presupuestos)
        </p>
        {error ? <ErrorBox message={error} onRetry={() => void load()} /> : null}
        {rows === null && !error ? <Spinner label="Cargando…" /> : null}
        {rows && rows.length === 0 ? <p className="mt-2 text-xs text-slate-400">(vacío)</p> : null}
        {rows && rows.length > 0 ? (
          <table className="mt-2 w-full text-left text-xs">
            <thead className="text-[10px] uppercase text-slate-400">
              <tr>
                <th className="py-1 pr-4">Clave</th>
                <th className="py-1 pr-4">Valor</th>
                <th className="py-1">Actualizado</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((r) => (
                <tr key={r.key}>
                  <td className="py-1.5 pr-4 font-mono">{r.key}</td>
                  <td className="py-1.5 pr-4 font-mono text-slate-600">{JSON.stringify(r.value)}</td>
                  <td className="py-1.5 text-slate-400">{fmtDate(r.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
        <p className="mt-3 text-[11px] text-slate-400">
          Edición de presupuestos y semáforos: MCP admin (mutaciones con idempotency_key +
          expected_version + reason, todo auditado).
        </p>
      </div>
    </div>
  );
}

export default function AdminView() {
  const [tab, setTab] = useState<"agents" | "config">("agents");
  return (
    <div className="p-4">
      <div className="mb-3 flex gap-1">
        <button
          onClick={() => setTab("agents")}
          className={`rounded-md px-3 py-1.5 text-xs font-medium ${
            tab === "agents" ? "bg-slate-900 text-white" : "bg-white text-slate-600 hover:bg-slate-100"
          }`}
        >
          Agentes
        </button>
        <button
          onClick={() => setTab("config")}
          className={`rounded-md px-3 py-1.5 text-xs font-medium ${
            tab === "config" ? "bg-slate-900 text-white" : "bg-white text-slate-600 hover:bg-slate-100"
          }`}
        >
          Config
        </button>
      </div>
      {tab === "agents" ? <AgentsTab /> : <ConfigTab />}
    </div>
  );
}
