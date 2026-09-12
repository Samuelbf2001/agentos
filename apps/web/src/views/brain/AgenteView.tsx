/**
 * 2brain › Agente 2brain: estado de las integraciones, prompt de extracción
 * y herramientas del agente conversacional/extractor de WhatsAppHub.
 *
 * Estado y config se piden por separado (como hace el hub): que el estado no
 * responda no debe bloquear ni el prompt ni las herramientas. Guardar y
 * restablecer viajan por el MISMO endpoint (`PUT /api/brain/agente/config`
 * con `prompt: string | null`); "Restablecer" pide confirmación en línea, sin
 * `window.confirm`.
 */
import { useEffect, useState } from "react";
import { ApiError } from "../../lib/api";
import {
  AGENT_PROMPT_MAX_LENGTH,
  fetchAgentConfig,
  fetchAgentStatus,
  updateAgentPrompt,
  type AgentConfig,
  type AgentStatus,
  type AgentTool,
} from "../../lib/brain/agente";
import { ActionButton, Card, Chip, SectionHead } from "../../components/system";
import { EmptyState, ErrorBox, Spinner } from "../../components/ui";

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

function StatusCard({ label, connected }: { label: string; connected: boolean }) {
  return (
    <Card className="flex items-center justify-between gap-3 px-4 py-3">
      <span className="text-small font-semibold text-ink-2">{label}</span>
      <Chip tone={connected ? "done" : "quiet"}>{connected ? "Conectado" : "Sin configurar"}</Chip>
    </Card>
  );
}

function ToolRow({ tool }: { tool: AgentTool }) {
  const [open, setOpen] = useState(false);
  const hasSchema = tool.input_schema !== undefined && tool.input_schema !== null;
  return (
    <li className="border-b border-line-soft py-2.5 last:border-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-mono text-small font-semibold text-ink">{tool.name || "(sin nombre)"}</p>
          <p className="mt-0.5 text-small text-muted">{tool.description || "Sin descripción"}</p>
        </div>
        {hasSchema ? (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="press shrink-0 text-label font-semibold text-link hover:underline"
          >
            {open ? "Ocultar esquema" : "Ver esquema"}
          </button>
        ) : null}
      </div>
      {open && hasSchema ? (
        <pre className="mt-2 max-h-72 overflow-auto rounded-tight bg-canvas-deep/60 p-2.5 text-label leading-relaxed text-ink-2">
          {JSON.stringify(tool.input_schema, null, 2)}
        </pre>
      ) : null}
    </li>
  );
}

function ToolsCard({ tools, emptyHint }: { tools: AgentTool[]; emptyHint: string }) {
  return (
    <Card className="p-4">
      {tools.length === 0 ? (
        <EmptyState title="Sin herramientas registradas" hint={emptyHint} />
      ) : (
        <ul>
          {tools.map((tool, i) => (
            <ToolRow key={tool.name || i} tool={tool} />
          ))}
        </ul>
      )}
    </Card>
  );
}

