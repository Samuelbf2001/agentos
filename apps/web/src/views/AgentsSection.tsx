/**
 * Sección de agentes (spec B5 §9): tabla con pausar y edición de modelo.
 * Se usa dentro de Sistema › Equipo. Espejo mínimo del MCP: el poder completo
 * (prompts versionados, proveedores, rollback) está en apps/mcp-admin — la
 * API REST no expone prompts ni proveedores, y aquí se dice explícitamente.
 */
import { useEffect, useState } from "react";
import { api, ApiError } from "../lib/api";
import { useStore } from "../state/store";
import { AgentAvatar, EmptyState } from "../components/ui";

const LAYER_LABEL: Record<string, string> = {
  consultoria: "Consultoría",
  implementacion: "Implementación",
  operacion: "Operación",
  meta: "Meta",
};

export function AgentsSection() {
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

  const hasReportsTo = agents.some((a) => a.reports_to != null || a.reportsTo != null);
  const byId = new Map(agents.map((a) => [a.id, a]));

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
    <div className="overflow-x-auto rounded-soft bg-surface shadow-rest">
      <table className="w-full text-left text-small">
        <thead className="bg-surface-2 text-label text-faint">
          <tr>
            <th className="px-3 py-2">Agente</th>
            <th className="px-3 py-2">Capa</th>
            <th className="px-3 py-2">Runtime</th>
            <th className="px-3 py-2">Modelo</th>
            <th className="px-3 py-2">Autonomía</th>
            <th className="px-3 py-2">Estado</th>
            {hasReportsTo ? <th className="px-3 py-2">Reporta a</th> : null}
            <th className="px-3 py-2">Acciones</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line-soft">
          {agents.map((a) => (
            <tr key={a.id} className="hover:bg-surface-2">
              <td className="px-3 py-2">
                <span className="flex items-center gap-1.5 font-medium">
                  <AgentAvatar name={a.name} slug={a.slug} size={5} />
                  {a.name}
                  <span className="font-mono text-label text-faint">{a.slug}</span>
                </span>
              </td>
              <td className="px-3 py-2">{LAYER_LABEL[a.layer] ?? a.layer}</td>
              <td className="px-3 py-2 font-mono text-label">{a.runtime}</td>
              <td className="px-3 py-2">
                {editingModel === a.id ? (
                  <span className="flex gap-1">
                    <input
                      value={modelDraft}
                      onChange={(e) => setModelDraft(e.target.value)}
                      className="w-40 rounded border border-line px-1 py-0.5 font-mono text-label"
                      placeholder="(por defecto del proveedor)"
                    />
                    <button
                      onClick={() => void saveModel(a.id, a.version)}
                      className="rounded bg-ink px-1.5 text-label text-surface"
                    >
                      ✓
                    </button>
                    <button onClick={() => setEditingModel(null)} className="text-label text-faint">
                      ✕
                    </button>
                  </span>
                ) : (
                  <button
                    onClick={() => {
                      setEditingModel(a.id);
                      setModelDraft(a.model ?? "");
                    }}
                    className="font-mono text-label text-link underline"
                  >
                    {a.model ?? "(por defecto)"}
                  </button>
                )}
              </td>
              <td className="px-3 py-2">{a.autonomy}</td>
              <td className="px-3 py-2">
                <span
                  className={`rounded-full px-1.5 py-0.5 text-label font-semibold ${
                    a.status === "active"
                      ? "bg-done-bg text-done"
                      : a.status === "paused"
                        ? "bg-work-bg text-work"
                        : "bg-line text-muted"
                  }`}
                >
                  {a.status === "active" ? "activo" : a.status === "paused" ? "pausado" : "desactivado"}
                </span>
              </td>
              {hasReportsTo ? (
                <td className="px-3 py-2">
                  {(() => {
                    const chief = a.reports_to ?? a.reportsTo ?? null;
                    return chief ? (byId.get(chief)?.name ?? "otro agente") : "—";
                  })()}
                </td>
              ) : null}
              <td className="px-3 py-2">
                {a.status === "active" ? (
                  <button
                    onClick={() => void setAgentStatus(a.id, "paused", a.version)}
                    className="rounded border border-work px-2 py-0.5 text-label text-work hover:bg-work-bg"
                  >
                    ⏸ Pausar
                  </button>
                ) : (
                  <button
                    onClick={() => void setAgentStatus(a.id, "active", a.version)}
                    className="rounded bg-done px-2 py-0.5 text-label text-surface hover:bg-done"
                  >
                    ▶ Activar
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="border-t border-line-soft p-3 text-label text-faint">
        Prompts (3 capas, versionados con rollback) y proveedores LLM se administran por el MCP
        <code className="mx-1 rounded bg-line-soft px-1">agentos-admin</code>
        desde Claude Code — la API no los expone a la UI (las claves jamás salen: solo nombres de
        variables de entorno).
      </p>
    </div>
  );
}
