/**
 * Responsables humanos: buscador con avatares, selección múltiple y marca de
 * principal. Guarda al cerrar el popover si cambió (`POST /assign` con
 * `expected_version`). El roster sale de `useProjectRoster` (compartido con
 * el alta de tarea).
 */
import { useMemo, useState } from "react";
import { PopoverSearch } from "../../components/ui/InlinePopover";
import { PersonAvatar } from "../../components/ui";
import { displayPersonName, useProjectRoster } from "../../lib/roster";
import { normalizar } from "../../lib/tareas";
import { getTaskAssignees, taskAssigneeIsPrimary, taskAssigneePersonId, type Person, type Task } from "../../lib/types";
import { useStore } from "../../state/store";
import { PropertyRow, useInlineCommit } from "./PropertyRow";

function assignmentOf(task: Task): { ids: string[]; primary: string } {
  const assignees = getTaskAssignees(task);
  const ids = assignees.map(taskAssigneePersonId).filter((id): id is string => Boolean(id));
  const primary = assignees.find(taskAssigneeIsPrimary);
  return { ids, primary: primary ? taskAssigneePersonId(primary) ?? ids[0] ?? "" : ids[0] ?? "" };
}

function embeddedPeople(task: Task): Person[] {
  return getTaskAssignees(task).flatMap((assignee) => {
    if (!assignee.person) return [];
    return [{ ...assignee.person, full_name: displayPersonName(assignee.person), role: assignee.person.role ?? null }];
  });
}

export function PeoplePicker({ task }: { task: Task }) {
  const assignTaskPeople = useStore((state) => state.assignTaskPeople);
  const { open, setOpen, notice, commit } = useInlineCommit(task.id);
  const extra = useMemo(() => embeddedPeople(task), [task]);
  const roster = useProjectRoster(task.projectId, extra);
  const [query, setQuery] = useState("");
  const [ids, setIds] = useState<string[]>([]);
  const [primary, setPrimary] = useState("");

  const byId = useMemo(() => new Map(roster.people.map((person) => [person.id, person])), [roster.people]);
  const current = assignmentOf(task);
  const visible = useMemo(() => {
    const needle = normalizar(query);
    return roster.people.filter((person) => !needle || normalizar(displayPersonName(person)).includes(needle));
  }, [roster.people, query]);

  function describeCurrent(): string {
    const latest = useStore.getState().taskDetail?.task ?? task;
    const names = assignmentOf(latest).ids.map((id) => (byId.get(id) ? displayPersonName(byId.get(id)!) : id));
    return names.length ? names.join(", ") : "nadie";
  }

  function handleOpenChange(value: boolean): void {
    if (value) {
      setIds(current.ids);
      setPrimary(current.primary);
      setQuery("");
      setOpen(true);
      return;
    }
    setOpen(false);
    const changed = ids.join("|") !== current.ids.join("|") || (primary || "") !== (current.primary || "");
    if (!changed) return;
    void commit(() => assignTaskPeople(task.id, ids, primary || null), describeCurrent);
  }

  function toggle(personId: string, checked: boolean): void {
    const next = checked ? [...ids, personId] : ids.filter((id) => id !== personId);
    setIds(next);
    setPrimary((value) => (next.includes(value) ? value : next[0] ?? ""));
  }

  const assigned = current.ids.map((id) => byId.get(id)).filter((person): person is Person => Boolean(person));

  return (
    <PropertyRow
      icon="◉"
      label="Asignado"
      testId="prop-assignees"
      open={open}
      onOpenChange={handleOpenChange}
      notice={notice}
      empty={current.ids.length === 0}
      popoverClassName="w-[min(92vw,22rem)]"
      editor={
        <div>
          <PopoverSearch value={query} onChange={setQuery} label="Buscar persona" placeholder="Buscar persona…" testId="people-search" />
          {roster.loading ? <p className="px-2 py-1 text-small text-faint">Cargando equipo…</p> : null}
          {roster.error ? (
            <div className="mx-1 my-1 rounded-tight border border-work-line bg-work-bg p-2 text-label text-work" role="alert">
              <p>{roster.error}</p>
              <button type="button" onClick={roster.reload} className="mt-1 font-semibold underline">Reintentar roster</button>
            </div>
          ) : null}
          {!roster.loading && roster.people.length === 0 ? (
            <p className="px-2 py-1 text-small text-work" data-testid="no-project-people">
              La organización de este proyecto no tiene personas registradas: una tarea sólo admite responsables de la organización dueña del proyecto.
            </p>
          ) : null}
          <div className="max-h-64 overflow-y-auto">
            {visible.map((person) => {
              const checked = ids.includes(person.id);
              const name = displayPersonName(person);
              return (
                <div key={person.id} className="flex min-h-10 items-center gap-2 rounded-tight px-2 hover:bg-surface-2">
                  <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 py-1.5">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(event) => toggle(person.id, event.target.checked)}
                      className="h-4 w-4 rounded border-line text-ink focus:ring-link"
                    />
                    <PersonAvatar name={name} size={5} />
                    <span className="min-w-0 flex-1 truncate text-small font-medium text-ink-2">{name}</span>
                  </label>
                  {checked ? (
                    <button
                      type="button"
                      aria-pressed={primary === person.id}
                      aria-label={`Marcar a ${name} como principal`}
                      onClick={() => setPrimary(person.id)}
                      className={`min-h-8 rounded-tight px-1.5 text-label font-semibold focus:outline-none focus:ring-2 focus:ring-link ${
                        primary === person.id ? "text-link" : "text-faint hover:text-muted"
                      }`}
                    >
                      {primary === person.id ? "principal" : "hacer principal"}
                    </button>
                  ) : null}
                </div>
              );
            })}
            {!roster.loading && roster.people.length > 0 && visible.length === 0 ? (
              <p className="px-2 py-1 text-small text-faint">Nadie coincide con «{query}».</p>
            ) : null}
          </div>
        </div>
      }
    >
      <span className="flex flex-wrap items-center gap-1.5">
        {assigned.map((person) => (
          <span key={person.id} className="inline-flex items-center gap-1 rounded-full border border-line bg-surface pl-0.5 pr-2 py-0.5 text-label font-medium text-ink-2">
            <PersonAvatar name={displayPersonName(person)} size={5} />
            <span className="max-w-[10rem] truncate">{displayPersonName(person)}</span>
            {current.primary === person.id && assigned.length > 1 ? <span className="text-faint" title="Principal">★</span> : null}
          </span>
        ))}
        {current.ids.filter((id) => !byId.has(id)).map((id) => (
          <span key={id} className="rounded-full border border-line bg-surface px-2 py-0.5 text-label text-muted">Persona {id.slice(0, 8)}</span>
        ))}
      </span>
    </PropertyRow>
  );
}
