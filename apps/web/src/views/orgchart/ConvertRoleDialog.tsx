/**
 * Convertir un rol en agente. El agente nace supervisado y pausado por
 * defecto: hereda propósito, funciones y procesos del rol, pero nunca
 * reemplaza a la persona que lo ocupa — todo lo que produce pasa por
 * revisión humana hasta que alguien decida lo contrario desde Equipo.
 */
import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useState } from "react";
import { ActionButton, Chip, SectionHead } from "../../components/system";
import { Spinner } from "../../components/ui";
import { api, ApiError } from "../../lib/api";
import type { OrgRoleFull, ToolCatalogEntry } from "../../lib/types";
import { useStore } from "../../state/store";

type Autonomy = "manual" | "supervised";

const KNOWN_PREFIXES = ["tasks", "knowledge", "processes", "org_graph", "sources"] as const;
type GroupKey = (typeof KNOWN_PREFIXES)[number] | "resto";

const GROUP_LABELS: Record<GroupKey, string> = {
  tasks: "Tareas",
  knowledge: "Conocimiento",
  processes: "Procesos",
  org_graph: "Organigrama",
  sources: "Fuentes",
  resto: "Otras",
};

function groupKeyOf(name: string): GroupKey {
  const prefix = name.split(".")[0] ?? "";
  return (KNOWN_PREFIXES as readonly string[]).includes(prefix) ? (prefix as GroupKey) : "resto";
}

function groupTools(tools: ToolCatalogEntry[]): { key: GroupKey; label: string; tools: ToolCatalogEntry[] }[] {
  const order: GroupKey[] = [...KNOWN_PREFIXES, "resto"];
  return order
    .map((key) => ({ key, label: GROUP_LABELS[key], tools: tools.filter((t) => groupKeyOf(t.name) === key) }))
    .filter((group) => group.tools.length > 0);
}

export interface ConvertRoleDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  role: OrgRoleFull;
  onCreated(role: OrgRoleFull): void;
}