export default function AgenteView() {
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [config, setConfig] = useState<AgentConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);

  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setConfigError(null);
      try {
        const [statusData, configData] = await Promise.all([
          fetchAgentStatus().catch(() => null),
          fetchAgentConfig(),
        ]);
        if (cancelled) return;
        setStatus(statusData);
        setConfig(configData);
        setDraft(configData.prompt_override ?? configData.prompt_default ?? "");
      } catch (err) {
        if (cancelled) return;
        setConfig(null);
        setConfigError(errorMessage(err, "No se pudo leer la configuración del agente."));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const promptDefault = config?.prompt_default ?? "";
  const persistedValue = config ? (config.prompt_override ?? promptDefault) : "";
  const dirty = config ? draft !== persistedValue : false;
  const usingOverride = Boolean(config?.prompt_override);

  const tools = Array.isArray(config?.tools) ? config.tools : [];
  const chatTools = Array.isArray(config?.chat_tools) ? config.chat_tools : [];

  async function save() {
    setSaving(true);
    setSaveError(null);
    setSaveMessage(null);
    try {
      const next = await updateAgentPrompt(draft);
      setConfig(next);
      setDraft(next.prompt_override ?? next.prompt_default ?? "");
      setSaveMessage("Prompt guardado correctamente.");
    } catch (err) {
      setSaveError(errorMessage(err, "No se pudo guardar el prompt."));
    } finally {
      setSaving(false);
    }
  }

  async function resetToDefault() {
    setResetting(true);
    setSaveError(null);
    setSaveMessage(null);
    try {
      const next = await updateAgentPrompt(null);
      setConfig(next);
      setDraft(next.prompt_override ?? next.prompt_default ?? "");
      setSaveMessage("Prompt restablecido al valor por defecto.");
    } catch (err) {
      setSaveError(errorMessage(err, "No se pudo restablecer el prompt."));
    } finally {
      setResetting(false);
      setConfirmReset(false);
    }
  }

  return (
    <div className="mx-auto max-w-[1180px] px-4 pb-20 pt-6 sm:px-5">
      <h1 className="text-display text-ink">Agente 2brain</h1>
      <p className="mt-1.5 max-w-[60ch] text-body text-muted">
        Estado de las integraciones, prompt de extracción y herramientas del agente conversacional de WhatsAppHub.
      </p>

      {loading && !config ? (
        <div className="mt-6">
          <Spinner label="Cargando la configuración del agente…" />
        </div>
      ) : configError && !config ? (
        <div className="mt-6">
          <ErrorBox message={configError} onRetry={() => setReloadKey((k) => k + 1)} />
        </div>
      ) : (
        <>
          <SectionHead label="Estado de integraciones" />
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatusCard label="Notion" connected={Boolean(status?.notion)} />
            <StatusCard label="Kapso (WhatsApp)" connected={Boolean(status?.kapso)} />
            <StatusCard label="Recordatorios" connected={Boolean(status?.whatsapp_reminders)} />
            <StatusCard label="Notas al wiki" connected={Boolean(status?.wiki_notes)} />
          </div>

          <SectionHead
            label="Prompt de extracción"
            hint={usingOverride ? "usando override personalizado" : "usando el prompt por defecto"}
          />
          <Card className="p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Chip tone={usingOverride ? "link" : "quiet"}>{usingOverride ? "Override activo" : "Por defecto"}</Chip>
              <span className="text-label tabular-nums text-muted">
                {draft.length.toLocaleString("es")} / {AGENT_PROMPT_MAX_LENGTH.toLocaleString("es")} caracteres
              </span>
            </div>

            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              spellCheck={false}
              rows={16}
              maxLength={AGENT_PROMPT_MAX_LENGTH}
              aria-label="Prompt de extracción del agente"
              className="mt-3 w-full resize-y rounded-tight border border-line bg-canvas p-3 font-mono text-small leading-relaxed text-ink-2 focus:border-link focus:outline-none"
            />

            {dirty ? <p className="mt-2 text-small font-semibold text-work">Tienes cambios sin guardar.</p> : null}
            {saveError ? (
              <div className="mt-2">
                <ErrorBox message={saveError} />
              </div>
            ) : null}
            {saveMessage ? <p className="mt-2 text-small font-semibold text-done">{saveMessage}</p> : null}

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <ActionButton variant="primary" onClick={() => void save()} disabled={!dirty || saving}>
                {saving ? "Guardando…" : "Guardar"}
              </ActionButton>

              {!confirmReset ? (
                <ActionButton
                  variant="quiet"
                  onClick={() => setConfirmReset(true)}
                  disabled={!usingOverride || saving}
                >
                  Restablecer al prompt por defecto
                </ActionButton>
              ) : (
                <span className="inline-flex items-center gap-2 rounded-full bg-broken-bg px-3 py-1.5 text-small text-broken">
                  ¿Restablecer al prompt por defecto?
                  <button
                    type="button"
                    onClick={() => void resetToDefault()}
                    disabled={resetting}
                    className="press font-bold underline disabled:opacity-50"
                  >
                    {resetting ? "Restableciendo…" : "Sí"}
                  </button>
                  <button type="button" onClick={() => setConfirmReset(false)} className="press font-semibold">
                    No
                  </button>
                </span>
              )}
            </div>
          </Card>

          <SectionHead label="Herramientas de extracción (reuniones)" count={tools.length} />
          <ToolsCard tools={tools} emptyHint="El hub todavía no reporta herramientas de extracción." />

          <SectionHead label="Herramientas del agente conversacional (WhatsApp)" count={chatTools.length} />
          <ToolsCard tools={chatTools} emptyHint="El hub todavía no reporta herramientas conversacionales." />
        </>
      )}
    </div>
  );
}
