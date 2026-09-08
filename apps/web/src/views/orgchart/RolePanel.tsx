/**
 * Panel lateral del rol seleccionado: propiedades, funciones, personas y
 * procesos. En readOnly (previsualización de cliente) todo es lectura — sin
 * inputs editables ni botones de guardar/eliminar.
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { X } from "lucide-react";
import { ActionButton, Chip, SectionHead } from "../../components/system";
import { PersonAvatar } from "../../components/ui";
import { InlinePopover, PopoverOption, PopoverSearch } from "../../components/ui/InlinePopover";
import { paths } from "../../lib/paths";
import type { OrgGraph, OrgRoleFull } from "../../lib/types";
import type { UpdateOrgRoleInput } from "./useOrgGraph";

interface SectionsProps {
  role: OrgRoleFull;
  graph: OrgGraph;
  readOnly: boolean;
}

// ── Funciones ────────────────────────────────────────────────────────────

interface DraftFunction {
  id?: string;
  name: string;
  description?: string | null;
}

function FunctionsSection({
  role,
  readOnly,
  setFunctions,
}: SectionsProps & { setFunctions: (id: string, functions: DraftFunction[]) => Promise<void> }) {
  const [draft, setDraft] = useState<DraftFunction[]>(() =>
    role.functions.map((f) => ({ id: f.id, name: f.name, description: f.description })),
  );

  useEffect(() => {
    setDraft(role.functions.map((f) => ({ id: f.id, name: f.name, description: f.description })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role.id]);

  function commit(next: DraftFunction[]) {
    setDraft(next);
    const payload = next
      .map((f) => ({ ...(f.id ? { id: f.id } : {}), name: f.name.trim(), ...(f.description ? { description: f.description } : {}) }))
      .filter((f) => f.name.length > 0);
    void setFunctions(role.id, payload);
  }

  return (
    <div>
      <SectionHead label="Funciones" count={role.functions.length} />
      <ul className="space-y-1">
        {draft.map((f, i) => (
          <li key={f.id ?? `nueva-${i}`} className="flex items-center gap-1.5">
            <input
              value={f.name}
              disabled={readOnly}
              placeholder="Nombre de la función"
              onChange={(e) => setDraft(draft.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
              onBlur={() => commit(draft)}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              }}
              className="min-w-0 flex-1 rounded-tight border border-transparent bg-transparent px-1.5 py-1 text-small text-ink focus:border-line focus:outline-none disabled:opacity-70"
            />
            {!readOnly ? (
              <button
                type="button"
                aria-label="Quitar función"
                onClick={() => commit(draft.filter((_, j) => j !== i))}
                className="press shrink-0 text-faint hover:text-broken"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {!readOnly ? (
        <button
          type="button"
          onClick={() => setDraft([...draft, { name: "" }])}
          className="press mt-1.5 text-small font-semibold text-link"
        >
          + Añadir función
        </button>
      ) : null}
    </div>
  );
}

// ── Personas ─────────────────────────────────────────────────────────────

function PeopleSection({
  role,
  graph,
  readOnly,
  setPeople,
}: SectionsProps & {
  setPeople: (id: string, people: { person_id: string; dedication_pct?: number | null }[]) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const peopleById = new Map(graph.people.map((p) => [p.id, p]));
  const assigned = role.people.map((rp) => ({ ...rp, person: peopleById.get(rp.personId) ?? null }));
  const candidates = graph.people.filter(
    (p) =>
      !p.isInternal &&
      !role.people.some((rp) => rp.personId === p.id) &&
      p.fullName.toLowerCase().includes(query.toLowerCase()),
  );

  function wireOf(people: { personId: string; dedicationPct: number | null }[]) {
    return people.map((rp) => ({ person_id: rp.personId, ...(rp.dedicationPct !== null ? { dedication_pct: rp.dedicationPct } : {}) }));
  }

  function addPerson(personId: string) {
    void setPeople(role.id, wireOf([...role.people, { personId, dedicationPct: null }]));
    setOpen(false);
    setQuery("");
  }

  function removePerson(personId: string) {
    void setPeople(role.id, wireOf(role.people.filter((rp) => rp.personId !== personId)));
  }

  return (
    <div>
      <SectionHead label="Personas" count={role.people.length} />
      {assigned.length === 0 ? (
        <div>
          <Chip tone="work">Vacante</Chip>
          <p className="mt-1 text-small text-faint">Un rol sin persona es un hallazgo</p>
        </div>
      ) : (
        <ul className="space-y-1.5">
          {assigned.map((a) => (
            <li key={a.personId} className="flex items-center gap-2">
              <PersonAvatar name={a.person?.fullName ?? "?"} size={6} />
              <span className="min-w-0 flex-1 truncate text-small text-ink">{a.person?.fullName ?? a.personId}</span>
              {!readOnly ? (
                <button
                  type="button"
                  aria-label="Quitar persona"
                  onClick={() => removePerson(a.personId)}
                  className="press shrink-0 text-faint hover:text-broken"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {!readOnly ? (
        <InlinePopover
          open={open}
          onOpenChange={setOpen}
          label="Asignar persona"
          trigger={
            <ActionButton variant="quiet" className="mt-1.5">
              Asignar persona
            </ActionButton>
          }
        >
          <PopoverSearch value={query} onChange={setQuery} label="Buscar persona" placeholder="Buscar persona…" />
          <div className="max-h-48 overflow-y-auto">
            {candidates.map((p) => (
              <PopoverOption key={p.id} onSelect={() => addPerson(p.id)}>
                {p.fullName}
              </PopoverOption>
            ))}
          </div>
        </InlinePopover>
      ) : null}
    </div>
  );
}

// ── Procesos ─────────────────────────────────────────────────────────────

function ProcessesSection({
  role,
  graph,
  readOnly,
  projectId,
  setProcesses,
}: SectionsProps & {
  projectId: string;
  setProcesses: (id: string, processes: { process_id: string; relation: "owner" | "participant" }[]) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const processesById = new Map(graph.processes.map((p) => [p.id, p]));
  const linked = role.processes.map((rp) => ({ ...rp, process: processesById.get(rp.processId) ?? null }));
  const candidates = graph.processes.filter((p) => !role.processes.some((rp) => rp.processId === p.id));

  function wireOf(processes: { processId: string; relation: "owner" | "participant" }[]) {
    return processes.map((rp) => ({ process_id: rp.processId, relation: rp.relation }));
  }

  function toggleRelation(processId: string) {
    void setProcesses(
      role.id,
      wireOf(
        role.processes.map((rp) =>
          rp.processId === processId
            ? { processId, relation: rp.relation === "owner" ? "participant" : "owner" }
            : { processId: rp.processId, relation: rp.relation },
        ),
      ),
    );
  }

  function addProcess(processId: string) {
    void setProcesses(role.id, wireOf([...role.processes, { processId, relation: "participant" }]));
    setOpen(false);
  }

  function removeProcess(processId: string) {
    void setProcesses(role.id, wireOf(role.processes.filter((rp) => rp.processId !== processId)));
  }

  return (
    <div>
      <SectionHead label="Procesos" count={role.processes.length} />
      <ul className="space-y-1.5">
        {linked.map((l) => (
          <li key={l.processId} className="flex items-center gap-2">
            <Link
              to={`${paths.contexto(projectId, "procesos")}?proceso=${l.processId}`}
              className="min-w-0 flex-1 truncate text-small text-ink underline hover:text-link"
            >
              {l.process?.name ?? l.processId}
            </Link>
            <button type="button" disabled={readOnly} onClick={() => toggleRelation(l.processId)} className="press shrink-0">
              <Chip tone={l.relation === "owner" ? "done" : "quiet"}>
                {l.relation === "owner" ? "Responsable" : "Participa"}
              </Chip>
            </button>
            {!readOnly ? (
              <button
                type="button"
                aria-label="Quitar proceso"
                onClick={() => removeProcess(l.processId)}
                className="press shrink-0 text-faint hover:text-broken"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {!readOnly ? (
        <InlinePopover
          open={open}
          onOpenChange={setOpen}
          label="Vincular proceso"
          trigger={
            <ActionButton variant="quiet" className="mt-1.5">
              Vincular proceso
            </ActionButton>
          }
        >
          <div className="max-h-48 overflow-y-auto">
            {candidates.map((p) => (
              <PopoverOption key={p.id} onSelect={() => addProcess(p.id)}>
                {p.name}
              </PopoverOption>
            ))}
          </div>
        </InlinePopover>
      ) : null}
      <Link to={paths.contexto(projectId, "procesos")} className="press mt-2 inline-block text-small font-semibold text-link underline">
        Ver procesos del cliente
      </Link>
    </div>
  );
}

// ── Panel ────────────────────────────────────────────────────────────────

export interface RolePanelProps {
  role: OrgRoleFull;
  graph: OrgGraph;
  readOnly: boolean;
  projectId: string;
  onClose(): void;
  updateRole(id: string, body: UpdateOrgRoleInput): Promise<boolean>;
  deleteRole(id: string): Promise<void>;
  setFunctions(id: string, functions: DraftFunction[]): Promise<void>;
  setPeople(id: string, people: { person_id: string; dedication_pct?: number | null }[]): Promise<void>;
  setProcesses(id: string, processes: { process_id: string; relation: "owner" | "participant" }[]): Promise<void>;
}

export default function RolePanel({
  role,
  graph,
  readOnly,
  projectId,
  onClose,
  updateRole,
  deleteRole,
  setFunctions,
  setPeople,
  setProcesses,
}: RolePanelProps) {
  const [nameDraft, setNameDraft] = useState(role.name);
  const [purposeDraft, setPurposeDraft] = useState(role.purpose ?? "");

  useEffect(() => setNameDraft(role.name), [role.id, role.name]);
  useEffect(() => setPurposeDraft(role.purpose ?? ""), [role.id, role.purpose]);

  function commitName() {
    const trimmed = nameDraft.trim();
    if (!trimmed || trimmed === role.name) {
      setNameDraft(role.name);
      return;
    }
    void updateRole(role.id, { name: trimmed, expected_version: role.version });
  }

  function toggleStatus() {
    void updateRole(role.id, {
      status: role.status === "validated" ? "draft" : "validated",
      expected_version: role.version,
    });
  }

  function commitPurpose() {
    const trimmed = purposeDraft.trim();
    if (trimmed === (role.purpose ?? "")) return;
    void updateRole(role.id, { purpose: trimmed || null, expected_version: role.version });
  }

  return (
    <aside
      data-testid="role-panel"
      className="w-full shrink-0 overflow-y-auto rounded-panel bg-surface p-5 shadow-raise md:w-[360px]"
    >
      <div className="flex items-start justify-between gap-2">
        <input
          value={nameDraft}
          disabled={readOnly}
          onChange={(e) => setNameDraft(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          className="min-w-0 flex-1 border-0 bg-transparent text-title font-semibold text-ink focus:outline-none disabled:opacity-100"
        />
        <button
          type="button"
          onClick={onClose}
          aria-label="Cerrar panel"
          className="press shrink-0 rounded-full p-1 text-faint hover:bg-canvas-deep hover:text-ink-2"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <button type="button" disabled={readOnly} onClick={toggleStatus} className="press mt-1">
        <Chip tone={role.status === "validated" ? "done" : "decide"}>
          {role.status === "validated" ? "Validado" : "Borrador"}
        </Chip>
      </button>

      <div className="mt-4 space-y-3">
        <label className="block">
          <span className="mb-1 block text-label text-faint">Área</span>
          <select
            value={role.unitId ?? ""}
            disabled={readOnly}
            onChange={(e) =>
              void updateRole(role.id, { unit_id: e.target.value || null, expected_version: role.version })
            }
            className="w-full rounded-tight border border-line bg-surface px-2 py-1.5 text-small text-ink disabled:opacity-70"
          >
            <option value="">Sin área</option>
            {graph.units.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-label text-faint">Reporta a</span>
          <select
            value={role.reportsToRoleId ?? ""}
            disabled={readOnly}
            onChange={(e) =>
              void updateRole(role.id, { reports_to_role_id: e.target.value || null, expected_version: role.version })
            }
            className="w-full rounded-tight border border-line bg-surface px-2 py-1.5 text-small text-ink disabled:opacity-70"
          >
            <option value="">Nadie</option>
            {graph.roles
              .filter((r) => r.id !== role.id)
              .map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-label text-faint">Propósito</span>
          <textarea
            value={purposeDraft}
            disabled={readOnly}
            rows={2}
            ref={(el) => {
              if (el) {
                el.style.height = "auto";
                el.style.height = `${el.scrollHeight}px`;
              }
            }}
            onChange={(e) => {
              setPurposeDraft(e.target.value);
              e.target.style.height = "auto";
              e.target.style.height = `${e.target.scrollHeight}px`;
            }}
            onBlur={commitPurpose}
            className="w-full resize-none rounded-tight border border-line bg-surface px-2 py-1.5 text-small text-ink disabled:opacity-70"
          />
        </label>
      </div>

      <FunctionsSection role={role} graph={graph} readOnly={readOnly} setFunctions={setFunctions} />
      <PeopleSection role={role} graph={graph} readOnly={readOnly} setPeople={setPeople} />
      <ProcessesSection role={role} graph={graph} readOnly={readOnly} projectId={projectId} setProcesses={setProcesses} />

      {!readOnly ? (
        <div className="mt-8 border-t border-line-soft pt-4">
          <ActionButton
            variant="danger"
            onClick={() => {
              if (window.confirm(`¿Eliminar el rol "${role.name}"? Esta acción no se puede deshacer.`)) {
                void deleteRole(role.id);
                onClose();
              }
            }}
          >
            Eliminar rol
          </ActionButton>
        </div>
      ) : null}
    </aside>
  );
}