export function ConvertRoleDialog({ open, onOpenChange, role, onCreated }: ConvertRoleDialogProps) {
  const pushToast = useStore((s) => s.pushToast);

  const [functionIds, setFunctionIds] = useState<Set<string>>(new Set());
  const [autonomy, setAutonomy] = useState<Autonomy>("supervised");
  const [activate, setActivate] = useState(false);
  const [name, setName] = useState("");

  const [catalog, setCatalog] = useState<ToolCatalogEntry[] | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [selectedTools, setSelectedTools] = useState<Set<string>>(new Set());

  const [busy, setBusy] = useState(false);

  // Reinicia el formulario cada vez que se abre para este rol.
  useEffect(() => {
    if (!open) return;
    setFunctionIds(new Set(role.functions.map((f) => f.id)));
    setAutonomy("supervised");
    setActivate(false);
    setName(`Agente de ${role.name}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, role.id]);

  // Carga el catálogo de herramientas al abrir.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setCatalog(null);
    setCatalogError(null);
    api
      .toolCatalog()
      .then(({ tools }) => {
        if (cancelled) return;
        setCatalog(tools);
        setSelectedTools(new Set(tools.filter((t) => t.readOnly).map((t) => t.name)));
      })
      .catch(() => {
        if (cancelled) return;
        setCatalog([]);
        setCatalogError("No se pudo leer el catálogo");
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  function toggleFunction(id: string, checked: boolean) {
    setFunctionIds((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function toggleTool(toolName: string, checked: boolean) {
    setSelectedTools((current) => {
      const next = new Set(current);
      if (checked) next.add(toolName);
      else next.delete(toolName);
      return next;
    });
  }

  const noFunctions = role.functions.length === 0;
  const createDisabled = noFunctions || busy;

  async function submit() {
    if (createDisabled) return;
    setBusy(true);
    try {
      const { agent, role: updatedRole } = await api.convertRoleToAgent(role.id, {
        function_ids: role.functions.filter((f) => functionIds.has(f.id)).map((f) => f.id),
        autonomy,
        activate,
        tools_allowlist: Array.from(selectedTools),
        ...(name.trim() ? { name: name.trim() } : {}),
      });
      onCreated(updatedRole);
      pushToast("ok", `Agente creado: ${agent.name}`);
      onOpenChange(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        pushToast("error", "Este rol ya tiene agente");
      } else {
        pushToast("error", err instanceof ApiError ? err.message : "No se pudo crear el agente");
      }
    } finally {
      setBusy(false);
    }
  }

  const groups = catalog ? groupTools(catalog) : [];

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/35 backdrop-blur-[1px]" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 max-h-[85vh] w-full max-w-xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-panel bg-surface p-6 shadow-float focus:outline-none"
          aria-describedby="convert-role-description"
          data-testid="convert-role-dialog"
        >
          <Dialog.Title className="text-title font-semibold text-ink">
            Convertir «{role.name}» en agente
          </Dialog.Title>
          <Dialog.Description id="convert-role-description" className="mt-1 text-small text-muted">
            El agente hereda el propósito, las funciones y los procesos del rol. Nace como asistente de
            la persona que ocupa el rol: nunca la reemplaza y todo lo que produce pasa por revisión
            humana.
          </Dialog.Description>

          <div>
            <SectionHead label="Alcance" />
            {noFunctions ? (
              <p className="text-small text-work">
                Este rol no tiene funciones todavía; añádelas antes para que el agente sepa qué hacer
              </p>
            ) : (
              <ul className="space-y-1.5">
                {role.functions.map((f) => (
                  <li key={f.id}>
                    <label className="flex min-h-9 cursor-pointer items-center gap-2 rounded-tight px-1.5 py-1 hover:bg-surface-2">
                      <input
                        type="checkbox"
                        checked={functionIds.has(f.id)}
                        onChange={(e) => toggleFunction(f.id, e.target.checked)}
                        className="h-4 w-4 rounded border-line text-ink focus:ring-link"
                      />
                      <span className="min-w-0 flex-1 truncate text-small text-ink-2">{f.name}</span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div>
            <SectionHead label="Activación" />
            <div className="space-y-2" role="radiogroup" aria-label="Activación">
              <button
                type="button"
                role="radio"
                aria-checked={autonomy === "supervised"}
                onClick={() => setAutonomy("supervised")}
                className={`w-full rounded-soft bg-canvas-deep/50 p-3 text-left ${
                  autonomy === "supervised" ? "ring-2 ring-link" : ""
                }`}
              >
                <p className="text-small font-semibold text-ink">Supervisado</p>
                <p className="mt-0.5 text-small text-muted">
                  Pide aprobación antes de cualquier efecto externo y entrega a revisión
                </p>
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={autonomy === "manual"}
                onClick={() => setAutonomy("manual")}
                className={`w-full rounded-soft bg-canvas-deep/50 p-3 text-left ${
                  autonomy === "manual" ? "ring-2 ring-link" : ""
                }`}
              >
                <p className="text-small font-semibold text-ink">Solo cuando se le pida</p>
              </button>
            </div>
            <label className="mt-2 flex min-h-9 cursor-pointer items-center gap-2 rounded-tight px-1.5 py-1 hover:bg-surface-2">
              <input
                type="checkbox"
                checked={activate}
                onChange={(e) => setActivate(e.target.checked)}
                className="h-4 w-4 rounded border-line text-ink focus:ring-link"
              />
              <span className="text-small text-ink-2">Activar ahora</span>
            </label>
            <p className="text-label text-faint">Si no, nace pausado y se activa desde Equipo</p>
          </div>

          <div>
            <SectionHead label="Accesos" />
            {catalog === null ? (
              <Spinner label="Cargando catálogo…" />
            ) : catalogError ? (
              <p className="text-small text-broken">{catalogError}</p>
            ) : (
              <div className="space-y-3">
                {groups.map((group) => (
                  <div key={group.key}>
                    <p className="mb-1 text-label font-semibold text-faint">{group.label}</p>
                    <ul className="space-y-1">
                      {group.tools.map((tool) => (
                        <li key={tool.name} className="flex items-center gap-2">
                          <label className="flex min-h-9 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-tight px-1.5 py-1 hover:bg-surface-2">
                            <input
                              type="checkbox"
                              checked={selectedTools.has(tool.name)}
                              onChange={(e) => toggleTool(tool.name, e.target.checked)}
                              className="h-4 w-4 shrink-0 rounded border-line text-ink focus:ring-link"
                            />
                            <span className="min-w-0 flex-1 truncate text-small text-ink-2">{tool.name}</span>
                          </label>
                          {tool.externalEffect || tool.requiresApproval ? (
                            <Chip tone="decide">requiere aprobación</Chip>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="mt-8">
            <label htmlFor="convert-role-name" className="text-label font-semibold text-muted">
              Nombre del agente
            </label>
            <input
              id="convert-role-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1 w-full rounded-soft border border-line px-2.5 py-2 text-body focus:border-link focus:outline-none focus:ring-2 focus:ring-link"
            />
          </div>

          <div className="mt-6 flex justify-end gap-2 border-t border-line-soft pt-4">
            <ActionButton variant="quiet" onClick={() => onOpenChange(false)}>
              Cancelar
            </ActionButton>
            <ActionButton
              variant="primary"
              disabled={createDisabled}
              onClick={() => void submit()}
              data-testid="convert-role-submit"
            >
              {busy ? "Creando…" : "Crear agente"}
            </ActionButton>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export default ConvertRoleDialog;
